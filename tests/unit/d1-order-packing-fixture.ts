import { readFile } from 'node:fs/promises'
import { fulfillmentFixture, CLAIMS, REASON, utc } from './d1-fulfillment-fixture'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { requestShippingOptions, placeOrder } from '../../workers/catalog/checkout'
import { initiateRedsysPayment, processRedsysNotification } from '../../workers/catalog/payments'
import { assignReservation } from '../../workers/catalog/inventory'
import { encodeMerchantParameters, signMerchantParameters } from '../../workers/payments/redsys'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'
import { executeD1AdminFulfillmentCommand } from '../../workers/fulfillment/admin'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'
export { CLAIMS, REASON, utc }

/** Portable real command setup: caller supplies catalog/shipping/auth fixture,
 * never an order/payment/fulfillment projection seeded by SQL. No fetch/provider. */
export async function createPackingOrder(
  database: D1Database,
  options: {
    method?: 'parcel' | 'pickup' | 'own_delivery'
    paid?: boolean
    stage?: 'pending' | 'picking' | 'packed' | 'in_transit'
    now?: string
    ownerSession?: VerifiedSessionClaims
    onOrderCreated?: (order: { id: string; orderToken: string }) => void
  } = {}
) {
  const now = options.now ?? utc(),
    method = options.method ?? 'parcel'
  const cart = await createCart(database, { correlationId: 'packing-fixture', now })
  const common = { cartId: cart.cartId, token: cart.token, correlationId: 'packing-fixture', now }
  await setCartLine(database, {
    ...common,
    variantId: 'v-1-1',
    quantity: 4,
    expectedVersion: 1,
    idempotencyKey: 'packing-add'
  })
  const shipping = await requestShippingOptions(database, {
    ...common,
    expectedVersion: 2,
    idempotencyKey: 'packing-shipping',
    destination: { city: 'Ontinyent', postalCode: '46870' }
  })
  const quote = await quoteCart(database, { ...common, expectedVersion: 2, idempotencyKey: 'packing-quote' })
  if (shipping.outcome !== 'options' || quote.outcome !== 'quoted') throw new Error('packing_fixture_quote_failed')
  const selected = (
    shipping.body.options as Array<{ methodCode: string; optionIndex: number; optionHash: string }>
  ).find((item) => item.methodCode === method)
  if (!selected) throw new Error('packing_fixture_shipping_missing')
  const placed = await placeOrder(database, {
    ...common,
    expectedVersion: 2,
    quoteId: quote.quote.quoteId,
    shippingQuoteId: shipping.body.shippingQuoteId as string,
    selectedOptionIndex: selected.optionIndex,
    selectedOptionHash: selected.optionHash,
    contactEmail: 'packing-buyer@example.invalid',
    contactName: 'Synthetic packing buyer',
    contactPhone: '+34600111222',
    shippingAddress: {
      recipientName: 'Synthetic packing buyer',
      line1: 'Synthetic street 1',
      city: 'Ontinyent',
      province: 'Valencia',
      postalCode: '46870',
      phone: '+34600111222'
    },
    consentTos: true,
    consentPrivacy: true,
    ...(options.ownerSession ? { ownerSession: options.ownerSession } : {}),
    idempotencyKey: 'packing-checkout'
  })
  if (placed.outcome !== 'order_created') throw new Error('packing_fixture_checkout_failed')
  const order = placed.body as { id: string; orderToken: string }
  options.onOrderCreated?.(order)
  if (options.paid !== false) {
    const config = {
      environment: 'sandbox' as const,
      merchantCode: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
      terminal: REDSYS_OFFICIAL_CONTRACT.sandbox.terminal,
      secretKey: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey,
      merchantName: 'NETECO',
      bizumEnabled: false,
      publicBaseUrl: 'https://packing-fixture.neteco.test'
    }
    await initiateRedsysPayment(
      database,
      {
        orderId: order.id,
        orderToken: order.orderToken,
        method: 'card',
        now,
        correlationId: 'packing-fixture',
        idempotencyKey: 'packing-payment'
      },
      config
    )
    const intent = await database
      .prepare('SELECT merchant_order,amount_gross_cents FROM payment_intents WHERE order_id=?')
      .bind(order.id)
      .first<{ merchant_order: string; amount_gross_cents: number }>()
    if (!intent) throw new Error('packing_fixture_payment_missing')
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
      { now, correlationId: 'packing-fixture' },
      { assign: (payload) => assignReservation(database, payload) }
    )
    const stage = options.stage ?? 'picking'
    const actions =
      stage === 'pending'
        ? []
        : stage === 'picking'
          ? ['picking']
          : stage === 'packed'
            ? ['picking', 'packed']
            : ['picking', 'packed', 'in_transit']
    for (const [expectedVersion, action] of actions.entries())
      await executeD1AdminFulfillmentCommand(
        database,
        CLAIMS,
        order.id,
        { action, expectedVersion, reason: REASON, ...(action === 'in_transit' ? { evidence: REASON } : {}) },
        { idempotencyKey: `${order.id}:${action}`, now }
      )
  }
  return order.id
}

export async function packingFixture(options: Parameters<typeof createPackingOrder>[1] = {}) {
  const fixture = await fulfillmentFixture(),
    { sqlite, database } = fixture
  let orderId: string
  try {
    sqlite
      .prepare(
        "INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at) VALUES('packing-parcel-zone','packing-parcel','Synthetic parcel','parcel_peninsular','[\"peninsular\"]',1,?)"
      )
      .run(utc(-60000))
    sqlite
      .prepare(
        "INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at) VALUES('packing-parcel-rate','packing-parcel-zone','parcel','parcel',500,2100,1,2,1,1,?)"
      )
      .run(utc(-60000))
    sqlite.exec(await readFile(new URL('../../db/d1/migrations/0069_order_packing.sql', import.meta.url), 'utf8'))
    orderId = await createPackingOrder(database, options)
  } catch (error) {
    sqlite.close()
    throw error
  }
  const economic = () =>
    Object.fromEntries(
      [
        'orders',
        'order_lines',
        'order_payment_states',
        'payment_events',
        'payment_intents',
        'payment_fulfilment_claims',
        'inventory_balances',
        'inventory_movements',
        'inventory_reservations',
        'inventory_reservation_lines',
        'order_fulfillments',
        'order_fulfillment_commands',
        'order_fulfillment_audit',
        'fiscal_invoice_intents'
      ].map((table) => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
    )
  return { ...fixture, orderId, economic }
}
