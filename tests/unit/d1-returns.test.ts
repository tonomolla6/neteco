import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  requestD1CustomerReturn,
  executeD1AdminReturnCommand,
  readD1AdminReturn,
  readD1CustomerReturns
} from '../../workers/returns/operations'
import {
  returnsFixture,
  CLAIMS,
  BUYER_CLAIMS,
  REQUEST,
  ADMISSION,
  REASON,
  BUYER,
  CUSTOMER,
  utc
} from './d1-returns-fixture'

describe('D1 single-warehouse custody returns', () => {
  let sqlite: DatabaseSync, database: D1Database, id: string
  beforeEach(async () => {
    const fixture = await returnsFixture()
    sqlite = fixture.sqlite
    database = fixture.database
    id = await fixture.order()
  })
  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
  })
  const key = () => crypto.randomUUID()
  function create(input: unknown = REQUEST, idempotencyKey = key()) {
    return requestD1CustomerReturn(database, BUYER_CLAIMS, id, input, { idempotencyKey })
  }
  function command(ref: string, input: unknown, idempotencyKey = key()) {
    return executeD1AdminReturnCommand(database, CLAIMS, ref, input, { idempotencyKey })
  }
  it('requests with review_required, historical line snapshot and quantity claim only', async () => {
    const receipt = await create()
    expect(receipt.state).toBe('requested')
    expect(receipt.inventoryEffect).toBe('none')
    const view = await readD1CustomerReturns(database, BUYER_CLAIMS, id, { page: 1, perPage: 25 })
    expect(view.eligibility.status).toBe('review_required')
    expect(view.lines[0]).toMatchObject({ availableQuantity: 0, claimedQuantity: 2, sku: 'SKU-1-1' })
    expect(view.returns[0]?.state).toBe('requested')
    expect(view.capabilities.returnRequest).toBe(false)
  })
  it('runs partial reception/inspection to resolution_ready without economic or stock effects', async () => {
    const before = digest(),
      requested = await create()
    await command(requested.publicRef, ADMISSION)
    await command(requested.publicRef, {
      action: 'received',
      expectedVersion: 2,
      reason: REASON,
      publicMessage: REASON,
      evidence: REASON,
      lines: [{ lineIndex: 0, quantity: 1 }]
    })
    expect(
      (await readD1AdminReturn(database, CLAIMS, requested.publicRef, { page: 1, perPage: 25 })).capabilities
        .allowedActions
    ).toEqual(['received'])
    await command(requested.publicRef, {
      action: 'received',
      expectedVersion: 3,
      reason: REASON,
      publicMessage: REASON,
      evidence: REASON,
      lines: [{ lineIndex: 0, quantity: 1 }]
    })
    await command(requested.publicRef, {
      action: 'inspected',
      expectedVersion: 4,
      reason: REASON,
      publicMessage: REASON,
      evidence: REASON,
      lines: [{ lineIndex: 0, quantity: 1, condition: 'opened', disposition: 'non_restockable' }]
    })
    await command(requested.publicRef, {
      action: 'inspected',
      expectedVersion: 5,
      reason: REASON,
      publicMessage: REASON,
      evidence: REASON,
      lines: [{ lineIndex: 0, quantity: 1, condition: 'sealed', disposition: 'review_restock' }]
    })
    const done = await command(requested.publicRef, {
      action: 'resolution_ready',
      expectedVersion: 6,
      reason: REASON,
      publicMessage: REASON,
      evidence: REASON,
      resolution: 'Inspection complete; financial and stock decisions remain pending.',
      cost: {
        amountCents: 0,
        currency: 'EUR',
        category: 'handling',
        evidenceRef: 'manual-no-charge',
        description: REASON
      }
    })
    expect(done.state).toBe('resolution_ready')
    expect(digest()).toBe(before)
    const view = await readD1AdminReturn(database, CLAIMS, requested.publicRef, { page: 1, perPage: 25 })
    expect(view.capabilities.allowedActions).toEqual([])
    expect(view.lines[0]).toMatchObject({ receivedQuantity: 2, inspectedQuantity: 2, claimedQuantity: 2 })
    expect(view.timeline.items[0]?.cost?.amountCents).toBe(0)
  })
  it('replays the exact historical receipt after admission and rejects key payload conflict', async () => {
    const idempotencyKey = key(),
      receipt = await create(REQUEST, idempotencyKey)
    await command(receipt.publicRef, ADMISSION)
    expect(await create(REQUEST, idempotencyKey)).toEqual(receipt)
    await expect(
      create({ ...REQUEST, reason: 'Different documented reason for same key' }, idempotencyKey)
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM order_returns').get()?.n).toBe(1)
  })
  it('releases a rejected unreceived claim and does not preserve fabricated eligibility', async () => {
    const receipt = await create()
    await command(receipt.publicRef, {
      action: 'rejected',
      expectedVersion: 1,
      reason: REASON,
      publicMessage: REASON,
      evidence: REASON
    })
    const view = await readD1CustomerReturns(database, BUYER_CLAIMS, id, { page: 1, perPage: 25 })
    expect(view.lines[0]?.availableQuantity).toBe(2)
    await create({ ...REQUEST, expectedVersion: 2 })
  })
  it('reduces admitted quantities with an explicit decision, conserves received quantities forever', async () => {
    const receipt = await create()
    await command(receipt.publicRef, { ...ADMISSION, lines: [{ lineIndex: 0, quantity: 1 }] })
    await create({ ...REQUEST, expectedVersion: 2, lines: [{ lineIndex: 0, quantity: 1 }] })
    await command(receipt.publicRef, {
      action: 'received',
      expectedVersion: 2,
      reason: REASON,
      publicMessage: REASON,
      evidence: REASON,
      lines: [{ lineIndex: 0, quantity: 1 }]
    })
    await expect(
      command(receipt.publicRef, {
        action: 'rejected',
        expectedVersion: 3,
        reason: REASON,
        publicMessage: REASON,
        evidence: REASON
      })
    ).rejects.toMatchObject({ code: 'invalid_transition' })
    expect(
      (await readD1CustomerReturns(database, BUYER_CLAIMS, id, { page: 1, perPage: 25 })).lines[0]?.availableQuantity
    ).toBe(0)
  })
  it('detects stale budget and stale RMA versions without effects', async () => {
    const receipt = await create()
    await expect(create()).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(command(receipt.publicRef, { ...ADMISSION, expectedVersion: 2 })).rejects.toMatchObject({
      code: 'version_conflict'
    })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM order_return_commands').get()?.n).toBe(1)
  })
  it('rejects oversized quantities and unknown historical indices atomically', async () => {
    await expect(create({ ...REQUEST, lines: [{ lineIndex: 0, quantity: 3 }] })).rejects.toMatchObject({
      code: 'quantity_unavailable'
    })
    await expect(
      create({
        ...REQUEST,
        lines: [
          { lineIndex: 0, quantity: 1 },
          { lineIndex: 1, quantity: 1 }
        ]
      })
    ).rejects.toMatchObject({ code: 'line_not_found' })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM order_return_commands').get()?.n).toBe(0)
  })
  it('serializes concurrent requests against one immutable quantity budget', async () => {
    const outcomes = await Promise.allSettled([create(), create()])
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(sqlite.prepare('SELECT SUM(claimed_quantity) AS n FROM order_return_lines').get()?.n).toBe(2)
  })
  it('preserves line snapshots when current catalog changes', async () => {
    const receipt = await create()
    sqlite.exec(
      "UPDATE products SET name='Current unrelated title' WHERE id='p-1'; UPDATE variants SET sku='CURRENT-SKU',status='hidden' WHERE id='v-1-1'"
    )
    const view = await readD1AdminReturn(database, CLAIMS, receipt.publicRef, { page: 1, perPage: 25 })
    expect(view.lines[0]).toMatchObject({ sku: 'SKU-1-1', name: 'Producto 1', unitGrossCents: 500 })
  })
  it('never releases private staff notes or evidence in the customer projection', async () => {
    const receipt = await create()
    await command(receipt.publicRef, {
      ...ADMISSION,
      reason: 'PRIVATE internal operational investigation',
      evidence: 'PRIVATE archive restricted evidence',
      decisionRef: 'PRIVATE-policy-document'
    })
    expect(
      JSON.stringify(await readD1CustomerReturns(database, BUYER_CLAIMS, id, { page: 1, perPage: 25 }))
    ).not.toContain('PRIVATE')
  })
  it.each(['mfa', 'grant', 'email', 'session'])(
    'refuses admin writes/replay when live %s authority is lost',
    async (lost) => {
      const receipt = await create()
      if (lost === 'mfa') sqlite.exec(`UPDATE auth_sessions SET mfa_verified=0 WHERE id='${CLAIMS.sessionId}'`)
      if (lost === 'grant') sqlite.exec(`DELETE FROM identity_roles WHERE identity_id='${CLAIMS.identityId}'`)
      if (lost === 'email') sqlite.exec(`UPDATE identities SET email_verified_at=NULL WHERE id='${CLAIMS.identityId}'`)
      if (lost === 'session')
        sqlite.exec(`UPDATE auth_sessions SET revoked_at=created_at WHERE id='${CLAIMS.sessionId}'`)
      await expect(command(receipt.publicRef, ADMISSION)).rejects.toMatchObject({
        code:
          lost === 'mfa'
            ? 'mfa_required'
            : lost === 'grant'
              ? 'forbidden'
              : lost === 'email'
                ? 'email_unverified'
                : 'unauthenticated'
      })
    }
  )
  it('does not grant customer ownership by matching email or guest contact', async () => {
    const fixture = await returnsFixture()
    try {
      const guest = await fixture.order({ owned: false })
      await expect(
        requestD1CustomerReturn(fixture.database, BUYER_CLAIMS, guest, REQUEST, { idempotencyKey: key() })
      ).rejects.toMatchObject({ code: 'not_found' })
    } finally {
      fixture.sqlite.close()
    }
  })
  it('rejects inactive current owner rather than returning an empty RMA history', async () => {
    sqlite.exec(
      `UPDATE customers SET status='blocked' WHERE id='${CUSTOMER}'; UPDATE identities SET email='different@example.invalid' WHERE id='${BUYER}'`
    )
    await expect(readD1CustomerReturns(database, BUYER_CLAIMS, id, { page: 1, perPage: 25 })).rejects.toMatchObject({
      code: 'unauthenticated'
    })
  })
  it('authenticates the current owner again after the source await and before disclosing facts', async () => {
    let changed = false
    const db = afterQuery('SELECT * FROM facts', () => {
      if (!changed) {
        changed = true
        sqlite.exec(`UPDATE customers SET status='blocked' WHERE id='${CUSTOMER}'`)
      }
    })
    await expect(readD1CustomerReturns(db, BUYER_CLAIMS, id, { page: 1, perPage: 25 })).rejects.toMatchObject({
      code: 'unauthenticated'
    })
  })
  it('does not emit the private receipt if authority disappears after committed admission', async () => {
    const receipt = await create(),
      idempotencyKey = key()
    let changed = false
    const db = afterQuery('SELECT c.payload_hash,c.response', () => {
      if (!changed && sqlite.prepare('SELECT count(*) AS n FROM order_return_commands').get()?.n === 2) {
        changed = true
        sqlite.exec(`DELETE FROM identity_roles WHERE identity_id='${CLAIMS.identityId}'`)
      }
    })
    await expect(
      executeD1AdminReturnCommand(db, CLAIMS, receipt.publicRef, ADMISSION, { idempotencyKey })
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(sqlite.prepare('SELECT state FROM order_returns').get()?.state).toBe('approved')
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'operator',?)")
      .run(CLAIMS.identityId, utc(-60000))
    expect(await command(receipt.publicRef, ADMISSION, idempotencyKey)).toMatchObject({ state: 'approved', version: 2 })
  })
  it('rolls back claim/projection/line/events together on late audit failure', async () => {
    sqlite.exec(
      "CREATE TRIGGER returns_fail_event BEFORE INSERT ON order_return_events BEGIN SELECT RAISE(ABORT,'synthetic_returns_late_failure'); END"
    )
    await expect(create()).rejects.toThrow('synthetic_returns_late_failure')
    for (const table of ['order_return_commands', 'order_returns', 'order_return_lines', 'order_return_events'])
      expect(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0)
  })
  it('preserves uncertainty after a committed malformed batch response and recovers the same key', async () => {
    const idempotencyKey = key(),
      db = beforeBatch(async (statements) => {
        await database.batch(statements)
        return []
      })
    await expect(requestD1CustomerReturn(db, BUYER_CLAIMS, id, REQUEST, { idempotencyKey })).rejects.toThrow()
    expect(sqlite.prepare('SELECT count(*) AS n FROM order_returns').get()?.n).toBe(1)
    expect(await create(REQUEST, idempotencyKey)).toMatchObject({ state: 'requested', version: 1 })
  })
  it('does not reuse another successful receipt/nonce to satisfy a stale command batch', async () => {
    const receipt = await create(),
      admissionKey = key()
    await command(receipt.publicRef, ADMISSION, admissionKey)
    await expect(command(receipt.publicRef, ADMISSION, key())).rejects.toMatchObject({ code: 'version_conflict' })
    expect(await command(receipt.publicRef, ADMISSION, admissionKey)).toMatchObject({ version: 2 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM order_return_events').get()?.n).toBe(2)
  })
  it('guarded CAS rejects a competing winner committed immediately before its own batch', async () => {
    let winner: unknown
    const db = beforeBatch(async (statements) => {
      winner = await create()
      return database.batch(statements)
    })
    await expect(
      requestD1CustomerReturn(db, BUYER_CLAIMS, id, REQUEST, { idempotencyKey: key() })
    ).rejects.toMatchObject({ code: 'version_conflict' })
    expect(winner).toMatchObject({ state: 'requested' })
    expect(sqlite.prepare('SELECT SUM(claimed_quantity) AS n FROM order_return_lines').get()?.n).toBe(2)
  })
  it('same-key racing winner yields its exact receipt after the losing guarded batch rolls back', async () => {
    const idempotencyKey = key()
    let winner: unknown
    const db = beforeBatch(async (statements) => {
      winner = await create(REQUEST, idempotencyKey)
      return database.batch(statements)
    })
    expect(await requestD1CustomerReturn(db, BUYER_CLAIMS, id, REQUEST, { idempotencyKey })).toEqual(winner)
    expect(sqlite.prepare('SELECT count(*) AS n FROM order_return_events').get()?.n).toBe(1)
  })
  it('rejects authority/payment cancellation immediately before its atomic batch', async () => {
    const db = beforeBatch(async (statements) => {
      sqlite.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(id)
      return database.batch(statements)
    })
    await expect(
      requestD1CustomerReturn(db, BUYER_CLAIMS, id, REQUEST, { idempotencyKey: key() })
    ).rejects.toMatchObject({ code: 'order_cancelled' })
    expect(sqlite.prepare('SELECT count(*) AS n FROM order_returns').get()?.n).toBe(0)
  })
  it('rolls back authorization revoked by a trigger after command claim', async () => {
    const receipt = await create()
    sqlite.exec(
      `CREATE TRIGGER returns_revoke_after_claim AFTER INSERT ON order_return_commands WHEN NEW.action='approved' BEGIN DELETE FROM identity_roles WHERE identity_id='${CLAIMS.identityId}'; END`
    )
    await expect(command(receipt.publicRef, ADMISSION)).rejects.toMatchObject({ code: 'conflict' })
    expect(sqlite.prepare('SELECT state FROM order_returns').get()?.state).toBe('requested')
    expect(sqlite.prepare('SELECT count(*) AS n FROM identity_roles').get()?.n).toBe(1)
  })
  it('protects immutable commands/events/line identity against UPDATE DELETE and REPLACE', async () => {
    await create()
    for (const table of ['order_return_commands', 'order_return_events', 'order_returns', 'order_return_lines']) {
      expect(() => sqlite.exec(`DELETE FROM ${table}`)).toThrow()
      const cols = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((row) => row.name)
        .join(',')
      expect(() => sqlite.exec(`INSERT OR REPLACE INTO ${table}(${cols}) SELECT ${cols} FROM ${table}`)).toThrow()
    }
    expect(() => sqlite.exec("UPDATE order_return_commands SET reason='Changed operational reason'")).toThrow()
    expect(() => sqlite.exec('UPDATE order_return_lines SET requested_quantity=1')).toThrow()
    expect(() => sqlite.exec("UPDATE order_returns SET state='resolution_ready'")).toThrow()
  })
  it.each(['unpaid', 'undelivered', 'claim', 'recovery', 'capture', 'warehouse'])(
    'requires persisted %s facts rather than UI status or promises',
    async (missing) => {
      if (missing === 'unpaid') sqlite.exec("UPDATE order_payment_states SET status='processing'")
      if (missing === 'undelivered')
        sqlite.exec("DROP TRIGGER order_fulfillments_update; UPDATE order_fulfillments SET status='packed'")
      if (missing === 'claim')
        sqlite.exec('DROP TRIGGER payment_fulfilment_claims_no_delete; DELETE FROM payment_fulfilment_claims')
      if (missing === 'recovery') sqlite.exec("UPDATE payment_recovery_jobs SET status='pending'")
      if (missing === 'capture')
        sqlite.exec("DROP TRIGGER payment_events_no_delete; DELETE FROM payment_events WHERE event_type='captured'")
      if (missing === 'warehouse') sqlite.exec('UPDATE inventory_locations SET active=0')
      await expect(create()).rejects.toMatchObject({
        code:
          missing === 'warehouse'
            ? 'warehouse_unavailable'
            : missing === 'undelivered'
              ? 'delivery_unconfirmed'
              : 'payment_unconfirmed'
      })
      expect(sqlite.prepare('SELECT count(*) AS n FROM order_returns').get()?.n).toBe(0)
    }
  )
  it('quarantines unverifiable history instead of enabling more returns', async () => {
    await create()
    sqlite.exec('DROP TRIGGER order_return_events_no_delete; DELETE FROM order_return_events')
    await expect(readD1CustomerReturns(database, BUYER_CLAIMS, id, { page: 1, perPage: 25 })).rejects.toMatchObject({
      code: 'history_unconfirmed'
    })
    await expect(create({ ...REQUEST, expectedVersion: 1 })).rejects.toMatchObject({ code: 'history_unconfirmed' })
  })
  it('refuses to turn unknown or malformed provider results into empty writable state', async () => {
    const db = afterQuery('SELECT * FROM facts', () => undefined, { success: true, results: [] })
    // A confirmed empty query is not-found. An unconfirmed envelope is an error.
    await expect(readD1CustomerReturns(db, BUYER_CLAIMS, id, { page: 1, perPage: 25 })).rejects.toMatchObject({
      code: 'not_found'
    })
    const broken = afterQuery('SELECT * FROM facts', () => undefined, { results: [] })
    await expect(readD1CustomerReturns(broken, BUYER_CLAIMS, id, { page: 1, perPage: 25 })).rejects.toThrow()
  })
  function beforeBatch(callback: (statements: D1PreparedStatement[]) => Promise<unknown>) {
    return new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'batch') return callback
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }
  function afterQuery(fragment: string, callback: () => void, resultOverride?: unknown) {
    return new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql)
            if (!sql.includes(fragment)) return statement
            const wrapped = {
              ...statement,
              bind(...params: unknown[]) {
                statement.bind(...params)
                return wrapped
              },
              async all() {
                const result = await statement.all()
                callback()
                return resultOverride ?? result
              }
            }
            return wrapped
          }
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }
  function digest() {
    return JSON.stringify(
      [
        'orders',
        'order_lines',
        'order_shipping_address',
        'order_billing_address',
        'inventory_balances',
        'inventory_reservations',
        'inventory_reservation_lines',
        'inventory_movements',
        'payment_intents',
        'order_payment_states',
        'order_fulfillments',
        'order_events',
        'fiscal_outbox_events'
      ].map((table) => sqlite.prepare(`SELECT * FROM ${table}`).all())
    )
  }
})
