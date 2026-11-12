import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { requestShippingOptions, placeOrder } from '../../workers/catalog/checkout'
import { assignReservation } from '../../workers/catalog/inventory'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { testUuid, testNow } from '../support/deterministic'

export const ACTOR = '10000000-0000-4000-8000-000000000043'
export const SESSION = '20000000-0000-4000-8000-000000000043'
export const CLAIMS = { identityId: ACTOR, sessionId: SESSION, sessionVersion: 1 }
export const utc = (offset = 0) => new Date(testNow() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
export const REASON = 'Synthetic verified warehouse operation'

export async function fulfillmentFixture(options: { stock?: number } = {}) {
  const sqlite = await openMigratedDatabase()
  if (!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='order_fulfillment_commands'").get())
    sqlite.exec(await readFile(new URL('../../db/d1/migrations/0043_order_fulfillment.sql', import.meta.url), 'utf8'))
  sqlite.limits.exprDepth = 100
  sqlite.limits.variableNumber = 100
  sqlite.limits.functionArg = 32
  const database = d1OverSqlite(sqlite)
  seedInventoryFixture(sqlite, { initialPhysicalQuantity: options.stock })
  await provisionPublicationValidityFixture(database, { productIds: ['p-1'], now: utc(-3600000) })
  const now = utc(-60000)
  sqlite.exec(`
    INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at)
      VALUES('pickup-zone','pickup','Pickup','warehouse_pickup','[]',1,'${now}'),
        ('own-zone','own','Own delivery','own_delivery','["46"]',1,'${now}');
    INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at)
      VALUES('pickup-rate','pickup-zone','pickup','parcel',0,2100,0,0,1,1,'${now}'),
        ('own-rate','own-zone','own_delivery','parcel',500,2100,1,2,1,1,'${now}');
    INSERT INTO roles VALUES('operator','Operator','Synthetic');
    INSERT INTO permissions VALUES('administration.manage','administration','manage','Synthetic');
    INSERT INTO role_permissions VALUES('operator','administration.manage');
    INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
      VALUES('${ACTOR}','operator@example.invalid','synthetic','${now}','active','${now}','${now}');
    INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
      VALUES('${SESSION}','${ACTOR}',1,1,'${now}','${utc(3600000)}');
    INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES('${ACTOR}','operator','${now}');
  `)
  async function order(method = 'pickup', paid = true) {
    const cart = await createCart(database, { correlationId: 'synthetic-fulfillment', now: utc() })
    await setCartLine(database, {
      cartId: cart.cartId,
      token: cart.token,
      variantId: 'v-1-1',
      quantity: 2,
      expectedVersion: 1,
      idempotencyKey: 'line',
      correlationId: 'synthetic-fulfillment',
      now: utc()
    })
    const shipping = await requestShippingOptions(database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: 2,
      idempotencyKey: 'shipping',
      correlationId: 'synthetic-fulfillment',
      now: utc(),
      destination: { city: 'Ontinyent', postalCode: '46870' }
    })
    if (shipping.outcome !== 'options') throw new Error(shipping.outcome)
    const options = shipping.body.options as Array<{ optionIndex: number; optionHash: string; methodCode: string }>
    const option = options.find((item) => item.methodCode === method)
    if (!option) throw new Error(`missing_shipping_${method}`)
    const quote = await quoteCart(database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: 2,
      idempotencyKey: 'quote',
      correlationId: 'synthetic-fulfillment',
      now: utc()
    })
    if (quote.outcome !== 'quoted') throw new Error(quote.outcome)
    const result = await placeOrder(database, {
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
        recipientName: 'Original recipient',
        line1: 'Carrer Major 1',
        city: 'Ontinyent',
        province: 'València',
        postalCode: '46870',
        countryCode: 'ES',
        phone: '+34600111222'
      },
      billingAddress: {
        recipientName: 'Original buyer',
        line1: 'Carrer Major 2',
        city: 'Ontinyent',
        province: 'València',
        postalCode: '46870',
        countryCode: 'ES'
      },
      consentTos: true,
      consentPrivacy: true,
      idempotencyKey: 'checkout',
      correlationId: 'synthetic-fulfillment',
      now: utc()
    })
    if (result.outcome !== 'order_created') throw new Error(result.outcome)
    const id = (result.body as { id: string }).id
    if (paid) await capture(sqlite, database, id)
    return id
  }
  return { sqlite, database, order }
}

async function capture(sqlite: DatabaseSync, database: D1Database, orderId: string) {
  const row = sqlite
    .prepare('SELECT total_gross_cents AS total,reservation_id AS reservation FROM orders WHERE id=?')
    .get(orderId) as { total: number; reservation: string }
  await assignReservation(database, {
    idempotencyKey: row.reservation,
    correlationId: 'synthetic-capture',
    now: utc(),
    reason: 'Synthetic payment capture'
  })
  const id = testUuid(),
    now = utc()
  sqlite
    .prepare(
      `INSERT INTO payment_intents(id,order_id,provider,merchant_order,method,status,amount_gross_cents,currency,request_hash,redirect_envelope_hash,response_code,expires_at,correlation_id,created_at,updated_at)
    VALUES(?,?,'redsys',?,'card','captured',?,'EUR',?,?,'0000',?,'synthetic',?,?)`
    )
    .run(id, orderId, `1234${testUuid().slice(-8)}`, row.total, 'a'.repeat(64), 'b'.repeat(64), utc(3600000), now, now)
  sqlite
    .prepare(
      `INSERT INTO order_payment_states(order_id,status,active_intent_id,paid_gross_cents,updated_at) VALUES(?,'paid',?,?,?)`
    )
    .run(orderId, id, row.total, now)
  sqlite.prepare('INSERT INTO payment_fulfilment_claims VALUES(?,?,?)').run(orderId, id, now)
  sqlite
    .prepare(
      `INSERT INTO payment_recovery_jobs(payment_intent_id,order_id,status,attempts,due_at,created_at,updated_at) VALUES(?,?,'completed',1,?,?,?)`
    )
    .run(id, orderId, now, now, now)
  sqlite
    .prepare(
      `INSERT INTO payment_events(id,payment_intent_id,order_id,provider_event_id,event_type,payload_hash,response_code,correlation_id,created_at)
    VALUES(?,?,?,?,'captured',?,'0000','synthetic',?)`
    )
    .run(testUuid(), id, orderId, testUuid(), 'c'.repeat(64), now)
}
