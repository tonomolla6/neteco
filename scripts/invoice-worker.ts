import { createHash, randomUUID } from 'node:crypto'
import postgres from 'postgres'
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
  invoiceStatus: string
  totalGrossCents: number
  shippingNetCents: number
  customer: {
    name: string
    company: string | null
    taxId: string | null
    email: string
    phone: string
  }
  billing: {
    line1: string
    postalCode: string
    city: string
    region: string
    countryCode: string
  }
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

const connection = process.env.DATABASE_URL?.trim()
if (!connection) throw new Error('DATABASE_URL is required')
const sql = postgres(connection, { max: 2, connect_timeout: 10 })
const provider = invoiceProviderFromEnvironment()
const workerId = `invoice-${process.pid}-${randomUUID()}`

async function claim() {
  return sql.begin(async (transaction) => {
    const [job] = await transaction<Job[]>`
      SELECT id, aggregate_id AS "aggregateId", correlation_id AS "correlationId", attempts
      FROM outbox_events
      WHERE status IN ('pending', 'retry') AND available_at <= now()
        AND event_type = 'invoice.issue.requested'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
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
           payment_method AS "paymentMethod", invoice_status AS "invoiceStatus",
           total_gross_cents AS "totalGrossCents", shipping_net_cents AS "shippingNetCents",
           customer_snapshot AS customer, billing_snapshot AS billing,
           confirmed_at AS "confirmedAt", created_at AS "createdAt"
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
  const legalName = order.customer.company?.trim() || order.customer.name
  return {
    orderId: order.id,
    orderNumber: order.publicNumber,
    series: process.env.BEPLY_INVOICE_SERIES || 'DEMO',
    issuedOn: (order.confirmedAt ?? order.createdAt).toISOString(),
    customer: {
      externalKey: order.id,
      legalName,
      taxId: order.customer.taxId?.trim() || '00000000T',
      email: order.customer.email,
      phone: order.customer.phone,
      address: {
        line1: order.billing.line1,
        postalCode: order.billing.postalCode,
        city: order.billing.city,
        region: order.billing.region,
        countryCode: order.billing.countryCode
      }
    },
    lines,
    shippingNetCents: order.shippingNetCents,
    currency: 'EUR',
    idempotencyKey: `invoice:${order.id}:v1`
  }
}

async function completeExisting(job: Job) {
  await sql`
    UPDATE outbox_events SET status = 'completed', completed_at = now(), locked_at = NULL, locked_by = NULL
    WHERE id = ${job.id} AND locked_by = ${workerId}
  `
}

async function processJob(job: Job) {
  const { order, lines } = await snapshot(job.aggregateId)
  if (!order) throw new Error('Invoice order does not exist')
  if (!['captured', 'authorized', 'partially_refunded', 'refunded'].includes(order.paymentStatus)) {
    throw new Error('Invoice order has never been paid')
  }
  const [existing] = await sql<{ status: string }[]>`
    SELECT status FROM invoices WHERE order_id = ${order.id} AND kind = 'invoice' AND fiscal_version = 1
  `
  if (existing?.status === 'issued' || existing?.status === 'fiscal_pending') {
    await completeExisting(job)
    return
  }
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO invoices (
        order_id, provider, series, kind, status, fiscal_version, amount_cents, currency, idempotency_key
      ) VALUES (
        ${order.id}, ${provider.name}, ${process.env.BEPLY_INVOICE_SERIES || 'DEMO'},
        'invoice', 'issuing', 1, ${order.totalGrossCents}, 'EUR', ${`invoice:${order.id}:v1`}
      ) ON CONFLICT (order_id, kind, fiscal_version) DO UPDATE SET
        status = 'issuing', updated_at = now()
    `
    await transaction`UPDATE orders SET invoice_status = 'issuing', updated_at = now() WHERE id = ${order.id}`
  })
  const request = requestFromSnapshot(order, lines)
  const issued = await provider.issueInvoice(request)
  if (issued.amountCents > 0 && Math.abs(issued.amountCents - order.totalGrossCents) > 1) {
    throw new Error(`Invoice amount mismatch: order=${order.totalGrossCents} provider=${issued.amountCents}`)
  }
  await provider.markPaid(issued.providerId, request.issuedOn)
  const pdf = await provider.downloadPdf(issued.providerId)
  const checksum = createHash('sha256').update(pdf).digest('hex')
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE invoices SET provider_invoice_id = ${issued.providerId}, provider_code = ${issued.code},
        status = ${issued.status}, pdf_checksum = ${checksum}, issued_at = now(), updated_at = now()
      WHERE order_id = ${order.id} AND kind = 'invoice' AND fiscal_version = 1
    `
    await transaction`
      UPDATE orders SET invoice_status = ${issued.status}, updated_at = now() WHERE id = ${order.id}
    `
    await transaction`
      INSERT INTO order_events (
        order_id, event_type, actor_type, origin, to_state, public_data, private_data,
        correlation_id, idempotency_key
      ) VALUES (
        ${order.id}, 'invoice.issued', 'provider', ${provider.name},
        ${transaction.json({ invoice: issued.status })},
        ${transaction.json({ code: issued.code })}, ${transaction.json({ providerId: issued.providerId, checksum })},
        ${job.correlationId}, ${`invoice:${order.id}:issued:v1`}
      ) ON CONFLICT (order_id, idempotency_key) DO NOTHING
    `
    await transaction`
      INSERT INTO outbox_events (
        aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
      ) VALUES (
        'invoice', (SELECT id FROM invoices WHERE order_id = ${order.id} AND kind = 'invoice' AND fiscal_version = 1),
        'invoice.issued', ${transaction.json({ orderId: order.id, orderNumber: order.publicNumber, code: issued.code })},
        ${job.correlationId}, ${`invoice:${order.id}:notification:v1`}
      ) ON CONFLICT (idempotency_key) DO NOTHING
    `
    await transaction`
      UPDATE outbox_events SET status = 'completed', completed_at = now(), locked_at = NULL, locked_by = NULL,
        last_error_code = NULL, last_error_message = NULL
      WHERE id = ${job.id} AND locked_by = ${workerId}
    `
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
      UPDATE outbox_events SET status = ${terminal ? 'dead' : 'retry'}, attempts = attempts,
        available_at = now() + (${delay} * interval '1 second'), locked_at = NULL, locked_by = NULL,
        last_error_code = ${code}, last_error_message = ${message}
      WHERE id = ${job.id} AND locked_by = ${workerId}
    `
    await transaction`
      UPDATE orders SET invoice_status = 'failed', updated_at = now() WHERE id = ${job.aggregateId}
    `
    await transaction`
      UPDATE invoices SET status = 'failed', updated_at = now()
      WHERE order_id = ${job.aggregateId} AND kind = 'invoice' AND fiscal_version = 1
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
