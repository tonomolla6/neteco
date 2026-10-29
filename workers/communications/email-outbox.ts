import { isCanonicalInventoryInstant } from '../catalog/inventory'

/** Transport payload contains no recipient, email body, token or provider data. */
export interface EmailDispatchMessage {
  type: 'email.dispatch.requested'
  version: 1
  eventId: string
}

export interface EmailDispatchQueue {
  send(message: EmailDispatchMessage): Promise<void>
}

const SOURCE_KIND_BY_EVENT = {
  'identity.verification.requested': 'identity',
  'identity.password_reset.requested': 'identity',
  'identity.email_change.requested': 'identity',
  'identity.security.password_changed': 'identity',
  'identity.security.password_rotated': 'identity',
  'identity.security.email_changed': 'identity',
  'identity.security.mfa_changed': 'identity',
  'identity.security.fiscal_changed': 'identity',
  'order.created': 'order',
  'order.confirmed': 'order',
  'order.status.updated': 'order',
  'order.cancelled': 'order',
  'order.cancellation.requested': 'order',
  'order.reservation.expired': 'order',
  'order.shipped': 'order',
  'order.delivered': 'order',
  'refund.succeeded.email': 'refund',
  'return.requested': 'return',
  'return.status.updated': 'return',
  'support.ticket.received': 'support',
  'support.ticket.reply': 'support',
  'invoice.issued': 'invoice'
} as const

export type EmailOutboxEventType = keyof typeof SOURCE_KIND_BY_EVENT
export type EmailSourceKind = (typeof SOURCE_KIND_BY_EVENT)[EmailOutboxEventType]

export interface EmailOutboxInput {
  /** Persisted, unique domain occurrence. Reuse for transport retries. */
  sourceEventId: string
  sourceKind: EmailSourceKind
  /** Opaque UUID for a source-of-truth row; never an email address or token. */
  sourceId: string
  eventType: EmailOutboxEventType
  now: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const EVENT_ID = /^email:[0-9a-f]{64}$/
const MAX_ATTEMPTS = 10
const LEASE_SECONDS = 60
const RECEIPT_GRACE_SECONDS = 600

function assertInstant(now: string): Date {
  if (!isCanonicalInventoryInstant(now)) throw new Error('invalid_email_outbox_instant')
  return new Date(now)
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_email_outbox_limit')
}

function assertInput(input: EmailOutboxInput): void {
  if (!UUID.test(input.sourceEventId) || !UUID.test(input.sourceId)) {
    throw new Error('invalid_email_outbox_reference')
  }
  if (
    !Object.hasOwn(SOURCE_KIND_BY_EVENT, input.eventType) ||
    SOURCE_KIND_BY_EVENT[input.eventType] !== input.sourceKind
  ) {
    throw new Error('invalid_email_outbox_event')
  }
  assertInstant(input.now)
}

function after(date: Date, seconds: number): string {
  return new Date(date.getTime() + seconds * 1000).toISOString().replace('.000Z', 'Z')
}

async function emailEventId(sourceEventId: string, eventType: string): Promise<string> {
  const bytes = new TextEncoder().encode(`neteco:transactional-email:v1:${sourceEventId}:${eventType}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return `email:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Include this statement in the SAME D1 batch as the domain event/mutation.
 * D1's batch transaction then rolls both back together. A retry of the same
 * source event is a no-op; changing its source reference aborts the batch.
 * The caller must establish that the referenced source event exists.
 */
export async function prepareEmailOutboxEnqueue(
  database: D1Database,
  input: EmailOutboxInput
): Promise<{ eventId: string; statement: D1PreparedStatement }> {
  assertInput(input)
  const eventId = await emailEventId(input.sourceEventId, input.eventType)
  return {
    eventId,
    statement: database
      .prepare(
        `INSERT INTO email_outbox_events
          (id, source_event_id, event_type, source_kind, source_id, schema_version, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
        ON CONFLICT (source_event_id, event_type) DO NOTHING
        RETURNING id`
      )
      .bind(eventId, input.sourceEventId, input.eventType, input.sourceKind, input.sourceId, input.now)
  }
}

/** Standalone enqueue for a source event already committed to D1. */
export async function enqueueEmailOutbox(
  database: D1Database,
  input: EmailOutboxInput
): Promise<{ outcome: 'enqueued' | 'replayed'; eventId: string }> {
  const { eventId, statement } = await prepareEmailOutboxEnqueue(database, input)
  const inserted = await statement.first<{ id: string }>()
  return { outcome: inserted ? 'enqueued' : 'replayed', eventId }
}

/**
 * Publish at least once. A lost send acknowledgement leaves a recoverable
 * lease; a replaced lease cannot be acknowledged by its older publisher.
 * Queue consumers must deduplicate on eventId before any future side effect.
 */
export async function publishEmailOutbox(
  database: D1Database,
  queue: EmailDispatchQueue,
  input: { now: string; limit?: number }
): Promise<{ published: number; retryable: number; lostLease: number; manualReview: number }> {
  const date = assertInstant(input.now)
  const limit = input.limit ?? 25
  assertLimit(limit)
  if (!queue || typeof queue.send !== 'function') throw new Error('email_queue_unavailable')

  const exhausted = await database
    .prepare(
      `UPDATE email_outbox_delivery
       SET status = 'manual_review', lease_token = NULL, lease_until = NULL,
           last_error_code = 'publish_attempts_exhausted'
       WHERE event_id IN (
         SELECT event_id FROM email_outbox_delivery
         WHERE attempts >= ?2
           AND (status = 'ready' OR (status = 'leased' AND lease_until <= ?1))
         ORDER BY available_at, event_id LIMIT ?3
       ) RETURNING event_id`
    )
    .bind(input.now, MAX_ATTEMPTS, limit)
    .all<{ event_id: string }>()
  const candidates = (
    await database
      .prepare(
        `SELECT event_id FROM email_outbox_delivery
         WHERE (status = 'ready' AND available_at <= ?1)
            OR (status = 'leased' AND lease_until <= ?1)
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
        `UPDATE email_outbox_delivery
         SET status = 'leased', lease_token = ?2, lease_until = ?3, attempts = attempts + 1
         WHERE event_id = ?1 AND attempts < ?5
           AND ((status = 'ready' AND available_at <= ?4)
             OR (status = 'leased' AND lease_until <= ?4))
         RETURNING attempts`
      )
      .bind(candidate.event_id, token, after(date, LEASE_SECONDS), input.now, MAX_ATTEMPTS)
      .first<{ attempts: number }>()
    if (!claimed) continue
    try {
      await queue.send({ type: 'email.dispatch.requested', version: 1, eventId: candidate.event_id })
    } catch {
      // Never persist exception text: it may contain provider data or secrets.
      const retry = await database
        .prepare(
          `UPDATE email_outbox_delivery
           SET status = CASE WHEN attempts >= ?4 THEN 'manual_review' ELSE 'ready' END,
               lease_token = NULL, lease_until = NULL, available_at = ?3,
               last_error_code = 'queue_send_failed'
           WHERE event_id = ?1 AND status = 'leased' AND lease_token = ?2
           RETURNING status`
        )
        .bind(candidate.event_id, token, after(date, Math.min(3600, 30 * 2 ** (claimed.attempts - 1))), MAX_ATTEMPTS)
        .first<{ status: string }>()
      if (!retry) report.lostLease++
      else if (retry.status === 'manual_review') report.manualReview++
      else report.retryable++
      continue
    }
    const published = await database
      .prepare(
        `UPDATE email_outbox_delivery
         SET status = 'published', lease_token = NULL, lease_until = NULL,
             published_at = ?3, last_error_code = NULL
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

/**
 * Queue receipt only. The immutable legacy `blocked_provider` receipt is not
 * a send acknowledgement. Migration 0031 atomically creates durable provider
 * work in transactional_email_deliveries; dispatch it separately and sweep it
 * on a schedule even if Queue acknowledgement fails or delivery is disabled.
 * Malformed/unknown messages do not create inbox work. D1 failure must
 * propagate so the Queue can retry rather than acknowledging lost work.
 */
export async function receiveEmailDispatch(
  database: D1Database,
  message: unknown,
  now: string
): Promise<'stored' | 'replayed' | 'invalid' | 'not_ready'> {
  assertInstant(now)
  if (!message || typeof message !== 'object' || Array.isArray(message)) return 'invalid'
  const raw = message as Record<string, unknown>
  if (
    raw.type !== 'email.dispatch.requested' ||
    raw.version !== 1 ||
    typeof raw.eventId !== 'string' ||
    !EVENT_ID.test(raw.eventId) ||
    Object.keys(raw).some((key) => !['type', 'version', 'eventId'].includes(key))
  )
    return 'invalid'
  const inserted = await database
    .prepare(
      `INSERT INTO email_dispatch_inbox (event_id, received_at)
       SELECT event.id, ?2 FROM email_outbox_events event
       JOIN email_outbox_delivery delivery ON delivery.event_id = event.id
       WHERE event.id = ?1 AND event.schema_version = 1
         AND (delivery.status IN ('leased', 'published')
           OR (delivery.status IN ('ready', 'manual_review') AND delivery.attempts > 0))
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`
    )
    .bind(raw.eventId, now)
    .first()
  if (inserted) return 'stored'
  const previous = await database
    .prepare('SELECT event_id FROM email_dispatch_inbox WHERE event_id = ?1')
    .bind(raw.eventId)
    .first()
  return previous ? 'replayed' : 'not_ready'
}

/** Requeue published Queue work only when no durable receipt was observed. */
export async function reconcileEmailOutbox(
  database: D1Database,
  input: { now: string; limit?: number }
): Promise<{ requeued: number; manualReview: number }> {
  const date = assertInstant(input.now)
  const limit = input.limit ?? 25
  assertLimit(limit)
  const cutoff = after(date, -RECEIPT_GRACE_SECONDS)
  const changed = await database
    .prepare(
      `UPDATE email_outbox_delivery
       SET status = CASE WHEN attempts >= ?3 THEN 'manual_review' ELSE 'ready' END,
           available_at = ?1, last_error_code = 'receipt_missing'
       WHERE event_id IN (
         SELECT delivery.event_id FROM email_outbox_delivery delivery
         WHERE delivery.status = 'published' AND delivery.published_at <= ?2
           AND NOT EXISTS (
             SELECT 1 FROM email_dispatch_inbox receipt WHERE receipt.event_id = delivery.event_id
           )
         ORDER BY delivery.published_at, delivery.event_id LIMIT ?4
       ) RETURNING status`
    )
    .bind(input.now, cutoff, MAX_ATTEMPTS, limit)
    .all<{ status: string }>()
  return {
    requeued: changed.results.filter((row) => row.status === 'ready').length,
    manualReview: changed.results.filter((row) => row.status === 'manual_review').length
  }
}
