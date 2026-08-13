import { randomUUID } from 'node:crypto'
import postgres from 'postgres'

const connection = process.env.DATABASE_URL?.trim()
if (!connection) throw new Error('DATABASE_URL is required')
const sql = postgres(connection, { max: 1, connect_timeout: 10 })
const correlationId = randomUUID()

try {
  const missing = await sql<{ id: string; publicNumber: string }[]>`
    SELECT orders.id, orders.public_number AS "publicNumber"
    FROM orders
    LEFT JOIN invoices invoice ON invoice.order_id = orders.id AND invoice.kind = 'invoice' AND invoice.fiscal_version = 1
    WHERE orders.payment_status IN ('captured', 'authorized', 'partially_refunded', 'refunded')
      AND invoice.id IS NULL
  `
  for (const order of missing) {
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO outbox_events (
          aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
        ) VALUES (
          'order', ${order.id}, 'invoice.issue.requested',
          ${transaction.json({ orderId: order.id, orderNumber: order.publicNumber, source: 'reconciliation' })},
          ${correlationId}, ${`invoice:${order.id}:issue:v1`}
        ) ON CONFLICT (idempotency_key) DO UPDATE SET
          status = CASE
            WHEN outbox_events.status IN ('completed', 'processing') THEN outbox_events.status
            ELSE 'pending'
          END,
          available_at = CASE
            WHEN outbox_events.status IN ('completed', 'processing') THEN outbox_events.available_at
            ELSE now()
          END,
          locked_at = CASE WHEN outbox_events.status = 'processing' THEN outbox_events.locked_at ELSE NULL END,
          locked_by = CASE WHEN outbox_events.status = 'processing' THEN outbox_events.locked_by ELSE NULL END
      `
      await transaction`
        UPDATE orders SET invoice_status = 'queued', updated_at = now()
        WHERE id = ${order.id} AND invoice_status IN ('not_requested', 'failed')
      `
    })
  }
  const amountMismatches = await sql<Array<{ publicNumber: string; orderAmount: number; invoiceAmount: number }>>`
    SELECT orders.public_number AS "publicNumber", orders.total_gross_cents AS "orderAmount",
           invoice.amount_cents AS "invoiceAmount"
    FROM orders
    JOIN invoices invoice ON invoice.order_id = orders.id AND invoice.kind = 'invoice'
    WHERE abs(orders.total_gross_cents - invoice.amount_cents) > 1
  `
  const duplicateProviderIds = await sql<Array<{ providerId: string; count: number }>>`
    SELECT provider_invoice_id AS "providerId", count(*)::int AS count
    FROM invoices
    WHERE provider_invoice_id IS NOT NULL
    GROUP BY provider_invoice_id HAVING count(*) > 1
  `
  const missingCredits = await sql<{ refundId: string; orderId: string }[]>`
    SELECT refund.id AS "refundId", refund.order_id AS "orderId"
    FROM refunds refund
    JOIN invoices source ON source.order_id = refund.order_id
      AND source.kind = 'invoice' AND source.status = 'issued'
    LEFT JOIN invoices credit ON credit.refund_id = refund.id
    WHERE refund.status = 'succeeded' AND credit.id IS NULL
  `
  for (const refund of missingCredits) {
    await sql`
      INSERT INTO outbox_events (
        aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
      ) VALUES (
        'refund', ${refund.refundId}, 'invoice.credit.requested',
        ${sql.json({ refundId: refund.refundId, orderId: refund.orderId, source: 'reconciliation' })},
        ${correlationId}, ${`refund:${refund.refundId}:credit-note`}
      ) ON CONFLICT (idempotency_key) DO UPDATE SET
        status = CASE
          WHEN outbox_events.status IN ('completed', 'processing') THEN outbox_events.status
          ELSE 'pending'
        END,
        available_at = CASE
          WHEN outbox_events.status IN ('completed', 'processing') THEN outbox_events.available_at
          ELSE now()
        END,
        locked_at = CASE WHEN outbox_events.status = 'processing' THEN outbox_events.locked_at ELSE NULL END,
        locked_by = CASE WHEN outbox_events.status = 'processing' THEN outbox_events.locked_by ELSE NULL END
    `
  }
  const fiscalPending = await sql<
    { invoiceId: string; orderNumber: string; kind: string; code: string | null; message: string | null }[]
  >`
    SELECT invoice.id AS "invoiceId", orders.public_number AS "orderNumber", invoice.kind,
           invoice.last_error_code AS code, invoice.last_error_message AS message
    FROM invoices invoice
    JOIN orders ON orders.id = invoice.order_id
    WHERE invoice.reconciliation_required OR invoice.status = 'fiscal_pending'
    ORDER BY invoice.updated_at
  `
  const paymentDiscrepancies = await sql<
    { orderNumber: string; orderStatus: string; paymentStatus: string; intentStatus: string }[]
  >`
    SELECT orders.public_number AS "orderNumber", orders.order_status AS "orderStatus",
           orders.payment_status AS "paymentStatus", payment.status AS "intentStatus"
    FROM orders
    JOIN payment_intents payment ON payment.order_id = orders.id
    WHERE orders.payment_status <> payment.status
       OR (orders.order_status = 'confirmed' AND orders.payment_status NOT IN ('captured', 'partially_refunded'))
  `
  const inventoryDiscrepancies = await sql<
    { sku: string; physical: number; blocked: number; activeReserved: number; ledgerPhysical: number }[]
  >`
    SELECT variant.sku, balance.physical_quantity AS physical, balance.blocked_quantity AS blocked,
           COALESCE(reservation.quantity, 0)::int AS "activeReserved",
           COALESCE(movement.quantity, 0)::int AS "ledgerPhysical"
    FROM inventory_balances balance
    JOIN variants variant ON variant.id = balance.variant_id
    LEFT JOIN LATERAL (
      SELECT sum(quantity)::int AS quantity FROM inventory_reservations
      WHERE variant_id = balance.variant_id AND location_id = balance.location_id
        AND status = 'active' AND expires_at > now()
    ) reservation ON true
    LEFT JOIN LATERAL (
      SELECT sum(physical_delta)::int AS quantity FROM inventory_movements
      WHERE variant_id = balance.variant_id AND location_id = balance.location_id
    ) movement ON true
    WHERE balance.physical_quantity < 0
       OR balance.blocked_quantity > balance.physical_quantity
       OR balance.physical_quantity <> COALESCE(movement.quantity, 0)
  `
  const staleRefunds = await sql<{ id: string; orderNumber: string; status: string; ageMinutes: number }[]>`
    SELECT refund.id, orders.public_number AS "orderNumber", refund.status,
           floor(extract(epoch FROM (now() - refund.updated_at)) / 60)::int AS "ageMinutes"
    FROM refunds refund JOIN orders ON orders.id = refund.order_id
    WHERE refund.status IN ('requested', 'pending') AND refund.updated_at < now() - interval '30 minutes'
  `
  process.stdout.write(
    `${JSON.stringify({
      correlationId,
      repairedMissingInvoices: missing.length,
      repairedMissingCredits: missingCredits.length,
      amountMismatches,
      duplicateProviderIds,
      fiscalPending,
      paymentDiscrepancies,
      inventoryDiscrepancies,
      staleRefunds
    })}\n`
  )
  if (
    amountMismatches.length ||
    duplicateProviderIds.length ||
    fiscalPending.length ||
    paymentDiscrepancies.length ||
    inventoryDiscrepancies.length ||
    staleRefunds.length
  ) {
    process.exitCode = 2
  }
} finally {
  await sql.end({ timeout: 5 })
}
