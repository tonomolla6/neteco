import { isCanonicalInventoryInstant } from './inventory'

export interface FiscalEvaluationMessage {
  type: 'invoice.evaluate.requested'
  version: 1
  eventId: string
}

export interface FiscalEvaluationQueue {
  send(message: FiscalEvaluationMessage): Promise<void>
}

/** Acknowledge transport only after the policy-blocked work exists in D1. */
export async function receiveFiscalEvaluation(
  database: D1Database,
  message: unknown,
  now: string
): Promise<'stored' | 'replayed' | 'invalid' | 'not_ready'> {
  if (!isCanonicalInventoryInstant(now)) throw new Error('Invalid fiscal receipt instant')
  if (!message || typeof message !== 'object' || Array.isArray(message)) return 'invalid'
  const raw = message as Record<string, unknown>
  if (
    raw.type !== 'invoice.evaluate.requested' ||
    raw.version !== 1 ||
    typeof raw.eventId !== 'string' ||
    raw.eventId.length < 1 ||
    raw.eventId.length > 200 ||
    Object.keys(raw).some((key) => !['type', 'version', 'eventId'].includes(key))
  )
    return 'invalid'
  const inserted = await database
    .prepare(
      `INSERT INTO fiscal_evaluation_inbox (event_id, order_id, received_at)
    SELECT event.id, event.order_id, ?2 FROM fiscal_outbox_events event
    JOIN fiscal_outbox_delivery delivery ON delivery.event_id = event.id
    WHERE event.id = ?1 AND event.event_type = 'invoice.evaluate.requested'
      AND event.schema_version = 1 AND (
        delivery.status IN ('ready', 'leased', 'published')
        OR (delivery.status = 'manual_review' AND delivery.attempts > 0)
      )
    ON CONFLICT (event_id) DO NOTHING RETURNING event_id`
    )
    .bind(raw.eventId, now)
    .first()
  if (inserted) return 'stored'
  const previous = await database
    .prepare('SELECT event_id FROM fiscal_evaluation_inbox WHERE event_id = ?1')
    .bind(raw.eventId)
    .first()
  return previous ? 'replayed' : 'not_ready'
}

/** At-least-once transport only. It cannot approve policy or issue invoices. */
export async function publishFiscalOutbox(
  database: D1Database,
  queue: FiscalEvaluationQueue,
  input: { now: string; limit?: number }
): Promise<{ published: number; retryable: number; lostLease: number; manualReview: number }> {
  const date = new Date(input.now)
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(input.now) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().replace('.000Z', 'Z') !== input.now
  )
    throw new Error('Invalid outbox evaluation instant')
  const limit = input.limit ?? 25
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid outbox batch limit')
  const after = (seconds: number) => new Date(date.getTime() + seconds * 1000).toISOString().replace('.000Z', 'Z')

  const exhausted = await database
    .prepare(
      `UPDATE fiscal_outbox_delivery
    SET status = 'manual_review', lease_token = NULL, lease_until = NULL,
        last_error_code = 'publish_attempts_exhausted'
    WHERE event_id IN (
      SELECT event_id FROM fiscal_outbox_delivery
      WHERE attempts >= 10 AND (status = 'ready' OR (status = 'leased' AND lease_until <= ?1))
      ORDER BY available_at, event_id LIMIT ?2
    ) RETURNING event_id`
    )
    .bind(input.now, limit)
    .all<{ event_id: string }>()
  const candidates = (
    await database
      .prepare(
        `SELECT event_id FROM fiscal_outbox_delivery
    WHERE (status = 'ready' AND available_at <= ?1) OR (status = 'leased' AND lease_until <= ?1)
    ORDER BY available_at, event_id LIMIT ?2`
      )
      .bind(input.now, limit)
      .all<{ event_id: string }>()
  ).results
  const report = { published: 0, retryable: 0, lostLease: 0, manualReview: exhausted.results.length }
  for (const candidate of candidates) {
    const token = crypto.randomUUID()
    const claimed = await database
      .prepare(
        `UPDATE fiscal_outbox_delivery
      SET status = 'leased', lease_token = ?2, lease_until = ?3, attempts = attempts + 1
      WHERE event_id = ?1 AND attempts < 10
        AND ((status = 'ready' AND available_at <= ?4) OR (status = 'leased' AND lease_until <= ?4))
      RETURNING attempts`
      )
      .bind(candidate.event_id, token, after(60), input.now)
      .first<{ attempts: number }>()
    if (!claimed) continue
    try {
      await queue.send({ type: 'invoice.evaluate.requested', version: 1, eventId: candidate.event_id })
    } catch {
      // Never store provider text, credentials or message bodies in error logs.
      const retried = await database
        .prepare(
          `UPDATE fiscal_outbox_delivery
        SET status = CASE WHEN attempts >= 10 THEN 'manual_review' ELSE 'ready' END,
            lease_token = NULL, lease_until = NULL, available_at = ?3,
            last_error_code = 'queue_send_failed'
        WHERE event_id = ?1 AND status = 'leased' AND lease_token = ?2
        RETURNING event_id`
        )
        .bind(candidate.event_id, token, after(Math.min(3600, 30 * 2 ** (claimed.attempts - 1))))
        .first()
      if (retried && claimed.attempts >= 10) report.manualReview++
      else if (retried) report.retryable++
      else report.lostLease++
      continue
    }
    // A crash after send leaves the lease recoverable; the consumer must dedupe
    // on eventId. An old publisher may never acknowledge a replacement lease.
    const published = await database
      .prepare(
        `UPDATE fiscal_outbox_delivery
      SET status = 'published', lease_token = NULL, lease_until = NULL, last_error_code = NULL, published_at = ?3
      WHERE event_id = ?1 AND status = 'leased' AND lease_token = ?2
      RETURNING event_id`
      )
      .bind(candidate.event_id, token, input.now)
      .first()
    if (published) report.published++
    else report.lostLease++
  }
  return report
}

/** Reconcile transport receipts only; never queries or creates a Beply invoice. */
export async function reconcileFiscalDelivery(
  database: D1Database,
  input: { now: string; limit?: number }
): Promise<{ requeued: number; manualReview: number }> {
  if (!isCanonicalInventoryInstant(input.now)) throw new Error('Invalid fiscal reconciliation instant')
  const limit = input.limit ?? 25
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid fiscal reconciliation limit')
  const cutoff = new Date(Date.parse(input.now) - 600000).toISOString().replace('.000Z', 'Z')
  const changed = await database
    .prepare(
      `UPDATE fiscal_outbox_delivery
    SET status = CASE WHEN attempts >= 10 THEN 'manual_review' ELSE 'ready' END,
        available_at = ?1, last_error_code = 'receipt_missing'
    WHERE event_id IN (
      SELECT delivery.event_id FROM fiscal_outbox_delivery delivery
      WHERE delivery.status = 'published' AND delivery.published_at <= ?2
        AND NOT EXISTS (SELECT 1 FROM fiscal_evaluation_inbox receipt WHERE receipt.event_id = delivery.event_id)
      ORDER BY delivery.published_at, delivery.event_id LIMIT ?3
    ) RETURNING status`
    )
    .bind(input.now, cutoff, limit)
    .all<{ status: string }>()
  return {
    requeued: changed.results.filter((row) => row.status === 'ready').length,
    manualReview: changed.results.filter((row) => row.status === 'manual_review').length
  }
}
