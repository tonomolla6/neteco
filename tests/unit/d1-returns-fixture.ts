import { readFile } from 'node:fs/promises'
import { fulfillmentFixture, CLAIMS, REASON, utc } from './d1-fulfillment-fixture'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { requestShippingOptions, placeOrder } from '../../workers/catalog/checkout'
import { initiateRedsysPayment, processRedsysNotification } from '../../workers/catalog/payments'
import { assignReservation } from '../../workers/catalog/inventory'
import { encodeMerchantParameters, signMerchantParameters } from '../../workers/payments/redsys'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'
import { executeD1AdminFulfillmentCommand } from '../../workers/fulfillment/admin'

export { CLAIMS, REASON, utc }
export const CUSTOMER = '30000000-0000-4000-8000-000000000046'
export const BUYER = '10000000-0000-4000-8000-000000000046'
export const BUYER_SESSION = '20000000-0000-4000-8000-000000000046'
export const BUYER_CLAIMS = { identityId: BUYER, sessionId: BUYER_SESSION, sessionVersion: 1 }
export const REQUEST = { expectedVersion: 0, reason: REASON, lines: [{ lineIndex: 0, quantity: 2 }] }
export const ADMISSION = {
  action: 'approved' as const,
  expectedVersion: 1,
  reason: REASON,
  publicMessage: 'Solicitud admitida tras revisión documentada.',
  evidence: 'Reviewed historical contract and documented case.',
  decisionRef: 'documented-manual-case-review',
  lines: [{ lineIndex: 0, quantity: 2 }]
}

export async function returnsFixture() {
  const fixture = await fulfillmentFixture(),
    { sqlite, database } = fixture
  if (!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='order_return_commands'").get())
    sqlite.exec(await readFile(new URL('../../db/d1/migrations/0046_order_returns.sql', import.meta.url), 'utf8'))
  const now = utc(-60000)
  sqlite
    .prepare('INSERT INTO customers(id,name,created_at,updated_at) VALUES(?,?,?,?)')
    .run(CUSTOMER, 'Historical customer', now, now)
  sqlite
    .prepare(
      "INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at) VALUES(?,?,'synthetic',?,'active',?,?,?)"
    )
    .run(BUYER, 'buyer@example.invalid', now, CUSTOMER, now, now)
  sqlite
    .prepare(
      'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,0,?,?)'
    )
    .run(BUYER_SESSION, BUYER, now, utc(3600000))
  async function order({
    owned = true,
    paid = true,
    delivered = true,
    quantity = 2,
    couponCode,
    storeCreditCents
  }: {
    owned?: boolean
    paid?: boolean
    delivered?: boolean
    quantity?: number
    couponCode?: string
    /** PRI-018: requires the pricing/credit migrations (0146, 0152) and a funded account. */
    storeCreditCents?: number
  } = {}) {
    const cart = await createCart(database, { correlationId: 'returns-fixture', now: utc() })
    await setCartLine(database, {
      cartId: cart.cartId,
      token: cart.token,
      variantId: 'v-1-1',
      quantity,
      expectedVersion: 1,
      idempotencyKey: 'add',
      correlationId: 'returns-fixture',
      now: utc()
    })
    const shipping = await requestShippingOptions(database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: 2,
      idempotencyKey: 'shipping',
      correlationId: 'returns-fixture',
      destination: { city: 'Ontinyent', postalCode: '46870' },
      now: utc()
    })
    const quote = await quoteCart(database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: 2,
      idempotencyKey: 'quote',
      correlationId: 'returns-fixture',
      ...(couponCode === undefined ? {} : { couponCode, ownerSession: owned ? BUYER_CLAIMS : null }),
      now: utc()
    })
    if (shipping.outcome !== 'options' || quote.outcome !== 'quoted') throw new Error('returns_quote_failed')
    const option = (
      shipping.body.options as Array<{ optionIndex: number; optionHash: string; methodCode: string }>
    ).find((item) => item.methodCode === 'pickup')!
    const result = await placeOrder(
      database,
      {
        cartId: cart.cartId,
        token: cart.token,
        expectedVersion: 2,
        quoteId: quote.quote.quoteId,
        shippingQuoteId: shipping.body.shippingQuoteId as string,
        selectedOptionIndex: option.optionIndex,
        selectedOptionHash: option.optionHash,
        contactEmail: 'buyer@example.invalid',
        contactName: 'Original buyer',
        contactPhone: '+34600111222',
        shippingAddress: {
          recipientName: 'Original buyer',
          line1: 'Carrer Major 1',
          city: 'Ontinyent',
          province: 'Valencia',
          postalCode: '46870',
          phone: '+34600111222'
        },
        consentTos: true,
        consentPrivacy: true,
        idempotencyKey: 'checkout',
        correlationId: 'returns-fixture',
        now: utc(),
        ownerSession: owned ? BUYER_CLAIMS : null,
        ...(storeCreditCents === undefined ? {} : { storeCreditCents })
      },
      undefined,
      null,
      storeCreditCents === undefined ? {} : { storeCreditRedemptionEnabled: true }
    )
    if (result.outcome !== 'order_created') throw new Error('returns_checkout_failed')
    const receipt = result.body as { id: string; orderToken: string },
      id = receipt.id
    if (paid) {
      const config = {
        environment: 'sandbox' as const,
        merchantCode: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
        terminal: REDSYS_OFFICIAL_CONTRACT.sandbox.terminal,
        secretKey: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey,
        merchantName: 'NETECO',
        bizumEnabled: false,
        publicBaseUrl: 'https://returns-fixture.neteco.test'
      }
      await initiateRedsysPayment(
        database,
        {
          orderId: id,
          orderToken: receipt.orderToken,
          method: 'card',
          now: utc(),
          correlationId: 'returns-fixture',
          idempotencyKey: 'pay'
        },
        config
      )
      const intent = sqlite
        .prepare('SELECT merchant_order,amount_gross_cents FROM payment_intents WHERE order_id=?')
        .get(id) as { merchant_order: string; amount_gross_cents: number }
      const parameters = encodeMerchantParameters({
        Ds_Order: intent.merchant_order,
        Ds_Amount: String(intent.amount_gross_cents),
        Ds_Currency: '978',
        Ds_MerchantCode: config.merchantCode,
        Ds_Terminal: config.terminal,
        Ds_TransactionType: '0',
        Ds_Response: '0000'
      })
      await processRedsysNotification(
        database,
        {
          Ds_MerchantParameters: parameters,
          Ds_SignatureVersion: 'HMAC_SHA512_V2',
          Ds_Signature: await signMerchantParameters(parameters, config.secretKey)
        },
        config,
        { correlationId: 'returns-fixture', now: utc() },
        { assign: (payload) => assignReservation(database, payload) }
      )
      if (delivered) {
        for (const [version, action] of ['picking', 'packed', 'ready_for_pickup', 'delivered'].entries())
          await executeD1AdminFulfillmentCommand(
            database,
            CLAIMS,
            id,
            {
              action,
              expectedVersion: version,
              reason: REASON,
              ...(action === 'delivered' ? { evidence: REASON } : {})
            },
            { idempotencyKey: `${id}:${action}` }
          )
      }
    }
    return id
  }
  return { ...fixture, order }
}
