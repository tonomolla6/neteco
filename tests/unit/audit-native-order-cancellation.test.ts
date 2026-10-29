import { describe, expect, it, vi } from 'vitest'
import {
  auditNativeOrderCancellation,
  createNativeUnpaidOrder
} from '../../scripts/lib/audit-native-order-cancellation'
import { deterministicTestData } from '../fixtures/deterministic'
const data = deterministicTestData('audit-cancellation', '2026-10-08T12:00:00Z')
const orderId = data.uuid(),
  reservationId = 'native-reservation',
  actorId = data.uuid(),
  createdAt = '2026-10-08T12:00:00Z'
function boundary() {
  const state = { cancelled: false, commandId: '', violation: '', extraWrites: 0 }
  const receipt = () => ({
    source: 'cloudflare',
    orderId,
    commandId: state.commandId,
    outcome: 'cancelled',
    orderStatus: 'cancelled',
    inventoryEffect: 'released',
    updatedAt: createdAt
  })
  const inputBody = {
    expectedStatus: 'awaiting_payment',
    reason: 'Synthetic explicit cancellation acceptance request.'
  }
  const envelope = () => ({ kind: 'unpaid-order-cancellation', actorId, input: inputBody, receipt: receipt() })
  const command = () => ({
    command_id: state.commandId,
    payload_hash: 'a'.repeat(64),
    response_status: 200,
    response_body: JSON.stringify(envelope()),
    correlation_id: state.commandId,
    created_at: createdAt
  })
  const event = () => ({
    id: `order-cancelled:${orderId}:${state.commandId}`,
    event_type: 'order.cancelled',
    payload_json: JSON.stringify({ commandId: state.commandId, payloadHash: 'a'.repeat(64), ...envelope() }),
    correlation_id: state.commandId,
    created_at: createdAt
  })
  const order = () => ({
    id: orderId,
    status: state.cancelled ? 'cancelled' : 'awaiting_payment',
    reservation_id: reservationId,
    total_gross_cents: 121,
    updated_at: createdAt
  })
  const sqlSeen: string[] = []
  const prepare = vi.fn((sql: string) => {
    sqlSeen.push(sql)
    expect(sql.trim()).toMatch(/^SELECT\b/)
    const statement = {
      bind: () => statement,
      first: async () => {
        if (sql.includes('COUNT(*)'))
          return Object.fromEntries(
            [...sql.matchAll(/ AS ([a-z_]+)/g)].map((match) => [
              match[1]!,
              [
                'payment_intents',
                'payment_events',
                'payment_fulfilment_claims',
                'payment_recovery_jobs',
                'fiscal_outbox_events',
                'refund_contracts',
                'fiscal_invoice_intents',
                'fiscal_credit_contracts'
              ].includes(match[1]!)
                ? 0
                : ['inventory_movements', 'payment_commands'].includes(match[1]!)
                  ? state.cancelled
                    ? 1
                    : 0
                  : match[1] === 'order_events'
                    ? state.cancelled
                      ? 2
                      : 1
                    : 1 + state.extraWrites
            ])
          )
        if (sql.includes('inventory_reservations'))
          return { id: reservationId, status: state.cancelled ? 'released' : 'reserved' }
        return order()
      },
      all: async () => ({
        success: true,
        meta: { rows_written: 0 },
        results: sql.includes('FROM payment_commands')
          ? state.cancelled
            ? [command()]
            : []
          : sql.includes('FROM order_events')
            ? state.cancelled
              ? [event()]
              : []
            : sql.includes('FROM inventory_movements')
              ? state.cancelled
                ? [
                    {
                      id: 'release-1',
                      movement_type: 'release',
                      physical_delta: 0,
                      reserved_delta: -1,
                      reference_type: 'reservation',
                      reference_id: reservationId,
                      variant_id: 'variant-1',
                      location_id: 'location-1'
                    }
                  ]
                : []
              : sql.includes('FROM orders')
                ? [order()]
                : sql.includes('FROM order_lines')
                  ? [{ variant_id: 'variant-1', location_id: 'location-1', quantity: 1, unit_gross_cents: 121 }]
                  : sql.includes('FROM inventory_balances')
                    ? [{ variant_id: 'variant-1', location_id: 'location-1', physical_quantity: 100 }]
                    : /FROM (?:payment_intents|payment_events|payment_fulfilment_claims|payment_recovery_jobs|fiscal_outbox_events|refund_contracts|fiscal_invoice_intents|fiscal_credit_contracts)/.test(
                          sql
                        )
                      ? []
                      : [{ value: 'unchanged' }]
      })
    }
    return statement
  })
  const dispatch = vi.fn(async (request: Request) => {
    const url = new URL(request.url),
      cookie = request.headers.get('cookie') ?? ''
    const headers: Record<string, string> = { 'cache-control': 'private, no-store' }
    if (state.violation === 'cache' && url.pathname.includes('cancellation'))
      headers['cache-control'] = 'public, max-age=30'
    if (state.violation === 'cookie' && url.pathname.includes('cancellation')) headers['set-cookie'] = 'unexpected=1'
    const json = (body: unknown, status = 200) => Response.json(body, { status, headers })
    if (url.pathname === '/api/cart')
      return Response.json(
        { version: 1 },
        { headers: { 'set-cookie': `neteco-cart-v2=v1.${data.uuid()}.secret; HttpOnly` } }
      )
    if (url.pathname === '/api/cart/items') return json({ version: 2 })
    if (url.pathname === '/api/shipping/rates')
      return json({
        cartVersion: 2,
        rates: [
          {
            serviceCode: 'pickup',
            quoteId: 'quote',
            shippingQuoteId: 'shipping',
            optionIndex: 0,
            optionHash: 'hash',
            totalGrossCents: 121
          }
        ]
      })
    if (url.pathname === '/api/orders' && request.method === 'POST') {
      expect(cookie).toContain('session=owner')
      return Response.json(
        { id: orderId },
        { status: 201, headers: { 'set-cookie': `neteco-order-access-v2=v1.${orderId}.secret; HttpOnly` } }
      )
    }
    if (url.pathname === '/api/checkout/pay')
      return json(
        { error: { code: state.violation === 'pay_redirect' ? 'unexpected' : 'not_payable' } },
        state.violation === 'pay_redirect' ? 200 : 409
      )
    if (url.pathname.includes('cancellation')) {
      if (!cookie) return json({ error: { code: 'unauthenticated' } }, 401)
      if (cookie === 'session=other') return json({ error: { code: 'not_found' } }, 404)
      if (!url.pathname.includes(orderId)) return json({ error: { code: 'not_found' } }, 404)
      if (request.method === 'POST') {
        expect(await request.json()).toEqual(inputBody)
        const key = request.headers.get('idempotency-key')!
        if (state.cancelled) expect(key).toBe(state.commandId)
        state.commandId = key
        state.cancelled = true
        return json(state.violation === 'wrong_receipt' ? { ...receipt(), orderId: data.uuid() } : receipt())
      }
      if (url.pathname.includes('/commands/'))
        return json(
          state.violation === 'unknown_receipt'
            ? { source: 'cloudflare', orderId, commandId: state.commandId, outcome: 'unknown' }
            : receipt()
        )
      if (state.violation === 'read_write') state.extraWrites++
      return json({
        source: 'cloudflare',
        orderId,
        eligible: true,
        blocker: null,
        orderStatus: 'awaiting_payment',
        paymentStatus: null,
        reservationStatus: 'reserved'
      })
    }
    if (url.pathname.endsWith('/timeline'))
      return json({
        source: 'cloudflare',
        orderId,
        audience: 'customer',
        items: [
          {
            id: `checkout:order-cancelled:${orderId}:${state.commandId}`,
            kind: 'checkout',
            state: state.violation === 'timeline_missing' ? 'created' : 'cancelled',
            createdAt,
            validationOnly: null
          }
        ],
        nextCursor: null
      })
    return json({ id: orderId, status: state.violation === 'order_paid' ? 'pagado' : 'cancelado' })
  })
  return {
    state,
    dispatch,
    sqlSeen,
    input: {
      dispatch,
      database: { prepare } as unknown as D1Database,
      origin: 'https://shop-audit.neteco.test',
      variantId: 1,
      quantity: 1,
      customerCookie: 'session=owner',
      wrongOwnerCookie: 'session=other',
      randomUUID: () => data.uuid()
    }
  }
}
describe('unpaid order cancellation acceptance boundary (not live workerd evidence)', () => {
  it('awaits explicit inventory preparation before the original four HTTP requests', async () => {
    const f = boundary()
    let prepared = false
    const dispatch = vi.fn(async (request: Request) => {
      expect(prepared).toBe(true)
      return f.dispatch(request)
    })
    const prepareInventory = vi.fn(async () => {
      expect(dispatch).not.toHaveBeenCalled()
      await Promise.resolve()
      prepared = true
    })
    const input = { ...f.input, dispatch, prepareInventory }
    expect(await createNativeUnpaidOrder(input)).toMatchObject({ orderId })
    expect(prepareInventory).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls.map(([request]) => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', '/api/cart'],
      ['POST', '/api/cart/items'],
      ['POST', '/api/shipping/rates'],
      ['POST', '/api/orders']
    ])
    expect(f.sqlSeen).toHaveLength(0)
  })
  it('dispatches no HTTP requests when explicit inventory preparation fails', async () => {
    const f = boundary()
    const preparationError = new Error('synthetic_inventory_preparation_refused')
    const prepareInventory = vi.fn(async () => {
      throw preparationError
    })
    const input = { ...f.input, prepareInventory }
    await expect(createNativeUnpaidOrder(input)).rejects.toBe(preparationError)
    expect(prepareInventory).toHaveBeenCalledTimes(1)
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.sqlSeen).toHaveLength(0)
  })
  it('reports the actual checkout HTTP409 before requiring a success-only guest cookie', async () => {
    const f = boundary()
    const dispatch = vi.fn(async (request: Request) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/api/orders')
        return Response.json({ error: { code: 'out_of_stock' } }, { status: 409 })
      return f.dispatch(request)
    })
    await expect(createNativeUnpaidOrder({ ...f.input, dispatch })).rejects.toMatchObject({
      actual: 409,
      expected: 201
    })
    expect(dispatch).toHaveBeenCalledTimes(4)
    expect(f.sqlSeen).toHaveLength(0)
  })
  it('creates an unpaid order with the original four HTTP commands, no SQL or payment/cancellation side effects', async () => {
    const f = boundary()
    const result = await createNativeUnpaidOrder(f.input)
    expect(result).toEqual({ orderId, guestCookie: `neteco-order-access-v2=v1.${orderId}.secret` })
    expect(f.dispatch.mock.calls.map(([request]) => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', '/api/cart'],
      ['POST', '/api/cart/items'],
      ['POST', '/api/shipping/rates'],
      ['POST', '/api/orders']
    ])
    expect(f.sqlSeen).toHaveLength(0)
    expect(f.state.cancelled).toBe(false)
    const add = f.dispatch.mock.calls[1]![0]
    expect(add.headers.get('X-Neteco-Cart-Id')).toMatch(/^[a-f0-9-]{36}$/)
    expect(await add.clone().json()).toMatchObject({ variantId: 1, quantity: 1, expectedVersion: 1 })
  })
  it('drives a real HTTP checkout contract then nine verified cancellation scenarios', async () => {
    const f = boundary(),
      marks: string[] = []
    const result = await auditNativeOrderCancellation({ ...f.input, scenario: (name) => marks.push(name) })
    expect(result).toMatchObject({
      orderId,
      scenarios: 9,
      productionAcceptance: false,
      outboundNetworkGate: 'caller_owned'
    })
    expect(marks).toHaveLength(9)
    expect(f.sqlSeen.every((sql) => /^SELECT\b/.test(sql))).toBe(true)
    expect(f.dispatch).toHaveBeenCalled()
    expect(f.dispatch).toHaveBeenCalledTimes(17)
  })
  it.each([
    'cache',
    'cookie',
    'wrong_receipt',
    'unknown_receipt',
    'read_write',
    'pay_redirect',
    'timeline_missing',
    'order_paid'
  ])('rejects concrete acceptance violation %s', async (violation) => {
    const f = boundary()
    f.state.violation = violation
    const marks: string[] = []
    await expect(auditNativeOrderCancellation({ ...f.input, scenario: (name) => marks.push(name) })).rejects.toThrow()
    const reached: Record<string, number> = {
      cache: 1,
      cookie: 1,
      wrong_receipt: 2,
      unknown_receipt: 4,
      read_write: 1,
      pay_redirect: 6,
      timeline_missing: 8,
      order_paid: 5
    }
    expect(marks).toHaveLength(reached[violation]!)
  })
  it.each(['https://neteco.es', 'http://shop-audit.neteco.test', 'https://shop-audit.neteco.test/path'])(
    'rejects nonisolated origin %s before dispatch or SQL',
    async (origin) => {
      const f = boundary()
      await expect(auditNativeOrderCancellation({ ...f.input, origin })).rejects.toThrow()
      expect(f.dispatch).not.toHaveBeenCalled()
      expect(f.sqlSeen).toHaveLength(0)
    }
  )
})
