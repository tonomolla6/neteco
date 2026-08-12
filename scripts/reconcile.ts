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
    WHERE orders.payment_status IN ('captured', 'authorized')
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
          status = CASE WHEN outbox_events.status = 'completed' THEN outbox_events.status ELSE 'pending' END,
          available_at = CASE WHEN outbox_events.status = 'completed' THEN outbox_events.available_at ELSE now() END,
          locked_at = NULL, locked_by = NULL
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
  process.stdout.write(
    `${JSON.stringify({ correlationId, repairedMissingInvoices: missing.length, amountMismatches, duplicateProviderIds })}\n`
  )
  if (amountMismatches.length || duplicateProviderIds.length) process.exitCode = 2
} finally {
  await sql.end({ timeout: 5 })
}
