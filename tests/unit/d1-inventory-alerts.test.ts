import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleInventoryAlertsHttp } from '../../workers/catalog/inventory-alerts-http'
import {
  openAdminInventoryFixture,
  INVENTORY_FIXTURE_ACTOR,
  INVENTORY_FIXTURE_SESSION
} from '../support/admin-inventory-fixture'
import {
  executeD1InventoryAlertCommand,
  readD1InventoryAlertPolicy,
  readD1InventoryAlerts,
  readD1InventoryAlertCommand,
  sweepD1InventoryAlerts
} from '../../workers/catalog/inventory-alerts'
import { inventoryAlertIntentHash, inventoryAlertCommandReceiptSchema } from '../../shared/inventory-alerts'
import { deterministicTestData, FIXED_TEST_INSTANT } from '../fixtures/deterministic'

const claims = { identityId: INVENTORY_FIXTURE_ACTOR, sessionId: INVENTORY_FIXTURE_SESSION, sessionVersion: 1 }
const clock = { now: () => FIXED_TEST_INSTANT.replace('.000Z', 'Z') }

describe('bounded single-warehouse inventory alert episodes and audit', () => {
  let sqlite: DatabaseSync, database: D1Database
  let data = deterministicTestData('inventory-alerts')
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(FIXED_TEST_INSTANT)
    data = deterministicTestData('inventory-alerts')
    ;({ sqlite, database } = await openAdminInventoryFixture())
    sqlite.exec(await readFile(new URL('../../db/d1/migrations/0067_inventory_alerts.sql', import.meta.url), 'utf8'))
  })
  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
  })
  const reason = 'Explicit synthetic warehouse operator decision'
  function threshold(value: number | null, version = 0, key = data.uuid()) {
    return executeD1InventoryAlertCommand(
      database,
      claims,
      'threshold',
      '11',
      { expectedVersion: version, threshold: value, reason },
      key,
      clock
    )
  }
  const evaluate = (key = data.uuid()) =>
    executeD1InventoryAlertCommand(database, claims, 'evaluate', 'warehouse', { limit: 50 }, key, clock)
  function counts() {
    return Object.fromEntries(
      [
        'inventory_balances',
        'inventory_movements',
        'inventory_alert_commands',
        'inventory_alert_audit',
        'inventory_alert_evaluations',
        'inventory_alert_episodes'
      ].map((table) => [table, sqlite.prepare(`SELECT count(*) n FROM ${table}`).get()!.n])
    )
  }
  function stock(physical: number) {
    const before = sqlite.prepare('SELECT physical_quantity FROM inventory_balances').get()!.physical_quantity as number
    const id = data.uuid()
    sqlite.prepare('UPDATE inventory_balances SET physical_quantity=?,version=version+1').run(physical)
    sqlite
      .prepare(
        "INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,idempotency_key,correlation_id,created_at) SELECT ?,variant_id,location_id,'adjustment',?,0,'synthetic',?,?,? FROM inventory_balances"
      )
      .run(id, physical - before, id, id, clock.now())
  }
  it('starts unconfigured/off, reads live facts without evaluating or changing any ledger', async () => {
    const before = counts()
    expect(await readD1InventoryAlertPolicy(database, claims, 11, clock)).toMatchObject({
      version: 0,
      threshold: null,
      updatedAt: null
    })
    expect(await readD1InventoryAlerts(database, claims, {}, clock)).toMatchObject({
      lastEvaluationAt: null,
      items: [],
      pagination: { total: 0 }
    })
    expect(counts()).toEqual(before)
  })
  it('configures an explicit threshold separately from safety stock and opens exactly once, no stock effects', async () => {
    const before = counts(),
      receipt = await threshold(20)
    expect(receipt).toMatchObject({ action: 'threshold', version: 1, processed: 1, opened: 1, updated: 0, resolved: 0 })
    expect(sqlite.prepare('SELECT safety_stock FROM variants').get()!.safety_stock).toBe(2)
    const first = await readD1InventoryAlerts(database, claims, {}, clock)
    expect(first.items[0]).toMatchObject({
      variantId: 11,
      kind: 'low',
      state: 'open',
      sellableQuantity: 17,
      currentKind: 'low',
      threshold: 20
    })
    await evaluate()
    await sweepD1InventoryAlerts(database, { limit: 50 }, clock)
    expect((await readD1InventoryAlerts(database, claims, {}, clock)).items.map((x) => x.id)).toEqual(
      first.items.map((x) => x.id)
    )
    expect(counts()).toMatchObject({
      inventory_balances: before.inventory_balances,
      inventory_movements: before.inventory_movements,
      inventory_alert_episodes: 1
    })
  })
  it('changes kind in the SAME episode, ACK stays actionable, recovery resolves once and a new fall opens a new episode', async () => {
    await threshold(20)
    const first = (await readD1InventoryAlerts(database, claims, {}, clock)).items[0]!
    stock(3)
    expect(await evaluate()).toMatchObject({ opened: 0, updated: 1, resolved: 0 })
    const out = (await readD1InventoryAlerts(database, claims, {}, clock)).items[0]!
    expect(out).toMatchObject({ id: first.id, kind: 'out_of_stock', version: 2 })
    const before = counts()
    await executeD1InventoryAlertCommand(
      database,
      claims,
      'ack',
      out.id,
      { expectedVersion: 2, reason },
      data.uuid(),
      clock
    )
    expect((await readD1InventoryAlerts(database, claims, { state: 'acknowledged' }, clock)).items[0]).toMatchObject({
      id: first.id,
      state: 'acknowledged',
      version: 3,
      currentKind: 'out_of_stock'
    })
    expect(counts()).toMatchObject({
      inventory_balances: before.inventory_balances,
      inventory_movements: before.inventory_movements
    })
    stock(30)
    const stale = (await readD1InventoryAlerts(database, claims, { state: 'acknowledged' }, clock)).items[0]!
    expect(stale.currentKind).toBe(null)
    expect(stale.state).toBe('acknowledged')
    expect(await evaluate()).toMatchObject({ resolved: 1 })
    expect(await evaluate()).toMatchObject({ resolved: 0 })
    stock(10)
    await evaluate()
    expect((await readD1InventoryAlerts(database, claims, {}, clock)).items[0]!.id).not.toBe(first.id)
    expect(sqlite.prepare('SELECT count(*) n FROM inventory_alert_episodes').get()!.n).toBe(2)
  })
  it('uses canonical divergence even with thresholds disabled and does not fabricate zero stock when balance is absent', async () => {
    // Simulate an already-corrupt legacy database; ordinary writes correctly
    // cannot orphan a movement because the migrated FK is enabled.
    sqlite.exec('PRAGMA foreign_keys=OFF; DELETE FROM inventory_balances; PRAGMA foreign_keys=ON')
    await evaluate()
    expect((await readD1InventoryAlerts(database, claims, {}, clock)).items[0]).toMatchObject({
      kind: 'anomaly',
      currentKind: 'anomaly',
      sellableQuantity: null,
      threshold: null
    })
  })
  it('does not flag a legitimate retired/net-zero position or backorder commitment as an anomaly', async () => {
    sqlite.exec('UPDATE inventory_balances SET blocked_quantity=0')
    stock(0)
    sqlite.exec("UPDATE variants SET status='discontinued',backorder_allowed=1")
    await evaluate()
    expect((await readD1InventoryAlerts(database, claims, {}, clock)).items).toEqual([])
  })
  it('disabling threshold resolves low/out episodes but never hides canonical anomalies', async () => {
    await threshold(20)
    expect(await threshold(null, 1)).toMatchObject({ resolved: 1, version: 2 })
    sqlite.exec('UPDATE inventory_balances SET physical_quantity=1')
    await evaluate()
    expect((await readD1InventoryAlerts(database, claims, {}, clock)).items[0]!.kind).toBe('anomaly')
    await threshold(null, 2)
    expect((await readD1InventoryAlerts(database, claims, {}, clock)).items[0]!.kind).toBe('anomaly')
  })
  it('isolates key/owner/exact payload, recovers a committed response without another write, and never treats unknown as absence', async () => {
    const key = data.uuid(),
      body = { expectedVersion: 0, threshold: 20, reason }
    const receipt = await threshold(20, 0, key),
      before = counts(),
      hash = await inventoryAlertIntentHash('threshold', '11', body)
    expect(await readD1InventoryAlertCommand(database, claims, key, hash, clock)).toEqual({
      source: 'cloudflare',
      outcome: 'applied',
      receipt
    })
    expect(await threshold(20, 0, key)).toEqual(receipt)
    expect(counts()).toEqual(before)
    await expect(threshold(10, 0, key)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(
      readD1InventoryAlertCommand(
        database,
        {
          identityId: '10000000-0000-4000-8000-000000000042',
          sessionId: '20000000-0000-4000-8000-000000000042',
          sessionVersion: 1
        },
        key,
        hash,
        clock
      )
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(await readD1InventoryAlertCommand(database, claims, data.uuid(), hash, clock)).toEqual({
      source: 'cloudflare',
      outcome: 'unknown'
    })
    sqlite.exec("UPDATE auth_sessions SET revoked_at='2026-08-13T11:00:00Z'")
    await expect(threshold(20, 0, key)).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it('rejects stale policy/ACK CAS with no audit or stock mutation', async () => {
    await threshold(20)
    const item = (await readD1InventoryAlerts(database, claims, {}, clock)).items[0]!,
      before = counts()
    await expect(threshold(10, 0)).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(
      executeD1InventoryAlertCommand(
        database,
        claims,
        'ack',
        item.id,
        { expectedVersion: 9, reason },
        data.uuid(),
        clock
      )
    ).rejects.toMatchObject({ code: 'version_conflict' })
    expect(counts()).toEqual(before)
  })
  it('rolls back all effects on a mid-batch error and retries forward using the same intent', async () => {
    const key = data.uuid(),
      before = counts()
    sqlite.exec(
      "CREATE TRIGGER synthetic_alert_fail BEFORE INSERT ON inventory_alert_audit BEGIN SELECT RAISE(ABORT,'synthetic audit unavailable'); END"
    )
    await expect(threshold(20, 0, key)).rejects.toThrow()
    expect(counts()).toEqual(before)
    sqlite.exec('DROP TRIGGER synthetic_alert_fail')
    expect(await threshold(20, 0, key)).toMatchObject({ opened: 1, version: 1 })
  })
  it('guards source/CAS and current authority inside the atomic batch against changes after preflight', async () => {
    const original = database.batch.bind(database),
      before = counts()
    database.batch = async (statements) => {
      sqlite.exec("DELETE FROM role_permissions WHERE permission_code='inventory.write'")
      return original(statements)
    }
    await expect(threshold(20)).rejects.toMatchObject({ code: 'forbidden' })
    expect(counts()).toEqual(before)
  })
  it('guards stock source races after preflight without writing a stale alert', async () => {
    const original = database.batch.bind(database)
    database.batch = async (statements) => {
      stock(30)
      return original(statements)
    }
    await expect(threshold(20)).rejects.toMatchObject({ code: 'version_conflict' })
    expect(sqlite.prepare('SELECT count(*) n FROM inventory_alert_commands').get()!.n).toBe(0)
  })
  it('fails closed outside the single active warehouse scope and denies unverified/MFA/read/write authority', async () => {
    sqlite.exec(
      "INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES('second','SECOND','Synthetic second','warehouse',1,'2020-01-01T00:00:00Z')"
    )
    await expect(evaluate()).rejects.toMatchObject({ code: 'warehouse_unavailable' })
    sqlite.exec("DELETE FROM inventory_locations WHERE id='second'; UPDATE auth_sessions SET mfa_verified=0")
    await expect(evaluate()).rejects.toMatchObject({ code: 'mfa_required' })
    sqlite.exec('UPDATE auth_sessions SET mfa_verified=1; UPDATE identities SET email_verified_at=NULL')
    await expect(evaluate()).rejects.toMatchObject({ code: 'email_unverified' })
  })
  it('keeps command/evaluation/audit evidence append-only and validates bounded receipts/queries', async () => {
    const receipt = await threshold(20)
    for (const table of ['inventory_alert_commands', 'inventory_alert_audit', 'inventory_alert_evaluations']) {
      expect(() => sqlite.exec(`DELETE FROM ${table}`)).toThrow()
    }
    expect(inventoryAlertCommandReceiptSchema.safeParse({ ...receipt, opened: 2 }).success).toBe(false)
    await expect(readD1InventoryAlerts(database, claims, { perPage: 26 }, clock)).rejects.toMatchObject({
      code: 'invalid_input'
    })
    await expect(
      executeD1InventoryAlertCommand(database, claims, 'evaluate', 'warehouse', { limit: 101 }, data.uuid(), clock)
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
  function extraVariant(legacy: number, physical?: number) {
    const id = data.uuid('variant')
    sqlite
      .prepare(
        'INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,unit_base,price_gross_cents,safety_stock) SELECT ?,?,product_id,tax_class_id,shipping_profile_id,?,format,status,unit_base,price_gross_cents,safety_stock FROM variants WHERE legacy_id=11'
      )
      .run(id, legacy, `SYNTHETIC-${legacy}`)
    if (physical !== undefined)
      sqlite
        .prepare(
          "INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at) VALUES(?,'main',?,0,1,?,?)"
        )
        .run(id, physical, clock.now(), clock.now())
  }
  it('selects the exact alertId for ACK recovery even with a long SKU and other episodes', async () => {
    sqlite.prepare('UPDATE variants SET sku=? WHERE legacy_id=11').run('S'.repeat(120))
    await threshold(20)
    extraVariant(12, 1)
    await evaluate()
    const all = await readD1InventoryAlerts(database, claims, { state: 'all' }, clock)
    expect(all.items).toHaveLength(2)
    const target = all.items.find((item) => item.variantId === 11)!
    const exact = await readD1InventoryAlerts(database, claims, { state: 'all', alertId: target.id }, clock)
    expect(exact.items.map((item) => item.id)).toEqual([target.id])
    expect(exact.pagination.total).toBe(1)
    await expect(readD1InventoryAlerts(database, claims, { alertId: 'not-a-uuid' }, clock)).rejects.toMatchObject({
      code: 'invalid_input'
    })
  })
  it('rejects a policy projection whose threshold no longer matches its immutable command and audit', async () => {
    await threshold(20)
    sqlite.exec('UPDATE inventory_alert_policies SET threshold=0')
    await expect(readD1InventoryAlertPolicy(database, claims, 11, clock)).rejects.toThrow(
      'inventory_alert_projection_invalid'
    )
  })
  it('rejects an episode projection whose kind no longer matches its immutable command and audit', async () => {
    await threshold(20)
    sqlite.exec("UPDATE inventory_alert_episodes SET kind='anomaly'")
    await expect(readD1InventoryAlerts(database, claims, { state: 'all' }, clock)).rejects.toThrow(
      'inventory_alert_projection_invalid'
    )
  })
  it('advances a durable cron cursor across same-timestamp pages, cycles, and ignores manual evaluations', async () => {
    extraVariant(12)
    extraVariant(13)
    expect(await sweepD1InventoryAlerts(database, { limit: 1 }, clock)).toMatchObject({
      processed: 1,
      nextAfterVariantId: 11
    })
    await evaluate()
    expect(await sweepD1InventoryAlerts(database, { limit: 1 }, clock)).toMatchObject({
      processed: 1,
      nextAfterVariantId: 12
    })
    expect(await sweepD1InventoryAlerts(database, { limit: 1 }, clock)).toMatchObject({
      processed: 1,
      nextAfterVariantId: 13
    })
    expect(await sweepD1InventoryAlerts(database, { limit: 1 }, clock)).toMatchObject({
      processed: 0,
      nextAfterVariantId: null
    })
    expect(await sweepD1InventoryAlerts(database, { limit: 1 }, clock)).toMatchObject({
      processed: 1,
      nextAfterVariantId: 11
    })
    expect(
      sqlite
        .prepare(
          "SELECT count(DISTINCT variant_id) n FROM inventory_alert_evaluations e JOIN inventory_alert_commands c ON c.id=e.command_id WHERE c.source='cron'"
        )
        .get()!.n
    ).toBe(3)
  })
  it('evaluates 100 real canonical anomaly positions with a constant SQL/bind budget, not one query per variant', async () => {
    for (let legacy = 12; legacy <= 110; legacy++) extraVariant(legacy, 1)
    const original = database.batch.bind(database),
      lengths: number[] = []
    database.batch = async (statements) => {
      lengths.push(statements.length)
      return original(statements)
    }
    const receipt = await executeD1InventoryAlertCommand(
      database,
      claims,
      'evaluate',
      'warehouse',
      { limit: 100 },
      data.uuid(),
      clock
    )
    expect(receipt).toMatchObject({ processed: 100, opened: 99, nextAfterVariantId: 110 })
    expect(lengths).toHaveLength(1)
    expect(lengths[0]).toBeLessThanOrEqual(11)
    expect(sqlite.prepare('SELECT count(*) n FROM inventory_alert_episodes').get()!.n).toBe(99)
  })
})

describe('inventory alert capability through the current inventory boundary', () => {
  let sqlite: DatabaseSync, database: D1Database, cookie: string
  const origin = 'https://inventory-alerts.example.test'
  const password = 'synthetic-inventory-alert-cookie-password-at-least-32-characters'
  beforeEach(async () => {
    ;({ sqlite, database } = await openAdminInventoryFixture())
    sqlite.exec(await readFile(new URL('../../db/d1/migrations/0067_inventory_alerts.sql', import.meta.url), 'utf8'))
    cookie = (await issueD1SessionCookie(
      database,
      { identityId: INVENTORY_FIXTURE_ACTOR, sessionId: INVENTORY_FIXTURE_SESSION, sessionVersion: 1 },
      { password, maxAgeSeconds: 3600 }
    ))!.split(';')[0]!
  })
  afterEach(() => sqlite.close())
  it.each([
    ['GET', '/api/admin/inventory/alerts', undefined],
    [
      'PUT',
      '/api/admin/inventory/variants/11/alert-policy',
      { expectedVersion: 0, threshold: 20, reason: 'Explicit synthetic operator threshold' }
    ],
    ['POST', '/api/admin/inventory/alerts/evaluate', { limit: 50 }]
  ] as const)('serves the real %s %s capability rather than unknown-route', async (method, path, body) => {
    const response = await handleInventoryAlertsHttp(
      new Request(origin + path, {
        method,
        headers: {
          origin,
          cookie,
          'cf-connecting-ip': '192.0.2.41',
          'content-type': 'application/json',
          'idempotency-key': '60000000-0000-4000-8000-000000000067'
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      }),
      {
        database,
        origin,
        sessionCookieConfiguration: { password, maxAgeSeconds: 3600 },
        edgeLimiter: { limit: async () => ({ success: true }) },
        rateLimitPepper: password
      }
    )
    expect(response?.status).toBe(200)
    expect(((await response!.json()) as { source: string }).source).toBe('cloudflare')
  })
})
