import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { renderD1ShippingSeed } from '../../scripts/lib/d1-shipping-seed'
import { handleCartCommand } from '../../workers/cart-coordinator'
import { handleStorefrontCartHttp } from '../../workers/catalog/storefront-cart'
import { handleStorefrontShippingHttp } from '../../workers/catalog/storefront-shipping'
import { handleStorefrontCheckoutHttp, revokeStorefrontCredentials } from '../../workers/catalog/storefront-checkout'
import { getOrderView } from '../../workers/catalog/checkout'
import {
  initiateRedsysPayment,
  processRedsysNotification,
  type PaymentRuntimeConfiguration
} from '../../workers/catalog/payments'
import { encodeMerchantParameters, signMerchantParameters } from '../../workers/payments/redsys'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'
import { applyGeneratedSeed, d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { executeD1AdminFulfillmentCommand } from '../../workers/fulfillment/admin'
import { testUuid } from '../support/deterministic'

const OWNER = '10000000-0000-4000-8000-000000000043'
const CUSTOMER = '30000000-0000-4000-8000-000000000043'
const SESSION = '20000000-0000-4000-8000-000000000043'
const CLAIMS = { identityId: OWNER, sessionId: SESSION, sessionVersion: 1 }

const NOW = '2026-08-25T09:00:00Z'
const ORIGIN = 'https://shop.neteco.test'
const SHIPPING_KEY = '550e8400-e29b-41d4-a716-446655440001'
const ORDER_KEY = '550e8400-e29b-41d4-a716-446655440002'
const PAYMENT_KEY = '550e8400-e29b-41d4-a716-446655440003'
const databases: DatabaseSync[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

async function world(authenticated = false) {
  const sqlite = await openMigratedDatabase()
  databases.push(sqlite)
  seedInventoryFixture(sqlite)
  applyGeneratedSeed(sqlite, renderD1ShippingSeed())
  const database = d1OverSqlite(sqlite)
  // Explicit fixture clock also governs execution-time SQLite guards; the
  // actual workerd test below uses D1's real clock without substitution.
  const prepare = database.prepare.bind(database)
  database.prepare = (sql: string) => prepare(sql.replaceAll("'now'", `'${NOW}'`))
  if (authenticated)
    sqlite.exec(`
    INSERT INTO customers(id,created_at,updated_at) VALUES('${CUSTOMER}','${NOW}','${NOW}');
    INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at)
      VALUES('${OWNER}','ada@example.test','synthetic','${NOW}','active','${CUSTOMER}','${NOW}','${NOW}');
    INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
      VALUES('${SESSION}','${OWNER}',1,1,'${NOW}','2099-01-01T00:00:00Z');
    INSERT INTO roles VALUES('storefront_operator','Synthetic','Synthetic');
    INSERT OR IGNORE INTO permissions VALUES('administration.manage','administration','manage','Synthetic');
    INSERT INTO role_permissions VALUES('storefront_operator','administration.manage');
    INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES('${OWNER}','storefront_operator','${NOW}');
  `)
  await provisionPublicationValidityFixture(database, {
    productIds: ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6'],
    now: '2026-01-01T00:00:00Z'
  })
  const responses = new Map<string, { payloadHash: string; status: number; body: unknown }>()
  const dispatch = async (command: Record<string, unknown>) => {
    const result = await handleCartCommand(command, {
      database,
      getResponse: async (key) => responses.get(`${command.cartId}:${key}`),
      putResponse: async (key, value) => {
        responses.set(`${command.cartId}:${key}`, value)
      },
      setAlarm: async () => {}
    })
    return Response.json(result.body, { status: result.status })
  }
  const edgeLimiter = { limit: async () => ({ success: true }) } as unknown as RateLimit
  const shared = {
    database,
    dispatch,
    edgeLimiter,
    rateLimitPepper: 'test-checkout-edge-pepper-0123456789abcdef',
    now: () => NOW
  }
  const config = {
    environment: 'sandbox' as const,
    merchantCode: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
    terminal: '1',
    secretKey: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey,
    merchantName: 'NETECO',
    bizumEnabled: true,
    publicBaseUrl: ORIGIN
  }
  const deps = {
    ...shared,
    paymentConfiguration: () => config,
    session: async () => (authenticated ? CLAIMS : null),
    authenticationEnabled: authenticated
  }
  const request = (path: string, body: Record<string, unknown>, cookie?: string, key = ORDER_KEY, origin = ORIGIN) =>
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        'cf-connecting-ip': '192.0.2.22',
        'content-type': 'application/json',
        'idempotency-key': key,
        origin,
        ...(cookie ? { cookie } : {})
      },
      body: JSON.stringify(body)
    })
  const created = await handleStorefrontCartHttp(
    new Request(`${ORIGIN}/api/cart`, { headers: { 'cf-connecting-ip': '192.0.2.22' } }),
    shared
  )
  if (!created || created.status !== 200) throw new Error('Cart creation failed')
  const cartCookie = created.headers.get('set-cookie')!.split(';')[0]!
  const added = await handleStorefrontCartHttp(
    request(
      '/api/cart/items',
      { variantId: 11, quantity: 2, expectedVersion: 1, idempotencyKey: 'checkout-add' },
      cartCookie
    ),
    shared
  )
  if (!added || added.status !== 200) throw new Error('Cart mutation failed')
  const shipping = await handleStorefrontShippingHttp(
    request('/api/shipping/rates', { postalCode: '46870', city: 'Ontinyent' }, cartCookie, SHIPPING_KEY),
    shared
  )
  if (!shipping || shipping.status !== 200) throw new Error(`Shipping failed: ${await shipping?.text()}`)
  const shippingBody = (await shipping.json()) as {
    cartVersion: number
    rates: Array<{
      quoteId: string
      shippingQuoteId: string
      optionIndex: number
      serviceCode: string
      optionHash: string
      totalGrossCents: number
    }>
  }
  const rate = authenticated
    ? shippingBody.rates.find((rate) => rate.serviceCode === 'own_delivery')!
    : shippingBody.rates[0]!
  const address = {
    recipientName: 'Ada Compradora',
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
    cartId: cartCookie.match(/v1\.([0-9a-f-]{36})\./)![1]!,
    cartVersion: shippingBody.cartVersion,
    quoteId: rate.quoteId,
    shippingQuoteId: rate.shippingQuoteId,
    optionIndex: rate.optionIndex,
    optionHash: rate.optionHash,
    expectedTotalGrossCents: rate.totalGrossCents,
    customer: { name: 'Ada Compradora', company: '', nif: '', email: 'ada@example.test', phone: '600000000' },
    shippingAddress: address,
    billingAddress: address,
    paymentMethod: 'tarjeta',
    termsAccepted: true,
    privacyNoticePresented: true,
    marketingConsent: false
  }
  return { sqlite, database, deps, request, cartCookie, body }
}

async function signedBankNotification(sqlite: DatabaseSync, config: PaymentRuntimeConfiguration, responseCode: string) {
  const intent = sqlite.prepare('SELECT merchant_order, amount_gross_cents FROM payment_intents').get() as {
    merchant_order: string
    amount_gross_cents: number
  }
  const parameters = encodeMerchantParameters({
    Ds_Order: intent.merchant_order,
    Ds_Amount: String(intent.amount_gross_cents),
    Ds_Currency: '978',
    Ds_MerchantCode: config.merchantCode,
    Ds_Terminal: config.terminal,
    Ds_TransactionType: '0',
    Ds_Response: responseCode
  })
  return {
    Ds_MerchantParameters: parameters,
    Ds_SignatureVersion: 'HMAC_SHA512_V2',
    Ds_Signature: await signMerchantParameters(parameters, config.secretKey)
  }
}

describe('Cloudflare storefront checkout bridge', () => {
  it('accepts an optional buyer PO only as a normalized independent checkout field', async () => {
    const w = await world()
    const dispatch = vi.fn(async (command: Record<string, unknown>) => {
      expect(command.type).toBe('checkout')
      return Response.json({
        outcome: 'order_created',
        body: { id: ORDER_KEY, orderToken: 'a'.repeat(64), createdAt: NOW }
      })
    })
    const response = await handleStorefrontCheckoutHttp(
      w.request('/api/orders', { ...w.body, purchaseOrderReference: '  PO-Cafe\u0301-26/031  ' }, w.cartCookie),
      { ...w.deps, dispatch }
    )
    expect(response?.status).toBe(201)
    expect(response?.headers.get('cache-control')).toContain('no-store')
    expect(dispatch).toHaveBeenCalledOnce()
    const command = dispatch.mock.calls[0]![0] as Record<string, unknown>
    expect(command.payload).toMatchObject({ purchaseOrderReference: 'PO-Café-26/031' })
    const payload = command.payload as Record<string, unknown>
    expect(payload.buyerTaxId).toBeUndefined()
    expect(payload.shippingAddress).not.toHaveProperty('purchaseOrderReference')
    expect(payload.billingAddress).not.toHaveProperty('purchaseOrderReference')
  })

  it.each([undefined, '   '])('keeps an omitted or blank PO out of the legacy command (%s)', async (reference) => {
    const w = await world()
    const dispatch = vi.fn(async (command: Record<string, unknown>) => {
      expect(command.type).toBe('checkout')
      return Response.json({
        outcome: 'order_created',
        body: { id: ORDER_KEY, orderToken: 'a'.repeat(64), createdAt: NOW }
      })
    })
    const response = await handleStorefrontCheckoutHttp(
      w.request('/api/orders', { ...w.body, purchaseOrderReference: reference }, w.cartCookie),
      { ...w.deps, dispatch }
    )
    expect(response?.status).toBe(201)
    expect((dispatch.mock.calls[0]![0] as Record<string, unknown>).payload).not.toHaveProperty('purchaseOrderReference')
  })

  it.each([null, 17, {}, 'x'.repeat(121), 'PO\n26', 'PO\u000026', 'PO\u008526', 'PO\u202826'])(
    'rejects a malformed PO before dispatch (%j)',
    async (reference) => {
      const w = await world()
      const dispatch = vi.fn()
      const response = await handleStorefrontCheckoutHttp(
        w.request('/api/orders', { ...w.body, purchaseOrderReference: reference }, w.cartCookie),
        { ...w.deps, dispatch }
      )
      expect(response?.status).toBe(400)
      expect(await response!.json()).toEqual({ error: { code: 'invalid_input' } })
      expect(response?.headers.get('cache-control')).toContain('no-store')
      expect(dispatch).not.toHaveBeenCalled()
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM checkout_attempts').get()?.n).toBe(0)
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM inventory_reservations').get()?.n).toBe(0)
    }
  )

  it('returns a definitive 422 for a non-positive payment total without quote refresh semantics', async () => {
    const w = await world()
    const response = await handleStorefrontCheckoutHttp(w.request('/api/orders', w.body, w.cartCookie), {
      ...w.deps,
      dispatch: async () =>
        new Response(JSON.stringify({ outcome: 'revalidation_required', reason: 'payment_total_non_positive' }), {
          status: 409
        })
    })
    expect(response?.status).toBe(422)
    expect(await response!.json()).toEqual({ error: { code: 'payment_total_non_positive' } })
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM orders').get()?.n).toBe(0)
  })
  async function confirmedOrder(guest = false) {
    const w = await world(true)
    const created = await handleStorefrontCheckoutHttp(
      w.request('/api/orders', w.body, w.cartCookie + (guest ? '' : '; neteco-session=synthetic')),
      w.deps
    )
    expect(created?.status).toBe(201)
    const orderId = ((await created!.json()) as { id: string }).id
    const guestCookie = created!.headers.get('set-cookie')!.split(';')[0]!
    expect(
      (
        await handleStorefrontCheckoutHttp(
          w.request(
            '/api/checkout/pay',
            { orderId, method: 'tarjeta' },
            guestCookie + '; neteco-session=synthetic',
            PAYMENT_KEY
          ),
          w.deps
        )
      )?.status
    ).toBe(200)
    await processRedsysNotification(
      w.database,
      await signedBankNotification(w.sqlite, w.deps.paymentConfiguration()!, '0000'),
      w.deps.paymentConfiguration()!,
      { correlationId: 'synthetic-confirmed', now: NOW }
    )
    const read = (deps = w.deps, cookie = 'neteco-session=synthetic') =>
      handleStorefrontCheckoutHttp(
        new Request(`${ORIGIN}/api/orders/${orderId}`, { headers: { cookie, 'cf-connecting-ip': '192.0.2.22' } }),
        deps
      )
    const advance = (action: string, expectedVersion: number) =>
      executeD1AdminFulfillmentCommand(
        w.database,
        CLAIMS,
        orderId,
        {
          action,
          expectedVersion,
          reason: 'Private synthetic warehouse reason',
          ...(['in_transit', 'delivered'].includes(action) ? { evidence: 'Private synthetic handover evidence' } : {})
        },
        { idempotencyKey: testUuid(), now: NOW }
      )
    return { ...w, orderId, guestCookie, read, advance }
  }
  it('projects confirmed delivery states to both owned and guest HTTP headers without internal evidence', async () => {
    const w = await confirmedOrder()
    for (const [version, state] of ['picking', 'packed', 'in_transit', 'delivered'].entries()) {
      await w.advance(state, version)
      for (const cookie of ['neteco-session=synthetic', w.guestCookie]) {
        const result = await w.read(w.deps, cookie)
        expect(result?.status).toBe(200)
        const body = await result!.json()
        expect(body).toMatchObject({ id: w.orderId, fulfillmentStatus: state })
        expect(JSON.stringify(body)).not.toMatch(/Private synthetic|actorId|commandId|sourceSnapshot|token_hash/)
      }
    }
  })
  it('projects audited fulfillment for an original guest order with no customer binding', async () => {
    const w = await confirmedOrder(true)
    expect(w.sqlite.prepare('SELECT customer_id FROM orders WHERE id=?').get(w.orderId)).toEqual({ customer_id: null })
    await w.advance('picking', 0)
    expect(await (await w.read(w.deps, w.guestCookie))!.json()).toMatchObject({
      id: w.orderId,
      fulfillmentStatus: 'picking'
    })
    expect((await w.read())?.status).toBe(404)
  })
  it('rejects a different current customer even with the original contact email', async () => {
    const w = await confirmedOrder()
    w.sqlite
      .prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)')
      .run('30000000-0000-4000-8000-000000000044', NOW, NOW)
    w.sqlite
      .prepare('UPDATE identities SET customer_id=? WHERE id=?')
      .run('30000000-0000-4000-8000-000000000044', OWNER)
    const response = await w.read()
    expect(response?.status).toBe(404)
    expect(await response!.json()).toEqual({ error: { code: 'not_found' } })
  })
  it.each(['missing', 'corrupt'] as const)(
    'does not expose an unproven fulfillment projection: %s audit',
    async (mode) => {
      const w = await confirmedOrder()
      await w.advance('picking', 0)
      w.sqlite.exec('DROP TRIGGER order_fulfillment_audit_no_update; DROP TRIGGER order_fulfillment_audit_no_delete')
      if (mode === 'missing') w.sqlite.prepare('DELETE FROM order_fulfillment_audit WHERE order_id=?').run(w.orderId)
      else
        w.sqlite
          .prepare("UPDATE order_fulfillment_audit SET reason='Corrupt private evidence' WHERE order_id=?")
          .run(w.orderId)
      expect(await (await w.read())!.json()).toMatchObject({ fulfillmentStatus: 'untracked' })
    }
  )
  it.each(['owner', 'session', 'guest'] as const)(
    'rechecks %s authority after asynchronous detail reads without releasing PII',
    async (mode) => {
      const w = await confirmedOrder()
      const prepare = w.database.prepare.bind(w.database)
      let changed = false
      const database = {
        ...w.database,
        prepare(sql: string) {
          const statement = prepare(sql)
          if (!sql.startsWith('SELECT shipping_gross_cents')) return statement
          const bind = statement.bind.bind(statement)
          return {
            ...statement,
            bind(...args: unknown[]) {
              const bound = bind(...args)
              return {
                ...bound,
                async first<T>() {
                  const result = await bound.first<T>()
                  if (!changed) {
                    changed = true
                    if (mode === 'session')
                      w.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(NOW, SESSION)
                    if (mode === 'owner') {
                      w.sqlite
                        .prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)')
                        .run('30000000-0000-4000-8000-000000000044', NOW, NOW)
                      w.sqlite
                        .prepare('UPDATE identities SET customer_id=? WHERE id=?')
                        .run('30000000-0000-4000-8000-000000000044', OWNER)
                    }
                    if (mode === 'guest')
                      w.sqlite.prepare('UPDATE orders SET access_revoked_at=? WHERE id=?').run(NOW, w.orderId)
                  }
                  return result
                }
              }
            }
          } as D1PreparedStatement
        }
      } as D1Database
      const response = await w.read(
        { ...w.deps, database },
        mode === 'guest' ? w.guestCookie : 'neteco-session=synthetic'
      )
      expect(response?.status).toBe(401)
      expect(JSON.stringify(await response!.json())).not.toMatch(/Ada|ada@example|Carrer|600000000/)
    }
  )
  it('leaves the authenticated account order list to its existing GET handler', async () => {
    const { deps } = await world()
    expect(
      await handleStorefrontCheckoutHttp(
        new Request(`${ORIGIN}/api/orders`, { method: 'GET', headers: { 'cf-connecting-ip': '192.0.2.22' } }),
        deps
      )
    ).toBeNull()
  })

  it('fails closed before reserving when payments are disabled', async () => {
    const { sqlite, deps, request, cartCookie, body } = await world()
    const response = await handleStorefrontCheckoutHttp(request('/api/orders', body, cartCookie), {
      ...deps,
      paymentConfiguration: () => null
    })
    expect(response?.status).toBe(503)
    expect((sqlite.prepare('SELECT count(*) AS n FROM orders').get() as { n: number }).n).toBe(0)
    expect((sqlite.prepare('SELECT count(*) AS n FROM inventory_reservations').get() as { n: number }).n).toBe(0)
  })

  it('keeps order access in an HttpOnly cookie and replays one order/reservation', async () => {
    const { sqlite, deps, request, cartCookie, body } = await world()
    const response = await handleStorefrontCheckoutHttp(request('/api/orders', body, cartCookie), deps)
    expect(response?.status).toBe(201)
    expect(response?.headers.get('cache-control')).toBe('no-store')
    const accessCookie = response!.headers.get('set-cookie')!
    expect(accessCookie).toContain('HttpOnly; Secure; SameSite=Lax')
    expect(accessCookie).toContain('Max-Age=86400')
    const result = (await response!.json()) as { id: string }
    expect(Object.keys(result)).toEqual(['id'])
    expect(JSON.stringify(result)).not.toContain(cartCookie.split('.').at(-1)!)
    const replay = await handleStorefrontCheckoutHttp(request('/api/orders', body, cartCookie), deps)
    expect(replay?.status).toBe(201)
    expect(await replay?.json()).toEqual(result)
    expect(replay?.headers.get('set-cookie')).toBe(accessCookie)
    const replayDuringOutage = await handleStorefrontCheckoutHttp(request('/api/orders', body, cartCookie), {
      ...deps,
      paymentConfiguration: () => null
    })
    expect(replayDuringOutage?.status).toBe(201)
    expect(replayDuringOutage?.headers.get('set-cookie')).toBe(accessCookie)
    // Simulate a committed order whose first HTTP response/cookie was lost,
    // followed by a browser reload before /api/cart replaces the converted cart.
    const recovered = await handleStorefrontCheckoutHttp(
      new Request(`${ORIGIN}/api/checkout/recover`, {
        headers: { cookie: cartCookie, 'cf-connecting-ip': '192.0.2.22' }
      }),
      deps
    )
    expect(recovered?.status).toBe(200)
    expect(await recovered?.json()).toEqual({ orderId: result.id })
    expect(recovered?.headers.get('set-cookie')).toBe(accessCookie)
    expect((sqlite.prepare('SELECT count(*) AS n FROM orders').get() as { n: number }).n).toBe(1)
    expect((sqlite.prepare('SELECT count(*) AS n FROM inventory_reservations').get() as { n: number }).n).toBe(1)
    const changed = await handleStorefrontCheckoutHttp(
      request('/api/orders', { ...body, expectedTotalGrossCents: body.expectedTotalGrossCents + 1 }, cartCookie),
      deps
    )
    expect(changed?.status).toBe(409)
    const detail = await handleStorefrontCheckoutHttp(
      new Request(`${ORIGIN}/api/orders/${result.id}`, {
        headers: { cookie: accessCookie.split(';')[0]!, 'cf-connecting-ip': '192.0.2.22' }
      }),
      deps
    )
    expect(detail?.status).toBe(200)
    const view = (await detail!.json()) as Record<string, unknown>
    expect(view).toMatchObject({
      source: 'cloudflare',
      id: result.id,
      status: 'pendiente_pago',
      fulfillmentStatus: 'untracked',
      invoiceStatus: 'untracked',
      paymentMethod: 'pendiente',
      total: body.expectedTotalGrossCents
    })
    expect(view).not.toHaveProperty('orderToken')
    expect((view.items as Array<{ format: string }>)[0]?.format).toBe('Botella 1 L')
    const unauthorisedDetail = await handleStorefrontCheckoutHttp(
      new Request(`${ORIGIN}/api/orders/${result.id}`, { headers: { 'cf-connecting-ip': '192.0.2.22' } }),
      deps
    )
    expect(unauthorisedDetail?.status).toBe(401)
    expect(
      await handleStorefrontCheckoutHttp(
        new Request(`${ORIGIN}/api/orders/${result.id}`, { headers: { authorization: `Order ${'a'.repeat(64)}` } }),
        deps
      )
    ).toBeNull()
  })

  it('recovers a committed order after a global cart load replaces the converted cart cookie', async () => {
    const { sqlite, deps, request, cartCookie, body } = await world()
    const created = await handleStorefrontCheckoutHttp(request('/api/orders', body, cartCookie), deps)
    expect(created?.status).toBe(201)
    const orderId = ((await created!.json()) as { id: string }).id
    // The checkout response (including its order cookie) was lost. Nuxt's
    // global cart plugin runs before checkout's recovery hook.
    const replaced = await handleStorefrontCartHttp(
      new Request(`${ORIGIN}/api/cart`, {
        headers: { cookie: cartCookie, 'cf-connecting-ip': '192.0.2.22' }
      }),
      deps
    )
    expect(replaced?.status).toBe(200)
    expect(await replaced?.json()).toMatchObject({ replacedConvertedCart: true, items: [] })
    const issued = replaced!.headers.getSetCookie().map((cookie) => cookie.split(';')[0]!)
    expect(issued).toHaveLength(2)
    expect(issued.some((cookie) => cookie.startsWith('neteco-cart-v2='))).toBe(true)
    expect(issued.some((cookie) => cookie.startsWith('neteco-checkout-recovery-v1='))).toBe(true)
    const recovered = await handleStorefrontCheckoutHttp(
      new Request(`${ORIGIN}/api/checkout/recover`, {
        headers: { cookie: issued.join('; '), 'cf-connecting-ip': '192.0.2.22' }
      }),
      deps
    )
    expect(recovered?.status).toBe(200)
    expect(await recovered?.json()).toEqual({ orderId })
    const cookies = recovered!.headers.getSetCookie()
    expect(cookies.some((cookie) => cookie.startsWith('neteco-order-access-v2='))).toBe(true)
    expect(cookies.some((cookie) => cookie.startsWith('neteco-checkout-recovery-v1=; Max-Age=0'))).toBe(true)
    expect((sqlite.prepare('SELECT count(*) AS n FROM orders').get() as { n: number }).n).toBe(1)
    expect((sqlite.prepare('SELECT count(*) AS n FROM inventory_reservations').get() as { n: number }).n).toBe(1)
    await revokeStorefrontCredentials(
      deps.database,
      new Request(`${ORIGIN}/api/auth/logout`, { headers: { cookie: issued.join('; ') } }),
      NOW
    )
    const afterLogout = await handleStorefrontCheckoutHttp(
      new Request(`${ORIGIN}/api/checkout/recover`, {
        headers: { cookie: issued.join('; '), 'cf-connecting-ip': '192.0.2.22' }
      }),
      deps
    )
    expect(afterLogout?.status).toBe(401)
  })

  it('revokes presented order and converted-cart credentials on logout without trusting forged cookies', async () => {
    const { sqlite, database, deps, request, cartCookie, body } = await world()
    const created = await handleStorefrontCheckoutHttp(request('/api/orders', body, cartCookie), deps)
    const orderId = ((await created!.json()) as { id: string }).id
    const accessCookie = created!.headers.get('set-cookie')!.split(';')[0]!
    const token = accessCookie.match(/v1\.[^.]+\.([0-9a-f]{64})/)![1]!
    const tamper = (cookie: string) => cookie.replace(/.$/, (character) => (character === 'a' ? 'b' : 'a'))
    const forged = new Request(`${ORIGIN}/api/auth/logout`, {
      headers: { cookie: `${tamper(cartCookie)}; ${tamper(accessCookie)}` }
    })
    await revokeStorefrontCredentials(database, forged, NOW)
    expect(await getOrderView(database, { orderId, token, now: NOW })).not.toBeNull()
    const actual = new Request(`${ORIGIN}/api/auth/logout`, { headers: { cookie: `${cartCookie}; ${accessCookie}` } })
    const cleared = await revokeStorefrontCredentials(database, actual, NOW)
    expect(cleared).toHaveLength(3)
    expect(cleared.every((cookie) => cookie.includes('Max-Age=0'))).toBe(true)
    expect(await getOrderView(database, { orderId, token, now: NOW })).toBeNull()
    const recovered = await handleStorefrontCheckoutHttp(
      new Request(`${ORIGIN}/api/checkout/recover`, {
        headers: { cookie: cartCookie, 'cf-connecting-ip': '192.0.2.22' }
      }),
      deps
    )
    expect(recovered?.status).toBe(200)
    expect(await recovered?.json()).toEqual({ orderId: null })
    expect(
      (sqlite.prepare('SELECT access_revoked_at AS at FROM orders WHERE id = ?').get(orderId) as { at: string }).at
    ).toBe(NOW)
  })

  it('rejects stale displayed totals, false consent, unsupported marketing and cross-origin requests without side effects', async () => {
    const { sqlite, deps, request, cartCookie, body } = await world()
    for (const [changed, expected] of [
      [{ ...body, expectedTotalGrossCents: body.expectedTotalGrossCents + 1 }, 409],
      [{ ...body, termsAccepted: false }, 400],
      [{ ...body, marketingConsent: true }, 422],
      [{ ...body, paymentMethod: 'transferencia' }, 422]
    ] as const) {
      const response = await handleStorefrontCheckoutHttp(request('/api/orders', changed, cartCookie), deps)
      expect(response?.status).toBe(expected)
    }
    expect(
      (
        await handleStorefrontCheckoutHttp(
          request('/api/orders', body, cartCookie, ORDER_KEY, 'https://evil.test'),
          deps
        )
      )?.status
    ).toBe(403)
    expect((await handleStorefrontCheckoutHttp(request('/api/orders', body), deps))?.status).toBe(401)
    expect((sqlite.prepare('SELECT count(*) AS n FROM orders').get() as { n: number }).n).toBe(0)
    expect((sqlite.prepare('SELECT count(*) AS n FROM inventory_reservations').get() as { n: number }).n).toBe(0)
  })

  it('starts a single Redsys intent with a stable key and blocks a paid replay', async () => {
    const { sqlite, deps, request, cartCookie, body } = await world()
    const created = await handleStorefrontCheckoutHttp(request('/api/orders', body, cartCookie), deps)
    expect(created?.status).toBe(201)
    const orderId = ((await created!.json()) as { id: string }).id
    const orderCookie = created!.headers.get('set-cookie')!.split(';')[0]!
    const input = { orderId, method: 'tarjeta' }
    const pay = await handleStorefrontCheckoutHttp(request('/api/checkout/pay', input, orderCookie, PAYMENT_KEY), deps)
    expect(pay?.status).toBe(200)
    const result = (await pay!.json()) as {
      ok: boolean
      redirect: { actionUrl: string; fields: Record<string, string> }
    }
    expect(result.ok).toBe(true)
    expect(result.redirect.actionUrl).toContain('redsys')
    const replay = await handleStorefrontCheckoutHttp(
      request('/api/checkout/pay', input, orderCookie, PAYMENT_KEY),
      deps
    )
    expect(await replay?.json()).toEqual(result)
    const lostResponseRecovery = await handleStorefrontCheckoutHttp(
      request('/api/checkout/pay', input, orderCookie, '550e8400-e29b-41d4-a716-446655440004'),
      deps
    )
    expect(lostResponseRecovery?.status).toBe(200)
    expect(await lostResponseRecovery?.json()).toEqual(result)
    expect((sqlite.prepare('SELECT count(*) AS n FROM payment_intents').get() as { n: number }).n).toBe(1)
    expect(
      (await handleStorefrontCheckoutHttp(request('/api/checkout/pay', input, cartCookie, PAYMENT_KEY), deps))?.status
    ).toBe(401)
    expect(
      (
        await handleStorefrontCheckoutHttp(
          request('/api/checkout/pay', input, orderCookie, PAYMENT_KEY, 'https://evil.test'),
          deps
        )
      )?.status
    ).toBe(403)
    sqlite.prepare("UPDATE order_payment_states SET status = 'provider_authorised' WHERE order_id = ?").run(orderId)
    const paidReplay = await handleStorefrontCheckoutHttp(
      request('/api/checkout/pay', input, orderCookie, PAYMENT_KEY),
      deps
    )
    expect(paidReplay?.status).toBe(409)
    expect(await paidReplay?.json()).toEqual({ error: { code: 'already_paid' } })
  })

  it('never reuses a failed provider form but permits a new payment attempt', async () => {
    const { sqlite, deps, request, cartCookie, body } = await world()
    const created = await handleStorefrontCheckoutHttp(request('/api/orders', body, cartCookie), deps)
    const orderId = ((await created!.json()) as { id: string }).id
    const orderCookie = created!.headers.get('set-cookie')!.split(';')[0]!
    const input = { orderId, method: 'tarjeta' }
    const first = await handleStorefrontCheckoutHttp(
      request('/api/checkout/pay', input, orderCookie, PAYMENT_KEY),
      deps
    )
    expect(first?.status).toBe(200)
    sqlite.prepare("UPDATE payment_intents SET status = 'failed' WHERE order_id = ?").run(orderId)
    sqlite.prepare("UPDATE order_payment_states SET status = 'failed' WHERE order_id = ?").run(orderId)
    const stale = await handleStorefrontCheckoutHttp(
      request('/api/checkout/pay', input, orderCookie, PAYMENT_KEY),
      deps
    )
    expect(stale?.status).toBe(409)
    expect(await stale?.json()).toEqual({ error: { code: 'stale_payment_attempt' } })
    const second = await handleStorefrontCheckoutHttp(
      request('/api/checkout/pay', input, orderCookie, '550e8400-e29b-41d4-a716-446655440005'),
      deps
    )
    expect(second?.status).toBe(200)
    expect((sqlite.prepare('SELECT count(*) AS n FROM payment_intents').get() as { n: number }).n).toBe(2)
  })

  it('does not re-present a bank form after a signed pending notification', async () => {
    const { sqlite, database, deps, request, cartCookie, body } = await world()
    const created = await handleStorefrontCheckoutHttp(request('/api/orders', body, cartCookie), deps)
    const orderId = ((await created!.json()) as { id: string }).id
    const orderCookie = created!.headers.get('set-cookie')!.split(';')[0]!
    const input = { orderId, method: 'tarjeta' }
    expect(
      (await handleStorefrontCheckoutHttp(request('/api/checkout/pay', input, orderCookie, PAYMENT_KEY), deps))?.status
    ).toBe(200)
    const config = deps.paymentConfiguration()!
    expect(
      await processRedsysNotification(database, await signedBankNotification(sqlite, config, '9997'), config, {
        correlationId: 'signed-pending',
        now: NOW
      })
    ).toEqual({ outcome: 'pending' })
    const sameKey = await handleStorefrontCheckoutHttp(
      request('/api/checkout/pay', input, orderCookie, PAYMENT_KEY),
      deps
    )
    expect(sameKey?.status).toBe(409)
    expect(await sameKey?.json()).toEqual({ error: { code: 'stale_payment_attempt' } })
    const newKey = await handleStorefrontCheckoutHttp(
      request('/api/checkout/pay', input, orderCookie, '550e8400-e29b-41d4-a716-446655440006'),
      deps
    )
    expect(newKey?.status).toBe(409)
    expect(await newKey?.json()).toEqual({ error: { code: 'payment_in_progress' } })
    expect((sqlite.prepare('SELECT count(*) AS n FROM payment_intents').get() as { n: number }).n).toBe(1)
  })

  it('presents a safe retry after a signed bank cancellation', async () => {
    const { sqlite, database, deps, request, cartCookie, body } = await world()
    const created = await handleStorefrontCheckoutHttp(request('/api/orders', body, cartCookie), deps)
    const orderId = ((await created!.json()) as { id: string }).id
    const orderCookie = created!.headers.get('set-cookie')!.split(';')[0]!
    const input = { orderId, method: 'tarjeta' }
    expect(
      (await handleStorefrontCheckoutHttp(request('/api/checkout/pay', input, orderCookie, PAYMENT_KEY), deps))?.status
    ).toBe(200)
    const config = deps.paymentConfiguration()!
    expect(
      await processRedsysNotification(database, await signedBankNotification(sqlite, config, '9915'), config, {
        correlationId: 'signed-cancelled',
        now: NOW
      })
    ).toEqual({ outcome: 'cancelled' })
    const detail = await handleStorefrontCheckoutHttp(
      new Request(`${ORIGIN}/api/orders/${orderId}`, {
        headers: { cookie: orderCookie, 'cf-connecting-ip': '192.0.2.22' }
      }),
      deps
    )
    expect(await detail?.json()).toMatchObject({ status: 'pago_fallido', paymentStatus: 'cancelled' })
    const retried = await handleStorefrontCheckoutHttp(
      request('/api/checkout/pay', input, orderCookie, '550e8400-e29b-41d4-a716-446655440007'),
      deps
    )
    expect(retried?.status).toBe(200)
    expect((sqlite.prepare('SELECT count(*) AS n FROM payment_intents').get() as { n: number }).n).toBe(2)
  })

  it('enforces server-side 24-hour access expiry despite a replayed browser cookie', async () => {
    const { database, deps, request, cartCookie, body } = await world()
    const created = await handleStorefrontCheckoutHttp(request('/api/orders', body, cartCookie), deps)
    const orderId = ((await created!.json()) as { id: string }).id
    const orderCookie = created!.headers.get('set-cookie')!.split(';')[0]!
    const token = orderCookie.match(/v1\.[^.]+\.([0-9a-f]{64})/)![1]!
    expect(await getOrderView(database, { orderId, token, now: '2026-08-26T08:59:59Z' })).not.toBeNull()
    expect(await getOrderView(database, { orderId, token, now: '2026-08-26T09:00:00Z' })).toBeNull()
    await expect(
      initiateRedsysPayment(
        database,
        {
          orderId,
          orderToken: token,
          idempotencyKey: PAYMENT_KEY,
          method: 'card',
          correlationId: 'expired-direct-payment',
          now: '2026-08-26T09:00:00Z'
        },
        deps.paymentConfiguration()!
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    const expired = await handleStorefrontCheckoutHttp(
      request('/api/checkout/pay', { orderId, method: 'tarjeta' }, orderCookie, PAYMENT_KEY),
      { ...deps, now: () => '2026-08-26T09:00:00Z' }
    )
    expect(expired?.status).toBe(401)
    const expiredDetail = await handleStorefrontCheckoutHttp(
      new Request(`${ORIGIN}/api/orders/${orderId}`, {
        headers: { cookie: orderCookie, 'cf-connecting-ip': '192.0.2.22' }
      }),
      { ...deps, now: () => '2026-08-26T09:00:00Z' }
    )
    expect(expiredDetail?.status).toBe(401)
    const expiredRecovery = await handleStorefrontCheckoutHttp(
      new Request(`${ORIGIN}/api/checkout/recover`, {
        headers: { cookie: cartCookie, 'cf-connecting-ip': '192.0.2.22' }
      }),
      { ...deps, now: () => '2026-08-26T09:00:00Z' }
    )
    expect(expiredRecovery?.status).toBe(401)
    expect(await expiredRecovery?.json()).toEqual({ error: { code: 'unauthorized' } })
  })
})

describe('storefront checkout market selection', () => {
  const ok = () =>
    vi.fn(async (_command: Record<string, unknown>) =>
      Response.json({ outcome: 'order_created', body: { id: ORDER_KEY, orderToken: 'a'.repeat(64), createdAt: NOW } })
    )
  const selection = { market: 'DE', version: 3, termsVersion: 'de-terms-v1' }
  const gbAddress = (w: Awaited<ReturnType<typeof world>>) => ({
    ...(w.body.shippingAddress as Record<string, unknown>),
    countryCode: 'DE'
  })
  it('forwards the buyer selection with the payment method mapped to the market vocabulary', async () => {
    const w = await world()
    const dispatch = ok()
    const address = gbAddress(w)
    const response = await handleStorefrontCheckoutHttp(
      w.request(
        '/api/orders',
        { ...w.body, shippingAddress: address, billingAddress: address, marketCheckout: selection },
        w.cartCookie
      ),
      { ...w.deps, dispatch }
    )
    expect(response?.status).toBe(201)
    const payload = (dispatch.mock.calls[0]![0] as { payload: Record<string, unknown> }).payload
    expect(payload.marketCheckout).toEqual({ ...selection, paymentMethod: 'card' })
    expect(payload.shippingAddress).toMatchObject({ countryCode: 'DE' })
  })
  it('does not add a market selection to the legacy command', async () => {
    const w = await world()
    const dispatch = ok()
    await handleStorefrontCheckoutHttp(w.request('/api/orders', w.body, w.cartCookie), { ...w.deps, dispatch })
    expect((dispatch.mock.calls[0]![0] as { payload: Record<string, unknown> }).payload).not.toHaveProperty(
      'marketCheckout'
    )
  })
  it('maps account transfer to the credit method only for an authenticated buyer', async () => {
    const w = await world(true)
    const dispatch = ok()
    const response = await handleStorefrontCheckoutHttp(
      w.request(
        '/api/orders',
        { ...w.body, paymentMethod: 'transferencia', marketCheckout: selection },
        w.cartCookie + '; neteco-session=synthetic'
      ),
      { ...w.deps, dispatch }
    )
    expect(response?.status).toBe(201)
    expect((dispatch.mock.calls[0]![0] as { payload: Record<string, unknown> }).payload.marketCheckout).toMatchObject({
      paymentMethod: 'credit'
    })
  })
  it('does not offer Bizum outside Spain', async () => {
    const w = await world()
    const dispatch = ok()
    const response = await handleStorefrontCheckoutHttp(
      w.request('/api/orders', { ...w.body, paymentMethod: 'bizum', marketCheckout: selection }, w.cartCookie),
      { ...w.deps, dispatch }
    )
    expect(response?.status).toBe(422)
    expect(await response!.json()).toEqual({ error: { code: 'method_unavailable' } })
    expect(dispatch).not.toHaveBeenCalled()
  })
  it.each([
    ['extra key', { ...selection, currency: 'USD' }],
    ['lowercase market', { ...selection, market: 'de' }],
    ['zero version', { ...selection, version: 0 }],
    ['fractional version', { ...selection, version: 1.5 }],
    ['bad terms', { ...selection, termsVersion: 'x y' }],
    ['array', [selection]],
    ['null', null]
  ])('rejects a malformed selection before dispatch (%s)', async (_name, marketCheckout) => {
    const w = await world()
    const dispatch = ok()
    const response = await handleStorefrontCheckoutHttp(
      w.request('/api/orders', { ...w.body, marketCheckout }, w.cartCookie),
      { ...w.deps, dispatch }
    )
    expect(response?.status).toBe(400)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
