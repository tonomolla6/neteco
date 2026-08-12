import { createHash, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { RedsysPaymentProvider } from '../server/integrations/redsys'

interface Job {
  id: string
  aggregateId: string
  correlationId: string
  attempts: number
}

interface RefundRecord {
  id: string
  orderId: string
  returnId: string | null
  amountCents: number
  status: string
  reason: string
  paymentIntentId: string
  paymentMethod: string
  provider: string
  paymentReference: string | null
  orderNumber: string
  capturedCents: number
}

const connection = process.env.DATABASE_URL?.trim()
if (!connection) throw new Error('DATABASE_URL is required')
const sql = postgres(connection, { max: 2, connect_timeout: 10 })
const workerId = `refund-${process.pid}-${randomUUID()}`

async function claim() {
  return sql.begin(async (transaction) => {
    const [job] = await transaction<Job[]>`
      SELECT id, aggregate_id AS "aggregateId", correlation_id AS "correlationId", attempts
      FROM outbox_events
      WHERE status IN ('pending', 'retry') AND available_at <= now()
        AND event_type = 'refund.execute.requested'
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

async function loadRefund(refundId: string) {
  const [refund] = await sql<RefundRecord[]>`
    SELECT refund.id, refund.order_id AS "orderId", refund.return_id AS "returnId",
           refund.amount_cents AS "amountCents", refund.status, refund.reason,
           payment.id AS "paymentIntentId", payment.method AS "paymentMethod", payment.provider,
           payment.provider_reference AS "paymentReference", orders.public_number AS "orderNumber",
           payment.amount_cents AS "capturedCents"
    FROM refunds refund
    JOIN payment_intents payment ON payment.id = refund.payment_intent_id
    JOIN orders ON orders.id = refund.order_id
    WHERE refund.id = ${refundId}
  `
  return refund
}

function redsysProvider() {
  return new RedsysPaymentProvider({
    environment: process.env.REDSYS_ENV === 'production' ? 'production' : 'sandbox',
    merchantCode: process.env.REDSYS_MERCHANT_CODE ?? '',
    terminal: process.env.REDSYS_TERMINAL ?? '1',
    secretKey: process.env.REDSYS_SECRET_KEY ?? '',
    currency: process.env.REDSYS_CURRENCY ?? '978',
    merchantName: process.env.REDSYS_MERCHANT_NAME ?? 'NETECO'
  })
}

async function markJobCompleted(job: Job) {
  await sql`
    UPDATE outbox_events SET status = 'completed', completed_at = now(), locked_at = NULL, locked_by = NULL,
      last_error_code = NULL, last_error_message = NULL
    WHERE id = ${job.id} AND locked_by = ${workerId}
  `
}

async function processJob(job: Job) {
  const refund = await loadRefund(job.aggregateId)
  if (!refund) throw new Error('Refund does not exist')
  if (refund.status === 'succeeded') return markJobCompleted(job)
  if (!['requested', 'pending'].includes(refund.status)) throw new Error(`Refund is ${refund.status}`)
  if (refund.amountCents > refund.capturedCents) throw new Error('Refund exceeds captured amount')

  await sql`UPDATE refunds SET status = 'pending', updated_at = now() WHERE id = ${refund.id}`
  if (refund.paymentMethod === 'transferencia') {
    await sql.begin(async (transaction) => {
      await transaction`
        UPDATE refunds SET response_code = 'manual_bank_transfer', updated_at = now() WHERE id = ${refund.id}
      `
      await transaction`
        UPDATE outbox_events SET status = 'completed', completed_at = now(), locked_at = NULL, locked_by = NULL
        WHERE id = ${job.id} AND locked_by = ${workerId}
      `
    })
    return
  }

  const result =
    process.env.PAYMENT_PROVIDER === 'mock'
      ? {
          providerReference: `MOCK-${createHash('sha256').update(refund.id).digest('hex').slice(0, 16)}`,
          status: 'succeeded' as const
        }
      : await redsysProvider().refund({
          paymentReference: refund.paymentReference ?? refund.orderNumber,
          orderReference: refund.orderNumber,
          amountCents: refund.amountCents,
          reason: refund.reason,
          idempotencyKey: `refund:${refund.id}`
        })

  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE refunds SET status = ${result.status}, provider_reference = ${result.providerReference},
        response_code = '0900', failure_message = NULL, completed_at = now(), updated_at = now()
      WHERE id = ${refund.id}
    `
    const [totals] = await transaction<{ refunded: number }[]>`
      SELECT COALESCE(sum(amount_cents), 0)::int AS refunded FROM refunds
      WHERE payment_intent_id = ${refund.paymentIntentId} AND status = 'succeeded'
    `
    const paymentStatus = (totals?.refunded ?? 0) >= refund.capturedCents ? 'refunded' : 'partially_refunded'
    await transaction`
      UPDATE payment_intents SET status = ${paymentStatus}, updated_at = now() WHERE id = ${refund.paymentIntentId}
    `
    await transaction`
      UPDATE orders SET payment_status = ${paymentStatus}, updated_at = now() WHERE id = ${refund.orderId}
    `
    await transaction`
      INSERT INTO order_events (
        order_id, event_type, actor_type, origin, to_state, public_data, private_data,
        correlation_id, idempotency_key
      ) VALUES (
        ${refund.orderId}, 'refund.succeeded', 'provider', ${refund.provider},
        ${transaction.json({ payment: paymentStatus })},
        ${transaction.json({ amountCents: refund.amountCents })},
        ${transaction.json({ providerReference: result.providerReference })},
        ${job.correlationId}, ${`refund:${refund.id}:succeeded`}
      ) ON CONFLICT (order_id, idempotency_key) DO NOTHING
    `
    await transaction`
      INSERT INTO outbox_events (
        aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
      ) VALUES (
        'refund', ${refund.id}, 'invoice.credit.requested',
        ${transaction.json({ refundId: refund.id, orderId: refund.orderId, returnId: refund.returnId })},
        ${job.correlationId}, ${`refund:${refund.id}:credit-note`}
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
  const terminal = job.attempts >= 10
  const delay = Math.min(30 * 2 ** job.attempts, 3600)
  const message = error instanceof Error ? error.message.slice(0, 500) : 'unknown'
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE outbox_events SET status = ${terminal ? 'dead' : 'retry'},
        available_at = now() + (${delay} * interval '1 second'), locked_at = NULL, locked_by = NULL,
        last_error_code = 'refund_provider_failed', last_error_message = ${message}
      WHERE id = ${job.id} AND locked_by = ${workerId}
    `
    await transaction`
      UPDATE refunds SET status = ${terminal ? 'failed' : 'pending'}, failure_message = ${message}, updated_at = now()
      WHERE id = ${job.aggregateId}
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
