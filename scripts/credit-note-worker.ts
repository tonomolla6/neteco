import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { splitGross } from '../server/domain/money'
import { BeplyError } from '../server/integrations/beply'
import { invoiceProviderFromEnvironment } from '../server/integrations/invoice-factory'
import type { IssueInvoiceRequest } from '../server/integrations/invoice-provider'

interface Job {
  id: string
  aggregateId: string
  correlationId: string
  attempts: number
}

interface CreditSnapshot {
  refundId: string
  returnId: string
  returnNumber: string
  amountCents: number
  orderId: string
  orderNumber: string
  customer: { name: string; company: string | null; taxId: string | null; email: string; phone: string }
  billing: { line1: string; postalCode: string; city: string; region: string; countryCode: string }
  sourceInvoiceId: string
  sourceProviderInvoiceId: string
}

const connection = process.env.DATABASE_URL?.trim()
if (!connection) throw new Error('DATABASE_URL is required')
const sql = postgres(connection, { max: 2, connect_timeout: 10 })
const provider = invoiceProviderFromEnvironment()
const workerId = `credit-${process.pid}-${randomUUID()}`

async function claim() {
  return sql.begin(async (transaction) => {
    const [job] = await transaction<Job[]>`
      SELECT id, aggregate_id AS "aggregateId", correlation_id AS "correlationId", attempts
      FROM outbox_events
      WHERE status IN ('pending', 'retry') AND available_at <= now()
        AND event_type = 'invoice.credit.requested'
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    `
    if (!job) return undefined
    await transaction`
      UPDATE outbox_events SET status = 'processing', attempts = attempts + 1,
        locked_at = now(), locked_by = ${workerId} WHERE id = ${job.id}
    `
    return { ...job, attempts: job.attempts + 1 }
  })
}

async function loadSnapshot(refundId: string) {
  const [snapshot] = await sql<CreditSnapshot[]>`
    SELECT refund.id AS "refundId", refund.return_id AS "returnId", r.public_number AS "returnNumber",
           refund.amount_cents AS "amountCents", orders.id AS "orderId", orders.public_number AS "orderNumber",
           orders.customer_snapshot AS customer, orders.billing_snapshot AS billing,
           source.id AS "sourceInvoiceId", source.provider_invoice_id AS "sourceProviderInvoiceId"
    FROM refunds refund
    JOIN returns r ON r.id = refund.return_id
    JOIN orders ON orders.id = refund.order_id
    JOIN invoices source ON source.order_id = orders.id AND source.kind = 'invoice' AND source.status = 'issued'
    WHERE refund.id = ${refundId} AND refund.status = 'succeeded'
  `
  return snapshot
}

function request(snapshot: CreditSnapshot): IssueInvoiceRequest & { sourceProviderInvoiceId: string; reason: string } {
  const net = splitGross(snapshot.amountCents, 2100).netCents
  return {
    orderId: snapshot.orderId,
    orderNumber: `${snapshot.orderNumber}-${snapshot.returnNumber}`,
    series: process.env.BEPLY_CORRECTIVE_SERIES || 'RECT',
    issuedOn: new Date().toISOString(),
    customer: {
      externalKey: snapshot.orderId,
      legalName: snapshot.customer.company?.trim() || snapshot.customer.name,
      taxId: snapshot.customer.taxId?.trim() || '00000000T',
      email: snapshot.customer.email,
      phone: snapshot.customer.phone,
      address: snapshot.billing
    },
    lines: [
      {
        sku: snapshot.returnNumber,
        description: `Rectificación ${snapshot.returnNumber}`,
        quantity: 1,
        unitNetCents: net,
        lineNetCents: net,
        discountNetCents: 0,
        taxRateBasisPoints: 2100
      }
    ],
    shippingNetCents: 0,
    currency: 'EUR',
    idempotencyKey: `credit:${snapshot.refundId}`,
    sourceProviderInvoiceId: snapshot.sourceProviderInvoiceId,
    reason: `Devolución ${snapshot.returnNumber}`
  }
}

async function processJob(job: Job) {
  const snapshot = await loadSnapshot(job.aggregateId)
  if (!snapshot) throw new Error('Credit note requires a succeeded refund and issued source invoice')
  const [existing] = await sql<{ status: string }[]>`
    SELECT status FROM invoices WHERE refund_id = ${snapshot.refundId}
  `
  if (existing?.status === 'issued') {
    await sql`
      UPDATE outbox_events SET status = 'completed', completed_at = now(), locked_at = NULL, locked_by = NULL
      WHERE id = ${job.id} AND locked_by = ${workerId}
    `
    return
  }
  const [version] = await sql<{ value: number }[]>`
    SELECT COALESCE(max(fiscal_version), 0)::int + 1 AS value FROM invoices WHERE order_id = ${snapshot.orderId}
  `
  const fiscalVersion = version?.value ?? 2
  await sql`
    INSERT INTO invoices (
      order_id, provider, series, kind, status, fiscal_version, amount_cents, currency,
      source_invoice_id, return_id, refund_id, idempotency_key
    ) VALUES (
      ${snapshot.orderId}, ${provider.name}, ${process.env.BEPLY_CORRECTIVE_SERIES || 'RECT'},
      'credit_note', 'issuing', ${fiscalVersion}, ${snapshot.amountCents}, 'EUR',
      ${snapshot.sourceInvoiceId}, ${snapshot.returnId}, ${snapshot.refundId}, ${`credit:${snapshot.refundId}`}
    ) ON CONFLICT (refund_id) WHERE refund_id IS NOT NULL DO UPDATE SET status = 'issuing', updated_at = now()
  `
  const issued = await provider.issueCreditNote(request(snapshot))
  if (issued.amountCents > 0 && Math.abs(issued.amountCents - snapshot.amountCents) > 1) {
    throw new Error(`Credit amount mismatch: refund=${snapshot.amountCents} provider=${issued.amountCents}`)
  }
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE invoices SET provider_invoice_id = ${issued.providerId}, provider_code = ${issued.code},
        status = ${issued.status}, issued_at = now(), updated_at = now()
      WHERE refund_id = ${snapshot.refundId}
    `
    await transaction`
      UPDATE orders SET invoice_status = 'rectified', updated_at = now() WHERE id = ${snapshot.orderId}
    `
    await transaction`
      INSERT INTO order_events (
        order_id, event_type, actor_type, origin, to_state, public_data, private_data,
        correlation_id, idempotency_key
      ) VALUES (
        ${snapshot.orderId}, 'invoice.credit.issued', 'provider', ${provider.name},
        ${transaction.json({ invoice: 'rectified' })}, ${transaction.json({ code: issued.code })},
        ${transaction.json({ providerId: issued.providerId, refundId: snapshot.refundId })},
        ${job.correlationId}, ${`credit:${snapshot.refundId}:issued`}
      ) ON CONFLICT (order_id, idempotency_key) DO NOTHING
    `
    await transaction`
      UPDATE outbox_events SET status = 'completed', completed_at = now(), locked_at = NULL, locked_by = NULL,
        last_error_code = NULL, last_error_message = NULL
      WHERE id = ${job.id} AND locked_by = ${workerId}
    `
  })
}

async function failJob(job: Job, error: unknown) {
  const retryable = error instanceof BeplyError ? error.retryable : true
  const terminal = !retryable || job.attempts >= 10
  const delay = Math.min(30 * 2 ** job.attempts, 3600)
  const message = error instanceof Error ? error.message.slice(0, 500) : 'unknown'
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE outbox_events SET status = ${terminal ? 'dead' : 'retry'},
        available_at = now() + (${delay} * interval '1 second'), locked_at = NULL, locked_by = NULL,
        last_error_code = 'credit_note_failed', last_error_message = ${message}
      WHERE id = ${job.id} AND locked_by = ${workerId}
    `
    await transaction`
      UPDATE invoices SET status = 'failed', updated_at = now() WHERE refund_id = ${job.aggregateId}
    `
  })
}

try {
  const once = process.argv.includes('--once')
  do {
    const job = await claim()
    if (!job) break
    try {
      await processJob(job)
    } catch (error) {
      await failJob(job, error)
    }
  } while (!once)
} finally {
  await sql.end({ timeout: 5 })
}
