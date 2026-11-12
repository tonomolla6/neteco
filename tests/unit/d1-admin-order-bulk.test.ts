import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fulfillmentFixture, CLAIMS, REASON, ACTOR, SESSION, utc } from './d1-fulfillment-fixture'
import { executeD1AdminFulfillmentCommand } from '../../workers/fulfillment/admin'
import {
  createD1AdminOrderBulk,
  previewD1AdminOrderBulk,
  processD1AdminOrderBulkStep,
  readD1AdminOrderBulk,
  readD1AdminOrderBulkCommand
} from '../../workers/fulfillment/bulk'
import {
  adminOrderBulkCreateInputSchema,
  adminOrderBulkIntentHash,
  adminOrderBulkPreviewInputSchema
} from '../../shared/admin-order-bulk'
import { testNow, testUuid } from '../support/deterministic'

vi.mock('../support/d1-sqlite', async (importOriginal) => {
  const original = await importOriginal<typeof import('../support/d1-sqlite')>()
  return {
    ...original,
    openMigratedDatabase: async (...args: Parameters<typeof original.openMigratedDatabase>) => {
      const sqlite = await original.openMigratedDatabase(...args)
      sqlite.function('synthetic_order_bulk_clock', () => {
        const clock = vi.getMockedSystemTime()
        if (!clock) throw new Error('missing_synthetic_order_bulk_clock')
        return clock.toISOString().replace(/\.\d{3}Z$/, 'Z')
      })
      const nativeExec = sqlite.exec.bind(sqlite)
      sqlite.exec = (sql: string) => nativeExec(sql.replaceAll("'now'", 'synthetic_order_bulk_clock()'))
      return sqlite
    },
    d1OverSqlite: (sqlite: Parameters<typeof original.d1OverSqlite>[0]) => {
      const database = original.d1OverSqlite(sqlite),
        nativePrepare = database.prepare.bind(database)
      database.prepare = (sql: string) => nativePrepare(sql.replaceAll("'now'", 'synthetic_order_bulk_clock()'))
      return database
    }
  }
})

describe('bounded explicit administrative fulfillment groups', () => {
  let fixture: Awaited<ReturnType<typeof fulfillmentFixture>>
  let id: string
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(testNow() + 1000)
    fixture = await fulfillmentFixture({ stock: 100 })
    fixture.sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0086_admin_order_bulk.sql', import.meta.url), 'utf8')
    )
    fixture.sqlite
      .prepare(
        "INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES(?,'synthetic-not-production','[]',?,?)"
      )
      .run(ACTOR, utc(-60000), utc(-60000))
    id = await fixture.order()
  })
  afterEach(() => {
    fixture?.sqlite.close()
    vi.useRealTimers()
  })
  const input = (ids = [id], action: 'picking' | 'packed' = 'picking') => ({ action, orderIds: ids, reason: REASON })
  const economic = () =>
    Object.fromEntries(
      [
        'orders',
        'order_lines',
        'order_payment_states',
        'payment_intents',
        'payment_fulfilment_claims',
        'inventory_balances',
        'inventory_movements',
        'inventory_reservations',
        'inventory_reservation_lines'
      ].map((table) => [table, fixture.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
    )
  async function reviewed(ids = [id]) {
    const preview = await previewD1AdminOrderBulk(fixture.database, CLAIMS, input(ids))
    return {
      action: preview.action,
      reason: REASON,
      orders: preview.rows.map((row) => ({ orderId: row.orderId, expectedVersion: row.expectedVersion })),
      previewHash: preview.previewHash
    }
  }
  const create = async (ids = [id], key = testUuid()) => {
    const body = await reviewed(ids)
    return { body, receipt: await createD1AdminOrderBulk(fixture.database, CLAIMS, body, { idempotencyKey: key }), key }
  }
  it('bounds explicit unique selection and reuses operational evidence rules', () => {
    expect(adminOrderBulkPreviewInputSchema.safeParse(input([id, id])).success).toBe(false)
    expect(
      adminOrderBulkPreviewInputSchema.safeParse(input(Array.from({ length: 26 }, () => testUuid()))).success
    ).toBe(false)
    expect(adminOrderBulkPreviewInputSchema.safeParse({ ...input(), action: 'delivered' }).success).toBe(false)
    expect(
      adminOrderBulkPreviewInputSchema.safeParse({ ...input(), action: 'delivered', evidence: REASON }).success
    ).toBe(true)
    expect(adminOrderBulkCreateInputSchema.safeParse({ ...input(), previewHash: 'a'.repeat(64) }).success).toBe(false)
  })
  it('previews only selected real orders without writes, exposing eligible and unpaid blockers without private facts', async () => {
    const unpaid = await fixture.order('pickup', false),
      before = economic()
    const preview = await previewD1AdminOrderBulk(fixture.database, CLAIMS, input([id, unpaid]))
    expect(preview).toMatchObject({
      source: 'cloudflare',
      eligible: 1,
      blocked: 1,
      inventoryEffect: 'none',
      economicEffect: 'none'
    })
    expect(preview.rows).toMatchObject([
      { orderId: id, expectedVersion: 0, eligible: true, reason: null },
      { orderId: unpaid, eligible: false, reason: 'payment_unconfirmed' }
    ])
    expect(JSON.stringify(preview)).not.toMatch(/buyer@example|Original buyer|token|paid_gross|reservation_id/)
    expect(economic()).toEqual(before)
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM order_fulfillment_commands').get()?.n).toBe(0)
  })
  it('captures actual fulfillment versions server-side rather than assuming initial versions', async () => {
    await executeD1AdminFulfillmentCommand(
      fixture.database,
      CLAIMS,
      id,
      { action: 'picking', expectedVersion: 0, reason: REASON },
      { idempotencyKey: 'already-picking' }
    )
    const preview = await previewD1AdminOrderBulk(fixture.database, CLAIMS, input([id], 'packed'))
    expect(preview.rows[0]).toMatchObject({ expectedVersion: 1, currentVersion: 1, state: 'picking', eligible: true })
  })
  it('creates an immutable durable group and exact actor-bound receipt before execution, replaying the original key', async () => {
    const { body, receipt, key } = await create()
    expect(receipt).toMatchObject({ commandId: key, selected: 1, eligible: 1, blocked: 0 })
    expect(await createD1AdminOrderBulk(fixture.database, CLAIMS, body, { idempotencyKey: key })).toEqual(receipt)
    expect(
      await readD1AdminOrderBulkCommand(fixture.database, CLAIMS, key, await adminOrderBulkIntentHash(body))
    ).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    const group = await readD1AdminOrderBulk(fixture.database, CLAIMS, receipt.groupId)
    expect(group).toMatchObject({
      status: 'pending',
      completed: 0,
      remaining: 1,
      rows: [{ orderId: id, status: 'pending', receipt: null }]
    })
    await expect(
      createD1AdminOrderBulk(
        fixture.database,
        CLAIMS,
        { ...body, reason: 'Changed verified reason' },
        { idempotencyKey: key }
      )
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })
  it('requires revalidation if source changes after preview and creates no group', async () => {
    const body = await reviewed()
    await executeD1AdminFulfillmentCommand(
      fixture.database,
      CLAIMS,
      id,
      { action: 'picking', expectedVersion: 0, reason: REASON },
      { idempotencyKey: 'changed-after-review' }
    )
    await expect(
      createD1AdminOrderBulk(fixture.database, CLAIMS, body, { idempotencyKey: testUuid() })
    ).rejects.toMatchObject({ code: 'revalidation_required' })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM admin_order_bulk_groups').get()?.n).toBe(0)
  })
  it('processes one effective bounded order per step and duplicate delivery does not duplicate transitions or stock effects', async () => {
    const ids = [id]
    for (let i = 0; i < 5; i++) ids.push(await fixture.order())
    const before = economic(),
      { receipt } = await create(ids)
    const first = await processD1AdminOrderBulkStep(fixture.database, receipt.groupId, receipt.dispatchId)
    expect(first).toMatchObject({ processed: 1, remaining: 5, requeue: true })
    for (let i = 0; i < 5; i++) await processD1AdminOrderBulkStep(fixture.database, receipt.groupId, receipt.dispatchId)
    await processD1AdminOrderBulkStep(fixture.database, receipt.groupId, receipt.dispatchId)
    const group = await readD1AdminOrderBulk(fixture.database, CLAIMS, receipt.groupId)
    expect(group).toMatchObject({ status: 'completed', completed: 6, remaining: 0 })
    expect(group.rows.every((row) => row.status === 'applied' && row.receipt?.version === 1)).toBe(true)
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM order_fulfillment_commands').get()?.n).toBe(6)
    expect(economic()).toEqual(before)
  })
  it('records blocked selected orders without attempts and gives honest partial outcomes for a stale eligible order', async () => {
    const unpaid = await fixture.order('pickup', false),
      second = await fixture.order()
    const { receipt } = await create([id, unpaid, second])
    await executeD1AdminFulfillmentCommand(
      fixture.database,
      CLAIMS,
      second,
      { action: 'picking', expectedVersion: 0, reason: REASON },
      { idempotencyKey: 'independent-command' }
    )
    await processD1AdminOrderBulkStep(fixture.database, receipt.groupId, receipt.dispatchId)
    await processD1AdminOrderBulkStep(fixture.database, receipt.groupId, receipt.dispatchId)
    const group = await readD1AdminOrderBulk(fixture.database, CLAIMS, receipt.groupId)
    expect(group.rows.map((row) => [row.orderId, row.status, row.reason])).toEqual([
      [id, 'applied', null],
      [unpaid, 'not_attempted', 'payment_unconfirmed'],
      [second, 'rejected', 'version_conflict']
    ])
  })
  it('recovers a child committed before transport failure without applying it twice', async () => {
    const { receipt } = await create(),
      before = economic()
    let lost = false
    const database = new Proxy(fixture.database, {
      get(target, key, receiver) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements)
            if (
              !lost &&
              fixture.sqlite.prepare('SELECT count(*) AS n FROM order_fulfillment_commands').get()?.n === 1
            ) {
              lost = true
              throw new Error('synthetic_response_lost')
            }
            return result
          }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    try {
      await processD1AdminOrderBulkStep(database, receipt.groupId, receipt.dispatchId)
    } catch {
      /* Explicit recovery below proves the committed source. */
    }
    await processD1AdminOrderBulkStep(fixture.database, receipt.groupId, receipt.dispatchId)
    expect(lost).toBe(true)
    expect((await readD1AdminOrderBulk(fixture.database, CLAIMS, receipt.groupId)).rows[0]?.status).toBe('applied')
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM order_fulfillment_commands').get()?.n).toBe(1)
    expect(economic()).toEqual(before)
  })
  it('pauses processing after revocation and leaves remaining orders not attempted', async () => {
    const { receipt } = await create()
    fixture.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), SESSION)
    expect(await processD1AdminOrderBulkStep(fixture.database, receipt.groupId, receipt.dispatchId)).toMatchObject({
      status: 'paused',
      requeue: false,
      processed: 0
    })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM order_fulfillment_commands').get()?.n).toBe(0)
    await expect(readD1AdminOrderBulk(fixture.database, CLAIMS, receipt.groupId)).rejects.toMatchObject({
      code: 'unauthenticated'
    })
  })
  it('requires live authority before replay or recovery and does not treat outages as unknown', async () => {
    const { receipt, body, key } = await create()
    fixture.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(ACTOR)
    await expect(createD1AdminOrderBulk(fixture.database, CLAIMS, body, { idempotencyKey: key })).rejects.toMatchObject(
      { code: 'forbidden' }
    )
    await expect(
      readD1AdminOrderBulkCommand(fixture.database, CLAIMS, key, await adminOrderBulkIntentHash(body))
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(receipt.groupId).toBeTruthy()
  })
  it('rolls back group creation entirely if its guarded batch fails', async () => {
    const body = await reviewed()
    fixture.sqlite.exec(
      "CREATE TRIGGER synthetic_group_failure BEFORE INSERT ON admin_order_bulk_groups BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END"
    )
    await expect(
      createD1AdminOrderBulk(fixture.database, CLAIMS, body, { idempotencyKey: testUuid() })
    ).rejects.toBeTruthy()
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM admin_order_bulk_groups').get()?.n).toBe(0)
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM order_fulfillment_commands').get()?.n).toBe(0)
  })
  it('rejects a foreign dispatch ID and a mismatched recovery hash without executing any order', async () => {
    const { receipt, key } = await create()
    await expect(processD1AdminOrderBulkStep(fixture.database, receipt.groupId, testUuid())).rejects.toMatchObject({
      code: 'not_found'
    })
    await expect(readD1AdminOrderBulkCommand(fixture.database, CLAIMS, key, 'f'.repeat(64))).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM order_fulfillment_commands').get()?.n).toBe(0)
  })
  it('bounds actual prepared queries for 25-order preview/create and one canonical child, reserving ten queries for ingress/runtime', async () => {
    const ids = [id]
    for (let index = 1; index < 25; index++) ids.push(await fixture.order())
    let queries = 0
    // Counting prepares is a conservative upper bound: even unused prepared
    // statements count, and every statement in batch is prepared individually.
    const database = new Proxy(fixture.database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return (sql: string) => {
            queries++
            return target.prepare(sql)
          }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const preview = await previewD1AdminOrderBulk(database, CLAIMS, input(ids))
    const previewQueries = queries
    queries = 0
    const body = {
      action: preview.action,
      reason: REASON,
      orders: preview.rows.map((row) => ({ orderId: row.orderId, expectedVersion: row.expectedVersion })),
      previewHash: preview.previewHash
    }
    const receipt = await createD1AdminOrderBulk(database, CLAIMS, body, { idempotencyKey: testUuid() })
    const createQueries = queries
    queries = 0
    const step = await processD1AdminOrderBulkStep(database, receipt.groupId, receipt.dispatchId, { limit: 5 })
    console.info('bulk prepared-query upper bounds', { preview: previewQueries, create: createQueries, step: queries })
    expect(preview.rows).toHaveLength(25)
    expect(step).toMatchObject({ processed: 1, remaining: 24, requeue: true })
    expect(previewQueries).toBeLessThanOrEqual(40)
    expect(createQueries).toBeLessThanOrEqual(40)
    expect(queries).toBeLessThanOrEqual(40)
  })
  it('pauses without attempting an order when real MFA enrollment is removed, and denies subsequent reads and previews', async () => {
    const { receipt } = await create(),
      before = economic()
    fixture.sqlite.prepare('DELETE FROM identity_mfa WHERE identity_id=?').run(ACTOR)
    expect(await processD1AdminOrderBulkStep(fixture.database, receipt.groupId, receipt.dispatchId)).toMatchObject({
      status: 'paused',
      processed: 0,
      requeue: false
    })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM admin_order_bulk_attempts').get()?.n).toBe(0)
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM order_fulfillment_commands').get()?.n).toBe(0)
    await expect(previewD1AdminOrderBulk(fixture.database, CLAIMS, input())).rejects.toMatchObject({
      code: 'mfa_required'
    })
    await expect(readD1AdminOrderBulk(fixture.database, CLAIMS, receipt.groupId)).rejects.toMatchObject({
      code: 'mfa_required'
    })
    expect(economic()).toEqual(before)
  })
  it('does not commit a child when real MFA enrollment disappears immediately before its atomic batch', async () => {
    const { receipt } = await create(),
      before = economic()
    let revoked = false
    const database = new Proxy(fixture.database, {
      get(target, key, receiver) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (
              !revoked &&
              fixture.sqlite.prepare('SELECT count(*) AS n FROM admin_order_bulk_attempts').get()?.n === 1
            ) {
              revoked = true
              fixture.sqlite.prepare('DELETE FROM identity_mfa WHERE identity_id=?').run(ACTOR)
            }
            return target.batch(statements)
          }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    expect(await processD1AdminOrderBulkStep(database, receipt.groupId, receipt.dispatchId)).toMatchObject({
      status: 'paused',
      processed: 0,
      requeue: false
    })
    expect(revoked).toBe(true)
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM order_fulfillment_commands').get()?.n).toBe(0)
    expect(
      fixture.sqlite.prepare('SELECT status FROM admin_order_bulk_results WHERE group_id=?').get(receipt.groupId)
    ).toBeUndefined()
    expect(economic()).toEqual(before)
  })
  it.each(['attempts', 'results', 'pauses'] as const)(
    'rejects replacement of immutable bulk %s with recursive triggers disabled',
    async (table) => {
      const { receipt } = await create()
      if (table === 'pauses')
        fixture.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), SESSION)
      await processD1AdminOrderBulkStep(fixture.database, receipt.groupId, receipt.dispatchId)
      fixture.sqlite.exec('PRAGMA recursive_triggers=OFF')
      const name = `admin_order_bulk_${table}`,
        before = fixture.sqlite.prepare(`SELECT * FROM ${name}`).all()
      expect(before.length).toBeGreaterThan(0)
      expect(() => fixture.sqlite.exec(`INSERT OR REPLACE INTO ${name} SELECT * FROM ${name}`)).toThrow()
      expect(fixture.sqlite.prepare(`SELECT * FROM ${name}`).all()).toEqual(before)
    }
  )
  it('rejects replacing a group using another id but the same unique dispatch capability', async () => {
    const { receipt } = await create(),
      replacement = testUuid(),
      key = testUuid()
    fixture.sqlite.exec('PRAGMA recursive_triggers=OFF')
    const before = fixture.sqlite.prepare('SELECT * FROM admin_order_bulk_groups').all()
    expect(() =>
      fixture.sqlite
        .prepare(
          `INSERT OR REPLACE INTO admin_order_bulk_groups SELECT ?,dispatch_id,?,actor_id,session_id,session_version,payload_hash,input_json,preview_json,sources_json,children_json,json_set(receipt_json,'$.groupId',?,'$.commandId',?),claim_nonce,created_at FROM admin_order_bulk_groups WHERE id=?`
        )
        .run(replacement, key, replacement, key, receipt.groupId)
    ).toThrow()
    expect(fixture.sqlite.prepare('SELECT * FROM admin_order_bulk_groups').all()).toEqual(before)
  })
})
