import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { orderCancellationEligibilitySchema, orderCancellationReceiptSchema } from '../../shared/order-cancellation'
import { orderTimelineResponseSchema } from '../../shared/order-timeline'

export interface NativeOrderCancellationInput {
  dispatch: (request: Request) => Promise<Response>
  database: D1Database
  origin: string
  variantId: number
  quantity: number
  customerCookie: string
  wrongOwnerCookie: string
  scenario?: (name: string) => void
  randomUUID?: () => string
}
export type NativeUnpaidOrderInput = Pick<
  NativeOrderCancellationInput,
  'dispatch' | 'origin' | 'variantId' | 'quantity' | 'customerCookie' | 'randomUUID'
> & { prepareInventory?: () => Promise<void> }
export const ORDER_CANCELLATION_NATIVE_SCENARIOS = [
  'native_unpaid_cancellation_checkout_http',
  'native_unpaid_cancellation_eligibility_read_only',
  'native_unpaid_cancellation_atomic_release_and_audit',
  'native_unpaid_cancellation_same_key_replay',
  'native_unpaid_cancellation_receipt_recovery_read_only',
  'native_unpaid_cancellation_current_customer_order',
  'native_unpaid_cancellation_subsequent_payment_blocked',
  'native_unpaid_cancellation_owner_and_anonymous_denied_without_writes',
  'native_unpaid_cancellation_confirmed_timeline'
] as const
/** Operates only against the caller's isolated, already compiled workerd.
 * Uses the same cart/shipping/checkout HTTP contracts as the existing native
 * checkout helper, stopping BEFORE any payment attempt. Never seeds an order,
 * owner, money fact or inventory authority by SQL. Caller owns outbound0. */
function nativeOrderHttp(input: NativeUnpaidOrderInput) {
  const url = new URL(input.origin)
  assert(
    url.protocol === 'https:' && url.origin === input.origin && url.hostname === 'shop-audit.neteco.test',
    'isolated origin required'
  )
  assert(Number.isSafeInteger(input.variantId) && input.variantId > 0)
  assert(Number.isSafeInteger(input.quantity) && input.quantity >= 1 && input.quantity <= 999)
  for (const cookie of [input.customerCookie])
    assert(typeof cookie === 'string' && cookie.length > 0 && cookie.length <= 16384 && !/[\r\n]/u.test(cookie))
  const uuid = input.randomUUID ?? randomUUID
  const key = () => {
    const value = uuid()
    assert.match(value, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
    return value
  }
  const request = (path: string, method = 'GET', body?: unknown, cookie = input.customerCookie, commandId?: string) =>
    input.dispatch(
      new Request(input.origin + path, {
        method,
        headers: {
          'cf-connecting-ip': '192.0.2.162',
          origin: input.origin,
          'sec-fetch-site': 'same-origin',
          ...(cookie ? { cookie } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(commandId ? { 'idempotency-key': commandId } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'manual'
      })
    )
  async function json(response: Response, status: number, privacy: 'private' | 'no-store' | 'setup' = 'private') {
    assert.equal(response.status, status)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/iu)
    if (privacy !== 'setup') {
      assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/iu)
      if (privacy === 'private') assert.match(response.headers.get('cache-control') ?? '', /\bprivate\b/iu)
      assert.equal(response.headers.get('set-cookie'), null)
    }
    const bytes = await response.arrayBuffer()
    assert(bytes.byteLength > 0 && bytes.byteLength <= 65536)
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
  }
  function cookieFrom(response: Response, name: string) {
    const values = response.headers.getSetCookie().filter((value) => value.startsWith(name + '='))
    assert.equal(values.length, 1)
    return values[0]!.split(';')[0]!
  }
  return { request, json, cookieFrom, key }
}

/** Same four existing checkout HTTP requests, with no SQL seeding and no
 * payment attempt. Both native cancellation and browser setup share this path. */
export async function createNativeUnpaidOrder(
  input: NativeUnpaidOrderInput
): Promise<{ orderId: string; guestCookie: string }> {
  const { request, json, cookieFrom, key } = nativeOrderHttp(input)
  await input.prepareInventory?.()
  const cartResponse = await request('/api/cart')
  const cartCookie = cookieFrom(cartResponse, 'neteco-cart-v2')
  const cartId = /^neteco-cart-v2=v1\.([a-f0-9-]{36})\./u.exec(cartCookie)?.[1]
  assert(cartId)
  const cart = await json(cartResponse, 200, 'setup')
  assert(Number.isSafeInteger(cart.version) && Number(cart.version) > 0)
  const cartSession = cartCookie + '; ' + input.customerCookie
  const addBody = {
    variantId: input.variantId,
    quantity: input.quantity,
    expectedVersion: cart.version,
    idempotencyKey: key()
  }
  const addRequest = new Request(input.origin + '/api/cart/items', {
    method: 'POST',
    headers: {
      'cf-connecting-ip': '192.0.2.162',
      origin: input.origin,
      'content-type': 'application/json',
      cookie: cartSession,
      'X-Neteco-Cart-Id': cartId
    },
    body: JSON.stringify(addBody)
  })
  await json(await input.dispatch(addRequest), 200, 'setup')
  const shipping = await json(
    await request('/api/shipping/rates', 'POST', { postalCode: '46870', city: 'Ontinyent' }, cartSession, key()),
    200,
    'setup'
  )
  assert(Number.isSafeInteger(shipping.cartVersion) && Number(shipping.cartVersion) > 0)
  assert(Array.isArray(shipping.rates) && shipping.rates.length > 0 && shipping.rates.length <= 50)
  const rates = shipping.rates as Array<Record<string, unknown>>
  const option = rates.find((rate) => rate.serviceCode === 'pickup') ?? rates[0]!
  for (const field of ['quoteId', 'shippingQuoteId', 'optionHash'])
    assert(typeof option[field] === 'string' && String(option[field]).length > 0 && String(option[field]).length <= 200)
  assert(Number.isSafeInteger(option.optionIndex) && Number(option.optionIndex) >= 0)
  assert(Number.isSafeInteger(option.totalGrossCents) && Number(option.totalGrossCents) > 0)
  const address = {
    recipientName: 'Comprador sintético local',
    companyName: '',
    taxId: '',
    line1: 'Carrer Major 1',
    line2: '',
    postalCode: '46870',
    city: 'Ontinyent',
    region: 'Valencia',
    countryCode: 'ES',
    phone: '600000000',
    instructions: ''
  }
  const checkoutBody = {
    cartId,
    cartVersion: shipping.cartVersion,
    quoteId: option.quoteId,
    shippingQuoteId: option.shippingQuoteId,
    optionIndex: option.optionIndex,
    optionHash: option.optionHash,
    expectedTotalGrossCents: option.totalGrossCents,
    customer: {
      name: address.recipientName,
      company: '',
      nif: '',
      email: 'synthetic-buyer@example.test',
      phone: address.phone
    },
    shippingAddress: address,
    billingAddress: address,
    paymentMethod: 'tarjeta',
    termsAccepted: true,
    privacyNoticePresented: true,
    marketingConsent: false
  }
  const created = await request('/api/orders', 'POST', checkoutBody, cartSession, key())
  const createdBody = await json(created, 201, 'setup'),
    candidateOrderId = createdBody.id
  const guestCookie = cookieFrom(created, 'neteco-order-access-v2')
  assert(typeof candidateOrderId === 'string')
  const orderId = candidateOrderId
  assert.match(orderId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
  assert(guestCookie.startsWith('neteco-order-access-v2=v1.' + orderId + '.'))
  return { orderId, guestCookie }
}

export async function auditNativeOrderCancellation(input: NativeOrderCancellationInput) {
  const { request, json, key } = nativeOrderHttp(input)
  assert(
    typeof input.wrongOwnerCookie === 'string' &&
      input.wrongOwnerCookie.length > 0 &&
      input.wrongOwnerCookie.length <= 16384 &&
      !/[\r\n]/u.test(input.wrongOwnerCookie)
  )
  assert.notEqual(input.customerCookie, input.wrongOwnerCookie)
  const { orderId, guestCookie } = await createNativeUnpaidOrder(input)
  const checks: string[] = []
  const mark = (index: number) => {
    const name = ORDER_CANCELLATION_NATIVE_SCENARIOS[index]!
    checks.push(name)
    input.scenario?.(name)
  }
  async function first(sql: string, ...values: string[]) {
    const value = await input.database
      .prepare(sql)
      .bind(...values)
      .first<Record<string, unknown>>()
    assert(value)
    return value
  }
  async function all(sql: string, ...values: string[]) {
    const result = await input.database
      .prepare(sql)
      .bind(...values)
      .all()
    assert(result.success && Array.isArray(result.results))
    assert.equal(result.meta.rows_written, 0)
    return result.results
  }
  const order = await first('SELECT * FROM orders WHERE id = ?', orderId)
  assert.equal(order.id, orderId)
  assert.equal(order.status, 'awaiting_payment')
  assert(typeof order.reservation_id === 'string')
  const reservationId = order.reservation_id
  assert.equal(
    (await first('SELECT id,status FROM inventory_reservations WHERE id = ?', reservationId)).status,
    'reserved'
  )
  const financialTables = [
    'payment_intents',
    'payment_events',
    'payment_fulfilment_claims',
    'payment_recovery_jobs',
    'fiscal_outbox_events',
    'refund_contracts',
    'fiscal_invoice_intents',
    'fiscal_credit_contracts'
  ] as const
  const tables = [
    'orders',
    'order_lines',
    'inventory_reservations',
    'inventory_movements',
    'payment_commands',
    'order_events',
    'identity_rate_limits',
    ...financialTables
  ] as const
  async function snapshot(includeQuota = true) {
    const counts = await first(
      `SELECT ${tables.map((table) => `(SELECT COUNT(*) FROM ${table}) AS ${table}`).join(', ')}`
    )
    for (const table of tables) assert(Number.isSafeInteger(counts[table]) && Number(counts[table]) >= 0)
    return {
      counts,
      metadata: await Promise.all([
        all('SELECT * FROM orders WHERE id = ?', orderId),
        all('SELECT * FROM order_lines WHERE order_id = ? ORDER BY line_index', orderId),
        all('SELECT * FROM inventory_reservations WHERE id = ?', reservationId),
        all('SELECT * FROM inventory_movements WHERE reference_id = ? ORDER BY id', reservationId),
        all('SELECT * FROM payment_commands WHERE order_id = ? ORDER BY command_id', orderId),
        all('SELECT * FROM order_events WHERE order_id = ? ORDER BY id', orderId),
        all('SELECT * FROM order_shipping_address WHERE order_id = ?', orderId),
        all('SELECT * FROM order_billing_address WHERE order_id = ?', orderId),
        ...(includeQuota ? [all('SELECT * FROM identity_rate_limits ORDER BY identity_id,scope')] : [])
      ])
    }
  }
  const before = await snapshot()
  for (const table of financialTables)
    assert.equal(
      (await all(`SELECT * FROM ${table} WHERE order_id = ?`, orderId)).length,
      0,
      'Unpaid checkout must have no financial history'
    )
  mark(0)
  const eligible = orderCancellationEligibilitySchema.parse(
    await json(await request(`/api/orders/${orderId}/cancellation`), 200)
  )
  assert.equal(eligible.orderId, orderId)
  assert(eligible.eligible && eligible.blocker === null)
  assert.deepEqual(await snapshot(), before)
  mark(1)
  const commandId = key(),
    body = { expectedStatus: 'awaiting_payment', reason: 'Synthetic explicit cancellation acceptance request.' }
  const balances = await all('SELECT * FROM inventory_balances ORDER BY variant_id,location_id')
  const lines = await all('SELECT * FROM order_lines WHERE order_id = ? ORDER BY line_index', orderId)
  const cancelled = orderCancellationReceiptSchema.parse(
    await json(await request(`/api/orders/${orderId}/cancellation`, 'POST', body, input.customerCookie, commandId), 200)
  )
  assert.equal(cancelled.orderId, orderId)
  assert.equal(cancelled.commandId, commandId)
  assert.equal(cancelled.inventoryEffect, 'released')
  const afterOrder = await first('SELECT * FROM orders WHERE id = ?', orderId)
  assert.equal(afterOrder.status, 'cancelled')
  assert.deepEqual({ ...afterOrder, status: order.status, updated_at: order.updated_at }, order)
  assert.deepEqual(await all('SELECT * FROM order_lines WHERE order_id = ? ORDER BY line_index', orderId), lines)
  assert.deepEqual(await all('SELECT * FROM inventory_balances ORDER BY variant_id,location_id'), balances)
  assert.equal(
    (await first('SELECT id,status FROM inventory_reservations WHERE id = ?', reservationId)).status,
    'released'
  )
  const movements = await all('SELECT * FROM inventory_movements WHERE reference_id = ? ORDER BY id', reservationId)
  const releases = movements.filter((movement) => movement.movement_type === 'release')
  const quantities = new Map<string, number>()
  for (const line of lines) {
    assert(Number.isSafeInteger(line.quantity) && Number(line.quantity) > 0)
    const ref = JSON.stringify([line.variant_id, line.location_id])
    quantities.set(ref, (quantities.get(ref) ?? 0) + Number(line.quantity))
  }
  assert.equal(releases.length, quantities.size)
  for (const movement of releases) {
    assert.equal(movement.physical_delta, 0)
    assert.equal(movement.reference_id, reservationId)
    assert.equal(movement.reference_type, 'reservation')
    assert.equal(movement.reserved_delta, -quantities.get(JSON.stringify([movement.variant_id, movement.location_id]))!)
  }
  const commands = await all('SELECT * FROM payment_commands WHERE order_id = ? ORDER BY command_id', orderId)
  assert.equal(commands.length, 1)
  const command = commands[0]!
  assert.equal(command.command_id, commandId)
  assert.equal(command.response_status, 200)
  assert.equal(command.correlation_id, commandId)
  assert.equal(command.created_at, cancelled.updatedAt)
  assert.match(String(command.payload_hash), /^[a-f0-9]{64}$/u)
  const envelope = JSON.parse(String(command.response_body)) as Record<string, unknown>
  assert.equal(envelope.kind, 'unpaid-order-cancellation')
  assert.deepEqual(envelope.input, body)
  assert.deepEqual(orderCancellationReceiptSchema.parse(envelope.receipt), cancelled)
  const audits = (await all('SELECT * FROM order_events WHERE order_id = ? ORDER BY id', orderId)).filter(
    (event) => event.event_type === 'order.cancelled'
  )
  assert.equal(audits.length, 1)
  const audit = audits[0]!
  assert.equal(audit.id, `order-cancelled:${orderId}:${commandId}`)
  assert.equal(audit.correlation_id, commandId)
  assert.equal(audit.created_at, cancelled.updatedAt)
  assert.deepEqual(JSON.parse(String(audit.payload_json)), {
    commandId,
    payloadHash: command.payload_hash,
    ...envelope
  })
  const after = await snapshot()
  for (const table of financialTables) assert.equal(after.counts[table], before.counts[table])
  mark(2)
  const replayBefore = await snapshot(false)
  assert.deepEqual(
    orderCancellationReceiptSchema.parse(
      await json(
        await request(`/api/orders/${orderId}/cancellation`, 'POST', body, input.customerCookie, commandId),
        200
      )
    ),
    cancelled
  )
  assert.deepEqual(await snapshot(false), replayBefore)
  mark(3)
  const receiptBefore = await snapshot()
  assert.deepEqual(
    orderCancellationReceiptSchema.parse(
      await json(await request(`/api/orders/${orderId}/cancellation/commands/${commandId}`), 200)
    ),
    cancelled
  )
  assert.deepEqual(await snapshot(), receiptBefore)
  mark(4)
  const current = await json(await request(`/api/orders/${orderId}`), 200, 'no-store')
  assert.equal(current.id, orderId)
  assert.equal(current.status, 'cancelado')
  mark(5)
  const paymentBefore = await snapshot()
  const deniedPayment = await json(
    await request(
      '/api/checkout/pay',
      'POST',
      { orderId, method: 'tarjeta' },
      guestCookie + '; ' + input.customerCookie,
      key()
    ),
    409,
    'no-store'
  )
  assert.deepEqual(deniedPayment, { error: { code: 'not_payable' } })
  assert.deepEqual(await snapshot(), paymentBefore)
  mark(6)
  const deniedBefore = await snapshot()
  for (const suffix of ['', `/commands/${commandId}`]) {
    assert.deepEqual(
      await json(await request(`/api/orders/${orderId}/cancellation${suffix}`, 'GET', undefined, ''), 401),
      { error: { code: 'unauthenticated' } }
    )
    assert.deepEqual(
      await json(
        await request(`/api/orders/${orderId}/cancellation${suffix}`, 'GET', undefined, input.wrongOwnerCookie),
        404
      ),
      { error: { code: 'not_found' } }
    )
  }
  const unknownOrderId = key()
  assert.deepEqual(await json(await request(`/api/orders/${unknownOrderId}/cancellation`), 404), {
    error: { code: 'not_found' }
  })
  assert.deepEqual(
    await json(await request(`/api/orders/${orderId}/cancellation`, 'POST', body, input.wrongOwnerCookie, key()), 404),
    { error: { code: 'not_found' } }
  )
  assert.deepEqual(await snapshot(), deniedBefore)
  mark(7)
  const timelineBefore = await snapshot()
  const timeline = orderTimelineResponseSchema.parse(
    await json(await request(`/api/orders/${orderId}/timeline?limit=20`), 200)
  )
  assert.equal(timeline.orderId, orderId)
  assert.equal(timeline.audience, 'customer')
  assert(
    timeline.items.some(
      (event) =>
        event.id === 'checkout:' + audit.id &&
        event.kind === 'checkout' &&
        String(event.state) === 'cancelled' &&
        event.createdAt === cancelled.updatedAt &&
        event.validationOnly === null
    ),
    'Confirmed cancellation must appear in timeline'
  )
  assert.deepEqual(await snapshot(), timelineBefore)
  mark(8)
  return {
    orderId,
    commandId,
    scenarios: checks.length,
    checks,
    financialTablesUnchanged: true,
    physicalBalancesUnchanged: true,
    readOnlySnapshotsUnchanged: true,
    globalRowsWrittenProof: false,
    outboundNetworkGate: 'caller_owned' as const,
    productionAcceptance: false as const
  }
}
