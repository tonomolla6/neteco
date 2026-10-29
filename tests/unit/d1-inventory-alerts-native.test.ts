import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { executeD1AdminInventoryCommand } from '../../workers/catalog/admin-inventory'
import worker from '../../workers/canary'
import {
  inventoryAlertIntentHash,
  inventoryAlertCommandReceiptSchema,
  inventoryAlertsResponseSchema
} from '../../shared/inventory-alerts'
import {
  openAdminInventoryFixture,
  INVENTORY_FIXTURE_ACTOR,
  INVENTORY_FIXTURE_SESSION
} from '../support/admin-inventory-fixture'

it('runs threshold, evaluation, acknowledgement and receipt recovery against actual workerd D1 without changing stock', async () => {
  const outbound = vi.fn(() => {
    throw new Error('unexpected_outbound')
  })
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'inventory-alerts-native',
      modules: true,
      script: 'export default {fetch(){return new Response("isolated")}}',
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      d1Databases: { DB: '00000000-0000-4000-8000-000000000067' },
      outboundService: outbound
    })
  )
  let fixture: Awaited<ReturnType<typeof openAdminInventoryFixture>> | undefined
  try {
    fixture = await openAdminInventoryFixture()
    const database = (await runtime.getD1Database('DB')) as unknown as D1Database
    for (const name of (await readdir('db/d1/migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
      const statements = splitDemoSql(await readFile(join('db/d1/migrations', name), 'utf8'))
      for (let offset = 0; offset < statements.length; offset += 50)
        await database.batch(statements.slice(offset, offset + 50).map((sql) => database.prepare(sql)))
    }
    // Only the existing synthetic catalog/warehouse/identity setup is portable.
    // All subsequent stock changes use the governed inventory command primitive.
    for (const table of [
      'categories',
      'tax_classes',
      'shipping_profiles',
      'products',
      'variants',
      'inventory_locations',
      'inventory_balances',
      'inventory_movements',
      'roles',
      'permissions',
      'role_permissions',
      'identities',
      'auth_sessions',
      'identity_roles'
    ]) {
      const statements = fixture.sqlite
        .prepare(`SELECT * FROM "${table}"`)
        .all()
        .map((row) => {
          const columns = Object.keys(row)
          return database
            .prepare(
              `INSERT INTO "${table}"(${columns.map((column) => `"${column}"`).join(',')}) VALUES(${columns.map(() => '?').join(',')})`
            )
            .bind(...Object.values(row))
        })
      if (statements.length) await database.batch(statements)
    }
    // Exact canonical core fixture: 99 isolated draft positions with physical1
    // and no ledger. Their intentional divergence tests anomaly detection; this
    // setup is outside every measured interval, never a stock-repair operation.
    const positions: D1PreparedStatement[] = []
    const fixtureInstant = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    for (let legacy = 12; legacy <= 110; legacy++) {
      const id = `70000000-0000-4000-8000-${String(legacy).padStart(12, '0')}`
      positions.push(
        database
          .prepare(
            'INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,unit_base,price_gross_cents,safety_stock) SELECT ?,?,product_id,tax_class_id,shipping_profile_id,?,format,status,unit_base,price_gross_cents,safety_stock FROM variants WHERE legacy_id=11'
          )
          .bind(id, legacy, `SYNTHETIC-${legacy}`)
      )
      positions.push(
        database
          .prepare(
            "INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at) VALUES(?,'main',1,0,1,?,?)"
          )
          .bind(id, fixtureInstant, fixtureInstant)
      )
    }
    for (let offset = 0; offset < positions.length; offset += 50)
      await database.batch(positions.slice(offset, offset + 50))
    const origin = 'https://inventory-alerts.neteco.test'
    const claims = { identityId: INVENTORY_FIXTURE_ACTOR, sessionId: INVENTORY_FIXTURE_SESSION, sessionVersion: 1 }
    const sessionCookieConfiguration = {
      password: 'synthetic-inventory-alerts-cookie-more-than-32',
      maxAgeSeconds: 3600
    }
    const cookie = (await issueD1SessionCookie(database, claims, sessionCookieConfiguration))!.split(';')[0]!
    // Actual canary entrypoint and actual workerd D1, like quick-order-native.
    // This is not execution of the compiled shop bundle or a browser acceptance.
    const env = {
      APP_ENV: 'local',
      AUTH_ENABLED: 'true',
      DB: database,
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: sessionCookieConfiguration.password,
      ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
      AUTH_RATE_LIMIT_PEPPER: 'synthetic-inventory-alerts-pepper-more-than-32'
    } as unknown as CloudflareEnv
    let keyNumber = 1
    const key = () => `60000000-0000-4000-8000-${String(keyNumber++).padStart(12, '0')}`
    const send = async (path: string, method = 'GET', body?: unknown, commandId = key(), hash?: string) => {
      const response = await worker.fetch(
        new Request(origin + path, {
          method,
          headers: {
            Cookie: cookie,
            ...(method === 'GET' ? {} : { Origin: origin }),
            'CF-Connecting-IP': '192.0.2.67',
            'Content-Type': 'application/json',
            'Idempotency-Key': commandId,
            ...(hash ? { 'X-Neteco-Command-Payload-Hash': hash } : {})
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        }),
        env
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.get('set-cookie')).toBeNull()
      return response.json()
    }
    const snapshot = async () => ({
      balances: (await database.prepare('SELECT * FROM inventory_balances ORDER BY variant_id,location_id').all())
        .results,
      movements: (await database.prepare('SELECT * FROM inventory_movements ORDER BY id').all()).results,
      reservations: (await database.prepare('SELECT * FROM inventory_reservations ORDER BY id').all()).results
    })
    const initial = await snapshot()
    const unexpectedDatabase = {
      prepare: vi.fn(() => {
        throw new Error('unexpected_disabled_db')
      })
    } as unknown as D1Database
    for (const path of [
      '/api/admin/inventory/alerts',
      '/api/admin/inventory/%61lerts',
      '/api/admin/inventory/variants/11/alert-policy'
    ]) {
      const disabled = await worker.fetch(new Request(origin + path), {
        ...env,
        AUTH_ENABLED: 'false',
        DB: unexpectedDatabase
      })
      expect(disabled.status).toBe(503)
      expect(disabled.headers.get('cache-control')).toBe('private, no-store')
      expect(disabled.headers.get('set-cookie')).toBeNull()
    }
    expect(unexpectedDatabase.prepare).not.toHaveBeenCalled()
    const alias = await worker.fetch(new Request(origin + '/api/admin/inventory/%61lerts'), env)
    expect(alias.status).toBe(400)
    const input = { expectedVersion: 0, threshold: 20, reason: 'Synthetic stock alert threshold' }
    const commandId = key()
    const receipt = inventoryAlertCommandReceiptSchema.parse(
      await send('/api/admin/inventory/variants/11/alert-policy', 'PUT', input, commandId)
    )
    const payloadHash = await inventoryAlertIntentHash('threshold', '11', input)
    expect(receipt).toMatchObject({ commandId, action: 'threshold', targetId: '11', payloadHash, version: 1 })
    expect(
      await send(`/api/admin/inventory/alerts/commands/${commandId}`, 'GET', undefined, key(), payloadHash)
    ).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    expect(await send('/api/admin/inventory/variants/11/alert-policy', 'PUT', input, commandId)).toEqual(receipt)
    const conflict = await worker.fetch(
      new Request(origin + '/api/admin/inventory/variants/11/alert-policy', {
        method: 'PUT',
        headers: {
          Cookie: cookie,
          Origin: origin,
          'CF-Connecting-IP': '192.0.2.67',
          'Content-Type': 'application/json',
          'Idempotency-Key': key()
        },
        body: JSON.stringify({ ...input, threshold: 30 })
      }),
      env
    )
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ error: { code: 'version_conflict' } })
    await send('/api/admin/inventory/alerts/evaluate', 'POST', { limit: 1 })
    const queue = inventoryAlertsResponseSchema.parse(await send('/api/admin/inventory/alerts'))
    expect(queue.items).toHaveLength(1)
    expect(queue.items[0]).toMatchObject({ variantId: 11, kind: 'low', state: 'open', sellableQuantity: 17 })
    await send(`/api/admin/inventory/alerts/${queue.items[0]!.id}/ack`, 'POST', {
      expectedVersion: queue.items[0]!.version,
      reason: 'Synthetic warehouse acknowledgement'
    })
    expect(await snapshot()).toEqual(initial)
    await executeD1AdminInventoryCommand(
      database,
      claims,
      'receipt',
      { variantId: '11' },
      {
        expectedBalanceVersion: 1,
        quantity: 5,
        reason: 'Synthetic governed stock receipt',
        reference: 'SYNTHETIC-INV011'
      },
      { idempotencyKey: 'native-alert-stock-receipt' }
    )
    const received = await snapshot()
    await send('/api/admin/inventory/alerts/evaluate', 'POST', { limit: 1 })
    expect(inventoryAlertsResponseSchema.parse(await send('/api/admin/inventory/alerts?state=resolved')).items).toEqual(
      [expect.objectContaining({ variantId: 11, state: 'resolved' })]
    )
    expect(await snapshot()).toEqual(received)
    const evaluated = inventoryAlertCommandReceiptSchema.parse(
      await send('/api/admin/inventory/alerts/evaluate', 'POST', { limit: 100 })
    )
    expect(evaluated).toMatchObject({ action: 'evaluate', processed: 100, opened: 99, nextAfterVariantId: 110 })
    const anomalies = inventoryAlertsResponseSchema.parse(await send('/api/admin/inventory/alerts?kind=anomaly'))
    expect(anomalies.pagination).toMatchObject({ total: 99, perPage: 25, pages: 4 })
    expect(anomalies.items).toHaveLength(25)
    expect(anomalies.items.every((item) => item.kind === 'anomaly' && item.currentKind === 'anomaly')).toBe(true)
    expect(await snapshot()).toEqual(received)
    const commandRows = (await database.prepare('SELECT * FROM inventory_alert_commands ORDER BY id').all()).results
    await database.prepare('DELETE FROM identity_roles WHERE identity_id=?').bind(claims.identityId).run()
    const revoked = await worker.fetch(
      new Request(origin + '/api/admin/inventory/alerts', {
        headers: { Cookie: cookie, 'CF-Connecting-IP': '192.0.2.67' }
      }),
      env
    )
    expect(revoked.status).toBe(403)
    expect(await database.prepare('SELECT * FROM inventory_alert_commands ORDER BY id').all()).toMatchObject({
      results: commandRows
    })
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    try {
      fixture?.sqlite.close()
    } finally {
      await runtime.dispose()
    }
  }
}, 60000)
