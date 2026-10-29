import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { issueD1SessionCookie, verifySessionCookie } from '../../workers/auth/session-cookie'
import { handleAdminPromotionsHttp } from '../../workers/catalog/admin-promotions-http'
import { handleStorefrontShippingHttp } from '../../workers/catalog/storefront-shipping'
import { handleStorefrontCheckoutHttp } from '../../workers/catalog/storefront-checkout'
import { handleCartCommand } from '../../workers/cart-coordinator'
import { createCart, setCartLine } from '../../workers/catalog/cart'
import { adminPromotionIntentHash } from '../../shared/admin-promotions'
import { promotionBasketPreviewResponseSchema } from '../../shared/promotion-basket-preview'
import {
  PROMOTIONS_BROWSER_SCENARIOS,
  auditNativePromotionsBrowser,
  createPromotionsBrowserBridge
} from '../../scripts/lib/audit-native-promotions-browser'

const connection = vi.hoisted(() => vi.fn())
vi.mock('../../scripts/lib/remote-test-browser', () => ({
  connectRemoteTestBrowser: connection,
  REMOTE_BROWSER_NOT_RUN_REASON: 'explicitly not run'
}))
const origin = 'https://shop-audit.neteco.test'
const configuration = { password: 'synthetic-promotion-browser-session-password-over32', maxAgeSeconds: 3600 }
let fixture: Awaited<ReturnType<typeof returnsFixture>>
let adminCookie: string, customerCookie: string, cartCookie: string, cartId: string
let dispatch: (request: Request) => Promise<Response>
beforeEach(async () => {
  connection.mockReset()
  fixture = await returnsFixture()
  for (const file of ['0072_promotions.sql', '0073_promotion_admin_commands.sql', '0074_order_purchase_reference.sql'])
    await fixture.database.batch(
      splitDemoSql(await readFile('db/d1/migrations/' + file, 'utf8')).map((sql) => fixture.database.prepare(sql))
    )
  fixture.sqlite.exec(
    "INSERT OR IGNORE INTO permissions VALUES('catalog.write','catalog','write','Synthetic'); INSERT INTO role_permissions VALUES('operator','catalog.write')"
  )
  adminCookie = (await issueD1SessionCookie(fixture.database, CLAIMS, configuration))!.split(';')[0]!
  customerCookie = (await issueD1SessionCookie(fixture.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
  const cart = await createCart(fixture.database, { now: utc(), correlationId: 'browser-coupon-fixture' })
  cartId = cart.cartId
  cartCookie = `neteco-cart-v2=v1.${cart.cartId}.${cart.token}`
  await setCartLine(fixture.database, {
    ...cart,
    variantId: 'v-1-1',
    quantity: 2,
    expectedVersion: 1,
    idempotencyKey: randomUUID(),
    now: utc(),
    correlationId: 'browser-coupon-fixture'
  })
  const responses = new Map<string, { payloadHash: string; status: number; body: unknown }>()
  const commandDispatch = async (command: Record<string, unknown>) => {
    const result = await handleCartCommand(command, {
      database: fixture.database,
      getResponse: async (key) => responses.get(key),
      putResponse: async (key, value) => {
        responses.set(key, value)
      },
      setAlarm: async () => {}
    })
    return Response.json(result.body, { status: result.status })
  }
  const deps = {
    database: fixture.database,
    dispatch: commandDispatch,
    origin,
    sessionCookieConfiguration: configuration,
    authenticationEnabled: true,
    session: (request: Request) => verifySessionCookie(request, configuration),
    edgeLimiter: { limit: async () => ({ success: true }) },
    rateLimitPepper: 'synthetic-promotion-browser-edge-pepper-over32',
    paymentConfiguration: () => ({
      environment: 'sandbox' as const,
      merchantCode: '999008881',
      terminal: '001',
      secretKey: 'synthetic-not-used',
      merchantName: 'NETECO',
      bizumEnabled: false,
      publicBaseUrl: origin
    })
  }
  dispatch = async (request) =>
    (await handleAdminPromotionsHttp(request, deps)) ??
    (await handleStorefrontShippingHttp(request, deps)) ??
    (await handleStorefrontCheckoutHttp(request, deps)) ??
    new Response(null, { status: 404 })
})
afterEach(() => fixture?.sqlite.close())
const prepared = () => ({
  customerCookie,
  cartCookie,
  cartId,
  code: 'BROWSER101',
  startsAt: '2020-01-01T00:00:00Z',
  quantity: 2,
  goodsGrossCents: 1000,
  discountGrossCents: 101,
  variantId: 'v-1-1',
  sku: 'SKU-1-1',
  customerId: CUSTOMER
})
const setup = (override: Partial<{ dispatch: typeof dispatch; purchaseOrderReference: string }> = {}) =>
  createPromotionsBrowserBridge({
    database: fixture.database,
    origin,
    adminCookie,
    ...prepared(),
    dispatch,
    ...override
  })
const request = (
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = adminCookie,
  key = randomUUID(),
  hash?: string
) =>
  new Request(origin + path, {
    method,
    headers: {
      Origin: origin,
      Cookie: cookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      'CF-Connecting-IP': '192.0.2.173',
      ...(hash ? { 'X-Neteco-Command-Payload-Hash': hash } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
async function activate(bridge: Awaited<ReturnType<typeof setup>>) {
  const initial = {
    expectedVersion: 0,
    reason: 'Synthetic explicit browser campaign',
    rule: {
      id: randomUUID(),
      version: 1,
      code: 'BROWSER101',
      status: 'paused',
      channel: 'online',
      startsAt: '2020-01-01T00:00:00Z',
      endsAt: null,
      benefit: { kind: 'fixed', grossCents: 101 },
      scope: { kind: 'all' },
      segment: 'registered',
      totalLimit: null,
      perCustomerLimit: 1,
      volumeMode: 'stack_volume'
    }
  }
  const created = await bridge.forward(request('/api/admin/promotions', 'POST', initial))
  expect(created.action).toBe('fulfill')
  if (created.action !== 'fulfill') throw new Error('expected_real_receipt')
  expect(created.response.status).toBe(201)
  const body = { ...initial, expectedVersion: 1, rule: { ...initial.rule, version: 2, status: 'active' } },
    key = randomUUID()
  expect(await bridge.forward(request('/api/admin/promotions/' + body.rule.id, 'PUT', body, adminCookie, key))).toEqual(
    { action: 'abort', reason: 'proven_promotion_activation_response_lost' }
  )
  expect(
    fixture.sqlite.prepare('SELECT current_version FROM promotion_rules WHERE id=?').get(body.rule.id)?.current_version
  ).toBe(2)
  await bridge.forward(
    request(
      '/api/admin/promotions/commands/' + key,
      'GET',
      undefined,
      adminCookie,
      randomUUID(),
      await adminPromotionIntentHash(body)
    )
  )
  await bridge.forward(request('/api/admin/promotions/' + body.rule.id))
  return body.rule.id
}
async function checkout(bridge: Awaited<ReturnType<typeof setup>>, purchaseOrderReference?: string) {
  if (bridge.state().basketPreviews === 0) {
    const rule = JSON.parse(
      String(fixture.sqlite.prepare('SELECT rule_json FROM promotion_rule_versions WHERE version=2').get()?.rule_json)
    )
    const preview = await bridge.forward(
      request('/api/admin/promotions/basket-preview', 'POST', {
        lines: [{ variantId: 'v-1-1', quantity: 2 }],
        destination: { postalCode: '46870', city: 'Ontinyent' },
        customerId: CUSTOMER,
        rule
      })
    )
    expect(preview.action).toBe('fulfill')
  }
  const cookie = cartCookie + '; ' + customerCookie
  const shipping = await bridge.forward(
    request('/api/shipping/rates', 'POST', { postalCode: '46870', city: 'Ontinyent', couponCode: 'BROWSER101' }, cookie)
  )
  if (shipping.action !== 'fulfill') throw new Error('expected_shipping')
  expect(shipping.response.status).toBe(200)
  const rates = (await shipping.response.json()) as {
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
  const rate = rates.rates.find((item) => item.serviceCode === 'pickup')!
  expect(rate.totalGrossCents).toBe(899)
  const address = {
    recipientName: 'Synthetic buyer',
    line1: 'Synthetic street 1',
    postalCode: '46870',
    city: 'Ontinyent',
    region: 'Valencia',
    countryCode: 'ES',
    phone: '600000000'
  }
  const body = {
    ...(purchaseOrderReference ? { purchaseOrderReference } : {}),
    cartId,
    cartVersion: rates.cartVersion,
    quoteId: rate.quoteId,
    shippingQuoteId: rate.shippingQuoteId,
    optionIndex: rate.optionIndex,
    optionHash: rate.optionHash,
    expectedTotalGrossCents: 899,
    customer: { name: 'Synthetic buyer', email: 'buyer@example.invalid', phone: '600000000' },
    shippingAddress: address,
    billingAddress: address,
    paymentMethod: 'tarjeta',
    termsAccepted: true,
    privacyNoticePresented: true,
    marketingConsent: false
  }
  expect(await bridge.forward(request('/api/orders', 'POST', body, cookie))).toEqual({
    action: 'abort',
    reason: 'proven_coupon_order_response_lost'
  })
  await bridge.forward(request('/api/checkout/recover', 'GET', undefined, cookie))
}
it('refuses to lose a committed response when independent SQL contains a different PO', async () => {
  const bridge = await setup({ purchaseOrderReference: 'PO-EXPECTED' })
  await activate(bridge)
  await expect(checkout(bridge, 'PO-DIFFERENT')).rejects.toThrow()
  expect(fixture.sqlite.prepare('SELECT purchase_order_reference FROM orders').get()?.purchase_order_reference).toBe(
    'PO-DIFFERENT'
  )
  expect(bridge.state().lostResponses).toBe(1)
  expect(bridge.state().orderId).toBeNull()
})
it('forwards an admin-only basket simulation from real catalog costs without writing domain state', async () => {
  const bridge = await setup()
  const ruleId = await activate(bridge)
  const rule = JSON.parse(
    String(
      fixture.sqlite.prepare('SELECT rule_json FROM promotion_rule_versions WHERE rule_id=? AND version=2').get(ruleId)
        ?.rule_json
    )
  )
  const tables = [
    'carts',
    'cart_lines',
    'checkout_quotes',
    'shipping_quotes',
    'orders',
    'promotion_rules',
    'promotion_rule_versions',
    'promotion_redemptions',
    'promotion_admin_commands',
    'inventory_balances',
    'inventory_movements'
  ]
  const snapshot = () => tables.map((table) => [table, fixture.sqlite.prepare('SELECT * FROM ' + table).all()])
  const before = snapshot()
  const result = await bridge.forward(
    request('/api/admin/promotions/basket-preview', 'POST', {
      lines: [{ variantId: 'v-1-1', quantity: 2 }],
      destination: { postalCode: '46870', city: 'Ontinyent' },
      customerId: CUSTOMER,
      rule
    })
  )
  expect(result.action).toBe('fulfill')
  if (result.action !== 'fulfill') throw new Error('expected_actual_preview')
  expect(result.response.status).toBe(200)
  const preview = promotionBasketPreviewResponseSchema.parse(await result.response.json())
  expect(preview.totals.proposed.grossCents).toBe(899)
  const cost = fixture.sqlite.prepare("SELECT cost_net_cents FROM variants WHERE id='v-1-1'").get()?.cost_net_cents
  expect(preview.lines[0]?.costNetCents).toBe(cost === null ? null : Number(cost) * 2)
  expect(snapshot()).toEqual(before)
})
it('never dispatches a private-cost preview from the buyer transport', async () => {
  let dispatches = 0
  const bridge = await setup({
    dispatch: async (request) => {
      dispatches++
      return dispatch(request)
    }
  })
  const before = dispatches
  expect(await bridge.forward(request('/api/admin/promotions/basket-preview', 'POST', {}, customerCookie))).toEqual({
    action: 'abort',
    reason: 'forbidden_write'
  })
  expect(dispatches).toBe(before)
})
it('proves the original PO from SQL before losing and recovering the actual order response', async () => {
  const bridge = await setup({ purchaseOrderReference: 'PO-MATCHING' })
  await activate(bridge)
  await checkout(bridge, 'PO-MATCHING')
  expect(await bridge.assertComplete()).toMatchObject({ orderRecovered: true, lostResponses: 2 })
  expect(fixture.sqlite.prepare('SELECT purchase_order_reference FROM orders').get()?.purchase_order_reference).toBe(
    'PO-MATCHING'
  )
})
it('declares two full journeys and not-run performs no preparation, connection, dispatch or D1 access', async () => {
  const prepare = vi.fn(),
    send = vi.fn(),
    database = { prepare: vi.fn() } as unknown as D1Database
  expect(PROMOTIONS_BROWSER_SCENARIOS).toHaveLength(2)
  expect(new Set(PROMOTIONS_BROWSER_SCENARIOS).size).toBe(2)
  expect(
    await auditNativePromotionsBrowser({
      origin,
      database,
      dispatch: send,
      adminCookie,
      prepare,
      browserMode: 'not-run'
    })
  ).toMatchObject({ scenarios: 0, browserExecuted: false, viewports: [] })
  expect(prepare).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  expect(connection).not.toHaveBeenCalled()
  expect(database.prepare).not.toHaveBeenCalled()
})
it('required without a private browser rejects before fixture preparation', async () => {
  connection.mockRejectedValue(new Error('remote_browser_endpoint_required'))
  const prepare = vi.fn()
  await expect(
    auditNativePromotionsBrowser({
      origin,
      database: fixture.database,
      dispatch,
      adminCookie,
      prepare,
      browserMode: 'required'
    })
  ).rejects.toThrow('remote_browser_endpoint_required')
  expect(prepare).not.toHaveBeenCalled()
})
it('drops only a committed activation and confirms its exact durable receipt plus live rule', async () => {
  const bridge = await setup()
  await activate(bridge)
  expect(bridge.state()).toMatchObject({
    adminCreates: 1,
    adminUpdates: 1,
    adminRecovered: true,
    lostResponses: 1,
    orderPosts: 0
  })
  expect(fixture.sqlite.prepare('SELECT count(*) n FROM orders').get()?.n).toBe(0)
  expect(fixture.sqlite.prepare('SELECT count(*) n FROM promotion_admin_commands').get()?.n).toBe(2)
})
it('recovers an actual discounted order once, keeps one redemption, and never dispatches payment', async () => {
  const bridge = await setup()
  await activate(bridge)
  await checkout(bridge)
  expect(await bridge.assertComplete()).toMatchObject({
    adminRecovered: true,
    orderRecovered: true,
    adminCreates: 1,
    adminUpdates: 1,
    orderPosts: 1,
    lostResponses: 2,
    paymentPosts: 0
  })
  expect(fixture.sqlite.prepare('SELECT count(*) n FROM orders').get()?.n).toBe(1)
  expect(fixture.sqlite.prepare('SELECT discount_gross_cents FROM promotion_redemptions').all()).toEqual([
    { discount_gross_cents: 101 }
  ])
  expect(fixture.sqlite.prepare('SELECT count(*) n FROM payment_intents').get()?.n).toBe(0)
})
it('blocks payment and external writes before dispatch rather than fabricating provider success', async () => {
  const send = vi.fn(dispatch),
    bridge = await setup({ dispatch: send })
  send.mockClear()
  expect(
    await bridge.forward(request('/api/checkout/pay', 'POST', { orderId: randomUUID(), method: 'tarjeta' }))
  ).toMatchObject({ action: 'abort', reason: 'forbidden_write' })
  expect(await bridge.forward(new Request('https://provider.invalid/payment', { method: 'POST' }))).toMatchObject({
    action: 'abort',
    reason: 'external_request'
  })
  expect(send).not.toHaveBeenCalled()
})
it('does not relabel a real unavailable response as a proven lost committed response', async () => {
  const bridge = await setup({
    dispatch: async (request) =>
      request.method === 'PUT' ? Response.json({ error: { code: 'internal' } }, { status: 503 }) : dispatch(request)
  })
  await expect(activate(bridge)).rejects.toThrow()
  expect(bridge.state()).toMatchObject({ lostResponses: 0, adminRecovered: false })
  expect(fixture.sqlite.prepare('SELECT current_version FROM promotion_rules').get()?.current_version).toBe(1)
})
