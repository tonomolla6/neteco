import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase } from '../../server/db/client'
import {
  cancelOrderByAdmin,
  confirmMockPayment,
  createOrder,
  processPaymentNotification,
  type CreateOrderInput
} from '../../server/services/orders'

const connection = process.env.DATABASE_URL ?? 'postgres://neteco:neteco-local@localhost:56432/neteco'
const sql = postgres(connection, { max: 4 })
const execFileAsync = promisify(execFile)

interface StockFixture {
  variantId: string
  variantLegacyId: number
  locationId: string
  physicalQuantity: number
  blockedQuantity: number
  safetyStock: number
  backorderAllowed: boolean
  priceGrossCents: number
  sourceVersion: string | null
}

let stock: StockFixture
const cartIds = new Set<string>()

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
  const orders = await sql<{ id: string; customerId: string | null }[]>`
    SELECT id, customer_id AS "customerId" FROM orders WHERE cart_id IN ${sql(carts)}
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

beforeAll(async () => {
  const [fixture] = await sql<StockFixture[]>`
    SELECT v.id AS "variantId", v.legacy_id AS "variantLegacyId", balance.location_id AS "locationId",
           balance.physical_quantity AS "physicalQuantity", balance.blocked_quantity AS "blockedQuantity",
           v.safety_stock AS "safetyStock", v.backorder_allowed AS "backorderAllowed",
           price.gross_cents AS "priceGrossCents", price.pricing_version AS "sourceVersion"
    FROM variants v
    JOIN effective_variant_prices price ON price.variant_id = v.id
    JOIN products product ON product.id = v.product_id
    JOIN inventory_balances balance ON balance.variant_id = v.id
    WHERE v.status = 'published' AND product.status = 'published'
      AND v.minimum_quantity = 1 AND v.quantity_increment = 1
    ORDER BY v.id, balance.location_id
    LIMIT 1
  `
  if (!fixture) throw new Error('The integration catalog has no suitable stock fixture')
  stock = fixture
})

beforeEach(async () => {
  await sql`
    UPDATE variants SET safety_stock = 0, backorder_allowed = false WHERE id = ${stock.variantId}
  `
  await sql`
    UPDATE inventory_balances
    SET physical_quantity = 10, blocked_quantity = 0, version = version + 1, updated_at = now()
    WHERE variant_id = ${stock.variantId} AND location_id = ${stock.locationId}
  `
})

afterEach(async () => {
  await cleanupOrders()
})

afterAll(async () => {
  if (stock) {
    await sql`
      UPDATE variants
      SET safety_stock = ${stock.safetyStock}, backorder_allowed = ${stock.backorderAllowed}
      WHERE id = ${stock.variantId}
    `
    await sql`
      UPDATE inventory_balances
      SET physical_quantity = ${stock.physicalQuantity}, blocked_quantity = ${stock.blockedQuantity},
          version = version + 1, updated_at = now()
      WHERE variant_id = ${stock.variantId} AND location_id = ${stock.locationId}
    `
  }
  await closeDatabase()
  await sql.end({ timeout: 5 })
})

describe('commerce transaction spine', () => {
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
    const providerEventId = `event:${randomUUID()}`
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
        providerEventId: `event:${randomUUID()}`,
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
        providerEventId: `event:${randomUUID()}`,
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
      PAYMENT_PROVIDER: 'mock'
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
  })
})
