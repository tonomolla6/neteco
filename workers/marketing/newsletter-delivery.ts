import { createNewsletterConfirmationToken, type NewsletterSecrets } from './newsletter'

export interface NewsletterSender {
  send(message: { to: string; from: string; subject: string; html: string; text: string }): Promise<{
    messageId: string
  }>
}

interface DeliveryRow {
  request_id: string
  email_normalized: string
}

function assertConfiguration(from: string, publicOrigin: string): void {
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(from) || from.length > 254 || /[\r\n]/.test(from))
    throw new Error('invalid_newsletter_sender')
  const origin = new URL(publicOrigin)
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== publicOrigin ||
    origin.hostname.endsWith('.invalid') ||
    origin.username ||
    origin.password
  )
    throw new Error('invalid_newsletter_origin')
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** No automatic retry after an ambiguous provider call. A stale `sending` job
 * goes to manual_review, because a provider acceptance may have preceded a crash.
 */
export async function dispatchNewsletterConfirmations(
  database: D1Database,
  sender: NewsletterSender,
  config: { from: string; publicOrigin: string; secrets: NewsletterSecrets; now?: number; limit?: number }
): Promise<{ sent: number; skipped: number; manualReview: number }> {
  assertConfiguration(config.from, config.publicOrigin)
  const now = config.now ?? Math.floor(Date.now() / 1000)
  const limit = config.limit ?? 25
  if (!Number.isSafeInteger(now) || now < 1_000_000_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('invalid_newsletter_dispatch_input')

  const stale = await database
    .prepare(
      `UPDATE newsletter_confirmation_deliveries
       SET status = 'manual_review', finished_at = ?1
       WHERE status = 'sending' AND claimed_at <= ?1 - 900
       RETURNING request_id`
    )
    .bind(now)
    .all<{ request_id: string }>()
  let manualReview = stale.results.length
  let sent = 0
  let skipped = 0
  const candidates = await database
    .prepare(
      `SELECT d.request_id, s.email_normalized
       FROM newsletter_confirmation_deliveries d
       JOIN newsletter_consent_events e ON e.id = d.request_id
       JOIN newsletter_subscriptions s ON s.id = e.subscription_id
       WHERE d.status = 'pending' AND d.created_at <= ?2
       ORDER BY d.created_at, d.request_id LIMIT ?1`
    )
    .bind(limit, now)
    .all<DeliveryRow>()

  for (const candidate of candidates.results) {
    const claimed = await database
      .prepare(
        `UPDATE newsletter_confirmation_deliveries SET status = 'sending', claimed_at = ?2
         WHERE request_id = ?1 AND status = 'pending'
           AND EXISTS (
             SELECT 1 FROM newsletter_consent_events e
             JOIN newsletter_subscriptions s ON s.id = e.subscription_id
             WHERE e.id = ?1 AND s.request_id = e.id AND s.status = 'pending'
               AND s.confirmation_expires_at > ?2
               AND NOT EXISTS (SELECT 1 FROM newsletter_suppressions x WHERE x.email_hash = s.email_hash)
           )
         RETURNING request_id`
      )
      .bind(candidate.request_id, now)
      .first<{ request_id: string }>()
    if (!claimed) {
      const obsolete = await database
        .prepare(
          `UPDATE newsletter_confirmation_deliveries SET status = 'skipped', finished_at = ?2
           WHERE request_id = ?1 AND status = 'pending'
             AND NOT EXISTS (
               SELECT 1 FROM newsletter_consent_events e
               JOIN newsletter_subscriptions s ON s.id = e.subscription_id
               WHERE e.id = ?1 AND s.request_id = e.id AND s.status = 'pending'
                 AND s.confirmation_expires_at > ?2
                 AND NOT EXISTS (SELECT 1 FROM newsletter_suppressions x WHERE x.email_hash = s.email_hash)
             ) RETURNING request_id`
        )
        .bind(candidate.request_id, now)
        .first<{ request_id: string }>()
      if (obsolete) skipped++
      continue
    }
    try {
      const token = await createNewsletterConfirmationToken(candidate.request_id, config.secrets)
      const url = new URL('/newsletter/confirmar', config.publicOrigin)
      url.searchParams.set('token', token)
      const link = url.toString()
      const result = await sender.send({
        to: candidate.email_normalized,
        from: config.from,
        subject: 'Confirma tu suscripción a la newsletter de NETECO',
        text: `Confirma tu suscripción a NETECO: ${link}\nEl enlace caduca en 48 horas. Si no lo solicitaste, ignora este mensaje.`,
        html: `<h1>Confirma tu suscripción</h1><p>Solo recibirás novedades comerciales si confirmas esta solicitud.</p><p><a href="${escapeHtml(link)}">Confirmar newsletter</a></p><p>El enlace caduca en 48 horas. Si no lo solicitaste, ignora este mensaje.</p>`
      })
      if (!result.messageId || result.messageId.length > 200 || /[\r\n]/.test(result.messageId))
        throw new Error('invalid_newsletter_provider_receipt')
      const acknowledged = await database
        .prepare(
          `UPDATE newsletter_confirmation_deliveries
           SET status = 'sent', finished_at = ?2, provider_message_id = ?3
           WHERE request_id = ?1 AND status = 'sending'
           RETURNING request_id`
        )
        .bind(candidate.request_id, now, result.messageId)
        .first<{ request_id: string }>()
      if (acknowledged) sent++
      else manualReview++
    } catch {
      // The provider may have accepted the message. Never retry this job blindly.
      try {
        await database
          .prepare(
            `UPDATE newsletter_confirmation_deliveries SET status = 'manual_review', finished_at = ?2
             WHERE request_id = ?1 AND status = 'sending'`
          )
          .bind(candidate.request_id, now)
          .run()
      } catch {
        // A later sweep transitions stale sending jobs to manual_review.
      }
      manualReview++
    }
  }
  return { sent, skipped, manualReview }
}

export async function pruneNewsletterRequestLimits(database: D1Database, now = Math.floor(Date.now() / 1000)) {
  return database
    .prepare(
      `DELETE FROM newsletter_request_limits WHERE rowid IN
       (SELECT rowid FROM newsletter_request_limits WHERE expires_at <= ?1 ORDER BY expires_at LIMIT 500)`
    )
    .bind(now)
    .run()
}
