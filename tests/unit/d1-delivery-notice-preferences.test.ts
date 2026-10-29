import { applyDeliveryPreferencesMigration } from '../support/delivery-preferences-migration'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { returnsFixture, BUYER_CLAIMS, CUSTOMER, CLAIMS, REASON, utc } from './d1-returns-fixture'
import { updateD1DeliveryPreferences } from '../../workers/auth/delivery-preferences'
import { DELIVERY_PREFERENCES_POLICY_VERSION } from '../../shared/delivery-preferences'
import { executeD1AdminFulfillmentCommand } from '../../workers/fulfillment/admin'
import { cancelD1UnpaidOrder } from '../../workers/catalog/order-cancellation'
import { publishEmailOutbox, receiveEmailDispatch } from '../../workers/communications/email-outbox'
import { orderOperationsEmailRenderers } from '../../workers/communications/order-operations-email'
import {
  dispatchTransactionalEmails,
  type TransactionalEmailSender
} from '../../workers/communications/transactional-email-delivery'

let f: Awaited<ReturnType<typeof returnsFixture>>, orderId: string, eventId: string, queueMessage: unknown
beforeEach(async () => {
  f = await returnsFixture()
  await applyDeliveryPreferencesMigration(f.sqlite)
  orderId = await f.order({ delivered: false })
  await executeD1AdminFulfillmentCommand(
    f.database,
    CLAIMS,
    orderId,
    { action: 'picking', expectedVersion: 0, reason: REASON },
    { idempotencyKey: crypto.randomUUID() }
  )
  eventId = String(
    f.sqlite
      .prepare("SELECT id FROM email_outbox_events WHERE source_id=? AND event_type='order.status.updated'")
      .get(orderId)!.id
  )
  await publishEmailOutbox(
    f.database,
    {
      send: async (message) => {
        if (message.eventId === eventId) queueMessage = message
        await receiveEmailDispatch(f.database, message, utc())
      }
    },
    { now: utc(), limit: 100 }
  )
})
afterEach(() => {
  f?.sqlite.close()
  vi.restoreAllMocks()
})
const sender = () => ({
  send: vi.fn<TransactionalEmailSender['send']>(async () => ({ messageId: 'synthetic-delivery-notice' }))
})
const dispatch = (send: TransactionalEmailSender = sender(), database = f.database) =>
  dispatchTransactionalEmails(
    database,
    send,
    {
      enabled: true,
      from: 'operations@example.invalid',
      now: utc(),
      appEnvironment: 'local',
      rendererOptIns: orderOperationsEmailRenderers.map((item) => item.key)
    },
    { renderers: orderOperationsEmailRenderers }
  )
async function preference(deliveryUpdates: boolean, at?: string) {
  const row = f.sqlite.prepare('SELECT version FROM delivery_preferences WHERE customer_id=?').get(CUSTOMER)
  return updateD1DeliveryPreferences(
    f.database,
    BUYER_CLAIMS,
    crypto.randomUUID(),
    {
      expectedVersion: Number(row?.version ?? 0),
      deliveryUpdates,
      policyVersion: DELIVERY_PREFERENCES_POLICY_VERSION
    },
    at ? { now: () => at } : {}
  )
}
function state() {
  return f.sqlite.prepare('SELECT * FROM transactional_email_deliveries WHERE event_id=?').get(eventId)!
}
function notices(send: ReturnType<typeof sender>) {
  return send.send.mock.calls.filter(([message]) => message.subject.includes('En preparación'))
}
function domain() {
  return [
    'orders',
    'order_lines',
    'inventory_balances',
    'inventory_movements',
    'order_fulfillments',
    'payment_intents',
    'order_payment_states'
  ].map((table) => JSON.stringify(f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))
}
function race(beforeBatch: (sql: string) => Promise<void>) {
  return {
    ...f.database,
    batch: async (statements: D1PreparedStatement[]) => {
      const sql = statements.map((s) => (s as unknown as { sql: string }).sql).join('\n')
      await beforeBatch(sql)
      return f.database.batch(statements)
    }
  } as D1Database
}
it('suppresses a confirmed opt-out terminally without provider, receipt, manual review or domain changes', async () => {
  await preference(false)
  const before = domain(),
    send = sender()
  expect(await dispatch(send)).toMatchObject({ suppressed: 1, manualReview: 0, lostLease: 0 })
  expect(notices(send)).toHaveLength(0)
  expect(state()).toMatchObject({
    status: 'pending',
    lease_token: null,
    provider_message_id: null,
    last_error_code: null
  })
  const ledger = f.sqlite.prepare('SELECT * FROM operational_email_suppressions WHERE event_id=?').get(eventId)!
  expect(ledger).toMatchObject({ customer_id: CUSTOMER, preference_version: 1, reason: 'delivery_updates_disabled' })
  expect(JSON.stringify(ledger)).not.toMatch(/buyer@|recipient|token|body/)
  expect(domain()).toEqual(before)
  expect(() => f.sqlite.prepare('DELETE FROM operational_email_suppressions WHERE event_id=?').run(eventId)).toThrow()
  expect(() =>
    f.sqlite.prepare('UPDATE operational_email_suppressions SET reason=reason WHERE event_id=?').run(eventId)
  ).toThrow()
})
it('duplicate queue delivery and re-enabling never resend an already suppressed notice', async () => {
  await preference(false)
  const send = sender()
  await dispatch(send)
  await preference(true)
  expect(queueMessage).toBeDefined()
  expect(await receiveEmailDispatch(f.database, queueMessage, utc())).toBe('replayed')
  await publishEmailOutbox(
    f.database,
    {
      send: async (message) => {
        await receiveEmailDispatch(f.database, message, utc())
      }
    },
    { now: utc(), limit: 100 }
  )
  const attempts = state().attempts
  await dispatch(send)
  expect(notices(send)).toHaveLength(0)
  expect(state().attempts).toBe(attempts)
  expect(f.sqlite.prepare('SELECT count(*) n FROM operational_email_suppressions').get()!.n).toBe(1)
})
it.each([false, true])(
  'default and explicitly enabled preferences deliver exactly once (explicit=%s)',
  async (explicit) => {
    if (explicit) await preference(true)
    const send = sender()
    await dispatch(send)
    await dispatch(send)
    expect(notices(send)).toHaveLength(1)
    expect(state().status).toBe('sent')
  }
)
it('a guest order defaults enabled independently of another customer opting out', async () => {
  await preference(false)
  const guest = await f.order({ owned: false, delivered: false })
  await executeD1AdminFulfillmentCommand(
    f.database,
    CLAIMS,
    guest,
    { action: 'picking', expectedVersion: 0, reason: REASON },
    { idempotencyKey: crypto.randomUUID() }
  )
  await publishEmailOutbox(
    f.database,
    {
      send: async (message) => {
        await receiveEmailDispatch(f.database, message, utc())
      }
    },
    { now: utc(), limit: 100 }
  )
  const send = sender()
  await dispatch(send)
  const subjects = send.send.mock.calls.map(([message]) => message.subject)
  expect(subjects.some((value) => value.includes(guest) && value.includes('En preparación'))).toBe(true)
  expect(subjects.some((value) => value.includes(orderId) && value.includes('En preparación'))).toBe(false)
})
it('opt-out after the committed sending marker does not claim cancellation of a message already in flight', async () => {
  const send = {
    send: vi.fn(async (message: { subject: string }) => {
      if (message.subject.includes('En preparación')) {
        expect(state().status).toBe('sending')
        await preference(false)
      }
      return { messageId: 'synthetic-in-flight' }
    })
  }
  await dispatch(send)
  expect(state().status).toBe('sent')
  expect(f.sqlite.prepare('SELECT count(*) n FROM operational_email_suppressions').get()!.n).toBe(0)
})
it('an opt-out immediately before the sending marker suppresses normally instead of sending or claiming failure', async () => {
  let changed = false
  const db = race(async (sql) => {
      if (!changed && sql.includes('INSERT INTO transactional_email_preparations')) {
        changed = true
        await preference(false)
      }
    }),
    send = sender()
  expect(await dispatch(send, db)).toMatchObject({ suppressed: 1, manualReview: 0, lostLease: 0 })
  expect(changed).toBe(true)
  expect(notices(send)).toHaveLength(0)
})
it('enabling during a suppression transaction cannot record a false terminal suppression or manual review', async () => {
  await preference(false)
  let changed = false
  const db = race(async (sql) => {
      if (!changed && sql.includes('INSERT INTO operational_email_suppressions')) {
        changed = true
        // The race may span a whole second; a stale marker clock must not
        // misclassify the newly confirmed enable as a corrupt source.
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000)
        await preference(true, utc())
      }
    }),
    send = sender()
  const result = await dispatch(send, db)
  expect(changed).toBe(true)
  expect(result.manualReview).toBe(0)
  expect(f.sqlite.prepare('SELECT count(*) n FROM operational_email_suppressions').get()!.n).toBe(0)
  await dispatch(send)
  expect(notices(send)).toHaveLength(1)
})
it('missing projection with immutable history is corruption, never an enabled default', async () => {
  await preference(false)
  const triggers = f.sqlite
    .prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='delivery_preferences'")
    .all()
  for (const row of triggers) f.sqlite.exec(`DROP TRIGGER "${String(row.name).replaceAll('"', '""')}"`)
  f.sqlite.prepare('DELETE FROM delivery_preferences WHERE customer_id=?').run(CUSTOMER)
  const send = sender()
  expect(await dispatch(send)).toMatchObject({ manualReview: 1 })
  expect(notices(send)).toHaveLength(0)
  expect(f.sqlite.prepare('SELECT count(*) n FROM operational_email_suppressions').get()!.n).toBe(0)
})
it('opt-out does not suppress cancellation or the original order receipt', async () => {
  await preference(false)
  const unpaid = await f.order({ paid: false, delivered: false })
  await cancelD1UnpaidOrder(
    f.database,
    BUYER_CLAIMS,
    unpaid,
    crypto.randomUUID(),
    { expectedStatus: 'awaiting_payment', reason: REASON },
    { audience: 'customer' }
  )
  await publishEmailOutbox(
    f.database,
    {
      send: async (message) => {
        await receiveEmailDispatch(f.database, message, utc())
      }
    },
    { now: utc(), limit: 100 }
  )
  const send = sender()
  await dispatch(send)
  const subjects = send.send.mock.calls.map(([message]) => message.subject)
  expect(subjects.some((value) => value.includes('Pedido cancelado'))).toBe(true)
  expect(subjects.some((value) => !value.includes('En preparación') && !value.includes('Pedido cancelado'))).toBe(true)
})
it.each(['unsupported_source', 'enabled_preference', 'unleased_delivery'])(
  'rejects forged raw suppression (%s)',
  async (invalid) => {
    const receipt = await preference(invalid === 'enabled_preference')
    const target =
      invalid === 'unsupported_source'
        ? String(
            f.sqlite
              .prepare("SELECT id FROM email_outbox_events WHERE source_id=? AND event_type='order.created'")
              .get(orderId)!.id
          )
        : eventId
    if (invalid !== 'unleased_delivery')
      f.sqlite
        .prepare(
          "UPDATE transactional_email_deliveries SET status='leased',lease_token='synthetic',lease_until=? WHERE event_id=?"
        )
        .run(utc(60000), target)
    expect(() =>
      f.sqlite
        .prepare(
          `INSERT INTO operational_email_suppressions(event_id,customer_id,preference_command_id,preference_version,source_hash,suppressed_at,reason)
    VALUES(?,?,?,?,?,?,'delivery_updates_disabled')`
        )
        .run(target, CUSTOMER, receipt.commandId, receipt.version, 'a'.repeat(64), utc())
    ).toThrow()
  }
)
it('terminal suppression forbids a raw sending transition and stays excluded when the renderer opt-in is off', async () => {
  await preference(false)
  const send = sender()
  await dispatch(send)
  expect(() =>
    f.sqlite
      .prepare(
        "UPDATE transactional_email_deliveries SET status='sending',sending_at=?,lease_token='synthetic',lease_until=? WHERE event_id=?"
      )
      .run(utc(), utc(60000), eventId)
  ).toThrow()
  // Deliberate isolated boundary injection: attempts exhausted must still not
  // turn a normal opt-out into manual review after the renderer is disabled.
  f.sqlite.prepare('UPDATE transactional_email_deliveries SET attempts=10 WHERE event_id=?').run(eventId)
  await preference(true)
  expect(
    await dispatchTransactionalEmails(
      f.database,
      send,
      { enabled: true, from: 'operations@example.invalid', now: utc(), appEnvironment: 'local', rendererOptIns: [] },
      { renderers: orderOperationsEmailRenderers }
    )
  ).toMatchObject({ manualReview: 0, sent: 0 })
  expect(state()).toMatchObject({ status: 'pending', last_error_code: null, attempts: 10 })
  expect(notices(send)).toHaveLength(0)
})
