import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { REDSYS_OFFICIAL_CONTRACT } from '../../tests/fixtures/redsys-official'
import { encodeMerchantParameters, signMerchantParameters } from '../../workers/payments/redsys'

/** A bank callback signed with the published sandbox fixture, dispatched only
 * inside disposable workerd. No bank request or production credential exists. */
export async function auditNativeCheckoutPayment(input: {
  dispatch: (request: Request) => Promise<Response>
  database: D1Database
  origin: string
  variantId: number
  quantity: number
  /** Explicitly selected from the actual quoted services, never list order. */
  shippingMethod?: 'pickup' | 'own_delivery' | 'parcel'
  /** Existing authenticated customer, never a retroactive SQL owner claim. */
  ownerCookie?: string
  scenario: (name: string) => void
}): Promise<{ orderId: string; guestCookie: string; scenarios: number }> {
  const { dispatch, database, origin, scenario } = input
  assert.equal(new URL(origin).hostname, 'shop-audit.neteco.test')
  const request = (path: string, method = 'GET', body?: unknown, cookie?: string, key?: string) =>
    dispatch(
      new Request(`${origin}${path}`, {
        method,
        headers: {
          'cf-connecting-ip': '192.0.2.123',
          ...(cookie || input.ownerCookie ? { cookie: [cookie, input.ownerCookie].filter(Boolean).join('; ') } : {}),
          ...(body ? { origin, 'content-type': 'application/json' } : {}),
          ...(key ? { 'idempotency-key': key } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual'
      })
    )
  const cookieFrom = (response: Response, name: string) => {
    const value = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${name}=`))
      ?.split(';')[0]
    assert(value)
    return value
  }
  scenario('real_native_checkout_contract_reservation_and_replay_create_cart')
  const empty = await request('/api/cart')
  assert.equal(empty.status, 200)
  const cartCookie = cookieFrom(empty, 'neteco-cart-v2')
  const cart = (await empty.json()) as { version: number }
  scenario('real_native_checkout_contract_reservation_and_replay_add_item')
  const added = await request(
    '/api/cart/items',
    'POST',
    {
      variantId: input.variantId,
      quantity: input.quantity,
      expectedVersion: cart.version,
      idempotencyKey: randomUUID()
    },
    cartCookie
  )
  assert.equal(added.status, 200)
  scenario('real_native_checkout_contract_reservation_and_replay_shipping_rates')
  const quoted = await request(
    '/api/shipping/rates',
    'POST',
    { postalCode: '46870', city: 'Ontinyent' },
    cartCookie,
    randomUUID()
  )
  assert.equal(quoted.status, 200)
  const shipping = (await quoted.json()) as {
    cartVersion: number
    rates: Array<{
      serviceCode: string
      quoteId: string
      shippingQuoteId: string
      optionIndex: number
      optionHash: string
      totalGrossCents: number
    }>
  }
  assert(shipping.rates.length > 0)
  const option = input.shippingMethod
    ? shipping.rates.find((rate) => rate.serviceCode === input.shippingMethod)
    : shipping.rates[0]
  assert(option, 'Requested native shipping service must actually be quoted')
  const cartId = cartCookie.match(/v1\.([0-9a-f-]{36})\./)?.[1]
  assert(cartId)
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
  const body = {
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
  const key = randomUUID()
  scenario('real_native_checkout_contract_reservation_and_replay_create_order')
  const created = await request('/api/orders', 'POST', body, cartCookie, key)
  assert.equal(created.status, 201)
  const guestCookie = cookieFrom(created, 'neteco-order-access-v2')
  const receipt = await created.text()
  const orderId = (JSON.parse(receipt) as { id: string }).id
  assert.match(orderId, /^[0-9a-f-]{36}$/)
  scenario('real_native_checkout_contract_reservation_and_replay_replay_order')
  const replay = await request('/api/orders', 'POST', body, cartCookie, key)
  assert.equal(replay.status, 201)
  assert.equal(await replay.text(), receipt)
  scenario('real_native_checkout_contract_reservation_and_replay_reservation_readback')
  const reservation = await database
    .prepare(`SELECT r.id,r.status FROM orders o JOIN inventory_reservations r ON r.id=o.reservation_id WHERE o.id=?`)
    .bind(orderId)
    .first<{ id: string; status: string }>()
  assert.equal(reservation?.status, 'reserved')
  assert.equal(
    (await database.prepare('SELECT COUNT(*) AS n FROM orders WHERE cart_id=?').bind(cartId).first<{ n: number }>())?.n,
    1
  )

  scenario('real_native_signed_synthetic_bank_callback_assigns_exactly_once')
  const started = await request('/api/checkout/pay', 'POST', { orderId, method: 'tarjeta' }, guestCookie, randomUUID())
  assert.equal(started.status, 200)
  const redirect = (await started.json()) as { ok: boolean; redirect: { actionUrl: string } }
  assert.equal(redirect.ok, true)
  assert.equal(redirect.redirect.actionUrl, 'https://sis-t.redsys.es:25443/sis/realizarPago')
  // Inspect the persisted intent, not any untrusted customer-supplied amounts.
  const intent = await database
    .prepare('SELECT merchant_order,amount_gross_cents FROM payment_intents WHERE order_id=?')
    .bind(orderId)
    .first<{ merchant_order: string; amount_gross_cents: number }>()
  assert(intent)
  const sandbox = REDSYS_OFFICIAL_CONTRACT.sandbox
  const parameters = encodeMerchantParameters({
    Ds_Order: intent.merchant_order,
    Ds_Amount: String(intent.amount_gross_cents),
    Ds_Currency: sandbox.currency,
    Ds_MerchantCode: sandbox.merchantCode,
    Ds_Terminal: sandbox.terminal,
    Ds_TransactionType: '0',
    Ds_Response: '0000'
  })
  const notification = new URLSearchParams({
    Ds_MerchantParameters: parameters,
    Ds_SignatureVersion: 'HMAC_SHA512_V2',
    Ds_Signature: await signMerchantParameters(parameters, sandbox.secretKey)
  }).toString()
  const notify = () =>
    dispatch(
      new Request(`${origin}/api/payments/redsys/notification`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: notification
      })
    )
  const first = await notify()
  assert.equal(first.status, 200)
  assert.equal(await first.text(), 'OK')
  const after = await database
    .prepare(
      `SELECT r.status,p.status AS payment FROM orders o JOIN inventory_reservations r ON r.id=o.reservation_id
     JOIN order_payment_states p ON p.order_id=o.id WHERE o.id=?`
    )
    .bind(orderId)
    .first<{ status: string; payment: string }>()
  assert.deepEqual(after, { status: 'assigned', payment: 'paid' })
  const allocationCount = () =>
    database
      .prepare(
        "SELECT COUNT(*) AS n FROM inventory_movements WHERE reference_type='reservation' AND reference_id=? AND movement_type='allocate'"
      )
      .bind(reservation!.id)
      .first<{ n: number }>()
  const beforeReplay = await allocationCount()
  assert.equal(beforeReplay?.n, 1)
  assert.equal((await notify()).status, 200)
  assert.deepEqual(await allocationCount(), beforeReplay)
  return { orderId, guestCookie, scenarios: 2 }
}
