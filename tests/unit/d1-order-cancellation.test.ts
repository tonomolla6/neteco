import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, BUYER_SESSION, utc } from './d1-returns-fixture'
import { deterministicTestData } from '../fixtures/deterministic'
import * as checkout from '../../workers/catalog/checkout'
import { initiateRedsysPayment } from '../../workers/catalog/payments'
import { assignReservation, releaseReservation, expireExpiredReservations } from '../../workers/catalog/inventory'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'
import {
  cancelD1UnpaidOrder,
  readD1OrderCancellation,
  readD1OrderCancellationCommand,
  validateOrderCancellationProof
} from '../../workers/catalog/order-cancellation'

const data = deterministicTestData('order-cancellation', '2026-10-08T12:00:00Z')
let f: Awaited<ReturnType<typeof returnsFixture>>, orderId: string, orderToken: string
const commandId = data.uuid()
const reason = 'Cancelación solicitada expresamente por el comprador.'
const body = { expectedStatus: 'awaiting_payment' as const, reason }
const options = { audience: 'customer' as const, now: () => utc() }
const paymentConfiguration = {
  environment: 'sandbox' as const,
  merchantCode: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
  terminal: '1',
  secretKey: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey,
  merchantName: 'NETECO',
  publicBaseUrl: 'https://cancellation.neteco.test'
}
const initiate = () =>
  initiateRedsysPayment(
    f.database,
    {
      orderId,
      orderToken,
      method: 'card',
      idempotencyKey: 'initial-payment',
      correlationId: 'payment-history',
      now: utc(),
      randomUUID: () => data.uuid()
    },
    paymentConfiguration
  )
beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(data.date())
  f = await returnsFixture()
  f.sqlite.function('cancellation_test_clock', () => utc())
  const prepare = f.database.prepare.bind(f.database)
  f.database.prepare = (sql: string) => prepare(sql.replaceAll("'now'", 'cancellation_test_clock()'))
  const place = checkout.placeOrder
  vi.spyOn(checkout, 'placeOrder').mockImplementation(async (...args) => {
    const result = await place(...args)
    if (result.outcome === 'order_created') orderToken = String(result.body.orderToken)
    return result
  })
  orderId = await f.order({ paid: false, delivered: false })
})
afterEach(() => {
  f?.sqlite.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const cancel = (overrides: Record<string, unknown> = {}) =>
  cancelD1UnpaidOrder(f.database, BUYER_CLAIMS, orderId, commandId, body, { ...options, ...overrides })
function facts() {
  return {
    orders: f.sqlite.prepare('SELECT * FROM orders').all(),
    lines: f.sqlite.prepare('SELECT * FROM order_lines').all(),
    reservations: f.sqlite.prepare('SELECT * FROM inventory_reservations').all(),
    movements: f.sqlite.prepare('SELECT * FROM inventory_movements').all(),
    commands: f.sqlite.prepare('SELECT * FROM payment_commands').all(),
    events: f.sqlite.prepare('SELECT * FROM order_events').all()
  }
}
function beforeBatch(action: () => void | Promise<void>) {
  return new Proxy(f.database, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: Parameters<D1Database['batch']>[0]) => {
          await action()
          return target.batch(statements)
        }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  }) as D1Database
}
describe('safe unpaid order cancellation', () => {
  it.each(['customer', 'admin'] as const)(
    'records the actual %s audience and issuing session without inferring historical roles',
    async (audience) => {
      const actor = audience === 'admin' ? CLAIMS : BUYER_CLAIMS
      const receipt = await cancelD1UnpaidOrder(f.database, actor, orderId, commandId, body, {
        audience,
        now: options.now,
        ...{ ipHash: 'a'.repeat(64) }
      })
      const row = f.sqlite.prepare('SELECT response_body FROM payment_commands WHERE command_id=?').get(commandId) as {
        response_body: string
      }
      const envelope = JSON.parse(row.response_body)
      expect(envelope.auditContext).toEqual({
        audience,
        sessionId: actor.sessionId,
        sessionVersion: actor.sessionVersion,
        ipHash: 'a'.repeat(64)
      })
      const audit = f.sqlite
        .prepare("SELECT payload_json FROM order_events WHERE event_type='order.cancelled'")
        .get() as { payload_json: string }
      expect(JSON.parse(audit.payload_json).auditContext).toEqual(envelope.auditContext)
      expect(
        await readD1OrderCancellationCommand(f.database, actor, orderId, commandId, { audience, now: options.now })
      ).toEqual(receipt)
    }
  )
  it('continues validating historical receipt proofs without inventing missing action context', async () => {
    const cancelled = await cancel()
    const command = f.sqlite.prepare('SELECT * FROM payment_commands WHERE command_id=?').get(commandId) as Record<
      string,
      string | number
    >
    const event = f.sqlite.prepare("SELECT * FROM order_events WHERE event_type='order.cancelled'").get() as Record<
      string,
      string
    >
    const envelope = JSON.parse(String(command.response_body)),
      audit = JSON.parse(event.payload_json!)
    // Build the pre-context wire format without altering any actual immutable
    // ledger. The unchanged business hash verifies a legitimate historical proof.
    delete envelope.auditContext
    delete audit.auditContext
    const verified = await validateOrderCancellationProof(
      {
        payloadHash: command.payload_hash,
        responseStatus: command.response_status,
        responseBody: JSON.stringify(envelope),
        correlationId: command.correlation_id,
        createdAt: command.created_at,
        audit: JSON.stringify(audit),
        auditAt: event.created_at,
        auditCorrelation: event.correlation_id
      },
      orderId,
      commandId
    )
    expect(verified.envelope.receipt).toEqual(cancelled)
    expect(verified.envelope.auditContext).toBeUndefined()
  })
  it.each([
    'redirect_ready',
    'processing',
    'failed',
    'cancelled',
    'provider_authorised',
    'captured',
    'stock_exception'
  ] as const)('never cancels after any existing %s payment attempt', async (state) => {
    await initiate()
    // The redirect is genuinely issued through the payment service. Any later
    // operational status, including failure, cannot erase that historical risk.
    f.sqlite.prepare('UPDATE payment_intents SET status=?').run(state)
    const before = facts()
    expect(await readD1OrderCancellation(f.database, BUYER_CLAIMS, orderId, options)).toMatchObject({
      eligible: false,
      blocker: 'payment_history'
    })
    await expect(cancel()).rejects.toMatchObject({ code: 'not_eligible' })
    expect(facts()).toEqual(before)
  })
  it.each(['released', 'expired'] as const)(
    'cancels a previously %s reservation without duplicate movements',
    async (state) => {
      const reservation = f.sqlite.prepare('SELECT idempotency_key AS key FROM inventory_reservations').get() as {
        key: string
      }
      if (state === 'released')
        await releaseReservation(f.database, {
          idempotencyKey: reservation.key,
          correlationId: 'release-before-cancel',
          now: utc()
        })
      else {
        vi.setSystemTime(data.date(31 * 60 * 1000))
        await expireExpiredReservations(f.database, {
          at: utc(),
          correlationId: 'expiry-before-cancel',
          reservationKey: reservation.key
        })
      }
      const movements = f.sqlite.prepare('SELECT * FROM inventory_movements').all()
      expect(await cancel()).toMatchObject({ inventoryEffect: state === 'released' ? 'already_released' : 'expired' })
      expect(f.sqlite.prepare('SELECT * FROM inventory_movements').all()).toEqual(movements)
    }
  )
  it('never releases assigned stock when assignment wins the batch race', async () => {
    const reservation = f.sqlite.prepare('SELECT idempotency_key AS key FROM inventory_reservations').get() as {
      key: string
    }
    const raced = beforeBatch(async () => {
      await assignReservation(f.database, {
        idempotencyKey: reservation.key,
        correlationId: 'assignment-winner',
        now: utc()
      })
    })
    await expect(cancelD1UnpaidOrder(raced, BUYER_CLAIMS, orderId, commandId, body, options)).rejects.toMatchObject({
      code: 'not_eligible'
    })
    expect(f.sqlite.prepare('SELECT status FROM orders WHERE id=?').get(orderId)).toEqual({
      status: 'awaiting_payment'
    })
    expect(f.sqlite.prepare('SELECT status FROM inventory_reservations').get()).toEqual({ status: 'assigned' })
    expect(
      f.sqlite.prepare("SELECT count(*) AS n FROM inventory_movements WHERE movement_type='release'").get()
    ).toEqual({ n: 0 })
  })
  it('rolls back cancellation if a real payment initiation wins immediately before its batch', async () => {
    const raced = beforeBatch(async () => {
      await initiate()
    })
    await expect(cancelD1UnpaidOrder(raced, BUYER_CLAIMS, orderId, commandId, body, options)).rejects.toMatchObject({
      code: 'not_eligible'
    })
    expect(f.sqlite.prepare('SELECT status FROM orders WHERE id=?').get(orderId)).toEqual({
      status: 'awaiting_payment'
    })
    expect(f.sqlite.prepare('SELECT status FROM inventory_reservations').get()).toEqual({ status: 'reserved' })
    expect(f.sqlite.prepare("SELECT count(*) n FROM order_events WHERE event_type='order.cancelled'").get()).toEqual({
      n: 0
    })
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_intents').get()).toEqual({ n: 1 })
  })
  it.each(['email', 'mfa', 'grant'] as const)(
    'rechecks current admin %s before accepting a command',
    async (change) => {
      if (change === 'email')
        f.sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(CLAIMS.identityId)
      if (change === 'mfa') f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CLAIMS.sessionId)
      if (change === 'grant') f.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(CLAIMS.identityId)
      const before = facts()
      await expect(
        cancelD1UnpaidOrder(f.database, CLAIMS, orderId, commandId, body, { ...options, audience: 'admin' })
      ).rejects.toMatchObject({
        code: change === 'email' ? 'email_unverified' : change === 'mfa' ? 'mfa_required' : 'forbidden'
      })
      expect(facts()).toEqual(before)
    }
  )
  it('does not reveal a foreign active customer order', async () => {
    const foreign = await f.order({ owned: false, paid: false, delivered: false })
    const before = facts()
    await expect(readD1OrderCancellation(f.database, BUYER_CLAIMS, foreign, options)).rejects.toMatchObject({
      code: 'not_found'
    })
    await expect(
      readD1OrderCancellationCommand(f.database, BUYER_CLAIMS, foreign, commandId, options)
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(facts()).toEqual(before)
  })
  it('fails closed on a partial or altered stored receipt rather than returning arbitrary ledger JSON', async () => {
    await cancel()
    f.sqlite
      .prepare('UPDATE payment_commands SET response_body=? WHERE command_id=?')
      .run(JSON.stringify({ outcome: 'cancelled', secret: 'never return ledger fields' }), commandId)
    await expect(
      readD1OrderCancellationCommand(f.database, BUYER_CLAIMS, orderId, commandId, options)
    ).rejects.toMatchObject({ code: 'unavailable' })
  })
  it('rejects a command key already used to initiate payment as a payload conflict', async () => {
    await initiateRedsysPayment(
      f.database,
      {
        orderId,
        orderToken,
        method: 'card',
        idempotencyKey: commandId,
        correlationId: 'payment-key-collision',
        now: utc(),
        randomUUID: () => data.uuid()
      },
      paymentConfiguration
    )
    const before = facts()
    await expect(cancel()).rejects.toMatchObject({ code: 'conflict' })
    expect(facts()).toEqual(before)
  })
  it('does not accept a terminal reservation missing its matching immutable release ledger', async () => {
    f.sqlite.prepare("UPDATE inventory_reservations SET status='released',released_at=?").run(utc())
    expect(await readD1OrderCancellation(f.database, BUYER_CLAIMS, orderId, options)).toMatchObject({
      eligible: false,
      blocker: 'reservation_unavailable'
    })
    await expect(cancel()).rejects.toMatchObject({ code: 'not_eligible' })
  })
  it('offers only a currently owned unpaid order without mutating any facts', async () => {
    const before = facts()
    expect(await readD1OrderCancellation(f.database, BUYER_CLAIMS, orderId, options)).toMatchObject({
      source: 'cloudflare',
      orderId,
      eligible: true,
      blocker: null,
      orderStatus: 'awaiting_payment'
    })
    expect(facts()).toEqual(before)
  })
  it.each(['customer', 'admin'] as const)(
    'cancels as %s with one atomic release and immutable snapshots',
    async (audience) => {
      const before = facts()
      const batches = vi.spyOn(f.database, 'batch')
      const receipt = await cancelD1UnpaidOrder(
        f.database,
        audience === 'admin' ? CLAIMS : BUYER_CLAIMS,
        orderId,
        commandId,
        body,
        { ...options, audience }
      )
      expect(receipt).toMatchObject({
        source: 'cloudflare',
        orderId,
        commandId,
        outcome: 'cancelled',
        orderStatus: 'cancelled',
        inventoryEffect: 'released'
      })
      expect(batches).toHaveBeenCalledTimes(1)
      expect(f.sqlite.prepare('SELECT status FROM inventory_reservations').get()).toEqual({ status: 'released' })
      expect(facts().lines).toEqual(before.lines)
      const after = facts().orders[0]!
      expect({ ...after, status: before.orders[0]!.status, updated_at: before.orders[0]!.updated_at }).toEqual(
        before.orders[0]
      )
      expect(
        f.sqlite
          .prepare("SELECT physical_delta,reserved_delta FROM inventory_movements WHERE movement_type='release'")
          .all()
      ).toEqual([{ physical_delta: 0, reserved_delta: -2 }])
      expect(
        f.sqlite.prepare("SELECT count(*) AS n FROM order_events WHERE event_type='order.cancelled'").get()
      ).toEqual({ n: 1 })
    }
  )
  it('replays the exact receipt and rejects different input without any further writes', async () => {
    const receipt = await cancel()
    const before = facts()
    expect(await cancel()).toEqual(receipt)
    await expect(
      cancelD1UnpaidOrder(
        f.database,
        BUYER_CLAIMS,
        orderId,
        commandId,
        { ...body, reason: reason + ' Distinto.' },
        options
      )
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(facts()).toEqual(before)
  })
  it('recovers a committed receipt read-only and reports unknown without asserting absence', async () => {
    expect(await readD1OrderCancellationCommand(f.database, BUYER_CLAIMS, orderId, commandId, options)).toEqual({
      source: 'cloudflare',
      orderId,
      commandId,
      outcome: 'unknown'
    })
    const receipt = await cancel()
    const before = facts()
    expect(await readD1OrderCancellationCommand(f.database, BUYER_CLAIMS, orderId, commandId, options)).toEqual(receipt)
    expect(facts()).toEqual(before)
  })
  it('does not expose an unknown or foreign order', async () => {
    await expect(readD1OrderCancellation(f.database, BUYER_CLAIMS, data.uuid(), options)).rejects.toMatchObject({
      code: 'not_found'
    })
    await expect(readD1OrderCancellation(f.database, CLAIMS, orderId, options)).rejects.toMatchObject({
      code: 'unauthenticated'
    })
  })
  it('rejects revocation in the mutation linearization window and writes nothing', async () => {
    const before = facts()
    const database = beforeBatch(() =>
      f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_SESSION)
    )
    await expect(cancelD1UnpaidOrder(database, BUYER_CLAIMS, orderId, commandId, body, options)).rejects.toMatchObject({
      code: 'unauthenticated'
    })
    expect(facts()).toEqual(before)
  })
  it.each(['session', 'email', 'mfa', 'grant'] as const)(
    'denies a committed receipt if admin %s is revoked during its last proof read',
    async (change) => {
      const original = f.database.prepare.bind(f.database)
      const database = new Proxy(f.database, {
        get(target, key) {
          if (key === 'prepare')
            return (sql: string) => {
              const statement = original(sql)
              if (
                !sql.includes('c.payload_hash') ||
                f.sqlite.prepare('SELECT status FROM orders WHERE id=?').get(orderId)?.status !== 'cancelled'
              )
                return statement
              return {
                bind(...args: unknown[]) {
                  const bound = statement.bind(...args)
                  return {
                    async first() {
                      const row = await bound.first()
                      if (change === 'session')
                        f.sqlite
                          .prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?')
                          .run(utc(), CLAIMS.sessionId)
                      if (change === 'email')
                        f.sqlite
                          .prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?')
                          .run(CLAIMS.identityId)
                      if (change === 'mfa')
                        f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CLAIMS.sessionId)
                      if (change === 'grant')
                        f.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(CLAIMS.identityId)
                      return row
                    }
                  }
                }
              }
            }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }) as D1Database
      await expect(
        cancelD1UnpaidOrder(database, CLAIMS, orderId, commandId, body, { ...options, audience: 'admin' })
      ).rejects.toMatchObject({
        code:
          change === 'session'
            ? 'unauthenticated'
            : change === 'email'
              ? 'email_unverified'
              : change === 'mfa'
                ? 'mfa_required'
                : 'forbidden'
      })
      expect(f.sqlite.prepare('SELECT status FROM orders WHERE id=?').get(orderId)).toEqual({ status: 'cancelled' })
      expect(
        f.sqlite.prepare("SELECT count(*) n FROM inventory_movements WHERE movement_type='release'").get()
      ).toEqual({ n: 1 })
    }
  )
  it('rolls back the order, release and command together if the audit cannot commit', async () => {
    f.sqlite.exec(
      "CREATE TRIGGER cancellation_failure BEFORE INSERT ON order_events WHEN NEW.event_type='order.cancelled' BEGIN SELECT RAISE(ABORT,'simulated audit outage'); END"
    )
    const before = facts()
    await expect(cancel()).rejects.toMatchObject({ code: 'unavailable' })
    expect(facts()).toEqual(before)
  })
  it('blocks a reservation whose immutable order quantities do not match its reserved lines', async () => {
    f.sqlite.prepare('UPDATE inventory_reservation_lines SET quantity=quantity+1').run()
    const before = facts()
    expect(await readD1OrderCancellation(f.database, BUYER_CLAIMS, orderId, options)).toMatchObject({
      eligible: false,
      blocker: 'reservation_unavailable'
    })
    await expect(cancel()).rejects.toMatchObject({ code: 'not_eligible' })
    expect(facts()).toEqual(before)
  })
  it('preserves uncertainty after a committed batch loses its response, then recovers safely', async () => {
    const database = new Proxy(f.database, {
      get(target, key) {
        if (key === 'batch')
          return async (statements: Parameters<D1Database['batch']>[0]) => {
            await target.batch(statements)
            throw new Error('connection lost after commit')
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as D1Database
    await expect(cancelD1UnpaidOrder(database, BUYER_CLAIMS, orderId, commandId, body, options)).rejects.toMatchObject({
      code: 'unavailable'
    })
    expect(await readD1OrderCancellationCommand(f.database, BUYER_CLAIMS, orderId, commandId, options)).toMatchObject({
      outcome: 'cancelled'
    })
    expect(
      f.sqlite.prepare("SELECT count(*) AS n FROM inventory_movements WHERE movement_type='release'").get()
    ).toEqual({ n: 1 })
  })
})
