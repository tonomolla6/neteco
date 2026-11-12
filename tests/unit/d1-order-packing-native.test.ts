import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import worker from '../../workers/canary'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { createPackingOrder, CLAIMS, REASON } from './d1-order-packing-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  adminOrderPackingSchema,
  orderPackingReceiptSchema,
  orderPackingCommandResponseSchema,
  orderPackingIntentHash
} from '../../shared/order-packing'
import { testUuid } from '../support/deterministic'

it('records two parcels and manual dispatch through actual canary.fetch/workerd D1 without economic, stock, fulfillment or provider effects', async () => {
  const outbound = vi.fn(() => {
    throw new Error('unexpected_outbound')
  })
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'packing-native',
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
      database.prepare("INSERT INTO roles VALUES('packing-native','Synthetic operator','Synthetic')"),
      database.prepare("INSERT INTO permissions VALUES('administration.manage','administration','manage','Synthetic')"),
      database.prepare("INSERT INTO role_permissions VALUES('packing-native','administration.manage')"),
      database
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES(?,'packing-native@example.invalid','synthetic',?,'active',?,?)"
        )
        .bind(CLAIMS.identityId, now, now, now),
      database
        .prepare(
          "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,'2099-01-01T00:00:00Z')"
        )
        .bind(CLAIMS.sessionId, CLAIMS.identityId, now),
      database
        .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'packing-native',?)")
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
    const orderId = await createPackingOrder(database, { stage: 'packed', now })
    const origin = 'https://packing.neteco.test',
      password = 'synthetic-packing-cookie-password-over-32'
    const cookie = (await issueD1SessionCookie(database, CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
    const env = {
      APP_ENV: 'local',
      AUTH_ENABLED: 'true',
      DB: database,
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: password,
      AUTH_RATE_LIMIT_PEPPER: 'synthetic-packing-rate-pepper-more-than-32',
      ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) }
    } as unknown as CloudflareEnv
    const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
    const base = `/api/admin/orders/${orderId}/packing`
    const dispatch = (path = base, init: RequestInit = {}, bindings = env) =>
      worker.fetch(
        new Request(origin + path, {
          ...init,
          headers: { cookie, 'CF-Connecting-IP': '192.0.2.169', ...Object.fromEntries(new Headers(init.headers)) }
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
      'payment_events',
      'payment_intents',
      'payment_fulfilment_claims',
      'inventory_balances',
      'inventory_movements',
      'inventory_reservations',
      'inventory_reservation_lines',
      'order_fulfillments',
      'order_fulfillment_commands',
      'order_fulfillment_audit',
      'fiscal_invoice_intents',
      'auth_sessions',
      'identities',
      'identity_roles',
      'role_permissions'
    ]
    const snapshot = () =>
      Promise.all(
        tables.map(async (table) => (await database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results)
      )
    const before = await snapshot()
    const initialResponse = await dispatch()
    expect(initialResponse.status).toBe(200)
    const initial = adminOrderPackingSchema.parse(await initialResponse.json())
    expect(initial).toMatchObject({
      orderId,
      version: 0,
      fulfillmentVersion: 2,
      fulfillmentState: 'packed',
      shippingMethod: 'parcel'
    })
    const pack = {
      action: 'pack',
      expectedVersion: 0,
      expectedFulfillmentVersion: 2,
      reason: REASON,
      parcels: [0, 1].map(() => ({
        weightGrams: 1000,
        widthMm: 200,
        heightMm: 100,
        depthMm: 100,
        contents: [{ lineIndex: 0, quantity: 2 }]
      }))
    }
    const manual = {
      action: 'manual_dispatch',
      expectedVersion: 1,
      expectedFulfillmentVersion: 2,
      reason: REASON,
      shipments: [0, 1].map((parcelIndex) => ({
        parcelIndex,
        carrier: 'Synthetic manual carrier',
        shipmentNumber: `synthetic-shipment-${parcelIndex}`,
        trackingNumber: `synthetic-tracking-${parcelIndex}`,
        externalLabelReference: `synthetic-document-${parcelIndex}`
      })),
      actualNetCents: 700,
      taxBps: 2100
    }
    for (const input of [pack, manual]) {
      const key = testUuid(),
        hash = await orderPackingIntentHash(orderId, input)
      const post = () =>
        dispatch(`${base}/commands`, {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key },
          body: JSON.stringify(input)
        })
      const response = await post()
      expect(response.status).toBe(201)
      expect(response.headers.get('Cache-Control')).toContain('no-store')
      expect(response.headers.get('Set-Cookie')).toBeNull()
      const receipt = orderPackingReceiptSchema.parse(await response.json())
      expect(receipt).toMatchObject({
        commandId: key,
        orderId,
        action: input.action,
        payloadHash: hash,
        parcelCount: 2,
        inventoryEffect: 'none',
        economicEffect: 'none',
        providerEffect: 'none'
      })
      const replay = await post()
      expect(replay.status).toBe(201)
      expect(await replay.json()).toEqual(receipt)
      const readTables = ['order_packings', 'order_packing_commands', 'order_packing_audit', 'identity_rate_limits']
      const readSnapshot = () =>
        Promise.all(
          readTables.map(async (table) => (await database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results)
        )
      const beforeRead = await readSnapshot()
      const recovered = await dispatch(`${base}/commands/${key}`, {
        headers: { 'X-Neteco-Command-Payload-Hash': hash }
      })
      expect(recovered.status).toBe(200)
      expect(orderPackingCommandResponseSchema.parse(await recovered.json())).toEqual({
        source: 'cloudflare',
        outcome: 'applied',
        receipt
      })
      const conflict = await dispatch(`${base}/commands/${key}`, {
        headers: { 'X-Neteco-Command-Payload-Hash': '0'.repeat(64) }
      })
      expect(conflict.status).toBe(409)
      expect(await readSnapshot()).toEqual(beforeRead)
    }
    const finalResponse = await dispatch()
    expect(finalResponse.status).toBe(200)
    expect(adminOrderPackingSchema.parse(await finalResponse.json())).toMatchObject({
      version: 2,
      state: 'manual_dispatch_recorded',
      fulfillmentVersion: 2,
      fulfillmentState: 'packed',
      dispatch: {
        actualNetCents: 700,
        actualTaxCents: 147,
        actualGrossCents: 847,
        labelVerification: 'unverified_reference_only'
      }
    })
    expect(await snapshot()).toEqual(before)
    const unknown = await dispatch(`${base}/commands/${testUuid()}`, {
      headers: { 'X-Neteco-Command-Payload-Hash': '0'.repeat(64) }
    })
    expect(unknown.status).toBe(200)
    expect(await unknown.json()).toEqual({ source: 'cloudflare', outcome: 'unknown' })
    for (const path of [base, `${base}/commands/${testUuid()}`, base.replace('/packing', '/%70acking')]) {
      const disabled = await dispatch(path, {}, { ...env, AUTH_ENABLED: 'false' })
      expect(disabled.status).toBe(503)
      expect(disabled.headers.get('Cache-Control')).toContain('no-store')
      expect(disabled.headers.get('Set-Cookie')).toBeNull()
    }
    const commandCount = await database
      .prepare('SELECT COUNT(*) AS n FROM order_packing_commands')
      .first<{ n: number }>()
    expect(commandCount?.n).toBe(2)
    const forbiddenDatabase = {
      prepare: vi.fn(() => {
        throw new Error('edge_must_precede_D1')
      }),
      batch: vi.fn(() => {
        throw new Error('edge_must_precede_D1')
      })
    } as unknown as D1Database
    for (const [limiter, status] of [
      [undefined, 503],
      [{ limit: async () => ({ success: false }) }, 429]
    ] as const) {
      expect(
        (await dispatch(base, {}, { ...env, DB: forbiddenDatabase, ADMIN_EDGE_LIMIT: limiter } as CloudflareEnv)).status
      ).toBe(status)
    }
    expect(forbiddenDatabase.prepare).not.toHaveBeenCalled()
    expect(forbiddenDatabase.batch).not.toHaveBeenCalled()
    await database.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').bind(CLAIMS.sessionId).run()
    const denied = await dispatch()
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: { code: 'mfa_required' } })
    expect(
      (
        await dispatch(`${base}/commands`, {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': testUuid() },
          body: JSON.stringify(manual)
        })
      ).status
    ).toBe(403)
    expect(
      (
        await dispatch(`${base}/commands/${testUuid()}`, {
          headers: { 'X-Neteco-Command-Payload-Hash': '0'.repeat(64) }
        })
      ).status
    ).toBe(403)
    expect(await database.prepare('SELECT COUNT(*) AS n FROM order_packing_commands').first()).toEqual(commandCount)
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
}, 30_000)
