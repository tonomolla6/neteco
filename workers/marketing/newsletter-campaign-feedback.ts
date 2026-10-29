import { z } from 'zod'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import {
  NewsletterEditorialError,
  assertBatch,
  editorialHash,
  editorialNow,
  editorialSource,
  stableJson,
  type NewsletterEditorialHttpDependencies
} from './newsletter-editorial-core'

export const newsletterFeedbackSchema = z
  .object({
    eventId: z.string().regex(/^[a-zA-Z0-9._:-]{3,200}$/),
    messageId: z.string().regex(/^[a-zA-Z0-9._:-]{1,200}$/),
    type: z.enum(['delivered', 'hard_bounce', 'complaint']),
    occurredAt: catalogPolicyInstantSchema
  })
  .strict()

/** Authenticate raw bytes, not a reserialized object. Unknown receipts never
 * create suppression entries. A dedicated provider key is injected by ingress. */
export async function receiveNewsletterEditorialFeedback(
  deps: NewsletterEditorialHttpDependencies,
  rawBody: string,
  signature: string | null
) {
  const config = deps.feedback
  if (
    deps.enabled !== true ||
    !config ||
    !(config.secret instanceof Uint8Array) ||
    config.secret.length < 32 ||
    config.secret.length > 128
  )
    throw new NewsletterEditorialError('feedback_unavailable')
  const match = /^sha256=([a-f0-9]{64})$/.exec(signature ?? '')
  if (!match) throw new NewsletterEditorialError('feedback_unauthenticated')
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(config.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    Uint8Array.from(match[1]!.match(/../g)!, (v) => parseInt(v, 16)),
    new TextEncoder().encode(rawBody)
  )
  if (!valid) throw new NewsletterEditorialError('feedback_unauthenticated')
  let value: unknown
  try {
    value = JSON.parse(rawBody)
  } catch {
    throw new NewsletterEditorialError('invalid_input')
  }
  const checked = newsletterFeedbackSchema.safeParse(value)
  if (!checked.success) throw new NewsletterEditorialError('invalid_input')
  const input = checked.data,
    now = editorialNow(deps)
  if (input.occurredAt > now) throw new NewsletterEditorialError('invalid_input')
  const hash = await editorialHash(stableJson(input))
  const existing = await deps.database
    .prepare('SELECT payload_hash FROM newsletter_editorial_feedback WHERE provider=? AND event_id=?')
    .bind(config.provider, input.eventId)
    .first()
  if (existing !== null) {
    if (editorialSource(z.object({ payload_hash: z.string() }).strict(), existing).payload_hash !== hash)
      throw new NewsletterEditorialError('idempotency_conflict')
    return { source: 'cloudflare' as const, acknowledged: true as const, replay: true }
  }
  const receipt = await deps.database
    .prepare(
      `SELECT d.id,s.email_hash,d.sending_at FROM newsletter_editorial_deliveries d JOIN newsletter_subscriptions s ON s.id=d.subscription_id
 WHERE d.status='accepted' AND d.provider=? AND d.provider_message_id=?`
    )
    .bind(config.provider, input.messageId)
    .first()
  if (receipt === null) throw new NewsletterEditorialError('receipt_unknown')
  const row = editorialSource(
    z
      .object({
        id: z.string().uuid(),
        email_hash: z.string().regex(/^[a-f0-9]{64}$/),
        sending_at: catalogPolicyInstantSchema
      })
      .strict(),
    receipt
  )
  if (input.occurredAt < row.sending_at) throw new NewsletterEditorialError('invalid_input')
  const id = crypto.randomUUID(),
    statements = [
      deps.database
        .prepare(
          `INSERT INTO newsletter_editorial_feedback(id,provider,event_id,delivery_id,event_type,occurred_at,received_at,payload_hash)
 SELECT ?1,?2,?3,d.id,?5,?6,?7,?8 FROM newsletter_editorial_deliveries d WHERE d.id=?4 AND d.status='accepted' AND d.provider=?2 AND d.provider_message_id=?9`
        )
        .bind(id, config.provider, input.eventId, row.id, input.type, input.occurredAt, now, hash, input.messageId)
    ]
  const status = input.type === 'complaint' ? 'complained' : input.type === 'hard_bounce' ? 'bounced' : 'delivered'
  statements.push(
    deps.database
      .prepare(
        `UPDATE newsletter_editorial_deliveries SET feedback_status=? WHERE id=?
 AND EXISTS(SELECT 1 FROM newsletter_editorial_feedback WHERE id=?) AND COALESCE(feedback_status,'')<>'complained'
 AND (COALESCE(feedback_status,'')<>'bounced' OR ?='complained')`
      )
      .bind(status, row.id, id, status)
  )
  if (input.type !== 'delivered')
    statements.push(
      deps.database
        .prepare(
          `INSERT INTO newsletter_suppressions(email_hash,reason,source,created_at,updated_at)
 SELECT ?,?,'newsletter_editorial_feedback',?,? WHERE EXISTS(SELECT 1 FROM newsletter_editorial_feedback WHERE id=?)
 ON CONFLICT(email_hash) DO UPDATE SET reason=CASE WHEN newsletter_suppressions.reason IN('legal','manual','complaint') THEN newsletter_suppressions.reason
 WHEN excluded.reason='complaint' THEN 'complaint' ELSE newsletter_suppressions.reason END,
 updated_at=max(newsletter_suppressions.updated_at,excluded.updated_at)`
        )
        .bind(row.email_hash, input.type, Math.floor(Date.parse(now) / 1000), Math.floor(Date.parse(now) / 1000), id)
    )
  statements.push(
    deps.database
      .prepare(
        'INSERT INTO newsletter_editorial_guards(id,satisfied) SELECT ?,EXISTS(SELECT 1 FROM newsletter_editorial_feedback WHERE id=?)'
      )
      .bind(id, id)
  )
  try {
    assertBatch(await deps.database.batch(statements), statements.length)
  } catch (error) {
    const winner = await deps.database
      .prepare('SELECT payload_hash FROM newsletter_editorial_feedback WHERE provider=? AND event_id=?')
      .bind(config.provider, input.eventId)
      .first()
    if (winner !== null) {
      if (editorialSource(z.object({ payload_hash: z.string() }).strict(), winner).payload_hash !== hash)
        throw new NewsletterEditorialError('idempotency_conflict')
      return { source: 'cloudflare' as const, acknowledged: true as const, replay: true }
    }
    throw error
  }
  return { source: 'cloudflare' as const, acknowledged: true as const, replay: false }
}
