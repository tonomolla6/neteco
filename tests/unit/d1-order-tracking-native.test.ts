import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import worker from '../../workers/canary'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { createPackingOrder, CLAIMS } from './d1-order-packing-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { orderTrackingSchema } from '../../shared/order-tracking'
import {
  seedTrackingBuyers,
  recordTrackingPacking,
  trackingGuestCookie,
  configuration,
  origin,
  BUYER,
  FOREIGN
} from './d1-order-tracking-http-fixture'

it('reads owner/admin/sealed guest tracking through actual canary.fetch/workerd D1 without writes or carrier claims', async () => {
  const outbound = vi.fn(() => {
    throw new Error('unexpected_outbound')
  })
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'tracking-native',
      modules: true,
      script: 'export default {fetch(){return new Response("isolated")}}',
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      d1Databases: { DB: '00000000-0000-4000-8000-000000000069' },
      outboundService: outbound
    })
  )
  try {
    const database = (await runtime.getD1Database('DB')) as unknown as D1Database
    const migrations = (await readdir('db/d1/migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()
    expect(migrations).toContain('0069_order_packing.sql')
    expect(migrations.map((name) => Number(name.slice(0, 4)))).toEqual(
      Array.from({ length: migrations.length }, (_, index) => index + 1)
    )
    for (const name of migrations) {
      const statements = splitDemoSql(await readFile(join('db/d1/migrations', name), 'utf8'))
      for (let offset = 0; offset < statements.length; offset += 50)
        await database.batch(statements.slice(offset, offset + 50).map((sql) => database.prepare(sql)))
    }
    const seeds: D1PreparedStatement[] = []
    seedInventoryFixture({
      exec(sql: string) {
        for (const text of splitDemoSql(sql)) seeds.push(database.prepare(text))
      },
      prepare(sql: string) {
        return {
          run(...args: unknown[]) {
            seeds.push(database.prepare(sql).bind(...args))
          }
        }
      }
    } as unknown as DatabaseSync)
    await database.batch(seeds)
    const now = (await database.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS now").first<{ now: string }>())!
      .now
    await provisionPublicationValidityFixture(database, { productIds: ['p-1'], now })
    await database.batch([
      database.prepare("INSERT INTO roles VALUES('tracking-native','Synthetic operator','Synthetic')"),
      database.prepare("INSERT INTO permissions VALUES('administration.manage','administration','manage','Synthetic')"),
      database.prepare("INSERT INTO role_permissions VALUES('tracking-native','administration.manage')"),
      database
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES(?,'tracking-native@example.invalid','synthetic',?,'active',?,?)"
        )
        .bind(CLAIMS.identityId, now, now, now),
      database
        .prepare(
          "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,'2099-01-01T00:00:00Z')"
        )
        .bind(CLAIMS.sessionId, CLAIMS.identityId, now),
      database
        .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'tracking-native',?)")
        .bind(CLAIMS.identityId, now),
      database
        .prepare(
          "INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at) VALUES('packing-parcel-zone','packing-parcel','Synthetic parcel','parcel_peninsular','[\"peninsular\"]',1,?)"
        )
        .bind(now),
      database
        .prepare(
          "INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at) VALUES('packing-parcel-rate','packing-parcel-zone','parcel','parcel',500,2100,1,2,1,1,?)"
        )
        .bind(now)
    ])
    await seedTrackingBuyers(database, now)
    const guestOrderId = await createPackingOrder(database, { stage: 'packed', now })
    const ownedOrderId = await createPackingOrder(database, { stage: 'packed', now, ownerSession: BUYER })
    for (const orderId of [guestOrderId, ownedOrderId]) await recordTrackingPacking(database, orderId)
    const cookie = async (claims: typeof CLAIMS) =>
      (await issueD1SessionCookie(database, claims, configuration))!.split(';')[0]!
    const adminCookie = await cookie(CLAIMS),
      buyerCookie = await cookie(BUYER),
      foreignCookie = await cookie(FOREIGN)
    const guestCookie = await trackingGuestCookie(database, guestOrderId)
    const env = {
      APP_ENV: 'local',
      AUTH_ENABLED: 'true',
      DB: database,
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: configuration.password,
      AUTH_RATE_LIMIT_PEPPER: 'synthetic-tracking-native-pepper-more-than-32',
      ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
      AUTH_EDGE_LIMIT: { limit: async () => ({ success: true }) }
    } as unknown as CloudflareEnv
    const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
    const dispatch = (orderId: string, credential: string, admin = false, bindings = env, tail = '', method = 'GET') =>
      worker.fetch(
        new Request(origin + `/api/${admin ? 'admin/' : ''}orders/${orderId}/tracking` + tail, {
          method,
          headers: { Cookie: credential, 'CF-Connecting-IP': '192.0.2.170' }
        }),
        bindings,
        context
      )
    const tables = [
      'orders',
      'order_lines',
      'order_shipping_address',
      'order_billing_address',
      'order_events',
      'order_payment_states',
      'payment_intents',
      'payment_events',
      'payment_fulfilment_claims',
      'inventory_balances',
      'inventory_movements',
      'inventory_reservations',
      'inventory_reservation_lines',
      'order_fulfillments',
      'order_fulfillment_commands',
      'order_fulfillment_audit',
      'order_packings',
      'order_packing_commands',
      'order_packing_audit',
      'auth_sessions',
      'identities',
      'identity_roles',
      'role_permissions',
      'identity_rate_limits'
    ]
    const snapshot = () =>
      Promise.all(
        tables.map(async (table) => (await database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results)
      )
    const before = await snapshot()
    for (const [orderId, credential, audience] of [
      [ownedOrderId, buyerCookie, 'customer'],
      [ownedOrderId, adminCookie, 'admin'],
      [guestOrderId, guestCookie, 'guest']
    ] as const) {
      const response = await dispatch(orderId, credential, audience === 'admin')
      expect(response.status, audience).toBe(200)
      const dto = orderTrackingSchema.parse(await response.json())
      expect(dto).toMatchObject({
        orderId,
        audience,
        shippingMethod: 'parcel',
        fulfillment: { state: 'packed', version: 2 },
        packing: { parcelCount: 2 },
        carrierEvents: [],
        carrierStatus: 'not_connected'
      })
      expect(dto.shipments.map((item) => item.verification)).toEqual(['manual_unverified', 'manual_unverified'])
      expect(JSON.stringify(dto)).not.toMatch(
        /shipmentNumber|externalLabelReference|actualNetCents|@example|Synthetic buyer|reason|token|DOCUMENT-/
      )
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
      expect(response.headers.get('Set-Cookie')).toBeNull()
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    }
    for (const [id, credential] of [
      [ownedOrderId, foreignCookie],
      [crypto.randomUUID(), buyerCookie],
      [ownedOrderId, guestCookie]
    ]) {
      const response = await dispatch(id!, credential!)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: { code: 'not_found' } })
    }
    for (const admin of [true, false]) {
      expect((await dispatch(ownedOrderId, admin ? adminCookie : buyerCookie, admin, env, '', 'POST')).status).toBe(405)
      expect(
        (await dispatch(ownedOrderId, admin ? adminCookie : buyerCookie, admin, env, '?token=' + 'a'.repeat(64))).status
      ).toBe(400)
      expect(
        (await dispatch(ownedOrderId, admin ? adminCookie : buyerCookie, admin, { ...env, AUTH_ENABLED: 'false' }))
          .status
      ).toBe(503)
    }
    expect(await snapshot()).toEqual(before)
    // These are explicit adversarial mutations AFTER genuine checkout+packing,
    // never source fabrication used to obtain a successful tracking response.
    await database.prepare('UPDATE orders SET access_revoked_at=created_at WHERE id=?').bind(guestOrderId).run()
    expect((await dispatch(guestOrderId, guestCookie)).status).toBe(404)
    await database.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').bind(CLAIMS.sessionId).run()
    expect((await dispatch(ownedOrderId, adminCookie, true)).status).toBe(403)
    await database.prepare('UPDATE auth_sessions SET mfa_verified=1 WHERE id=?').bind(CLAIMS.sessionId).run()
    await database.prepare('DROP TRIGGER order_packing_projection_update').run()
    await database
      .prepare('UPDATE order_packings SET parcels=\'[{"synthetic":"corrupt"}]\' WHERE order_id=?')
      .bind(ownedOrderId)
      .run()
    const corrupted = await dispatch(ownedOrderId, adminCookie, true)
    expect(corrupted.status).toBe(503)
    expect(await corrupted.json()).toEqual({ error: { code: 'history_unconfirmed' } })
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
}, 30_000)
