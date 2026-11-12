import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { Sql } from 'postgres'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase } from '../../server/db/client'
import { assertPurchasableVariant } from '../../server/services/cart'
import {
  cancelOrderByAdmin,
  confirmMockPayment,
  createOrder,
  processPaymentNotification,
  type CreateOrderInput
} from '../../server/services/orders'
import { hashAccessToken } from '../../server/utils/access-token'
import { decryptSecret } from '../../server/utils/secrets'
import { deterministicTestData, type DeterministicTestData } from '../fixtures/deterministic'
import { isolatedPostgresDatabase, type IsolatedPostgresDatabase } from '../fixtures/postgres'

const baseConnection = process.env.DATABASE_URL ?? 'postgres://neteco:neteco-local@localhost:56432/neteco'
let connection = baseConnection
let sql: Sql
let database: IsolatedPostgresDatabase
const execFileAsync = promisify(execFile)

interface StockFixture {
  variantId: string
  locationId: string
  priceGrossCents: number
  sourceVersion: string
}

interface CatalogTemplate {
  productId: string
  taxClassId: string
  shippingProfileId: string
  locationId: string
}

let stock: StockFixture
const cartIds = new Set<string>()
let testData: DeterministicTestData
const randomUUID = () => testData.uuid()

async function freshProviderEventId() {
  const providerEventId = `event:${randomUUID()}`
  await sql`DELETE FROM webhook_inbox WHERE provider = 'redsys' AND provider_event_id = ${providerEventId}`
  return providerEventId
}

async function cartInput(quantity = 1): Promise<CreateOrderInput> {
  const [cart] = await sql<{ id: string; version: number }[]>`
    INSERT INTO carts (public_token_hash, expires_at)
    VALUES (${`integration:${randomUUID()}`}, now() + interval '1 day')
    RETURNING id, version
  `
  await sql`
    INSERT INTO cart_items (cart_id, variant_id, quantity)
    VALUES (${cart!.id}, ${stock.variantId}, ${quantity})
  `
  cartIds.add(cart!.id)
  const marker = randomUUID()
  return {
    customer: {
      name: 'Comprador integración',
      company: '',
      nif: '',
      email: `${marker}@integration.invalid`,
      phone: '600000000'
    },
    shippingAddress: {
      recipientName: 'Comprador integración',
      companyName: '',
      taxId: '',
      line1: 'Calle de pruebas 1',
      line2: '',
      postalCode: '46800',
      city: 'Xàtiva',
      region: 'Valencia',
      countryCode: 'ES',
      phone: '600000000',
      instructions: ''
    },
    billingAddress: {
      recipientName: 'Comprador integración',
      companyName: '',
      taxId: '',
      line1: 'Calle fiscal 2',
      line2: '',
      postalCode: '46800',
      city: 'Xàtiva',
      region: 'Valencia',
      countryCode: 'ES',
      phone: '600000000',
      instructions: ''
    },
    shippingMethod: 'recogida',
    shippingServiceCode: 'WAREHOUSE-PICKUP',
    expectedPricingVersion: `catalog:${stock.sourceVersion ?? 'unknown'};shipping:neteco:WAREHOUSE-PICKUP`,
    expectedTotalGrossCents: stock.priceGrossCents * quantity,
    paymentMethod: 'tarjeta',
    cartId: cart!.id,
    cartVersion: cart!.version,
    idempotencyKey: randomUUID(),
    guestToken: randomUUID(),
    termsAccepted: true,
    marketingConsent: false,
    newsletterSecrets: {
      tokenPepper: 'integration-newsletter-token-pepper',
      encryptionKey: Buffer.alloc(32, 7).toString('base64')
    },
    correlationId: randomUUID()
  }
}

async function cleanupOrders() {
  if (cartIds.size === 0) return
  const carts = [...cartIds]
  const orders = await sql<{ id: string; publicNumber: string; customerId: string | null }[]>`
    SELECT id, public_number AS "publicNumber", customer_id AS "customerId"
    FROM orders WHERE cart_id IN ${sql(carts)}
  `
  const orderIds = orders.map((order) => order.id)
  if (orderIds.length > 0) {
    await sql.begin(async (transaction) => {
      await transaction`DELETE FROM analytics_events WHERE order_id IN ${transaction(orderIds)}`
      const refunds = await transaction<{ id: string }[]>`
        SELECT id FROM refunds WHERE order_id IN ${transaction(orderIds)}
      `
      const invoices = await transaction<{ id: string }[]>`
        SELECT id FROM invoices WHERE order_id IN ${transaction(orderIds)}
      `
      const aggregateIds = [
        ...orderIds,
        ...refunds.map((refund) => refund.id),
        ...invoices.map((invoice) => invoice.id)
      ]
      await transaction`DELETE FROM outbox_events WHERE aggregate_id IN ${transaction(aggregateIds)}`
      await transaction`
        DELETE FROM payment_events
        WHERE payment_intent_id IN (SELECT id FROM payment_intents WHERE order_id IN ${transaction(orderIds)})
      `
      await transaction`
        DELETE FROM webhook_inbox
        WHERE provider = 'redsys'
          AND sanitized_payload ->> 'orderReference' IN ${transaction(orders.map((order) => order.publicNumber))}
      `
      await transaction`DELETE FROM fulfillments WHERE order_id IN ${transaction(orderIds)}`
      await transaction`DELETE FROM invoices WHERE order_id IN ${transaction(orderIds)}`
      await transaction`DELETE FROM refunds WHERE order_id IN ${transaction(orderIds)}`
      await transaction`DELETE FROM payment_intents WHERE order_id IN ${transaction(orderIds)}`
      await transaction`DELETE FROM inventory_reservations WHERE order_id IN ${transaction(orderIds)}`
      await transaction`DELETE FROM inventory_movements WHERE reference_id IN ${transaction(orderIds)}`
      await transaction`DELETE FROM orders WHERE id IN ${transaction(orderIds)}`
      await transaction`
        DELETE FROM consent_events WHERE customer_id IN ${transaction(
          orders.flatMap((order) => (order.customerId ? [order.customerId] : []))
        )}
      `
      const subscriptionIds = await transaction<{ id: string }[]>`
        SELECT id FROM newsletter_subscriptions
        WHERE customer_id IN ${transaction(orders.flatMap((order) => (order.customerId ? [order.customerId] : [])))}
      `
      if (subscriptionIds.length) {
        await transaction`
          DELETE FROM outbox_events
          WHERE aggregate_type = 'newsletter_subscription'
            AND aggregate_id IN ${transaction(subscriptionIds.map((subscription) => subscription.id))}
        `
        await transaction`
          DELETE FROM newsletter_subscriptions
          WHERE id IN ${transaction(subscriptionIds.map((subscription) => subscription.id))}
        `
      }
    })
  }
  await sql`DELETE FROM carts WHERE id IN ${sql(carts)}`
  const customerIds = orders.flatMap((order) => (order.customerId ? [order.customerId] : []))
  if (customerIds.length > 0) await sql`DELETE FROM customers WHERE id IN ${sql(customerIds)}`
  cartIds.clear()
}

beforeEach(async (context) => {
  testData = deterministicTestData(`integration:commerce:${context.task.id}:${context.task.name}`)
  database = await isolatedPostgresDatabase(testData.namespace)
  connection = database.connection
  process.env.DATABASE_URL = connection
  await closeDatabase()
  sql = database.sql
  const [catalogTemplate] = await sql<CatalogTemplate[]>`
    SELECT variant.product_id AS "productId", variant.tax_class_id AS "taxClassId",
           variant.shipping_profile_id AS "shippingProfileId", balance.location_id AS "locationId"
    FROM variants variant
    JOIN products product ON product.id = variant.product_id
    JOIN inventory_balances balance ON balance.variant_id = variant.id
    WHERE variant.status = 'published' AND product.status = 'published'
    ORDER BY variant.id, balance.location_id
    LIMIT 1
  `
  if (!catalogTemplate) throw new Error('The integration catalog has no suitable template')
  const variantId = testData.uuid('stock-variant')
  const legacyId = 1_000_000_000 + Number.parseInt(testData.token('legacy-id').slice(0, 7), 16)
  const priceGrossCents = 1234
  await sql`
    INSERT INTO variants (
      id, legacy_id, product_id, tax_class_id, shipping_profile_id, sku, format, status,
      price_gross_cents, weight_grams, width_mm, height_mm, depth_mm, source_version
    ) VALUES (
      ${variantId}, ${legacyId}, ${catalogTemplate.productId}, ${catalogTemplate.taxClassId},
      ${catalogTemplate.shippingProfileId},
      ${`TST-${testData.token('sku').slice(0, 20).toUpperCase()}`}, 'Fixture integración', 'published',
      ${priceGrossCents}, 1000, 100, 100, 100, 'integration-fixture-v1'
    )
  `
  await sql`
    INSERT INTO inventory_balances (variant_id, location_id, physical_quantity, blocked_quantity)
    VALUES (${variantId}, ${catalogTemplate.locationId}, 10, 0)
  `
  stock = {
    variantId,
    locationId: catalogTemplate.locationId,
    priceGrossCents,
    sourceVersion: `legacy:${variantId}`
  }
})

afterEach(async () => {
  try {
    await cleanupOrders()
    if (stock) {
      await sql`DELETE FROM inventory_movements WHERE variant_id = ${stock.variantId}`
      await sql`DELETE FROM inventory_balances WHERE variant_id = ${stock.variantId}`
      await sql`DELETE FROM variants WHERE id = ${stock.variantId}`
    }
  } finally {
    try {
      try {
        await closeDatabase()
      } finally {
        await database.dispose()
      }
    } finally {
      connection = baseConnection
      process.env.DATABASE_URL = baseConnection
    }
  }
})

describe('commerce transaction spine', () => {
  it('never adds a "Consultar precio" variant (public price 0) to a cart', async () => {
    const [variant] = await sql<{ legacyId: number }[]>`
      UPDATE variants SET price_gross_cents = 0 WHERE id = ${stock.variantId} RETURNING legacy_id AS "legacyId"
    `
    await expect(
      sql.begin((transaction) => assertPurchasableVariant(transaction, variant!.legacyId, 1))
    ).rejects.toMatchObject({ statusCode: 409, data: { code: 'PRICE_ON_REQUEST' } })

    await sql`UPDATE variants SET price_gross_cents = ${stock.priceGrossCents} WHERE id = ${stock.variantId}`
    await expect(
      sql.begin((transaction) => assertPurchasableVariant(transaction, variant!.legacyId, 1))
    ).resolves.toMatchObject({ id: stock.variantId })
  })

  it('refuses to create an order with a line whose public price dropped to 0', async () => {
    const input = await cartInput()
    await sql`UPDATE variants SET price_gross_cents = 0 WHERE id = ${stock.variantId}`
    input.expectedTotalGrossCents = 0

    await expect(createOrder(input)).rejects.toMatchObject({
      statusCode: 409,
      data: { code: 'PRICE_ON_REQUEST' }
    })
    const [count] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM orders WHERE idempotency_key = ${input.idempotencyKey}
    `
    expect(count?.count).toBe(0)
  })

  it('requires explicit acceptance when the authoritative checkout quote changes', async () => {
    const input = await cartInput()
    input.expectedTotalGrossCents += 1

    await expect(createOrder(input)).rejects.toMatchObject({
      statusCode: 409,
      data: { code: 'CHECKOUT_QUOTE_CHANGED' }
    })
    const [count] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM orders WHERE idempotency_key = ${input.idempotencyKey}
    `
    expect(count?.count).toBe(0)
  })

  it('creates one order for an idempotency key even after the cart was converted', async () => {
    const input = await cartInput()
    const first = await createOrder(input)
    const replay = await createOrder(input)

    expect(replay).toEqual(first)
    const [count] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM orders WHERE idempotency_key = ${input.idempotencyKey}
    `
    expect(count!.count).toBe(1)
  })

  it('keeps billing and delivery snapshots separate and records optional marketing consent separately', async () => {
    const input = await cartInput()
    input.marketingConsent = true
    input.billingAddress = {
      ...input.billingAddress,
      recipientName: 'NETECO Cliente SL',
      companyName: 'NETECO Cliente SL',
      taxId: 'A58818501',
      line1: 'Avenida fiscal 99'
    }
    const order = await createOrder(input)

    const [state] = await sql<
      {
        shippingLine: string
        billingLine: string
        billingTaxId: string
        termsConsent: number
        combinedConsent: number
        marketingConsent: number
        marketingEnabled: boolean
        subscriptionStatus: string
        confirmationQueued: number
      }[]
    >`
      SELECT orders.shipping_snapshot ->> 'line1' AS "shippingLine",
             orders.billing_snapshot ->> 'line1' AS "billingLine",
             orders.billing_snapshot ->> 'taxId' AS "billingTaxId",
        (SELECT count(*) FROM consent_events
         WHERE customer_id = orders.customer_id AND purpose = 'purchase_terms')::int AS "termsConsent",
        (SELECT count(*) FROM consent_events
         WHERE customer_id = orders.customer_id AND purpose = 'purchase_terms_and_privacy')::int AS "combinedConsent",
        (SELECT count(*) FROM consent_events
         WHERE customer_id = orders.customer_id AND purpose = 'newsletter')::int AS "marketingConsent",
        COALESCE((SELECT enabled FROM customer_preferences
         WHERE customer_id = orders.customer_id AND purpose = 'newsletter' AND channel = 'email'), false)
          AS "marketingEnabled",
        (SELECT status FROM newsletter_subscriptions WHERE customer_id = orders.customer_id)
          AS "subscriptionStatus",
        (SELECT count(*) FROM outbox_events event
         JOIN newsletter_subscriptions subscription ON subscription.id = event.aggregate_id
         WHERE subscription.customer_id = orders.customer_id
           AND event.event_type = 'newsletter.confirmation.requested')::int AS "confirmationQueued"
      FROM orders WHERE public_number = ${order.id}
    `
    expect(state).toEqual({
      shippingLine: 'Calle de pruebas 1',
      billingLine: 'Avenida fiscal 99',
      billingTaxId: 'A58818501',
      termsConsent: 1,
      combinedConsent: 0,
      marketingConsent: 0,
      marketingEnabled: false,
      subscriptionStatus: 'pending',
      confirmationQueued: 1
    })
  })

  it('serializes the last unit, decrements physical stock once and rejects overselling', async () => {
    await sql`
      UPDATE inventory_balances SET physical_quantity = 1
      WHERE variant_id = ${stock.variantId} AND location_id = ${stock.locationId}
    `
    const inputs = await Promise.all([cartInput(), cartInput()])
    const attempts = await Promise.allSettled(inputs.map((input) => createOrder(input)))
    const accepted = attempts.filter((attempt) => attempt.status === 'fulfilled')
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected')

    expect(accepted).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 })

    const order = (accepted[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof createOrder>>>).value
    const input = inputs.find((candidate) => candidate.guestToken === order.token)!
    await Promise.all([
      confirmMockPayment({
        publicNumber: order.id,
        guestToken: input.guestToken,
        method: 'tarjeta',
        correlationId: randomUUID()
      }),
      confirmMockPayment({
        publicNumber: order.id,
        guestToken: input.guestToken,
        method: 'tarjeta',
        correlationId: randomUUID()
      })
    ])

    const [state] = await sql<
      {
        physical: number
        reservations: number
        allocations: number
        allocatedQuantity: number
        invoicesQueued: number
      }[]
    >`
      SELECT
        (SELECT physical_quantity FROM inventory_balances
         WHERE variant_id = ${stock.variantId} AND location_id = ${stock.locationId})::int AS physical,
        (SELECT count(*) FROM inventory_reservations reservation
         JOIN orders ON orders.id = reservation.order_id
         WHERE orders.public_number = ${order.id} AND reservation.status = 'allocated')::int AS reservations,
        (SELECT count(*) FROM inventory_movements movement
         JOIN orders ON orders.id = movement.reference_id
         WHERE orders.public_number = ${order.id} AND movement.movement_type = 'allocate')::int AS allocations,
        (SELECT COALESCE(sum(movement.quantity), 0) FROM inventory_movements movement
         JOIN orders ON orders.id = movement.reference_id
         WHERE orders.public_number = ${order.id} AND movement.movement_type = 'allocate')::int AS "allocatedQuantity",
        (SELECT count(*) FROM outbox_events event
         JOIN orders ON orders.id = event.aggregate_id
         WHERE orders.public_number = ${order.id} AND event.event_type = 'invoice.issue.requested')::int AS "invoicesQueued"
    `
    expect(state).toEqual({ physical: 0, reservations: 1, allocations: 1, allocatedQuantity: -1, invoicesQueued: 1 })

    await expect(createOrder(await cartInput())).rejects.toMatchObject({ statusCode: 409 })
  })

  it('deduplicates provider event IDs and ignores stale failures after capture', async () => {
    const input = await cartInput()
    const order = await createOrder(input)
    const providerEventId = await freshProviderEventId()
    const captured = {
      providerEventId,
      orderReference: order.id,
      amountCents: order.total,
      currency: 'EUR' as const,
      status: 'captured' as const,
      responseCode: '0000',
      payloadHash: randomUUID().replaceAll('-', '')
    }
    const first = await processPaymentNotification(captured, randomUUID())
    const replay = await processPaymentNotification(
      { ...captured, payloadHash: randomUUID().replaceAll('-', '') },
      randomUUID()
    )
    await processPaymentNotification(
      {
        ...captured,
        providerEventId: await freshProviderEventId(),
        payloadHash: randomUUID().replaceAll('-', ''),
        status: 'failed',
        responseCode: '0101'
      },
      randomUUID()
    )

    expect(first).toEqual({ accepted: true, duplicate: false })
    expect(replay).toEqual({ accepted: true, duplicate: true })
    const [state] = await sql<
      { paymentStatus: string; physical: number; allocations: number; invoiceEvents: number }[]
    >`
      SELECT orders.payment_status AS "paymentStatus",
        (SELECT physical_quantity FROM inventory_balances
         WHERE variant_id = ${stock.variantId} AND location_id = ${stock.locationId})::int AS physical,
        (SELECT count(*) FROM inventory_movements movement
         WHERE movement.reference_id = orders.id AND movement.movement_type = 'allocate')::int AS allocations,
        (SELECT count(*) FROM outbox_events event
         WHERE event.aggregate_id = orders.id AND event.event_type = 'invoice.issue.requested')::int AS "invoiceEvents"
      FROM orders WHERE orders.public_number = ${order.id}
    `
    expect(state).toEqual({ paymentStatus: 'captured', physical: 9, allocations: 1, invoiceEvents: 1 })
    const analytics = await sql<
      Array<{
        eventName: string
        source: string
        orderId: string
        dedupeKey: string
        properties: Record<string, unknown>
      }>
    >`
      SELECT event.event_name AS "eventName", event.source, event.order_id AS "orderId",
             event.dedupe_key AS "dedupeKey", event.properties
      FROM analytics_events event
      JOIN orders ON orders.id = event.order_id
      WHERE orders.public_number = ${order.id} AND event.event_name = 'order_confirmed'
    `
    expect(analytics).toEqual([
      expect.objectContaining({
        eventName: 'order_confirmed',
        source: 'server',
        dedupeKey: `order:${analytics[0]?.orderId}:confirmed`,
        properties: {
          orderNumber: order.id,
          totalCents: order.total,
          currency: 'EUR',
          paymentMethod: 'tarjeta'
        }
      })
    ])
  })

  it('cancels an unpaid order by releasing its reservation exactly once', async () => {
    const input = await cartInput()
    const order = await createOrder(input)
    const cancellation = {
      publicNumber: order.id,
      actorId: randomUUID(),
      reason: 'Solicitud verificada del cliente',
      correlationId: randomUUID()
    }
    const first = await cancelOrderByAdmin(cancellation)
    const replay = await cancelOrderByAdmin({ ...cancellation, correlationId: randomUUID() })

    expect(first).toMatchObject({ orderStatus: 'cancelled', duplicate: false })
    expect(replay).toMatchObject({ orderStatus: 'cancelled', duplicate: true })
    const [state] = await sql<
      { orderStatus: string; paymentStatus: string; inventoryStatus: string; releases: number; active: number }[]
    >`
      SELECT orders.order_status AS "orderStatus", orders.payment_status AS "paymentStatus",
             orders.inventory_status AS "inventoryStatus",
        (SELECT count(*) FROM inventory_movements movement
         WHERE movement.reference_id = orders.id AND movement.movement_type = 'release')::int AS releases,
        (SELECT count(*) FROM inventory_reservations reservation
         WHERE reservation.order_id = orders.id AND reservation.status = 'active')::int AS active
      FROM orders WHERE orders.public_number = ${order.id}
    `
    expect(state).toEqual({
      orderStatus: 'cancelled',
      paymentStatus: 'cancelled',
      inventoryStatus: 'released',
      releases: 1,
      active: 0
    })
  })

  it('requests an authorization void without reporting a false cancellation or refund', async () => {
    const input = await cartInput()
    const order = await createOrder(input)
    await processPaymentNotification(
      {
        providerEventId: await freshProviderEventId(),
        providerReference: `authorization:${randomUUID()}`,
        orderReference: order.id,
        amountCents: order.total,
        currency: 'EUR',
        status: 'authorized',
        responseCode: '0000',
        payloadHash: randomUUID().replaceAll('-', '')
      },
      randomUUID()
    )

    const result = await cancelOrderByAdmin({
      publicNumber: order.id,
      actorId: randomUUID(),
      reason: 'Anulación de autorización previa a captura',
      correlationId: randomUUID()
    })

    expect(result).toMatchObject({ orderStatus: 'on_hold', refundId: null, duplicate: false })
    const [state] = await sql<
      {
        orderStatus: string
        paymentStatus: string
        inventoryStatus: string
        voidJobs: number
        refunds: number
        physical: number
      }[]
    >`
      SELECT orders.order_status AS "orderStatus", orders.payment_status AS "paymentStatus",
             orders.inventory_status AS "inventoryStatus",
        (SELECT count(*) FROM outbox_events event
         WHERE event.aggregate_id = payment_intents.id
           AND event.event_type = 'payment.authorization.void.requested')::int AS "voidJobs",
        (SELECT count(*) FROM refunds WHERE order_id = orders.id)::int AS refunds,
        (SELECT physical_quantity FROM inventory_balances
         WHERE variant_id = ${stock.variantId} AND location_id = ${stock.locationId})::int AS physical
      FROM orders
      JOIN payment_intents ON payment_intents.order_id = orders.id
      WHERE orders.public_number = ${order.id}
    `
    expect(state).toEqual({
      orderStatus: 'on_hold',
      paymentStatus: 'authorized',
      inventoryStatus: 'released',
      voidJobs: 1,
      refunds: 0,
      physical: 10
    })
  })

  it('restocks a captured unfulfilled order once and queues one audited refund', async () => {
    const input = await cartInput()
    const order = await createOrder(input)
    await confirmMockPayment({
      publicNumber: order.id,
      guestToken: input.guestToken,
      method: 'tarjeta',
      correlationId: randomUUID()
    })
    const cancellation = {
      publicNumber: order.id,
      actorId: randomUUID(),
      reason: 'Cancelación antes de preparación',
      correlationId: randomUUID()
    }
    const first = await cancelOrderByAdmin(cancellation)
    const replay = await cancelOrderByAdmin({ ...cancellation, correlationId: randomUUID() })

    expect(first).toMatchObject({ orderStatus: 'on_hold', duplicate: false })
    expect(replay).toMatchObject({ orderStatus: 'on_hold', duplicate: true })
    const [state] = await sql<
      {
        orderStatus: string
        paymentStatus: string
        inventoryStatus: string
        physical: number
        refunds: number
        restocks: number
        refundJobs: number
      }[]
    >`
      SELECT orders.order_status AS "orderStatus", orders.payment_status AS "paymentStatus",
             orders.inventory_status AS "inventoryStatus",
        (SELECT physical_quantity FROM inventory_balances
         WHERE variant_id = ${stock.variantId} AND location_id = ${stock.locationId})::int AS physical,
        (SELECT count(*) FROM refunds WHERE order_id = orders.id)::int AS refunds,
        (SELECT count(*) FROM inventory_movements movement
         WHERE movement.reference_id = orders.id AND movement.movement_type = 'return')::int AS restocks,
        (SELECT count(*) FROM outbox_events event
         JOIN refunds refund ON refund.id = event.aggregate_id
         WHERE refund.order_id = orders.id AND event.event_type = 'refund.execute.requested')::int AS "refundJobs"
      FROM orders WHERE orders.public_number = ${order.id}
    `
    expect(state).toEqual({
      orderStatus: 'on_hold',
      paymentStatus: 'captured',
      inventoryStatus: 'released',
      physical: 10,
      refunds: 1,
      restocks: 1,
      refundJobs: 1
    })
  })

  it('persists invoice and cancellation credit-note PDFs through idempotent workers', async () => {
    const input = await cartInput()
    const order = await createOrder(input)
    await confirmMockPayment({
      publicNumber: order.id,
      guestToken: input.guestToken,
      method: 'tarjeta',
      correlationId: randomUUID()
    })
    const [internal] = await sql<{ id: string }[]>`SELECT id FROM orders WHERE public_number = ${order.id}`
    const workerEnvironment = {
      ...process.env,
      DATABASE_URL: connection,
      APP_ENV: 'test',
      INVOICE_PROVIDER: 'mock',
      PAYMENT_PROVIDER: 'mock',
      AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64')
    }
    await execFileAsync(
      'node_modules/.bin/tsx',
      ['scripts/invoice-worker.ts', '--once', `--aggregate-id=${internal!.id}`],
      { cwd: process.cwd(), env: workerEnvironment }
    )

    const [invoice] = await sql<
      { id: string; status: string; checksum: string | null; size: number | null; bytes: Uint8Array | null }[]
    >`
      SELECT id, status, pdf_checksum AS checksum, pdf_size AS size, pdf_bytes AS bytes
      FROM invoices WHERE order_id = ${internal!.id} AND kind = 'invoice'
    `
    if (!invoice) {
      const [job] = await sql<{ status: string; code: string | null; message: string | null }[]>`
        SELECT status, last_error_code AS code, last_error_message AS message
        FROM outbox_events
        WHERE aggregate_id = ${internal!.id} AND event_type = 'invoice.issue.requested'
      `
      throw new Error(`Invoice worker did not create the document: ${JSON.stringify(job)}`)
    }
    expect(invoice).toMatchObject({ status: 'issued' })
    expect(invoice!.checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(invoice!.size).toBeGreaterThan(10)
    expect(Buffer.from(invoice!.bytes!).subarray(0, 4).toString('ascii')).toBe('%PDF')
    const [invoiceEmail] = await sql<
      { tokenEnvelope: string; expiresAt: string; invoiceId: string; accessSessions: number }[]
    >`
      SELECT event.payload ->> 'tokenEnvelope' AS "tokenEnvelope",
             event.payload ->> 'expiresAt' AS "expiresAt",
             event.payload ->> 'invoiceId' AS "invoiceId",
             (SELECT count(*) FROM order_access_sessions session
              WHERE session.order_id = ${internal!.id})::int AS "accessSessions"
      FROM outbox_events event
      WHERE event.aggregate_id = ${invoice.id} AND event.event_type = 'invoice.issued'
    `
    expect(invoiceEmail).toMatchObject({ invoiceId: invoice.id, accessSessions: 1 })
    expect(invoiceEmail!.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const invoiceToken = decryptSecret(invoiceEmail!.tokenEnvelope, workerEnvironment.AUTH_ENCRYPTION_KEY)
    const [invoiceAccess] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM order_access_sessions
        WHERE order_id = ${internal!.id} AND token_hash = ${hashAccessToken(invoiceToken)}
          AND revoked_at IS NULL AND expires_at > now()
      ) AS exists
    `
    expect(invoiceAccess?.exists).toBe(true)

    const cancelled = await cancelOrderByAdmin({
      publicNumber: order.id,
      actorId: randomUUID(),
      reason: 'Cancelación fiscal de integración',
      correlationId: randomUUID()
    })
    expect(cancelled.refundId).toMatch(/^[0-9a-f-]{36}$/)
    await execFileAsync(
      'node_modules/.bin/tsx',
      ['scripts/refund-worker.ts', '--once', `--aggregate-id=${cancelled.refundId}`],
      { cwd: process.cwd(), env: workerEnvironment }
    )
    await execFileAsync(
      'node_modules/.bin/tsx',
      ['scripts/refund-worker.ts', '--once', `--aggregate-id=${cancelled.refundId}`],
      { cwd: process.cwd(), env: workerEnvironment }
    )
    await execFileAsync(
      'node_modules/.bin/tsx',
      ['scripts/credit-note-worker.ts', '--once', `--aggregate-id=${cancelled.refundId}`],
      { cwd: process.cwd(), env: workerEnvironment }
    )

    const documents = await sql<
      { kind: string; status: string; amount: number; checksum: string | null; size: number | null }[]
    >`
      SELECT kind, status, amount_cents AS amount, pdf_checksum AS checksum, pdf_size AS size
      FROM invoices WHERE order_id = ${internal!.id} ORDER BY fiscal_version
    `
    expect(documents).toHaveLength(2)
    expect(documents[1]).toMatchObject({ kind: 'credit_note', status: 'issued', amount: order.total })
    expect(documents[1]!.checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(documents[1]!.size).toBeGreaterThan(10)
    const [refund] = await sql<{ status: string; lines: number; gross: number }[]>`
      SELECT refund.status, count(line.id)::int AS lines, COALESCE(sum(line.gross_cents), 0)::int AS gross
      FROM refunds refund LEFT JOIN refund_lines line ON line.refund_id = refund.id
      WHERE refund.id = ${cancelled.refundId}
      GROUP BY refund.id
    `
    expect(refund).toEqual({ status: 'succeeded', lines: 1, gross: order.total })
    const analytics = await sql<
      Array<{
        eventName: string
        source: string
        orderId: string
        dedupeKey: string
        properties: Record<string, unknown>
      }>
    >`
      SELECT event_name AS "eventName", source, order_id AS "orderId", dedupe_key AS "dedupeKey", properties
      FROM analytics_events WHERE order_id = ${internal!.id}
      ORDER BY event_name
    `
    expect(analytics).toEqual([
      expect.objectContaining({ eventName: 'order_confirmed', source: 'server' }),
      expect.objectContaining({
        eventName: 'refund_confirmed',
        source: 'server',
        orderId: internal!.id,
        dedupeKey: `refund:${cancelled.refundId}:confirmed`,
        properties: {
          orderNumber: order.id,
          refundId: cancelled.refundId,
          amountCents: order.total
        }
      })
    ])
  })

  it('routes an ambiguous Beply duplicate to fiscal reconciliation without blind reissue', async () => {
    const input = await cartInput()
    const order = await createOrder(input)
    await confirmMockPayment({
      publicNumber: order.id,
      guestToken: input.guestToken,
      method: 'tarjeta',
      correlationId: randomUUID()
    })
    const [internal] = await sql<{ id: string }[]>`SELECT id FROM orders WHERE public_number = ${order.id}`
    const server = spawn('node_modules/.bin/tsx', ['scripts/test-beply-contract-server.ts'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const port = await new Promise<number>((resolve, reject) => {
      let output = ''
      server.once('error', reject)
      server.stderr.once('data', (chunk) => reject(new Error(String(chunk))))
      server.stdout.on('data', (chunk) => {
        output += String(chunk)
        const newline = output.indexOf('\n')
        if (newline < 0) return
        resolve((JSON.parse(output.slice(0, newline)) as { port: number }).port)
      })
    })
    try {
      const workerEnvironment = {
        ...process.env,
        DATABASE_URL: connection,
        APP_ENV: 'test',
        INVOICE_PROVIDER: 'beply',
        AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 12).toString('base64'),
        BEPLY_BASE_URL: `http://127.0.0.1:${port}/api/3`,
        BEPLY_API_TOKEN: 'integration-beply-token',
        BEPLY_INVOICE_SERIES: 'NE',
        BEPLY_CORRECTIVE_SERIES: 'NR',
        BEPLY_TAX_CODE_0: 'IVA0',
        BEPLY_TAX_CODE_10: 'IVA10',
        BEPLY_TAX_CODE_21: 'IVA21',
        BEPLY_PAYMENT_CODE_REDSYS: 'REDSYS',
        BEPLY_PAYMENT_CODE_BANK_TRANSFER: 'TRANSFER',
        BEPLY_COMPANY_ID: '1'
      }
      await execFileAsync(
        'node_modules/.bin/tsx',
        ['scripts/invoice-worker.ts', '--once', `--aggregate-id=${internal!.id}`],
        { cwd: process.cwd(), env: workerEnvironment }
      )

      const [state] = await sql<
        Array<{
          orderStatus: string
          invoiceStatus: string
          reconciliationRequired: boolean
          errorCode: string
          issueJobs: number
          reconciliationJobs: number
        }>
      >`
        SELECT orders.invoice_status AS "orderStatus", invoice.status AS "invoiceStatus",
               invoice.reconciliation_required AS "reconciliationRequired",
               invoice.last_error_code AS "errorCode",
          (SELECT count(*) FROM outbox_events event WHERE event.aggregate_id = orders.id
            AND event.event_type = 'invoice.issue.requested' AND event.status = 'completed')::int AS "issueJobs",
          (SELECT count(*) FROM outbox_events event WHERE event.aggregate_id = invoice.id
            AND event.event_type = 'invoice.reconciliation.requested')::int AS "reconciliationJobs"
        FROM orders JOIN invoices invoice ON invoice.order_id = orders.id AND invoice.kind = 'invoice'
        WHERE orders.id = ${internal!.id}
      `
      expect(state).toEqual({
        orderStatus: 'fiscal_pending',
        invoiceStatus: 'fiscal_pending',
        reconciliationRequired: true,
        errorCode: 'beply_duplicate',
        issueJobs: 1,
        reconciliationJobs: 1
      })
      const expectedCustomerCode = `NE${internal!.id
        .replace(/[^A-Za-z0-9]/g, '')
        .toUpperCase()
        .slice(-18)}`
      const requests = (await fetch(`http://127.0.0.1:${port}/__requests`).then((response) =>
        response.json()
      )) as Array<{
        method: string
        path: string
        token: string
      }>
      expect(requests).toEqual([
        { method: 'POST', path: '/api/3/clientes', token: 'integration-beply-token' },
        {
          method: 'GET',
          path: `/api/3/contactos?filter[codcliente]=${expectedCustomerCode}&limit=1`,
          token: 'integration-beply-token'
        },
        { method: 'POST', path: '/api/3/contactos', token: 'integration-beply-token' },
        { method: 'POST', path: '/api/3/crearFacturaCliente', token: 'integration-beply-token' }
      ])

      const reconciliation = await execFileAsync('node_modules/.bin/tsx', ['scripts/reconcile.ts'], {
        cwd: process.cwd(),
        env: workerEnvironment
      }).then(
        ({ stdout }) => ({ exitCode: 0, stdout }),
        (error: unknown) => {
          const failure = error as { code?: number; stdout?: string }
          return { exitCode: failure.code, stdout: failure.stdout ?? '' }
        }
      )
      expect(reconciliation.exitCode).toBe(2)
      const report = JSON.parse(reconciliation.stdout) as {
        fiscalPending: Array<{ invoiceId: string; orderNumber: string; code: string }>
      }
      expect(report.fiscalPending).toContainEqual(
        expect.objectContaining({ orderNumber: order.id, code: 'beply_duplicate' })
      )
    } finally {
      server.kill('SIGTERM')
      await new Promise<void>((resolve) => server.once('exit', () => resolve()))
    }
  })
})
