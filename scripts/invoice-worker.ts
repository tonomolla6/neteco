import { createHash, randomUUID } from 'node:crypto'
import postgres, { type TransactionSql } from 'postgres'
import { BeplyError } from '../server/integrations/beply'
import { invoiceProviderFromEnvironment } from '../server/integrations/invoice-factory'
import type { IssueInvoiceRequest } from '../server/integrations/invoice-provider'

interface Job {
  id: string
  aggregateId: string
  correlationId: string
  attempts: number
}

interface OrderSnapshot {
  id: string
  publicNumber: string
  paymentStatus: string
  paymentMethod: string
  totalGrossCents: number
  shippingNetCents: number
  customer: {
    name: string
    company: string | null
    taxId: string | null
    email: string
    phone: string
  }
  billing: { line1: string; postalCode: string; city: string; region: string; countryCode: string }
  confirmedAt: Date | null
  createdAt: Date
}

interface OrderLine {
  sku: string
  description: string
  quantity: number
  unitNetCents: number
  lineNetCents: number
  discountNetCents: number
  taxRateBasisPoints: number
}

interface InvoiceRecord {
  id: string
  status: string
  providerInvoiceId: string | null
  providerCode: string | null
  pdfChecksum: string | null
  requestFingerprint: string | null
  reconciliationRequired: boolean
}

const connection = process.env.DATABASE_URL?.trim()
if (!connection) throw new Error('DATABASE_URL is required')
const sql = postgres(connection, { max: 2, connect_timeout: 10 })
const provider = invoiceProviderFromEnvironment()
const workerId = `invoice-${process.pid}-${randomUUID()}`
const aggregateFilter =
  process.argv.find((argument) => argument.startsWith('--aggregate-id='))?.split('=', 2)[1] ?? null

async function claim() {
  return sql.begin(async (transaction) => {
    const [job] = await transaction<Job[]>`
      SELECT id, aggregate_id AS "aggregateId", correlation_id AS "correlationId", attempts
      FROM outbox_events
      WHERE status IN ('pending', 'retry') AND available_at <= now()
        AND event_type = 'invoice.issue.requested'
        AND (${aggregateFilter}::uuid IS NULL OR aggregate_id = ${aggregateFilter}::uuid)
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    `
    if (!job) return undefined
    await transaction`
      UPDATE outbox_events SET status = 'processing', attempts = attempts + 1,
        locked_at = now(), locked_by = ${workerId}
      WHERE id = ${job.id}
    `
    return { ...job, attempts: job.attempts + 1 }
  })
}

async function snapshot(orderId: string) {
  const [order] = await sql<OrderSnapshot[]>`
    SELECT id, public_number AS "publicNumber", payment_status AS "paymentStatus",
           payment_method AS "paymentMethod", total_gross_cents AS "totalGrossCents",
           shipping_net_cents AS "shippingNetCents", customer_snapshot AS customer,
           billing_snapshot AS billing, confirmed_at AS "confirmedAt", created_at AS "createdAt"
    FROM orders WHERE id = ${orderId}
  `
  const lines = order
    ? await sql<OrderLine[]>`
        SELECT sku, name || ' · ' || variant_name AS description, quantity,
               unit_net_cents AS "unitNetCents",
               (total_gross_cents - tax_cents + discount_net_cents)::int AS "lineNetCents",
               discount_net_cents AS "discountNetCents",
               tax_rate_basis_points AS "taxRateBasisPoints"
        FROM order_lines WHERE order_id = ${orderId} ORDER BY id
      `
    : []
  return { order, lines }
}

function requestFromSnapshot(order: OrderSnapshot, lines: OrderLine[]): IssueInvoiceRequest {
  return {
    orderId: order.id,
    orderNumber: order.publicNumber,
    series: process.env.BEPLY_INVOICE_SERIES || 'DEMO',
    issuedOn: (order.confirmedAt ?? order.createdAt).toISOString(),
    customer: {
      externalKey: order.id,
      legalName: order.customer.company?.trim() || order.customer.name,
      taxId: order.customer.taxId?.trim() || '00000000T',
      email: order.customer.email,
      phone: order.customer.phone,
      address: order.billing
    },
    lines,
    shippingNetCents: order.shippingNetCents,
    currency: 'EUR',
    paymentMethod: order.paymentMethod === 'transferencia' ? 'bank_transfer' : 'redsys',
    idempotencyKey: `invoice:${order.id}:v1`
  }
}

function fingerprint(request: IssueInvoiceRequest) {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex')
}

async function completeJob(transaction: TransactionSql, job: Job) {
  await transaction`
    UPDATE outbox_events SET status = 'completed', completed_at = now(), locked_at = NULL, locked_by = NULL,
      last_error_code = NULL, last_error_message = NULL
    WHERE id = ${job.id} AND locked_by = ${workerId}
  `
}

async function requireReconciliation(job: Job, invoiceId: string, code: string, message: string) {
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE invoices SET status = 'fiscal_pending', reconciliation_required = true,
        last_error_code = ${code}, last_error_message = ${message.slice(0, 500)}, updated_at = now()
      WHERE id = ${invoiceId}
    `
    await transaction`
      UPDATE orders SET invoice_status = 'fiscal_pending', updated_at = now() WHERE id = ${job.aggregateId}
    `
    await transaction`
      INSERT INTO outbox_events (
        aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
      ) VALUES (
        'invoice', ${invoiceId}, 'invoice.reconciliation.requested',
        ${transaction.json({ invoiceId, orderId: job.aggregateId, code })},
        ${job.correlationId}, ${`invoice:${invoiceId}:reconciliation:${code}`}
      ) ON CONFLICT (idempotency_key) DO NOTHING
    `
    await completeJob(transaction, job)
  })
}

async function prepareInvoice(
  job: Job,
  order: OrderSnapshot,
  request: IssueInvoiceRequest,
  requestFingerprint: string
) {
  return sql.begin(async (transaction) => {
    await transaction`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`
    const [existing] = await transaction<InvoiceRecord[]>`
      SELECT id, status, provider_invoice_id AS "providerInvoiceId", provider_code AS "providerCode",
             pdf_checksum AS "pdfChecksum", request_fingerprint AS "requestFingerprint",
             reconciliation_required AS "reconciliationRequired"
      FROM invoices
      WHERE order_id = ${order.id} AND kind = 'invoice' AND fiscal_version = 1
      FOR UPDATE
    `
    if (existing?.requestFingerprint && existing.requestFingerprint !== requestFingerprint) {
      throw new Error('Invoice snapshot fingerprint changed after fiscal queueing')
    }
    if (existing?.status === 'issued' && existing.pdfChecksum) {
      await completeJob(transaction, job)
      return { record: existing, complete: true, uncertain: false }
    }
    if (existing?.reconciliationRequired && !existing.providerInvoiceId) {
      await completeJob(transaction, job)
      return { record: existing, complete: true, uncertain: false }
    }
    if (existing && !existing.providerInvoiceId && ['issuing', 'fiscal_pending'].includes(existing.status)) {
      return { record: existing, complete: false, uncertain: true }
    }
    if (existing) {
      await transaction`
        UPDATE invoices SET status = 'issuing', request_fingerprint = ${requestFingerprint},
          last_error_code = NULL, last_error_message = NULL, updated_at = now()
        WHERE id = ${existing.id}
      `
      await transaction`UPDATE orders SET invoice_status = 'issuing', updated_at = now() WHERE id = ${order.id}`
      return { record: existing, complete: false, uncertain: false }
    }
    const [created] = await transaction<InvoiceRecord[]>`
      INSERT INTO invoices (
        order_id, provider, series, kind, status, fiscal_version, amount_cents, currency,
        idempotency_key, request_fingerprint
      ) VALUES (
        ${order.id}, ${provider.name}, ${request.series}, 'invoice', 'issuing', 1,
        ${order.totalGrossCents}, 'EUR', ${request.idempotencyKey}, ${requestFingerprint}
      )
      RETURNING id, status, provider_invoice_id AS "providerInvoiceId", provider_code AS "providerCode",
                pdf_checksum AS "pdfChecksum", request_fingerprint AS "requestFingerprint",
                reconciliation_required AS "reconciliationRequired"
    `
    if (!created) throw new Error('Invoice creation returned no row')
    await transaction`UPDATE orders SET invoice_status = 'issuing', updated_at = now() WHERE id = ${order.id}`
    return { record: created, complete: false, uncertain: false }
  })
}

async function processJob(job: Job) {
  const { order, lines } = await snapshot(job.aggregateId)
  if (!order) throw new Error('Invoice order does not exist')
  if (!['captured', 'partially_refunded', 'refunded'].includes(order.paymentStatus)) {
    throw new Error('Invoice order has never been captured')
  }
  const request = requestFromSnapshot(order, lines)
  const prepared = await prepareInvoice(job, order, request, fingerprint(request))
  if (prepared.complete) return
  if (prepared.uncertain) {
    await requireReconciliation(
      job,
      prepared.record.id,
      'issue_result_unknown',
      'Previous fiscal issue result is unknown'
    )
    return
  }

  let providerInvoiceId = prepared.record.providerInvoiceId
  let providerCode = prepared.record.providerCode
  if (!providerInvoiceId) {
    try {
      const issued = await provider.issueInvoice(request)
      if (issued.amountCents > 0 && Math.abs(issued.amountCents - order.totalGrossCents) > 1) {
        await requireReconciliation(
          job,
          prepared.record.id,
          'amount_mismatch',
          `Invoice amount mismatch: order=${order.totalGrossCents} provider=${issued.amountCents}`
        )
        return
      }
      providerInvoiceId = issued.providerId
      providerCode = issued.code
      await sql`
        UPDATE invoices SET provider_invoice_id = ${providerInvoiceId}, provider_code = ${providerCode},
          status = 'issuing', updated_at = now()
        WHERE id = ${prepared.record.id}
      `
    } catch (error) {
      if (error instanceof BeplyError && ['duplicate', 'transport'].includes(error.category)) {
        await requireReconciliation(job, prepared.record.id, `beply_${error.category}`, error.message)
        return
      }
      throw error
    }
  }

  let pdf: Uint8Array
  try {
    await provider.markPaid(providerInvoiceId, request.issuedOn)
    pdf = await provider.downloadPdf(providerInvoiceId)
  } catch (error) {
    if (error instanceof BeplyError) {
      await requireReconciliation(job, prepared.record.id, `beply_${error.category}`, error.message)
      return
    }
    throw error
  }
  const checksum = createHash('sha256').update(pdf).digest('hex')
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE invoices SET provider_invoice_id = ${providerInvoiceId}, provider_code = ${providerCode},
        status = 'issued', pdf_checksum = ${checksum}, pdf_bytes = ${Buffer.from(pdf)}, pdf_size = ${pdf.byteLength},
        reconciliation_required = false, last_error_code = NULL, last_error_message = NULL,
        issued_at = COALESCE(issued_at, now()), updated_at = now()
      WHERE id = ${prepared.record.id}
    `
    await transaction`UPDATE orders SET invoice_status = 'issued', updated_at = now() WHERE id = ${order.id}`
    await transaction`
      INSERT INTO order_events (
        order_id, event_type, actor_type, origin, to_state, public_data, private_data,
        correlation_id, idempotency_key
      ) VALUES (
        ${order.id}, 'invoice.issued', 'provider', ${provider.name},
        ${transaction.json({ invoice: 'issued' })}, ${transaction.json({ code: providerCode })},
        ${transaction.json({ providerId: providerInvoiceId, checksum })}, ${job.correlationId},
        ${`invoice:${order.id}:issued:v1`}
      ) ON CONFLICT (order_id, idempotency_key) DO NOTHING
    `
    await transaction`
      INSERT INTO outbox_events (
        aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
      ) VALUES (
        'invoice', ${prepared.record.id}, 'invoice.issued',
        ${transaction.json({ orderId: order.id, orderNumber: order.publicNumber, code: providerCode })},
        ${job.correlationId}, ${`invoice:${order.id}:notification:v1`}
      ) ON CONFLICT (idempotency_key) DO NOTHING
    `
    const refunds = await transaction<{ id: string }[]>`
      SELECT refund.id FROM refunds refund
      WHERE refund.order_id = ${order.id} AND refund.status = 'succeeded'
        AND NOT EXISTS (SELECT 1 FROM invoices credit WHERE credit.refund_id = refund.id)
    `
    for (const refund of refunds) {
      await transaction`
        INSERT INTO outbox_events (
          aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
        ) VALUES (
          'refund', ${refund.id}, 'invoice.credit.requested',
          ${transaction.json({ refundId: refund.id, orderId: order.id, source: 'invoice_completion' })},
          ${job.correlationId}, ${`refund:${refund.id}:credit-note`}
        ) ON CONFLICT (idempotency_key) DO UPDATE SET
          status = CASE WHEN outbox_events.status = 'completed' THEN outbox_events.status ELSE 'pending' END,
          available_at = CASE WHEN outbox_events.status = 'completed' THEN outbox_events.available_at ELSE now() END,
          locked_at = CASE WHEN outbox_events.status = 'completed' THEN outbox_events.locked_at ELSE NULL END,
          locked_by = CASE WHEN outbox_events.status = 'completed' THEN outbox_events.locked_by ELSE NULL END
      `
    }
    await completeJob(transaction, job)
  })
}

async function failJob(job: Job, error: unknown) {
  const retryable = error instanceof BeplyError ? error.retryable : false
  const terminal = !retryable || job.attempts >= 10
  const delay = Math.min(30 * 2 ** job.attempts + Math.floor(Math.random() * 30), 3600)
  const code = error instanceof BeplyError ? `beply_${error.category}` : 'invoice_invariant_failed'
  const message = error instanceof Error ? error.message.slice(0, 500) : 'unknown'
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE outbox_events SET status = ${terminal ? 'dead' : 'retry'},
        available_at = now() + (${delay} * interval '1 second'), locked_at = NULL, locked_by = NULL,
        last_error_code = ${code}, last_error_message = ${message}
      WHERE id = ${job.id} AND locked_by = ${workerId}
    `
    await transaction`UPDATE orders SET invoice_status = 'failed', updated_at = now() WHERE id = ${job.aggregateId}`
    await transaction`
      UPDATE invoices SET status = 'failed', last_error_code = ${code}, last_error_message = ${message}, updated_at = now()
      WHERE order_id = ${job.aggregateId} AND kind = 'invoice' AND fiscal_version = 1
        AND provider_invoice_id IS NULL AND reconciliation_required = false
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
