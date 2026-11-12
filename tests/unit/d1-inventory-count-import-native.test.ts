import { randomBytes } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { buildNativeCanary as build } from '../support/native-canary-build'
import { syncNativeTestClock } from '../support/native-runtime-clock'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  inventoryCountImportPreviewSchema,
  inventoryCountImportReceiptSchema,
  inventoryCountImportSnapshotSchema,
  inventoryCountImportCommandSchema,
  inventoryCountImportIntentHash
} from '../../shared/inventory-count-import'
import {
  openAdminInventoryFixture,
  INVENTORY_FIXTURE_ACTOR,
  INVENTORY_FIXTURE_SESSION
} from '../support/admin-inventory-fixture'
import { testUuid } from '../support/deterministic'

const origin = 'https://count-import-native.neteco.test'
const base = '/api/admin/inventory/count-imports'
const reason = 'Synthetic independent review of physical warehouse count'
const reference = 'SYNTHETIC-NATIVE-INV010'

describe('inventory imports through real workerd D1 and the global InventoryCoordinator binding', () => {
  let runtime: Miniflare | undefined
  let database: D1Database
  let ownerCookie: string
  let approverCookie: string
  const outbound = vi.fn(() => {
    throw new Error('unexpected_outbound')
  })

  beforeAll(async () => {
    const password = randomBytes(32).toString('hex')
    // In-memory source acceptance only: no shop rebuild, disk bundle or browser.
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        sourcefile: 'count-import-native-entry.ts',
        loader: 'ts',
        contents: "export { default, InventoryCoordinator } from './workers/canary'"
      },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      external: ['node:*', 'cloudflare:*'],
      write: false,
      logLevel: 'silent'
    })
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'count-import-native',
        ...bundle.nativeSource,
        compatibilityDate: '2026-08-15',
        compatibilityFlags: ['nodejs_compat'],
        cf: false,
        telemetry: { enabled: false },
        log: new NoOpLog(),
        bindings: {
          APP_ENV: 'local',
          AUTH_ENABLED: 'true',
          AUTH_ORIGIN: origin,
          NUXT_SESSION_PASSWORD: password,
          AUTH_TOKEN_PEPPER: randomBytes(32).toString('hex'),
          AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
          AUTH_RATE_LIMIT_PEPPER: randomBytes(32).toString('hex')
        },
        durableObjects: { INVENTORY: { className: 'InventoryCoordinator', useSQLite: true } },
        ratelimits: { ADMIN_EDGE_LIMIT: { namespace_id: '900771', simple: { limit: 100, period: 60 } } },
        d1Databases: { DB: testUuid() },
        outboundService: outbound
      })
    )
    try {
      database = (await runtime.getD1Database('DB')) as unknown as D1Database
      await syncNativeTestClock(database)
      const files = (await readdir('db/d1/migrations'))
        .filter((file) => /^\d{4}_.*\.sql$/.test(file) && Number(file.slice(0, 4)) <= 77)
        .sort()
      expect(files.map((file) => Number(file.slice(0, 4)))).toEqual(Array.from({ length: 77 }, (_, index) => index + 1))
      for (const file of files)
        await database.batch(
          splitDemoSql(await readFile('db/d1/migrations/' + file, 'utf8')).map((sql) => database.prepare(sql))
        )
      const fixture = await openAdminInventoryFixture()
      try {
        // Portable synthetic setup only. No approval, import or movement under
        // test is copied from SQLite; subsequent commands all cross real HTTP/DO.
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
          const inserts = fixture.sqlite
            .prepare(`SELECT * FROM "${table}"`)
            .all()
            .map((row) => {
              const names = Object.keys(row)
              return database
                .prepare(
                  `INSERT INTO "${table}"(${names.map((name) => `"${name}"`).join(',')}) VALUES(${names.map(() => '?').join(',')})`
                )
                .bind(...Object.values(row))
            })
          if (inserts.length) await database.batch(inserts)
        }
      } finally {
        fixture.sqlite.close()
      }
      const statements: D1PreparedStatement[] = []
      // Two disjoint hundred-position lots make the tests independent, without
      // resetting stock or editing authority after the measured interval starts.
      for (let legacy = 12; legacy <= 210; legacy++) {
        const id = `70000000-0000-4000-8000-${String(legacy).padStart(12, '0')}`
        statements.push(
          database
            .prepare(
              `INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,unit_base,price_gross_cents,safety_stock)
          SELECT ?,?,product_id,tax_class_id,shipping_profile_id,?,format,status,unit_base,price_gross_cents,safety_stock FROM variants WHERE legacy_id=11`
            )
            .bind(id, legacy, `NATIVE-COUNT-${legacy}`)
        )
        statements.push(
          database
            .prepare(
              `INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at)
          VALUES(?,'main',20,1,1,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')`
            )
            .bind(id)
        )
        statements.push(
          database
            .prepare(
              `INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,reference_id,idempotency_key,correlation_id,created_at)
          VALUES(?,?,'main','initial',20,0,'synthetic',NULL,?,'synthetic','2020-01-01T00:00:00Z')`
            )
            .bind(`native-initial-${legacy}`, id, `native-initial-${legacy}`)
        )
      }
      for (let offset = 0; offset < statements.length; offset += 48)
        await database.batch(statements.slice(offset, offset + 48))
      const configuration = { password, maxAgeSeconds: 3600 }
      ownerCookie = (await issueD1SessionCookie(
        database,
        { identityId: INVENTORY_FIXTURE_ACTOR, sessionId: INVENTORY_FIXTURE_SESSION, sessionVersion: 1 },
        configuration
      ))!.split(';')[0]!
      approverCookie = (await issueD1SessionCookie(
        database,
        {
          identityId: '10000000-0000-4000-8000-000000000042',
          sessionId: '20000000-0000-4000-8000-000000000042',
          sessionVersion: 1
        },
        configuration
      ))!.split(';')[0]!
    } catch (error) {
      await runtime.dispose()
      runtime = undefined
      throw error
    }
  }, 60000)
  afterAll(async () => {
    await runtime?.dispose()
  })

  async function send(
    path: string,
    method = 'GET',
    input?: unknown,
    options: { cookie?: string; key?: string; hash?: string } = {}
  ) {
    if (!runtime) throw new Error('native_runtime_unavailable')
    const response = await runtime.dispatchFetch(origin + path, {
      method,
      headers: {
        Cookie: options.cookie ?? ownerCookie,
        'CF-Connecting-IP': '192.0.2.77',
        ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
        ...(options.key ? { 'Idempotency-Key': options.key } : {}),
        ...(options.hash ? { 'X-Neteco-Command-Payload-Hash': options.hash } : {})
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) })
    })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('set-cookie')).toBeNull()
    return { status: response.status, body: (await response.json()) as unknown }
  }
  const csvFor = (first: number) =>
    'sku,countedPhysicalQuantity\n' +
    Array.from({ length: 100 }, (_, index) => {
      const legacy = first + index
      return `${legacy === 11 ? 'SYNTHETIC-SKU' : `NATIVE-COUNT-${legacy}`},21`
    }).join('\n')
  async function stock() {
    const result = await database.batch([
      database.prepare('SELECT * FROM inventory_balances ORDER BY variant_id,location_id'),
      database.prepare('SELECT * FROM inventory_movements ORDER BY id')
    ])
    expect(result.every((row) => row.success)).toBe(true)
    return result.map((row) => row.results)
  }
  async function untouched() {
    const tables = [
      'orders',
      'order_lines',
      'payment_commands',
      'payment_events',
      'inventory_reservations',
      'inventory_reservation_lines',
      'auth_sessions'
    ]
    const result = await database.batch(
      tables.map((table) => database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`))
    )
    expect(result.every((row) => row.success)).toBe(true)
    return result.map((row) => row.results)
  }
  async function propose(csv: string) {
    const before = await stock(),
      inspected = await send(base + '/preview', 'POST', { csv })
    expect(inspected.status).toBe(200)
    const preview = inventoryCountImportPreviewSchema.parse(inspected.body)
    expect(preview).toMatchObject({ canPropose: true })
    expect(preview.rows).toHaveLength(100)
    const input = { csv, previewHash: preview.previewHash, reason, reference },
      key = testUuid()
    const proposed = await send(base, 'POST', input, { key })
    expect(proposed.status).toBe(201)
    const receipt = inventoryCountImportReceiptSchema.parse(proposed.body)
    expect(receipt).toMatchObject({
      commandId: key,
      action: 'propose',
      rowCount: 100,
      changedCount: 100,
      inventoryEffect: 'none'
    })
    expect(await stock()).toEqual(before)
    return receipt
  }

  it('approves all hundred rows via a distinct real actor and replays/recoveries without another movement', async () => {
    const other = await untouched(),
      proposed = await propose(csvFor(11)),
      key = testUuid()
    const input = { expectedVersion: 1, reason },
      hash = await inventoryCountImportIntentHash('approve', proposed.importId, input)
    const self = await send(`${base}/${proposed.importId}/approve`, 'POST', input, { key: testUuid() })
    expect(self).toEqual({ status: 409, body: { error: { code: 'approval_self' } } })
    const approved = await send(`${base}/${proposed.importId}/approve`, 'POST', input, { key, cookie: approverCookie })
    expect(approved.status).toBe(201)
    const receipt = inventoryCountImportReceiptSchema.parse(approved.body)
    expect(receipt).toMatchObject({
      action: 'approve',
      commandId: key,
      payloadHash: hash,
      version: 2,
      changedCount: 100,
      inventoryEffect: 'physical_adjustment'
    })
    const current = await send(`${base}/${proposed.importId}`, 'GET', undefined, { cookie: approverCookie })
    expect(current.status).toBe(200)
    const view = inventoryCountImportSnapshotSchema.parse(current.body)
    expect(view).toMatchObject({ status: 'approved', approvedBy: '10000000-0000-4000-8000-000000000042' })
    expect(view.rows).toHaveLength(100)
    expect(view.rows.every((row) => row.currentPhysicalQuantity === 21 && row.currentBalanceVersion === 2)).toBe(true)
    const after = await stock()
    expect(await send(`${base}/${proposed.importId}/approve`, 'POST', input, { key, cookie: approverCookie })).toEqual(
      approved
    )
    const recovered = await send(`${base}/commands/${key}`, 'GET', undefined, { cookie: approverCookie, hash })
    expect(recovered.status).toBe(200)
    expect(inventoryCountImportCommandSchema.parse(recovered.body)).toEqual({
      source: 'cloudflare',
      outcome: 'applied',
      receipt
    })
    expect(await stock()).toEqual(after)
    expect(await untouched()).toEqual(other)
    expect(
      (
        await database
          .prepare(
            "SELECT count(*) AS n FROM inventory_movements WHERE reference_type='inventory_count_import' AND correlation_id=?"
          )
          .bind(proposed.importId)
          .first<{ n: number }>()
      )?.n
    ).toBe(100)
    expect(outbound).not.toHaveBeenCalled()
  }, 30000)

  it('rejects every adjustment when the last of a hundred rows changes through a governed stock receipt', async () => {
    const other = await untouched(),
      proposed = await propose(csvFor(111))
    const received = await send(
      '/api/admin/inventory/variants/210/receipts',
      'POST',
      {
        expectedBalanceVersion: 1,
        quantity: 1,
        reason,
        reference
      },
      { key: testUuid() }
    )
    expect(received.status).toBe(200)
    const before = await stock(),
      key = testUuid(),
      input = { expectedVersion: 1, reason }
    const response = await send(`${base}/${proposed.importId}/approve`, 'POST', input, { key, cookie: approverCookie })
    expect(response).toEqual({ status: 409, body: { error: { code: 'version_conflict' } } })
    expect(await stock()).toEqual(before)
    const current = await send(`${base}/${proposed.importId}`, 'GET', undefined, { cookie: approverCookie })
    expect(current.status).toBe(200)
    const view = inventoryCountImportSnapshotSchema.parse(current.body)
    expect(view).toMatchObject({ status: 'proposed', version: 1, capabilities: { approve: false } })
    expect(view.rows.filter((row) => row.stale)).toHaveLength(1)
    expect(view.rows[99]).toMatchObject({
      variantId: 210,
      currentPhysicalQuantity: 21,
      currentBalanceVersion: 2,
      stale: true
    })
    expect(
      (
        await database
          .prepare("SELECT count(*) AS n FROM inventory_count_import_commands WHERE import_id=? AND action='approve'")
          .bind(proposed.importId)
          .first<{ n: number }>()
      )?.n
    ).toBe(0)
    expect(
      (
        await database
          .prepare(
            "SELECT count(*) AS n FROM inventory_movements WHERE reference_type='inventory_count_import' AND correlation_id=?"
          )
          .bind(proposed.importId)
          .first<{ n: number }>()
      )?.n
    ).toBe(0)
    expect(await untouched()).toEqual(other)
    expect(outbound).not.toHaveBeenCalled()
  }, 30000)
})
