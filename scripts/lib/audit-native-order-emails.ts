import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type {
  TransactionalEmailDispatchConfig,
  TransactionalEmailDispatchReport,
  TransactionalEmailSender
} from '../../workers/communications/transactional-email-delivery'
export interface NativeOrderEmailsInput {
  database: D1Database
  origin: string
  orderIds: { fulfillment: readonly string[]; returns: string; cancelled: string; payment: string }
  runEmails: (config: TransactionalEmailDispatchConfig) => Promise<TransactionalEmailDispatchReport>
  deliverEmailTransport: (eventId: string) => Promise<void>
  sentMessages: () => readonly Parameters<TransactionalEmailSender['send']>[0][]
  scenario: (name: string) => void
}
export const ORDER_EMAILS_NATIVE_SCENARIOS = [
  'native_order_emails_confirmed_domain_sources',
  'native_order_emails_disabled_and_default_off_durable',
  'native_order_emails_current_exact_delivery_obsolete_review',
  'native_order_emails_transport_replay_no_second_send',
  'native_order_emails_money_stock_history_unchanged'
] as const
const titles: Record<string, string> = {
  'fulfillment:picking': 'En preparación',
  'fulfillment:ready_for_pickup': 'Listo para recoger',
  'fulfillment:in_transit': 'Tránsito registrado',
  'fulfillment:delivered': 'Entrega registrada',
  'return:requested': 'Solicitud de devolución registrada',
  'return:approved': 'Solicitud de devolución admitida',
  'return:rejected': 'Solicitud de devolución rechazada',
  'return:received': 'Recepción de devolución registrada',
  'return:inspected': 'Inspección de devolución registrada',
  'return:resolution_ready': 'Resolución de devolución preparada',
  'order:cancelled': 'Pedido cancelado',
  'payment:captured': 'Captura registrada'
}
const rowSchema = z
  .object({
    id: z.string().regex(/^email:[a-f0-9]{64}$/),
    state: z.string(),
    token: z.string(),
    current: z.union([z.literal(0), z.literal(1)]),
    renderer: z.string()
  })
  .strict()
type Event = z.infer<typeof rowSchema>
const snapshotTables = [
  'orders',
  'order_lines',
  'order_shipping_address',
  'order_billing_address',
  'order_events',
  'inventory_locations',
  'inventory_balances',
  'inventory_reservations',
  'inventory_reservation_lines',
  'inventory_movements',
  'payment_commands',
  'payment_intents',
  'payment_events',
  'order_payment_states',
  'payment_fulfilment_claims',
  'payment_recovery_jobs',
  'order_fulfillments',
  'order_fulfillment_commands',
  'order_fulfillment_audit',
  'order_returns',
  'order_return_commands',
  'order_return_events',
  'order_return_lines',
  'fiscal_outbox_events',
  'fiscal_invoice_intents',
  'fiscal_documents',
  'refund_contracts',
  'fiscal_credit_contracts'
] as const
/** Consumes only caller-created disposable domain history. No state seeding,
 * payment calls, recipient lookup output, or renderer-as-expected-value oracle. */
export async function auditNativeOrderEmails(input: NativeOrderEmailsInput) {
  const origin = new URL(input.origin)
  assert(
    origin.protocol === 'https:' && origin.origin === input.origin && origin.hostname === 'shop-audit.neteco.test',
    'isolated origin required'
  )
  z.array(z.string().uuid()).min(1).max(10).parse(input.orderIds.fulfillment)
  for (const id of [input.orderIds.returns, input.orderIds.cancelled, input.orderIds.payment])
    z.string().uuid().parse(id)
  assert(new Set(input.orderIds.fulfillment).size === input.orderIds.fulfillment.length, 'duplicate fulfillment source')
  const checks: string[] = []
  const mark = (index: number) => {
    const name = ORDER_EMAILS_NATIVE_SCENARIOS[index]!
    checks.push(name)
    input.scenario(name)
  }
  async function rows(sql: string, ...values: unknown[]) {
    const result = await input.database
      .prepare(sql)
      .bind(...values)
      .all()
    assert(
      result.success && Array.isArray(result.results) && result.results.length <= 10000,
      'bounded native email read required'
    )
    assert.equal(result.meta.rows_written, 0, 'email acceptance SELECT wrote data')
    return result.results
  }
  async function digest() {
    const data = []
    for (const table of snapshotTables) data.push(await rows(`SELECT * FROM ${table} ORDER BY 1,2 LIMIT 10001`))
    return createHash('sha256').update(JSON.stringify(data)).digest('hex')
  }
  const before = await digest(),
    events: Event[] = []
  for (const id of input.orderIds.fulfillment)
    events.push(
      ...z.array(rowSchema).parse(
        await rows(
          `SELECT e.id,'fulfillment:'||c.to_state state,c.order_id token,CASE WHEN f.last_command_id=c.id AND f.version=c.result_version AND f.status=c.to_state THEN 1 ELSE 0 END current,'order.operations.fulfillment.v1' renderer
 FROM order_fulfillment_commands c JOIN order_fulfillments f ON f.order_id=c.order_id
 LEFT JOIN email_outbox_events e ON e.source_event_id=c.id AND e.source_id=c.order_id AND e.event_type='order.status.updated' AND e.source_kind='order' AND e.created_at=c.created_at
 WHERE c.order_id=? AND c.to_state IN('picking','ready_for_pickup','in_transit','delivered') AND EXISTS(SELECT 1 FROM order_fulfillment_audit a WHERE a.command_id=c.id AND a.response=c.response AND a.input=c.input AND a.created_at=c.created_at AND a.result_version=c.result_version) ORDER BY c.result_version LIMIT 10001`,
          id
        )
      )
    )
  const fulfillmentCount = events.length
  assert(fulfillmentCount > 0, 'confirmed fulfillment email sources required')
  for (const id of input.orderIds.fulfillment)
    assert.equal(
      events.filter((event) => event.token === id && event.current === 1).length,
      1,
      'current fulfillment source missing'
    )
  events.push(
    ...z.array(rowSchema).parse(
      await rows(
        `SELECT e.id,'return:'||c.action state,c.public_ref token,CASE WHEN r.last_command_id=c.id AND r.version=c.result_version AND r.state=c.to_state THEN 1 ELSE 0 END current,CASE WHEN c.action='requested' THEN 'order.return.requested.v1' ELSE 'order.return.status.v1' END renderer
 FROM order_return_commands c JOIN order_returns r ON r.id=c.return_id AND r.order_id=c.order_id
 LEFT JOIN email_outbox_events e ON e.source_event_id=c.id AND e.source_id=c.return_id AND e.event_type=CASE WHEN c.action='requested' THEN 'return.requested' ELSE 'return.status.updated' END AND e.source_kind='return' AND e.created_at=c.created_at
 WHERE c.order_id=? AND EXISTS(SELECT 1 FROM order_return_events a WHERE a.command_id=c.id AND a.return_id=c.return_id AND a.version=c.result_version AND a.response=c.response AND a.input=c.input AND a.public_message=c.public_message AND a.created_at=c.created_at) ORDER BY c.result_version LIMIT 10001`,
        input.orderIds.returns
      )
    )
  )
  assert(events.length > fulfillmentCount, 'confirmed RMA email sources required')
  const returnProjections = await rows(
    'SELECT id FROM order_returns WHERE order_id=? LIMIT 10001',
    input.orderIds.returns
  )
  assert.equal(
    events.slice(fulfillmentCount).filter((event) => event.current === 1).length,
    returnProjections.length,
    'current RMA source missing'
  )
  const cancellation = await rows(
    `SELECT e.id,'order:cancelled' state,c.order_id token,1 current,'order.operations.cancelled.v1' renderer FROM payment_commands c JOIN orders o ON o.id=c.order_id AND o.status='cancelled'
 LEFT JOIN email_outbox_events e ON e.source_event_id=c.command_id AND e.source_id=c.order_id AND e.event_type='order.cancelled' AND e.source_kind='order' AND e.created_at=c.created_at
 WHERE c.order_id=? AND json_extract(c.response_body,'$.kind')='unpaid-order-cancellation' AND EXISTS(SELECT 1 FROM order_events a WHERE a.order_id=c.order_id AND a.event_type='order.cancelled' AND a.correlation_id=c.command_id AND json_extract(a.payload_json,'$.payloadHash')=c.payload_hash) LIMIT 10001`,
    input.orderIds.cancelled
  )
  assert.equal(cancellation.length, 1, 'one confirmed cancellation required')
  events.push(rowSchema.parse(cancellation[0]))
  const payment = await rows(
    `SELECT e.id,'payment:captured' state,p.order_id token,1 current,'order.payment.confirmed.v1' renderer FROM payment_intents p JOIN payment_fulfilment_claims claim ON claim.payment_intent_id=p.id AND claim.order_id=p.order_id
 JOIN order_payment_states s ON s.order_id=p.order_id AND s.active_intent_id=p.id AND s.status='paid' AND s.paid_gross_cents=p.amount_gross_cents
 JOIN payment_events c ON c.payment_intent_id=p.id AND c.order_id=p.order_id AND c.event_type='captured'
 LEFT JOIN email_outbox_events e ON e.source_event_id=p.id AND e.source_id=p.order_id AND e.event_type='order.confirmed' AND e.source_kind='order' AND e.created_at=c.created_at
 WHERE p.order_id=? AND p.status='captured' AND EXISTS(SELECT 1 FROM order_events a WHERE a.order_id=p.order_id AND a.event_type='payment_captured' AND a.id='order-event:'||c.provider_event_id AND json_extract(a.payload_json,'$.amountGrossCents')=p.amount_gross_cents) LIMIT 10001`,
    input.orderIds.payment
  )
  assert.equal(payment.length, 1, 'one confirmed payment required')
  events.push(rowSchema.parse(payment[0]))
  assert.equal(new Set(events.map((event) => event.id)).size, events.length, 'duplicate email domain occurrence')
  assert(
    events.every((event) => Object.hasOwn(titles, event.state)),
    'unknown confirmed email state'
  )
  mark(0)
  for (const event of events) await input.deliverEmailTransport(event.id)
  const configuration: TransactionalEmailDispatchConfig = {
    enabled: true,
    from: 'synthetic-orders@example.test',
    now: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    limit: 100,
    appEnvironment: 'local',
    rendererValidationEnabled: true
  }
  const initialMessages = input.sentMessages().length
  await input.runEmails({ ...configuration, enabled: false })
  assert.equal(input.sentMessages().length, initialMessages, 'disabled email sent a message')
  await input.runEmails({ ...configuration, rendererOptIns: [] })
  async function delivery(event: Event) {
    const values = await rows('SELECT status FROM transactional_email_deliveries WHERE event_id=?', event.id)
    assert.equal(values.length, 1)
    return values[0]!.status
  }
  for (const event of events) assert.equal(await delivery(event), 'pending', 'default OFF changed target delivery')
  const targetMessages = (messages: readonly Parameters<TransactionalEmailSender['send']>[0][], event: Event) =>
    messages.filter(
      (message) => message.subject.includes(event.token) && message.subject.includes(titles[event.state]!)
    )
  for (const event of events)
    assert.equal(
      targetMessages(input.sentMessages().slice(initialMessages), event).length,
      0,
      'default OFF sent a target'
    )
  mark(1)
  const beforeSending = input.sentMessages().length
  await input.runEmails({ ...configuration, rendererOptIns: [...new Set(events.map((event) => event.renderer))] })
  const sent = input.sentMessages().slice(beforeSending),
    current = events.filter((event) => event.current === 1),
    obsolete = events.filter((event) => event.current === 0)
  for (const event of current) {
    assert.equal(await delivery(event), 'sent', 'current confirmed email not sent')
    const matches = targetMessages(sent, event)
    assert.equal(matches.length, 1, 'exact target delivery required')
    const message = matches[0]!
    assert(/@[^@]+\.(test|invalid)$/.test(message.to), 'synthetic recipient required')
    assert.equal(message.from, configuration.from)
    if (event.state.startsWith('return:'))
      assert(
        message.text.includes('no confirma un reembolso') && message.text.includes('no repone existencias'),
        'RMA economic or stock claim'
      )
    if (event.state === 'payment:captured')
      assert(
        message.text.includes('Validación local o sandbox') &&
          message.text.includes('no acredita una liquidación bancaria'),
        'payment bank settlement claim'
      )
    if (event.state === 'order:cancelled')
      assert(message.text.includes('no acredita devolución de dinero'), 'cancellation refund claim')
    const manifest = await rows(
      'SELECT renderer_version,source_hash,message_hash FROM transactional_email_preparations WHERE event_id=?',
      event.id
    )
    assert.equal(manifest.length, 1)
    assert.equal(manifest[0]!.renderer_version, event.renderer)
    assert(
      /^[a-f0-9]{64}$/.test(String(manifest[0]!.source_hash)) &&
        /^[a-f0-9]{64}$/.test(String(manifest[0]!.message_hash)),
      'durable source/message hashes required'
    )
  }
  for (const event of obsolete)
    assert.equal(await delivery(event), 'manual_review', 'obsolete source was not held for review')
  mark(2)
  const afterSending = input.sentMessages().length
  for (const event of events) await input.deliverEmailTransport(event.id)
  await input.runEmails({ ...configuration, rendererOptIns: [...new Set(events.map((event) => event.renderer))] })
  assert.equal(input.sentMessages().length, afterSending, 'transport replay sent a second message')
  for (const event of current) assert.equal(await delivery(event), 'sent')
  for (const event of obsolete) assert.equal(await delivery(event), 'manual_review')
  mark(3)
  const after = await digest()
  assert.equal(after, before, 'domain snapshot changed')
  mark(4)
  const coveredStates = [...new Set(events.map((event) => event.state))].sort(),
    pendingStates = Object.keys(titles)
      .filter((state) => !coveredStates.includes(state))
      .sort()
  return {
    scenarios: checks.length,
    targets: current.length,
    obsolete: obsolete.length,
    coveredStates,
    pendingStates,
    deliveredStates: [...new Set(current.map((event) => event.state))].sort(),
    pendingDeliveryStates: Object.keys(titles)
      .filter((state) => !current.some((event) => event.state === state))
      .sort(),
    domainDigestBefore: before,
    domainDigestAfter: after,
    productionAcceptance: false as const,
    providerOperation: false as const,
    domainDigestUnchanged: true as const,
    unknownSendNative: 'not_exercised' as const
  }
}
