import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { applyDeliveryPreferencesMigration } from '../support/delivery-preferences-migration'
import { fulfillmentFixture, CLAIMS, REASON, utc } from './d1-fulfillment-fixture'
import { returnsFixture, BUYER_CLAIMS } from './d1-returns-fixture'
import { executeD1AdminFulfillmentCommand } from '../../workers/fulfillment/admin'
import { cancelD1UnpaidOrder } from '../../workers/catalog/order-cancellation'
import {
  orderOperationsEmailRenderers,
  prepareOrderOperationsEmail
} from '../../workers/communications/order-operations-email'
import { publishEmailOutbox, receiveEmailDispatch } from '../../workers/communications/email-outbox'
import { dispatchTransactionalEmails } from '../../workers/communications/transactional-email-delivery'
import type { TransactionalEmailSender } from '../../workers/communications/transactional-email-delivery'
import * as checkout from '../../workers/catalog/checkout'

let f: Pick<Awaited<ReturnType<typeof fulfillmentFixture>>, 'sqlite' | 'database'>, orderId: string
let fixtureOrder: Awaited<ReturnType<typeof fulfillmentFixture>>['order']
const context = { appEnvironment: 'local' as const, validationEnabled: false },
  from = 'operations@example.invalid'
beforeEach(async () => {
  const fixture = await fulfillmentFixture()
  f = fixture
  await applyDeliveryPreferencesMigration(f.sqlite)
  fixtureOrder = fixture.order
  orderId = await fixtureOrder()
})
afterEach(() => {
  f?.sqlite.close()
  vi.restoreAllMocks()
})
const transition = (action: string, expectedVersion: number) =>
  executeD1AdminFulfillmentCommand(
    f.database,
    CLAIMS,
    orderId,
    {
      action,
      expectedVersion,
      reason: REASON,
      ...(['in_transit', 'delivered', 'exception'].includes(action) ? { evidence: REASON } : {})
    },
    { idempotencyKey: `${orderId}:${action}:${expectedVersion}` }
  )
function event() {
  const row = f.sqlite
    .prepare(
      "SELECT e.id FROM email_outbox_events e JOIN order_fulfillment_commands c ON c.id=e.source_event_id WHERE e.source_id=? AND e.event_type='order.status.updated' ORDER BY c.result_version DESC LIMIT 1"
    )
    .get(orderId) as { id: string } | undefined
  expect(row).toBeDefined()
  return row!.id
}
async function publish() {
  await publishEmailOutbox(
    f.database,
    {
      send: async (message) => {
        await receiveEmailDispatch(f.database, message, utc())
      }
    },
    { now: utc(), limit: 100 }
  )
}
const dispatch = async (sender: TransactionalEmailSender, extra: Record<string, unknown> = {}) => {
  return dispatchTransactionalEmails(
    f.database,
    sender,
    {
      enabled: true,
      from,
      now: utc(),
      appEnvironment: 'local',
      rendererOptIns: orderOperationsEmailRenderers.map((item) => item.key),
      ...extra
    },
    { renderers: orderOperationsEmailRenderers }
  )
}
it.each([
  ['picking', 0, 'En preparación'],
  ['ready_for_pickup', 2, 'Listo para recoger'],
  ['delivered', 3, 'Entrega registrada']
] as const)('enqueues and renders confirmed %s with no internal evidence', async (action, version, title) => {
  for (const [index, state] of ['picking', 'packed', 'ready_for_pickup', 'delivered'].entries()) {
    await transition(state, index)
    if (index === version) break
  }
  const id = event(),
    prepared = await prepareOrderOperationsEmail(f.database, id, from, context)
  expect(prepared).toHaveProperty('message')
  if ('error' in prepared) throw new Error(prepared.error)
  expect(prepared.message.to).toBe('buyer@example.invalid')
  expect(prepared.message.text).toContain(title)
  expect(prepared.message.text).not.toContain(REASON)
  expect(prepared.message.html).not.toContain(REASON)
  expect(prepared.message.text).not.toMatch(/liquidación confirmada|tracking|https?:\/\//i)
  const outbox = f.sqlite.prepare('SELECT * FROM email_outbox_events WHERE id=?').get(id)!
  expect(Object.keys(outbox)).not.toContain('recipient')
  expect(JSON.stringify(outbox)).not.toContain('buyer@')
})
it('enqueues in-transit from the actual delivery-method transition, not a status log', async () => {
  orderId = await fixtureOrder('own_delivery')
  await transition('picking', 0)
  await transition('packed', 1)
  await transition('in_transit', 2)
  const prepared = await prepareOrderOperationsEmail(f.database, event(), from, context)
  expect('message' in prepared && prepared.message.text).toContain('Tránsito registrado')
})
it('exact command replay creates only one operational outbox event', async () => {
  await transition('picking', 0)
  await transition('picking', 0)
  expect(
    f.sqlite
      .prepare("SELECT count(*) n FROM email_outbox_events WHERE event_type='order.status.updated' AND source_id=?")
      .get(orderId)
  ).toEqual({ n: 1 })
})
it('packed and exception never fabricate an outbound public milestone', async () => {
  await transition('picking', 0)
  await transition('packed', 1)
  await transition('exception', 2)
  expect(
    f.sqlite
      .prepare("SELECT count(*) n FROM email_outbox_events WHERE event_type='order.status.updated' AND source_id=?")
      .get(orderId)
  ).toEqual({ n: 1 })
  expect(await prepareOrderOperationsEmail(f.database, event(), from, context)).toEqual({ error: 'source_not_found' })
})
it('rolls back command/projection/audit if the same-batch outbox insert fails', async () => {
  const original = f.sqlite.prepare('SELECT * FROM order_fulfillments').all()
  f.sqlite.exec(
    "CREATE TRIGGER fail_test_operational_email BEFORE INSERT ON email_outbox_events WHEN NEW.event_type='order.status.updated' BEGIN SELECT RAISE(ABORT,'synthetic-email-failure'); END"
  )
  await expect(transition('picking', 0)).rejects.toThrow()
  expect(f.sqlite.prepare('SELECT * FROM order_fulfillments').all()).toEqual(original)
  expect(f.sqlite.prepare('SELECT count(*) n FROM order_fulfillment_commands').get()).toEqual({ n: 0 })
  expect(f.sqlite.prepare('SELECT count(*) n FROM order_fulfillment_audit').get()).toEqual({ n: 0 })
})
it('renders escaped current contact but never internal reasons or contact email in body', async () => {
  const place = checkout.placeOrder
  vi.spyOn(checkout, 'placeOrder').mockImplementation((database, input) =>
    place(database, { ...input, contactName: '<script>synthetic</script>' })
  )
  orderId = await fixtureOrder()
  await transition('picking', 0)
  const prepared = await prepareOrderOperationsEmail(f.database, event(), from, context)
  if ('error' in prepared) throw new Error(prepared.error)
  expect(prepared.message.html).toContain('&lt;script&gt;')
  expect(prepared.message.html).not.toContain('<script>')
  expect(prepared.message.text).not.toContain('buyer@example.invalid')
})
it('immutable recipient and superseded source cannot pass the final atomic sending guard', async () => {
  await transition('picking', 0)
  const id = event(),
    prepared = await prepareOrderOperationsEmail(f.database, id, from, context)
  if ('error' in prepared) throw new Error(prepared.error)
  expect(() =>
    f.sqlite.prepare('UPDATE orders SET contact_email=? WHERE id=?').run('different@example.invalid', orderId)
  ).toThrow('immutable')
  await transition('packed', 1)
  await expect(
    f.database.batch(
      orderOperationsEmailRenderers[0]!.authorityStatements(
        f.database,
        { eventId: id, leaseToken: crypto.randomUUID(), sendingAt: utc(), leaseUntil: utc(60000) },
        prepared
      )
    )
  ).rejects.toThrow()
})
it('disables by default/without registry opt-in and sends a current source once with a LOCAL fake', async () => {
  await transition('picking', 0)
  await publish()
  const sender = {
    send: vi.fn<TransactionalEmailSender['send']>(async () => ({ messageId: 'local-operation-message' }))
  }
  expect(
    await dispatchTransactionalEmails(f.database, sender, { now: utc() }, { renderers: orderOperationsEmailRenderers })
  ).toMatchObject({ disabled: true, sent: 0 })
  expect(sender.send).not.toHaveBeenCalled()
  await dispatch(sender, { rendererOptIns: [] })
  expect(sender.send.mock.calls.some(([message]) => message.subject.includes('En preparación'))).toBe(false)
  expect(f.sqlite.prepare('SELECT status FROM transactional_email_deliveries WHERE event_id=?').get(event())).toEqual({
    status: 'pending'
  })
  await dispatch(sender)
  expect(sender.send.mock.calls.filter(([message]) => message.subject.includes('En preparación'))).toHaveLength(1)
  await dispatch(sender)
  expect(sender.send.mock.calls.filter(([message]) => message.subject.includes('En preparación'))).toHaveLength(1)
})
it('sender loss is manual review and never a second automatic send', async () => {
  await transition('picking', 0)
  await publish()
  const sender = {
    send: vi.fn(async (message: { subject: string }) => {
      if (message.subject.includes('En preparación')) throw new Error('lost_after_send')
      return { messageId: 'local-created' }
    })
  }
  expect(await dispatch(sender)).toMatchObject({ manualReview: 1 })
  const count = sender.send.mock.calls.filter(([message]) => message.subject.includes('En preparación')).length
  expect(count).toBe(1)
  await dispatch(sender)
  expect(sender.send.mock.calls.filter(([message]) => message.subject.includes('En preparación'))).toHaveLength(1)
})
it('moves an obsolete queued preparing source to manual review without a misleading send', async () => {
  await transition('picking', 0)
  await transition('packed', 1)
  await publish()
  const sender = { send: vi.fn<TransactionalEmailSender['send']>(async () => ({ messageId: 'local-created' })) }
  expect(await dispatch(sender)).toMatchObject({ manualReview: 1 })
  expect(sender.send.mock.calls.some(([message]) => message.subject.includes('En preparación'))).toBe(false)
})
it('cancellation enqueues only after the real atomic command and renders no refund/payment claim', async () => {
  f.sqlite.close()
  const cancelled = await returnsFixture()
  f = cancelled
  await applyDeliveryPreferencesMigration(f.sqlite)
  orderId = await cancelled.order({ paid: false, delivered: false })
  const key = crypto.randomUUID(),
    input = { expectedStatus: 'awaiting_payment' as const, reason: 'Synthetic private cancellation reason' }
  await cancelD1UnpaidOrder(f.database, BUYER_CLAIMS, orderId, key, input, { audience: 'customer', now: () => utc() })
  await cancelD1UnpaidOrder(f.database, BUYER_CLAIMS, orderId, key, input, { audience: 'customer', now: () => utc() })
  const rows = f.sqlite
    .prepare("SELECT id FROM email_outbox_events WHERE event_type='order.cancelled'")
    .all() as Array<{ id: string }>
  expect(rows).toHaveLength(1)
  const prepared = await prepareOrderOperationsEmail(f.database, rows[0]!.id, from, context)
  if ('error' in prepared) throw new Error(prepared.error)
  expect(prepared.message.text).toContain('Pedido cancelado')
  expect(prepared.message.text).not.toContain(input.reason)
  expect(prepared.message.text).toContain('no acredita devolución de dinero')
})
it('rolls back cancellation and release when its outbox insert fails', async () => {
  f.sqlite.close()
  const cancelled = await returnsFixture()
  f = cancelled
  await applyDeliveryPreferencesMigration(f.sqlite)
  orderId = await cancelled.order({ paid: false, delivered: false })
  const snapshot = () => ({
    orders: f.sqlite.prepare('SELECT * FROM orders').all(),
    reservations: f.sqlite.prepare('SELECT * FROM inventory_reservations').all(),
    movements: f.sqlite.prepare('SELECT * FROM inventory_movements').all(),
    commands: f.sqlite.prepare('SELECT * FROM payment_commands').all(),
    events: f.sqlite.prepare('SELECT * FROM order_events').all()
  })
  const before = snapshot()
  f.sqlite.exec(
    "CREATE TRIGGER fail_cancel_email BEFORE INSERT ON email_outbox_events WHEN NEW.event_type='order.cancelled' BEGIN SELECT RAISE(ABORT,'synthetic-cancel-email-failure'); END"
  )
  await expect(
    cancelD1UnpaidOrder(
      f.database,
      BUYER_CLAIMS,
      orderId,
      crypto.randomUUID(),
      { expectedStatus: 'awaiting_payment', reason: 'Synthetic private cancellation reason' },
      { audience: 'customer', now: () => utc() }
    )
  ).rejects.toMatchObject({ code: 'unavailable' })
  expect(snapshot()).toEqual(before)
})
it('queued preparing cannot be rendered after a cancelled order, even if its old audit survives', async () => {
  await transition('picking', 0)
  const id = event()
  f.sqlite.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(orderId)
  expect(await prepareOrderOperationsEmail(f.database, id, from, context)).toEqual({ error: 'source_not_found' })
})
it('validates the contractual mailbox and fences altered recipient proof', async () => {
  await transition('picking', 0)
  const id = event(),
    prepared = await prepareOrderOperationsEmail(f.database, id, from, context)
  if ('error' in prepared) throw new Error(prepared.error)
  const changed = {
    ...prepared,
    proof: { row: { ...(prepared.proof.row as Record<string, unknown>), contact_email: 'other@example.invalid' } }
  }
  await expect(
    f.database.batch(
      orderOperationsEmailRenderers[0]!.authorityStatements(
        f.database,
        { eventId: id, leaseToken: crypto.randomUUID(), sendingAt: utc(), leaseUntil: utc(60000) },
        changed
      )
    )
  ).rejects.toThrow()
})
it('rejects corrupted cancellation command content even when the receipt and hash fields still match', async () => {
  f.sqlite.close()
  const cancelled = await returnsFixture()
  f = cancelled
  await applyDeliveryPreferencesMigration(f.sqlite)
  orderId = await cancelled.order({ paid: false, delivered: false })
  await cancelD1UnpaidOrder(
    f.database,
    BUYER_CLAIMS,
    orderId,
    crypto.randomUUID(),
    { expectedStatus: 'awaiting_payment', reason: 'Synthetic private cancellation reason' },
    { audience: 'customer', now: () => utc() }
  )
  const event = f.sqlite.prepare("SELECT id FROM email_outbox_events WHERE event_type='order.cancelled'").get() as {
    id: string
  }
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args))
        if (key === 'first')
          return async () => {
            const raw = await target.first<Record<string, unknown>>()
            if (raw?.state === 'cancelled' && typeof raw.response_json === 'string') {
              const envelope = JSON.parse(raw.response_json)
              envelope.input.reason = 'Corrupted private command content'
              return { ...raw, response_json: JSON.stringify(envelope) }
            }
            return raw
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  const corrupted = new Proxy(f.database, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql))
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  expect(await prepareOrderOperationsEmail(corrupted, event.id, from, context)).toEqual({ error: 'invalid_source' })
})
