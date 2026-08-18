import { createHash, randomUUID } from 'node:crypto'
import postgres, { type TransactionSql } from 'postgres'
import { BeplyError } from '../server/integrations/beply'
import { invoiceProviderFromEnvironment } from '../server/integrations/invoice-factory'
import type { InvoiceLine, IssueInvoiceRequest } from '../server/integrations/invoice-provider'

interface Job {
  id: string
  aggregateId: string
  correlationId: string
  attempts: number
}

interface CreditSnapshot {
  refundId: string
  returnId: string | null
  returnNumber: string | null
  refundReason: string
  refundIssuedOn: Date
  amountCents: number
  orderId: string
  orderNumber: string
  paymentMethod: string
  customer: { name: string; company: string | null; taxId: string | null; email: string; phone: string }
  billing: { line1: string; postalCode: string; city: string; region: string; countryCode: string }
  sourceInvoiceId: string
  sourceProviderInvoiceId: string
}

interface RefundLine {
  quantity: number
  netCents: number
  taxCents: number
  taxRateBasisPoints: number
  snapshot: { sku?: string; name?: string; variantName?: string }
  componentType: string
}

interface CreditRecord {
  id: string
  status: string
  providerInvoiceId: string | null
  providerCode: string | null
  requestFingerprint: string | null
  reconciliationRequired: boolean
}

const connection = process.env.DATABASE_URL?.trim()
if (!connection) throw new Error('DATABASE_URL is required')
const sql = postgres(connection, { max: 2, connect_timeout: 10 })
const provider = invoiceProviderFromEnvironment()
const workerId = `credit-${process.pid}-${randomUUID()}`
const aggregateFilter =
  process.argv.find((argument) => argument.startsWith('--aggregate-id='))?.split('=', 2)[1] ?? null

async function claim() {
  return sql.begin(async (transaction) => {
    await transaction`
      UPDATE outbox_events
      SET status = 'retry', available_at = now(), locked_at = NULL, locked_by = NULL,
          last_error_code = 'stale_worker_lease',
          last_error_message = 'Recovered an expired credit-note worker lease'
      WHERE status = 'processing' AND locked_at < now() - interval '15 minutes'
        AND event_type = 'invoice.credit.requested'
    `
    const [job] = await transaction<Job[]>`
      SELECT event.id, event.aggregate_id AS "aggregateId", event.correlation_id AS "correlationId",
             event.attempts
      FROM outbox_events event
      JOIN refunds refund ON refund.id = event.aggregate_id AND refund.status = 'succeeded'
      JOIN invoices source ON source.order_id = refund.order_id
        AND source.kind = 'invoice' AND source.status = 'issued'
      WHERE event.status IN ('pending', 'retry') AND event.available_at <= now()
        AND event.event_type = 'invoice.credit.requested'
        AND (${aggregateFilter}::uuid IS NULL OR event.aggregate_id = ${aggregateFilter}::uuid)
      ORDER BY event.created_at FOR UPDATE OF event SKIP LOCKED LIMIT 1
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
    SELECT refund.id AS "refundId", refund.return_id AS "returnId", returned.public_number AS "returnNumber",
           refund.reason AS "refundReason", refund.amount_cents AS "amountCents",
           COALESCE(refund.completed_at, refund.created_at) AS "refundIssuedOn",
           orders.id AS "orderId", orders.public_number AS "orderNumber",
           orders.payment_method AS "paymentMethod",
           orders.customer_snapshot AS customer, orders.billing_snapshot AS billing,
           source.id AS "sourceInvoiceId", source.provider_invoice_id AS "sourceProviderInvoiceId"
    FROM refunds refund
    LEFT JOIN returns returned ON returned.id = refund.return_id
    JOIN orders ON orders.id = refund.order_id
    JOIN invoices source ON source.order_id = orders.id AND source.kind = 'invoice'
      AND source.status = 'issued' AND source.provider_invoice_id IS NOT NULL
    WHERE refund.id = ${refundId} AND refund.status = 'succeeded'
  `
  const lines = snapshot
    ? await sql<RefundLine[]>`
        SELECT quantity, net_cents AS "netCents", tax_cents AS "taxCents",
               tax_rate_basis_points AS "taxRateBasisPoints", fiscal_snapshot AS snapshot,
               component_type AS "componentType"
        FROM refund_lines WHERE refund_id = ${refundId} ORDER BY id
      `
    : []
  return { snapshot, lines }
}

function request(snapshot: CreditSnapshot, source: RefundLine[]) {
  const lines: InvoiceLine[] = source.map((line, index) => ({
    sku: line.snapshot.sku ?? `${line.componentType.toUpperCase()}-${index + 1}`,
    description: [line.snapshot.name ?? 'Rectificación', line.snapshot.variantName].filter(Boolean).join(' · '),
    quantity: line.quantity,
    unitNetCents: Math.floor(line.netCents / line.quantity),
    lineNetCents: line.netCents,
    discountNetCents: 0,
    taxRateBasisPoints: line.taxRateBasisPoints
  }))
  const total = source.reduce((sum, line) => sum + line.netCents + line.taxCents, 0)
  if (total !== snapshot.amountCents || lines.length === 0) {
    throw new Error(`Credit fiscal lines do not balance: refund=${snapshot.amountCents} lines=${total}`)
  }
  const reference = snapshot.returnNumber ?? `CANCEL-${snapshot.refundId.slice(0, 8).toUpperCase()}`
  const credit: IssueInvoiceRequest & { sourceProviderInvoiceId: string; reason: string } = {
    orderId: snapshot.orderId,
    orderNumber: `${snapshot.orderNumber}-${reference}`,
    series: process.env.BEPLY_CORRECTIVE_SERIES || 'RECT',
    issuedOn: snapshot.refundIssuedOn.toISOString(),
    customer: {
      externalKey: snapshot.orderId,
      legalName: snapshot.customer.company?.trim() || snapshot.customer.name,
      taxId: snapshot.customer.taxId?.trim() || undefined,
      email: snapshot.customer.email,
      phone: snapshot.customer.phone,
      address: snapshot.billing
    },
    lines,
    shippingNetCents: 0,
    currency: 'EUR',
    paymentMethod: snapshot.paymentMethod === 'transferencia' ? 'bank_transfer' : 'redsys',
    idempotencyKey: `credit:${snapshot.refundId}`,
    sourceProviderInvoiceId: snapshot.sourceProviderInvoiceId,
    reason: snapshot.refundReason
  }
  return credit
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function completeJob(transaction: TransactionSql, job: Job) {
  await transaction`
    UPDATE outbox_events SET status = 'completed', completed_at = now(), locked_at = NULL, locked_by = NULL,
      last_error_code = NULL, last_error_message = NULL
    WHERE id = ${job.id} AND locked_by = ${workerId}
  `
}

async function requireReconciliation(job: Job, creditId: string, code: string, message: string) {
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE invoices SET status = 'fiscal_pending', reconciliation_required = true,
        last_error_code = ${code}, last_error_message = ${message.slice(0, 500)}, updated_at = now()
      WHERE id = ${creditId}
    `
    await transaction`
      UPDATE orders SET invoice_status = 'fiscal_pending', updated_at = now()
      WHERE id = (SELECT order_id FROM invoices WHERE id = ${creditId})
    `
    await transaction`
      INSERT INTO outbox_events (
        aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
      ) VALUES (
        'invoice', ${creditId}, 'invoice.reconciliation.requested',
        ${transaction.json({ invoiceId: creditId, refundId: job.aggregateId, code })},
        ${job.correlationId}, ${`credit:${creditId}:reconciliation:${code}`}
      ) ON CONFLICT (idempotency_key) DO NOTHING
    `
    await completeJob(transaction, job)
  })
}

async function prepareCredit(job: Job, snapshot: CreditSnapshot, requestFingerprint: string) {
  return sql.begin(async (transaction) => {
    await transaction`SELECT id FROM orders WHERE id = ${snapshot.orderId} FOR UPDATE`
    const [existing] = await transaction<CreditRecord[]>`
      SELECT id, status, provider_invoice_id AS "providerInvoiceId", provider_code AS "providerCode",
             request_fingerprint AS "requestFingerprint", reconciliation_required AS "reconciliationRequired"
      FROM invoices WHERE refund_id = ${snapshot.refundId} FOR UPDATE
    `
    if (existing?.requestFingerprint && existing.requestFingerprint !== requestFingerprint) {
      throw new Error('Credit-note snapshot fingerprint changed after fiscal queueing')
    }
    if (existing?.status === 'issued') {
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
    if (existing) return { record: existing, complete: false, uncertain: false }

    const [created] = await transaction<CreditRecord[]>`
      INSERT INTO invoices (
        order_id, provider, series, kind, status, fiscal_version, amount_cents, currency,
        source_invoice_id, return_id, refund_id, idempotency_key, request_fingerprint
      ) SELECT
        ${snapshot.orderId}, ${provider.name}, ${process.env.BEPLY_CORRECTIVE_SERIES || 'RECT'},
        'credit_note', 'issuing', COALESCE(max(fiscal_version), 0)::int + 1,
        ${snapshot.amountCents}, 'EUR', ${snapshot.sourceInvoiceId}, ${snapshot.returnId},
        ${snapshot.refundId}, ${`credit:${snapshot.refundId}`}, ${requestFingerprint}
      FROM invoices WHERE order_id = ${snapshot.orderId}
      RETURNING id, status, provider_invoice_id AS "providerInvoiceId", provider_code AS "providerCode",
                request_fingerprint AS "requestFingerprint", reconciliation_required AS "reconciliationRequired"
    `
    if (!created) throw new Error('Credit note creation returned no row')
    return { record: created, complete: false, uncertain: false }
  })
}

async function processJob(job: Job) {
  const { snapshot, lines } = await loadSnapshot(job.aggregateId)
  if (!snapshot) throw new Error('Credit note requires a succeeded refund and issued source invoice')
  const creditRequest = request(snapshot, lines)
  const prepared = await prepareCredit(job, snapshot, fingerprint(creditRequest))
  if (prepared.complete) return
  if (prepared.uncertain) {
    await requireReconciliation(
      job,
      prepared.record.id,
      'issue_result_unknown',
      'Previous credit issue result is unknown'
    )
    return
  }

  let providerInvoiceId = prepared.record.providerInvoiceId
  let providerCode = prepared.record.providerCode
  if (!providerInvoiceId) {
    try {
      const issued = await provider.issueCreditNote(creditRequest)
      if (issued.amountCents > 0 && Math.abs(issued.amountCents - snapshot.amountCents) > 1) {
        await requireReconciliation(
          job,
          prepared.record.id,
          'amount_mismatch',
          `Credit amount mismatch: refund=${snapshot.amountCents} provider=${issued.amountCents}`
        )
        return
      }
      providerInvoiceId = issued.providerId
      providerCode = issued.code
      await sql`
        UPDATE invoices SET provider_invoice_id = ${providerInvoiceId}, provider_code = ${providerCode},
          status = 'issuing', updated_at = now() WHERE id = ${prepared.record.id}
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
    await transaction`UPDATE orders SET invoice_status = 'rectified', updated_at = now() WHERE id = ${snapshot.orderId}`
    await transaction`
      INSERT INTO order_events (
        order_id, event_type, actor_type, origin, to_state, public_data, private_data,
        correlation_id, idempotency_key
      ) VALUES (
        ${snapshot.orderId}, 'invoice.credit.issued', 'provider', ${provider.name},
        ${transaction.json({ invoice: 'rectified' })}, ${transaction.json({ code: providerCode })},
        ${transaction.json({ providerId: providerInvoiceId, refundId: snapshot.refundId, checksum })},
        ${job.correlationId}, ${`credit:${snapshot.refundId}:issued`}
      ) ON CONFLICT (order_id, idempotency_key) DO NOTHING
    `
    await completeJob(transaction, job)
  })
}

async function failJob(job: Job, error: unknown) {
  const retryable = error instanceof BeplyError ? error.retryable : false
  const terminal = !retryable || job.attempts >= 10
  const delay = Math.min(30 * 2 ** job.attempts + Math.floor(Math.random() * 30), 3600)
  const code = error instanceof BeplyError ? `beply_${error.category}` : 'credit_note_invariant_failed'
  const message = error instanceof Error ? error.message.slice(0, 500) : 'unknown'
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE outbox_events SET status = ${terminal ? 'dead' : 'retry'},
        available_at = now() + (${delay} * interval '1 second'), locked_at = NULL, locked_by = NULL,
        last_error_code = ${code}, last_error_message = ${message}
      WHERE id = ${job.id} AND locked_by = ${workerId}
    `
    await transaction`
      UPDATE invoices SET status = 'failed', last_error_code = ${code}, last_error_message = ${message}, updated_at = now()
      WHERE refund_id = ${job.aggregateId} AND provider_invoice_id IS NULL AND reconciliation_required = false
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
