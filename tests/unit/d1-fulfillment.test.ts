import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { executeD1AdminFulfillmentCommand, readD1AdminFulfillment } from '../../workers/fulfillment/admin'
import { fulfillmentTransitionInputSchema } from '../../shared/order-fulfillment'
import { ACTOR, CLAIMS, REASON, fulfillmentFixture, utc } from './d1-fulfillment-fixture'
import { expireExpiredReservations } from '../../workers/catalog/inventory'
import { testNow } from '../support/deterministic'

vi.mock('../support/d1-sqlite', async (importOriginal) => {
  const original = await importOriginal<typeof import('../support/d1-sqlite')>()
  return {
    ...original,
    d1OverSqlite: (sqlite: Parameters<typeof original.d1OverSqlite>[0]) => {
      sqlite.function('synthetic_fulfillment_clock', () => {
        const clock = vi.getMockedSystemTime()
        if (!clock) throw new Error('missing_synthetic_fulfillment_clock')
        return clock.toISOString().replace(/\.\d{3}Z$/, 'Z')
      })
      const database = original.d1OverSqlite(sqlite),
        nativePrepare = database.prepare.bind(database)
      database.prepare = (sql: string) => nativePrepare(sql.replaceAll("'now'", 'synthetic_fulfillment_clock()'))
      return database
    }
  }
})

describe('private single-warehouse post-payment fulfillment', () => {
  let sqlite: DatabaseSync,
    database: D1Database,
    order: (method?: string, paid?: boolean) => Promise<string>,
    id: string
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(testNow() + 1000)
    ;({ sqlite, database, order } = await fulfillmentFixture())
    id = await order()
  })
  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  const command = (action = 'picking', version = 0, key = 'picking', db?: D1Database, extra = {}) =>
    executeD1AdminFulfillmentCommand(
      db ?? database,
      CLAIMS,
      id,
      { action, expectedVersion: version, reason: REASON, ...extra },
      { idempotencyKey: key }
    )
  const read = (db?: D1Database) => readD1AdminFulfillment(db ?? database, CLAIMS, id, { page: 1, perPage: 50 })
  const count = () =>
    ['order_fulfillments', 'order_fulfillment_commands', 'order_fulfillment_audit', 'order_fulfillment_guards'].map(
      (table) => sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n
    )
  const stock = () => ({
    balances: sqlite.prepare('SELECT * FROM inventory_balances ORDER BY variant_id').all(),
    reservations: sqlite.prepare('SELECT * FROM inventory_reservations').all(),
    movements: sqlite.prepare('SELECT * FROM inventory_movements ORDER BY id').all()
  })
  function beforeBatch(change: () => void): D1Database {
    return new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            change()
            return target.batch(statements)
          }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }
  it('reads pending virtually without materializing historical fulfillment or exposing contact/payment secrets', async () => {
    const data = await read()
    expect(data).toMatchObject({
      orderId: id,
      state: 'pending',
      version: 0,
      readiness: { ready: true, blockers: [] },
      inventoryPolicy: 'allocated_on_payment_no_fulfillment_decrement'
    })
    expect(data.capabilities.allowedActions).toEqual(['picking', 'exception'])
    expect(JSON.stringify(data)).not.toMatch(/buyer@example|Original buyer|token_hash|request_hash|provider_reference/)
    expect(count()).toEqual([0, 0, 0, 0])
  })
  it('prepares and hands over pickup exactly once without any inventory or contractual mutation', async () => {
    const inventory = stock(),
      contract = sqlite.prepare('SELECT * FROM orders WHERE id=?').get(id),
      lines = sqlite.prepare('SELECT * FROM order_lines WHERE order_id=?').all(id)
    await command()
    await command('packed', 1, 'packed')
    await command('ready_for_pickup', 2, 'ready')
    await command('delivered', 3, 'delivered', undefined, { evidence: 'Verified pickup handover record 043' })
    expect((await read()).state).toBe('delivered')
    expect((await read()).capabilities.allowedActions).toEqual([])
    expect(stock()).toEqual(inventory)
    expect(sqlite.prepare('SELECT * FROM orders WHERE id=?').get(id)).toEqual(contract)
    expect(sqlite.prepare('SELECT * FROM order_lines WHERE order_id=?').all(id)).toEqual(lines)
    expect(count()).toEqual([1, 4, 4, 0])
  })
  it('records exception context and only resumes the interrupted stage, not arbitrary jumps', async () => {
    await command()
    await command('exception', 1, 'exception', undefined, { evidence: 'Missing packaging detected during picking' })
    expect(await read()).toMatchObject({ state: 'exception', interruptedState: 'picking', version: 2 })
    await expect(
      command('in_transit', 2, 'skip', undefined, { evidence: 'Synthetic verified dispatch evidence' })
    ).rejects.toMatchObject({ code: 'invalid_transition' })
    await command('picking', 2, 'resume')
    expect(await read()).toMatchObject({ state: 'picking', interruptedState: null, version: 3 })
    expect((await read()).timeline.items).toHaveLength(3)
  })
  it('delivery uses packed→in_transit→delivered, requires manual evidence and invents no tracking', async () => {
    id = await order('own_delivery')
    await command()
    await command('packed', 1, 'packed')
    await expect(command('ready_for_pickup', 2, 'wrong')).rejects.toMatchObject({ code: 'shipping_mode_mismatch' })
    await expect(command('in_transit', 2, 'missing')).rejects.toMatchObject({ code: 'invalid_input' })
    await command('in_transit', 2, 'dispatch', undefined, { evidence: 'Verified own delivery dispatch 043' })
    await command('delivered', 3, 'delivered', undefined, { evidence: 'Verified delivery handover record 043' })
    expect(JSON.stringify(await read())).not.toMatch(/tracking|carrier/)
  })
  it.each(['packed', 'ready_for_pickup', 'in_transit', 'delivered'])(
    'rejects invalid initial jump %s',
    async (action) => {
      await expect(
        command(action, 0, 'jump', undefined, { evidence: 'Verified synthetic operation evidence' })
      ).rejects.toMatchObject({ code: 'invalid_transition' })
      expect(count()).toEqual([0, 0, 0, 0])
    }
  )
  it('requires captured payment, matching claim and completed assignment, never pending authorization', async () => {
    id = await order('pickup', false)
    expect((await read()).readiness.ready).toBe(false)
    await expect(command()).rejects.toMatchObject({ code: 'payment_unconfirmed' })
    expect(count()).toEqual([0, 0, 0, 0])
  })
  it.each(['claim', 'payment', 'assignment', 'allocate', 'recovery'])('blocks broken live proof %s', async (fact) => {
    if (fact === 'claim')
      sqlite.exec(
        'CREATE TRIGGER ignore_claim BEFORE DELETE ON payment_fulfilment_claims BEGIN SELECT RAISE(IGNORE); END'
      )
    if (fact === 'claim')
      sqlite.exec(
        'DROP TRIGGER payment_fulfilment_claims_no_delete; DROP TRIGGER ignore_claim; DELETE FROM payment_fulfilment_claims'
      )
    if (fact === 'payment') sqlite.exec('UPDATE order_payment_states SET paid_gross_cents=0')
    if (fact === 'assignment')
      sqlite.exec("UPDATE inventory_reservations SET status='released',assigned_at=NULL,released_at=updated_at")
    if (fact === 'allocate') sqlite.exec("DELETE FROM inventory_movements WHERE movement_type='allocate'")
    if (fact === 'recovery') sqlite.exec("UPDATE payment_recovery_jobs SET status='pending'")
    await expect(command()).rejects.toMatchObject({
      code: fact === 'assignment' || fact === 'allocate' ? 'inventory_unconfirmed' : 'payment_unconfirmed'
    })
    expect(count()).toEqual([0, 0, 0, 0])
  })
  it('replays the immutable original receipt after later transitions and rejects changed intent with same key', async () => {
    const first = await command()
    await command('packed', 1, 'packed')
    expect(await command()).toEqual(first)
    await expect(command('packed', 1, 'picking')).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(count()).toEqual([1, 2, 2, 0])
  })
  it('uses CAS, admits one concurrent winner and converges identical concurrent requests', async () => {
    const same = await Promise.all([command(), command()])
    expect(same[0]).toEqual(same[1])
    const race = await Promise.allSettled([
      command('packed', 1, 'a'),
      command('exception', 1, 'b', undefined, { evidence: 'Synthetic operation exception evidence' })
    ])
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    await expect(command('packed', 0, 'stale')).rejects.toMatchObject({ code: 'version_conflict' })
    expect(count()).toEqual([1, 2, 2, 0])
  })
  it('guards live payment changes immediately before the atomic batch', async () => {
    await expect(
      command(
        'picking',
        0,
        'picking',
        beforeBatch(() => sqlite.exec("UPDATE order_payment_states SET status='stock_exception'"))
      )
    ).rejects.toMatchObject({ code: 'payment_unconfirmed' })
    expect(count()).toEqual([0, 0, 0, 0])
  })
  it('requires live verified email, MFA and grant even for replay', async () => {
    await command()
    sqlite.exec(`DELETE FROM identity_roles WHERE identity_id='${ACTOR}'`)
    await expect(command()).rejects.toMatchObject({ code: 'forbidden' })
    await expect(read()).rejects.toMatchObject({ code: 'forbidden' })
  })
  it('rejects revocation before batch and rolls back revocation triggered after claim', async () => {
    await expect(
      command(
        'picking',
        0,
        'picking',
        beforeBatch(() => sqlite.exec(`DELETE FROM identity_roles WHERE identity_id='${ACTOR}'`))
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(count()).toEqual([0, 0, 0, 0])
    sqlite
      .prepare(
        "INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'operator','2020-01-01T00:00:00Z')"
      )
      .run(ACTOR)
    sqlite.exec(
      `CREATE TRIGGER revoke_inside AFTER INSERT ON order_fulfillment_commands BEGIN DELETE FROM identity_roles WHERE identity_id='${ACTOR}'; END`
    )
    await expect(command()).rejects.toMatchObject({ code: 'conflict' })
    expect(count()).toEqual([0, 0, 0, 0])
  })
  it('does not return private data when a grant disappears while reading', async () => {
    let changed = false
    const db = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql)
            if (!sql.includes('FROM orders o')) return statement
            const wrapped = {
              ...statement,
              bind(...params: unknown[]) {
                statement.bind(...params)
                return wrapped
              },
              async all() {
                const result = await statement.all()
                if (!changed) {
                  changed = true
                  sqlite.exec(`DELETE FROM identity_roles WHERE identity_id='${ACTOR}'`)
                }
                return result
              }
            }
            return wrapped
          }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await expect(read(db)).rejects.toMatchObject({ code: 'forbidden' })
  })
  it('rolls back all effects if the audit fails late and never treats unconfirmed D1 result as success', async () => {
    sqlite.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON order_fulfillment_audit BEGIN SELECT RAISE(ABORT,'synthetic_late_failure'); END"
    )
    await expect(command()).rejects.toThrow('synthetic_late_failure')
    expect(count()).toEqual([0, 0, 0, 0])
    sqlite.exec('DROP TRIGGER fail_audit')
    const db = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            await target.batch(statements)
            return []
          }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await expect(command('picking', 0, 'picking', db)).rejects.toThrow()
    expect(await command()).toMatchObject({ state: 'picking', version: 1 })
  })
  it('physically rejects mutation, deletion or replacement of the command, audit and projection history', async () => {
    await command()
    for (const table of ['order_fulfillment_commands', 'order_fulfillment_audit']) {
      expect(() => sqlite.exec(`UPDATE ${table} SET reason='Synthetic changed reason'`)).toThrow()
      expect(() => sqlite.exec(`DELETE FROM ${table}`)).toThrow()
      const cols = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .map((r) => r.name)
        .join(',')
      expect(() => sqlite.exec(`INSERT OR REPLACE INTO ${table}(${cols}) SELECT ${cols} FROM ${table}`)).toThrow()
    }
    expect(() => sqlite.exec('DELETE FROM order_fulfillments')).toThrow()
    expect(() => sqlite.exec("UPDATE order_fulfillments SET status='delivered'")).toThrow()
  })
  it('rejects accessors, inherited data, controls, injected authority and noncanonical order ids without side effects', async () => {
    let invoked = 0
    const input = { action: 'picking', expectedVersion: 0, reason: REASON }
    Object.defineProperty(input, 'reason', {
      get() {
        invoked++
        return REASON
      },
      enumerable: true
    })
    expect(fulfillmentTransitionInputSchema.safeParse(input).success).toBe(false)
    await expect(
      executeD1AdminFulfillmentCommand(database, CLAIMS, id, input, { idempotencyKey: 'bad' })
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(invoked).toBe(0)
    await expect(command('picking', 0, 'bad', undefined, { reason: '\n' + REASON })).rejects.toMatchObject({
      code: 'invalid_input'
    })
    await expect(command('picking', 0, 'bad', undefined, { actorId: ACTOR })).rejects.toMatchObject({
      code: 'invalid_input'
    })
    await expect(
      executeD1AdminFulfillmentCommand(database, CLAIMS, ' ' + id, input, { idempotencyKey: 'bad' })
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(count()).toEqual([0, 0, 0, 0])
  })
  it('uses only the historical order contract even if catalog and customer/contact profiles change later', async () => {
    const lines = sqlite.prepare('SELECT * FROM order_lines WHERE order_id=?').all(id)
    sqlite.exec(
      "UPDATE products SET name='Changed current catalog'; UPDATE variants SET format='Changed current format',sku='CHANGED-'||id"
    )
    await command()
    expect(sqlite.prepare('SELECT * FROM order_lines WHERE order_id=?').all(id)).toEqual(lines)
    expect((await read()).state).toBe('picking')
  })
  it('captured/assigned stock cannot be freed by TTL or fulfillment transitions', async () => {
    const before = stock()
    await expireExpiredReservations(database, { at: utc(86400000), correlationId: 'synthetic-ttl' })
    expect(stock()).toEqual(before)
    await command()
    await command('packed', 1, 'packed')
    expect(stock()).toEqual(before)
  })
  it('blocks cancellation immediately before preparation without releasing allocated inventory', async () => {
    const before = stock()
    await expect(
      command(
        'picking',
        0,
        'picking',
        beforeBatch(() => sqlite.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(id))
      )
    ).rejects.toMatchObject({ code: 'order_cancelled' })
    expect(stock()).toEqual(before)
    expect(count()).toEqual([0, 0, 0, 0])
  })
  it('requires a single real warehouse and refuses a second persisted scope', async () => {
    sqlite
      .prepare(
        "INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES('second','SECOND','Second warehouse','warehouse',1,?)"
      )
      .run(utc())
    await expect(command()).rejects.toMatchObject({ code: 'warehouse_unavailable' })
    expect((await read()).readiness.blockers).toContain('warehouse_unavailable')
    expect(count()).toEqual([0, 0, 0, 0])
  })
  it('blocks preparation when the physical allocation ledger and touched balances do not reconcile', async () => {
    sqlite.exec("UPDATE inventory_balances SET physical_quantity=physical_quantity+1 WHERE variant_id='v-1-1'")
    await expect(command()).rejects.toMatchObject({ code: 'inventory_unconfirmed' })
    expect(count()).toEqual([0, 0, 0, 0])
  })
  it('keeps keys actor-scoped and never borrows another operators replay or audit ownership', async () => {
    const first = await command(),
      other = '10000000-0000-4000-8000-000000000044',
      session = '20000000-0000-4000-8000-000000000044',
      now = utc(-60000)
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES(?,'other@example.invalid','synthetic',?,'active',?,?)"
      )
      .run(other, now, now, now)
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,?)'
      )
      .run(session, other, now, utc(3600000))
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'operator',?)")
      .run(other, now)
    const claims = { identityId: other, sessionId: session, sessionVersion: 1 }
    await expect(
      executeD1AdminFulfillmentCommand(
        database,
        claims,
        id,
        { action: 'picking', expectedVersion: 0, reason: REASON },
        { idempotencyKey: 'picking' }
      )
    ).rejects.toMatchObject({ code: 'version_conflict' })
    const second = await executeD1AdminFulfillmentCommand(
      database,
      claims,
      id,
      { action: 'packed', expectedVersion: 1, reason: REASON },
      { idempotencyKey: 'picking' }
    )
    expect(second.commandId).not.toBe(first.commandId)
    expect((await read()).timeline.items[0]?.actorId).toBe(other)
  })
  it('denies receipt release if authority disappears after committed command but before the return read', async () => {
    let changed = false
    const db = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql)
            if (!sql.includes('JOIN order_fulfillment_commands c')) return statement
            const wrapped = {
              ...statement,
              bind(...params: unknown[]) {
                statement.bind(...params)
                return wrapped
              },
              async all() {
                const result = await statement.all()
                if (!changed && sqlite.prepare('SELECT count(*) AS n FROM order_fulfillment_commands').get()?.n === 1) {
                  changed = true
                  sqlite.exec(`DELETE FROM identity_roles WHERE identity_id='${ACTOR}'`)
                }
                return result
              }
            }
            return wrapped
          }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await expect(command('picking', 0, 'picking', db)).rejects.toMatchObject({ code: 'forbidden' })
    expect(count()).toEqual([1, 1, 1, 0])
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'operator',?)")
      .run(ACTOR, utc(-60000))
    expect(await command()).toMatchObject({ state: 'picking', version: 1 })
    expect(count()).toEqual([1, 1, 1, 0])
  })
  it('never reports invented empty history or permits replay when immutable audit proof is missing', async () => {
    await command()
    sqlite.exec('DROP TRIGGER order_fulfillment_audit_no_delete; DELETE FROM order_fulfillment_audit')
    const data = await read()
    expect(data.readiness.blockers).toContain('history_unconfirmed')
    expect(data.capabilities.allowedActions).toEqual([])
    await expect(command()).rejects.toMatchObject({ code: 'history_unconfirmed' })
    await expect(command('packed', 1, 'packed')).rejects.toMatchObject({ code: 'history_unconfirmed' })
  })
})
