import {
  LEAD_MAGNET_CONSENT_VERSION,
  findLeadMagnet,
  leadRequestSchema,
  renderLeadMagnetEmail
} from '../../shared/lead-magnets'
import { authorizeAdmin, fail, mapStorageError, type VerifiedSessionClaims } from './common'

/** Per-address quota: requests allowed per window. */
const QUOTA_LIMIT = 5
const QUOTA_WINDOW_SECONDS = 3600
const BATCH_SIZE = 25
const MAX_ATTEMPTS = 3

export interface LeadMagnetContext {
  /** Server secret for keyed hashes (>= 32 chars, not a local-only placeholder). */
  pepper: string
  /** Canonical client address from the trusted edge header, or null when unknown. */
  address: string | null
  publicOrigin: string
}

export interface LeadMagnetSender {
  send(message: { to: string; subject: string; text: string }): Promise<void>
}

async function hmacHex(pepper: string, label: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(label))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const epochSeconds = (iso: string) => Math.floor(Date.parse(iso) / 1000)

async function consumeQuota(db: D1Database, subjectHash: string, nowSeconds: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO lead_magnet_request_limits(subject_hash, used, expires_at) VALUES (?1, 1, ?2 + ?3)
       ON CONFLICT(subject_hash) DO UPDATE SET
         used = CASE WHEN lead_magnet_request_limits.expires_at <= ?2 THEN 1
                     ELSE min(lead_magnet_request_limits.used + 1, ?4 + 1) END,
         expires_at = CASE WHEN lead_magnet_request_limits.expires_at <= ?2 THEN ?2 + ?3
                           ELSE lead_magnet_request_limits.expires_at END
       RETURNING used`
    )
    .bind(subjectHash, nowSeconds, QUOTA_WINDOW_SECONDS, QUOTA_LIMIT)
    .first<{ used: number }>()
  if (!row) fail('service_unavailable')
  return row.used <= QUOTA_LIMIT
}

/**
 * Public entry point. The answer is always `{ accepted: true }` for a valid request, so the
 * response never reveals whether an address already requested the resource. Only the e-mail
 * is stored (until delivery); marketing consent is separate, optional evidence.
 */
export async function requestLeadMagnetCopy(
  db: D1Database,
  rawInput: unknown,
  context: LeadMagnetContext,
  now: string
): Promise<{ accepted: true }> {
  const parsed = leadRequestSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data
  if (input.website) return { accepted: true }
  if (!findLeadMagnet(input.magnetSlug)) fail('not_found')
  if (!context.address || context.pepper.length < 32 || context.pepper.startsWith('local-only-'))
    fail('service_unavailable')
  const nowSeconds = epochSeconds(now)
  if (!Number.isFinite(nowSeconds)) fail('invalid_input')
  const addressHash = await hmacHex(context.pepper, `neteco:lead-magnet:quota:v1:${context.address}`)
  if (!(await consumeQuota(db, addressHash, nowSeconds))) fail('rate_limited')

  const emailHash = await hmacHex(context.pepper, `neteco:lead-magnet:email:v1:${input.email}`)
  try {
    await db
      .prepare(
        `INSERT INTO lead_magnet_requests(id, magnet_slug, email, email_hash, status, attempts, created_at)
         VALUES (?, ?, ?, ?, 'queued', 0, ?) ON CONFLICT(magnet_slug, email_hash) DO NOTHING`
      )
      .bind(crypto.randomUUID(), input.magnetSlug, input.email, emailHash, now)
      .run()
    if (input.marketingConsent) {
      await db
        .prepare(
          `INSERT INTO lead_magnet_consents(id, request_id, email_hash, purpose, text_version, status, given_at)
           SELECT ?, r.id, r.email_hash, 'marketing_newsletter', ?, 'pending_confirmation', ?
           FROM lead_magnet_requests r WHERE r.magnet_slug = ? AND r.email_hash = ?
           ON CONFLICT(request_id) DO NOTHING`
        )
        .bind(crypto.randomUUID(), LEAD_MAGNET_CONSENT_VERSION, now, input.magnetSlug, emailHash)
        .run()
    }
  } catch (error) {
    mapStorageError(error)
  }
  return { accepted: true }
}

/** Job entry point: bounded batch; each message is independent; the address is erased after the outcome is final. */
export async function processLeadMagnetDeliveries(
  db: D1Database,
  sender: LeadMagnetSender,
  publicOrigin: string,
  now: string
): Promise<{ sent: number; failed: number; retried: number }> {
  const { results } = await db
    .prepare(
      `SELECT id, magnet_slug, email, attempts FROM lead_magnet_requests
       WHERE status = 'queued' ORDER BY created_at, id LIMIT ?`
    )
    .bind(BATCH_SIZE)
    .all<{ id: string; magnet_slug: string; email: string; attempts: number }>()
  const outcome = { sent: 0, failed: 0, retried: 0 }
  for (const row of results) {
    const magnet = findLeadMagnet(row.magnet_slug)
    let delivered = false
    if (magnet) {
      try {
        await sender.send({ to: row.email, ...renderLeadMagnetEmail(magnet, publicOrigin) })
        delivered = true
      } catch {
        delivered = false
      }
    }
    if (delivered) {
      await db
        .prepare(
          `UPDATE lead_magnet_requests SET status = 'sent', email = NULL, sent_at = ? WHERE id = ? AND status = 'queued'`
        )
        .bind(now, row.id)
        .run()
      outcome.sent++
    } else if (row.attempts + 1 >= MAX_ATTEMPTS || !magnet) {
      await db
        .prepare(
          `UPDATE lead_magnet_requests SET status = 'failed', email = NULL, attempts = ? WHERE id = ? AND status = 'queued'`
        )
        .bind(Math.min(MAX_ATTEMPTS, row.attempts + 1), row.id)
        .run()
      outcome.failed++
    } else {
      await db
        .prepare(`UPDATE lead_magnet_requests SET attempts = attempts + 1 WHERE id = ? AND status = 'queued'`)
        .bind(row.id)
        .run()
      outcome.retried++
    }
  }
  return outcome
}

export interface LeadMagnetSummaryRow {
  magnetSlug: string
  requested: number
  queued: number
  sent: number
  failed: number
  withMarketingConsent: number
}

export async function leadMagnetSummary(
  db: D1Database,
  claims: VerifiedSessionClaims,
  now: string
): Promise<LeadMagnetSummaryRow[]> {
  await authorizeAdmin(db, claims, now)
  const { results } = await db
    .prepare(
      `SELECT r.magnet_slug AS magnetSlug, count(*) AS requested,
              SUM(r.status = 'queued') AS queued, SUM(r.status = 'sent') AS sent, SUM(r.status = 'failed') AS failed,
              SUM(EXISTS(SELECT 1 FROM lead_magnet_consents c WHERE c.request_id = r.id)) AS withMarketingConsent
       FROM lead_magnet_requests r GROUP BY r.magnet_slug ORDER BY r.magnet_slug`
    )
    .all<LeadMagnetSummaryRow>()
  return results.map((row) => ({
    magnetSlug: row.magnetSlug,
    requested: Number(row.requested),
    queued: Number(row.queued),
    sent: Number(row.sent),
    failed: Number(row.failed),
    withMarketingConsent: Number(row.withMarketingConsent)
  }))
}
