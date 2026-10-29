import { isCanonicalInventoryInstant } from '../catalog/inventory'
import { renderOrderCreatedEmail } from './order-created-email'
import {
  issueD1GuestOrderEmailLink,
  prepareGuestOrderEmailSendingStatement,
  type GuestOrderEmailLinkConfiguration
} from '../catalog/guest-order-access'
import { invoiceEmailSendingStatements, prepareInvoiceIssuedEmail } from './invoice-issued-email'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'
import { fiscalClock } from '../fiscal/issuance'
import { passwordResetSecurityEmailRenderer } from './identity-security-email'
import { accountSecurityEmailRenderers } from './account-security-email'
import {
  isDeliveryNoticeRenderer,
  readDeliveryNoticePreference,
  deliveryNoticeSendingGuard,
  suppressDeliveryNotice,
  retryChangedDeliveryNotice,
  type DeliveryNoticePreference
} from './delivery-notice-preferences'
import {
  registeredEmailRenderers,
  registeredEmailSendingStatements,
  validatePreparedEmail,
  type TransactionalEmailDependencies,
  type TransactionalEmailRenderer
} from './transactional-email-renderers'
export type {
  TransactionalEmailDependencies,
  TransactionalEmailRenderer,
  PreparedTransactionalEmail
} from './transactional-email-renderers'

/** Cloudflare Email Service binding contract. Inject a fake in local tests. */
export interface TransactionalEmailSender {
  send(message: { to: string; from: string; subject: string; html: string; text: string }): Promise<{
    messageId: string
  }>
}

export interface TransactionalEmailDispatchConfig {
  /** Optional server-only guest view links; does not enable email sending. */
  guestOrderLinks?: GuestOrderEmailLinkConfiguration
  /** Strict opt-in. Missing/false keeps jobs durable without contacting a provider. */
  enabled?: boolean
  from?: string
  now: string
  limit?: number
  /** Separate opt-in: enabling order receipts never enables invoice emails. */
  invoiceEmailEnabled?: boolean
  invoiceValidationEmailEnabled?: boolean
  appEnvironment?: 'local' | 'preview' | 'production'
  rendererOptIns?: readonly string[]
  rendererValidationEnabled?: boolean
}

export interface TransactionalEmailDispatchReport {
  sent: number
  retryable: number
  manualReview: number
  lostLease: number
  disabled: boolean
  /** Normal terminal opt-outs, not provider acceptance or manual review. */
  suppressed?: number
}

interface EventRow {
  event_type: string
  source_kind: string
  source_id: string
  source_event_id: string
  schema_version: number
}
interface OrderRow {
  id: string
  contact_email: string
  contact_name: string | null
  currency: string
  total_gross_cents: number
  shipping_gross_cents: number
}
interface LineRow {
  name: string
  sku: string
  quantity: number
  gross_cents: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_ATTEMPTS = 10
const PREPARE_LEASE_SECONDS = 60
const SEND_LEASE_SECONDS = 900

function mailbox(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 254 || /\s/.test(value)) return false
  const parts = value.split('@')
  if (parts.length !== 2) return false
  const local = parts[0]!
  const labels = parts[1]!.split('.')
  return (
    local.length <= 64 &&
    /^[a-zA-Z0-9._%+-]+$/.test(local) &&
    !local.startsWith('.') &&
    !local.endsWith('.') &&
    !local.includes('..') &&
    labels.length >= 2 &&
    /^[a-zA-Z]{2,63}$/.test(labels.at(-1)!) &&
    labels.every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))
  )
}
function instantAfter(now: string, seconds: number): string {
  return new Date(new Date(now).getTime() + seconds * 1000).toISOString().replace('.000Z', 'Z')
}
function cents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}
function safeContent(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127
    })
  )
}

/**
 * Resolve the immutable order contact/line contract, never Queue payloads,
 * identity profiles or newsletter consent/suppression. Verify the domain event
 * references this same order before exposing any recipient to the adapter.
 */
async function prepareMessage(
  database: D1Database,
  eventId: string,
  from: string,
  config: TransactionalEmailDispatchConfig,
  renderers: readonly TransactionalEmailRenderer[] = []
) {
  const event = await database
    .prepare(
      'SELECT event_type, source_kind, source_id, source_event_id, schema_version FROM email_outbox_events WHERE id = ?1'
    )
    .bind(eventId)
    .first<EventRow>()
  const matches: TransactionalEmailRenderer[] = []
  for (const renderer of renderers) {
    if (event?.event_type !== renderer.eventType || event.source_kind !== renderer.sourceKind) continue
    if (
      await database
        .prepare(`SELECT e.id FROM email_outbox_events e WHERE e.id=?1 AND (${renderer.sourcePredicate})`)
        .bind(eventId)
        .first()
    )
      matches.push(renderer)
  }
  if (matches.length > 1) return { error: 'invalid_source' } as const
  if (matches.length === 1) {
    if (!config.appEnvironment) return { error: 'invalid_source' } as const
    const renderer = matches[0]!,
      candidate = await renderer.prepare(database, eventId, from, {
        appEnvironment: config.appEnvironment,
        validationEnabled: config.rendererValidationEnabled === true
      })
    const raw = catalogPolicyOwnJson(candidate)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid_source' } as const
    if ('error' in raw) {
      if (Object.keys(raw).length !== 1 || !['invalid_source', 'source_not_found'].includes(String(raw.error)))
        return { error: 'invalid_source' } as const
      return { error: raw.error as 'invalid_source' | 'source_not_found' }
    }
    const prepared = await validatePreparedEmail(raw, renderer, from)
    const manifest = await database
      .prepare(
        'SELECT renderer_version,source_hash,message_hash FROM transactional_email_preparations WHERE event_id=?1'
      )
      .bind(eventId)
      .first<{ renderer_version: string; source_hash: string; message_hash: string }>()
    if (
      manifest &&
      (manifest.renderer_version !== prepared.rendererVersion ||
        manifest.source_hash !== prepared.sourceHash ||
        manifest.message_hash !== prepared.messageHash)
    )
      return { error: 'invalid_source' } as const
    return { mode: 'registered' as const, message: prepared.message, registeredPreparation: { prepared, renderer } }
  }
  if (event?.event_type === 'invoice.issued') {
    if (config.invoiceEmailEnabled !== true || !config.appEnvironment) return { error: 'invalid_source' } as const
    const prepared = await prepareInvoiceIssuedEmail(database, eventId, from, {
      appEnvironment: config.appEnvironment,
      validationEnabled: config.invoiceValidationEmailEnabled === true
    })
    return 'error' in prepared ? prepared : { ...prepared, mode: 'ordinary_invoice' as const }
  }
  if (!event || event.event_type !== 'order.created') return { error: 'unsupported_event' } as const
  if (
    event.source_kind !== 'order' ||
    event.schema_version !== 1 ||
    !UUID.test(event.source_id) ||
    !UUID.test(event.source_event_id)
  )
    return { error: 'invalid_source' } as const
  const order = await database
    .prepare(
      `SELECT o.id, o.contact_email, o.contact_name, o.currency, o.total_gross_cents, o.shipping_gross_cents
       FROM orders o JOIN order_events e ON e.order_id = o.id
       WHERE o.id = ?1 AND e.id = ?2 AND e.event_type = 'order.created'`
    )
    .bind(event.source_id, event.source_event_id)
    .first<OrderRow>()
  if (!order) return { error: 'source_not_found' } as const
  const lines = (
    await database
      .prepare(
        'SELECT name, sku, quantity, gross_cents FROM order_lines WHERE order_id = ?1 ORDER BY line_index LIMIT 101'
      )
      .bind(order.id)
      .all<LineRow>()
  ).results
  if (
    !mailbox(order.contact_email) ||
    order.currency !== 'EUR' ||
    !cents(order.total_gross_cents) ||
    !cents(order.shipping_gross_cents) ||
    (order.contact_name !== null && !safeContent(order.contact_name, 120)) ||
    lines.length < 1 ||
    lines.length > 100 ||
    lines.some(
      (line) =>
        !safeContent(line.name, 500) ||
        !safeContent(line.sku, 160) ||
        !Number.isSafeInteger(line.quantity) ||
        line.quantity < 1 ||
        line.quantity > 999 ||
        !cents(line.gross_cents)
    ) ||
    lines.reduce((total, line) => total + line.gross_cents, order.shipping_gross_cents) !== order.total_gross_cents
  )
    return { error: 'invalid_source' } as const
  const guestLink = config.guestOrderLinks
    ? await issueD1GuestOrderEmailLink(database, eventId, config.guestOrderLinks)
    : null
  return {
    mode: 'order' as const,
    guestLink,
    message: {
      to: order.contact_email,
      from,
      ...renderOrderCreatedEmail({
        id: order.id,
        contactName: order.contact_name,
        totalGrossCents: order.total_gross_cents,
        shippingGrossCents: order.shipping_gross_cents,
        ...(guestLink ? { guestViewUrl: guestLink.url } : {}),
        lines: lines.map((line) => ({
          name: line.name,
          sku: line.sku,
          quantity: line.quantity,
          grossCents: line.gross_cents
        }))
      })
    }
  } as const
}

/**
 * Sweep durable receipt work. Only pre-send leases are reclaimable. Persist
 * `sending` BEFORE invoking the provider, then never automatically retry that
 * job: acceptance may precede a crash, timeout or failed D1 acknowledgement.
 * No provider exception text/body/recipient is persisted or logged.
 */
export async function dispatchTransactionalEmails(
  database: D1Database,
  sender: TransactionalEmailSender | undefined,
  config: TransactionalEmailDispatchConfig,
  dependencies: TransactionalEmailDependencies = {}
): Promise<TransactionalEmailDispatchReport> {
  database = guardedFiscalDatabase(database)
  const limit = config.limit ?? 25
  if (!isCanonicalInventoryInstant(config.now) || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('invalid_transactional_email_dispatch_input')
  const now = fiscalClock(config.now)
  // First-party security notices share the existing explicit sender enablement,
  // never marketing/delivery preferences or a caller-supplied registration.
  const renderers = [
    ...registeredEmailRenderers(dependencies, config.rendererOptIns),
    passwordResetSecurityEmailRenderer,
    ...accountSecurityEmailRenderers
  ]
  const suppressionExclusion =
    'AND NOT EXISTS(SELECT 1 FROM operational_email_suppressions suppression WHERE suppression.event_id=transactional_email_deliveries.event_id)'
  const report: TransactionalEmailDispatchReport = {
    sent: 0,
    retryable: 0,
    manualReview: 0,
    lostLease: 0,
    disabled: config.enabled !== true
  }
  // Reconcile uncertainty even if an operator has disabled new delivery.
  const stale = await database
    .prepare(
      `UPDATE transactional_email_deliveries
       SET status = 'manual_review', lease_token = NULL, lease_until = NULL,
           finished_at = ?1, last_error_code = 'sending_lease_expired'
       WHERE event_id IN (
         SELECT event_id FROM transactional_email_deliveries
         WHERE status = 'sending' AND lease_until <= ?1 ORDER BY lease_until, event_id LIMIT ?2
       ) RETURNING event_id`
    )
    .bind(config.now, limit)
    .all()
  report.manualReview += stale.results.length
  if (report.disabled) return report
  if (!sender || typeof sender.send !== 'function') throw new Error('transactional_email_sender_unavailable')
  if (!mailbox(config.from)) throw new Error('invalid_transactional_email_from')
  const from = config.from
  const exhausted = await database
    .prepare(
      `UPDATE transactional_email_deliveries
       SET status = 'manual_review', lease_token = NULL, lease_until = NULL,
           finished_at = ?1, last_error_code = 'preparation_attempts_exhausted'
       WHERE event_id IN (
         SELECT event_id FROM transactional_email_deliveries WHERE attempts >= ?2
           ${suppressionExclusion}
           AND (status = 'pending' OR (status = 'leased' AND lease_until <= ?1))
         ORDER BY available_at, event_id LIMIT ?3
       ) RETURNING event_id`
    )
    .bind(config.now, MAX_ATTEMPTS, limit)
    .all()
  report.manualReview += exhausted.results.length
  const candidates = (
    await database
      .prepare(
        `SELECT event_id FROM transactional_email_deliveries
       WHERE ((status = 'pending' AND available_at <= ?1) OR (status = 'leased' AND lease_until <= ?1))
         ${suppressionExclusion}
         AND EXISTS(SELECT 1 FROM email_outbox_events e WHERE e.id=event_id AND (
           e.event_type NOT IN('invoice.issued','refund.succeeded.email','support.ticket.received','support.ticket.reply','order.status.updated','order.cancelled','return.requested','return.status.updated','order.confirmed')
           OR (?3=1 AND e.event_type='invoice.issued' ${config.invoiceEmailEnabled === true ? 'AND EXISTS(SELECT 1 FROM fiscal_invoice_intents ordinary WHERE ordinary.id=e.source_id)' : ''})
           ${renderers.map((renderer, index) => `OR (e.event_type=?${4 + index * 2} AND e.source_kind=?${5 + index * 2} AND (${renderer.sourcePredicate}))`).join('\n')}
         ))
       ORDER BY available_at, event_id LIMIT ?2`
      )
      .bind(
        config.now,
        limit,
        config.invoiceEmailEnabled === true ? 1 : 0,
        ...renderers.flatMap((renderer) => [renderer.eventType, renderer.sourceKind])
      )
      .all<{ event_id: string }>()
  ).results

  for (const { event_id: eventId } of candidates) {
    const token = crypto.randomUUID()
    const claim = await database
      .prepare(
        `UPDATE transactional_email_deliveries
         SET status = 'leased', lease_token = ?2, lease_until = ?3, attempts = attempts + 1
         WHERE event_id = ?1 AND attempts < ?5
           ${suppressionExclusion}
           AND ((status = 'pending' AND available_at <= ?4) OR (status = 'leased' AND lease_until <= ?4))
         RETURNING attempts`
      )
      .bind(eventId, token, instantAfter(config.now, PREPARE_LEASE_SECONDS), config.now, MAX_ATTEMPTS)
      .first<{ attempts: number }>()
    if (!claim) continue
    let prepared: Awaited<ReturnType<typeof prepareMessage>>
    try {
      prepared = await prepareMessage(database, eventId, from, config, renderers)
    } catch {
      const retried = await database
        .prepare(
          `UPDATE transactional_email_deliveries
           SET status = CASE WHEN attempts >= ?4 THEN 'manual_review' ELSE 'pending' END,
               available_at = ?3, lease_token = NULL, lease_until = NULL,
               finished_at = CASE WHEN attempts >= ?4 THEN ?5 ELSE NULL END,
               last_error_code = 'preparation_failed'
           WHERE event_id = ?1 AND status = 'leased' AND lease_token = ?2 RETURNING status`
        )
        .bind(
          eventId,
          token,
          instantAfter(config.now, Math.min(3600, 30 * 2 ** (claim.attempts - 1))),
          MAX_ATTEMPTS,
          config.now
        )
        .first<{ status: string }>()
      if (!retried) report.lostLease++
      else if (retried.status === 'manual_review') report.manualReview++
      else report.retryable++
      continue
    }
    if ('error' in prepared) {
      const blocked = await database
        .prepare(
          `UPDATE transactional_email_deliveries
           SET status = 'manual_review', lease_token = NULL, lease_until = NULL,
               finished_at = ?3, last_error_code = ?4
           WHERE event_id = ?1 AND status = 'leased' AND lease_token = ?2 RETURNING event_id`
        )
        .bind(eventId, token, config.now, prepared.error)
        .first()
      if (blocked) report.manualReview++
      else report.lostLease++
      continue
    }
    let sending: unknown
    let noticePreference: DeliveryNoticePreference | undefined
    if (prepared.mode !== 'order') {
      try {
        let markerNow = now()
        const notice =
          prepared.mode === 'registered' && isDeliveryNoticeRenderer(prepared.registeredPreparation.renderer)
        if (notice && prepared.mode === 'registered') {
          noticePreference = await readDeliveryNoticePreference(database, eventId, markerNow)
          if (!noticePreference.deliveryUpdates) {
            if (
              await suppressDeliveryNotice(
                database,
                eventId,
                token,
                markerNow,
                instantAfter(markerNow, SEND_LEASE_SECONDS),
                prepared.registeredPreparation,
                noticePreference
              )
            ) {
              report.suppressed = (report.suppressed ?? 0) + 1
              continue
            }
            // One bounded re-evaluation: an enable committed before the
            // suppression batch must not create a false terminal opt-out.
            noticePreference = await readDeliveryNoticePreference(database, eventId, now())
            markerNow = now()
            if (!noticePreference.deliveryUpdates) {
              if (
                await suppressDeliveryNotice(
                  database,
                  eventId,
                  token,
                  now(),
                  instantAfter(now(), SEND_LEASE_SECONDS),
                  prepared.registeredPreparation,
                  noticePreference
                )
              ) {
                report.suppressed = (report.suppressed ?? 0) + 1
                continue
              }
              throw new Error('delivery_notice_preference_changed')
            }
          }
        }
        const results = await database.batch(
          prepared.mode === 'registered'
            ? [
                ...registeredEmailSendingStatements(
                  database,
                  eventId,
                  token,
                  markerNow,
                  instantAfter(markerNow, SEND_LEASE_SECONDS),
                  prepared.registeredPreparation.prepared,
                  prepared.registeredPreparation.renderer
                ),
                ...(noticePreference
                  ? [deliveryNoticeSendingGuard(database, eventId, token, markerNow, noticePreference)]
                  : [])
              ]
            : invoiceEmailSendingStatements(
                database,
                eventId,
                token,
                markerNow,
                instantAfter(markerNow, SEND_LEASE_SECONDS),
                prepared.invoicePreparation
              )
        )
        const marker = results[1]?.results
        if (!marker || marker.length !== 1) throw new Error('invoice_email_marker_unconfirmed')
        const markerRow = marker[0]
        if (!markerRow || typeof markerRow !== 'object' || Array.isArray(markerRow))
          throw new Error('invoice_email_marker_unconfirmed')
        const markerId = Object.getOwnPropertyDescriptor(markerRow, 'event_id')
        if (
          !markerId ||
          !Object.hasOwn(markerId, 'value') ||
          markerId.value !== eventId ||
          Object.keys(markerRow).length !== 1
        )
          throw new Error('invoice_email_marker_unconfirmed')
        sending = markerRow
      } catch {
        if (prepared.mode === 'registered' && isDeliveryNoticeRenderer(prepared.registeredPreparation.renderer)) {
          try {
            const currentNow = now(),
              fresh = await readDeliveryNoticePreference(database, eventId, currentNow)
            if (
              !fresh.deliveryUpdates &&
              (await suppressDeliveryNotice(
                database,
                eventId,
                token,
                currentNow,
                instantAfter(currentNow, SEND_LEASE_SECONDS),
                prepared.registeredPreparation,
                fresh
              ))
            ) {
              report.suppressed = (report.suppressed ?? 0) + 1
              continue
            }
            // Preference races are not source errors. Reclaim only a proven
            // pre-send lease; an uncertain committed marker is never retried.
            const current = await readDeliveryNoticePreference(database, eventId, now())
            if (
              noticePreference &&
              current.deliveryUpdates &&
              current.version !== noticePreference.version &&
              (await retryChangedDeliveryNotice(
                database,
                eventId,
                token,
                now(),
                instantAfter(now(), SEND_LEASE_SECONDS),
                prepared.registeredPreparation,
                current
              ))
            ) {
              report.retryable++
              continue
            }
          } catch {
            /* Corrupt/outage/source proof is not an opt-out. */
          }
        }
        // Failed/malformed acknowledgement cannot authorize a send. If the
        // marker committed, it remains non-retryable and is swept later.
        const blocked = await database
          .prepare(
            `UPDATE transactional_email_deliveries SET status='manual_review',lease_token=NULL,lease_until=NULL,finished_at=?3,last_error_code='invalid_source' WHERE event_id=?1 AND status='leased' AND lease_token=?2 RETURNING event_id`
          )
          .bind(eventId, token, config.now)
          .first()
        if (blocked) report.manualReview++
        else report.lostLease++
        continue
      }
    } else if (prepared.guestLink) {
      const markerNow = now()
      sending = await prepareGuestOrderEmailSendingStatement(database, {
        eventId,
        leaseToken: token,
        now: markerNow,
        leaseUntil: instantAfter(markerNow, SEND_LEASE_SECONDS),
        to: prepared.message.to,
        link: prepared.guestLink
      }).first()
    } else
      sending = await database
        .prepare(
          `UPDATE transactional_email_deliveries
         SET status = 'sending', sending_at = ?3, lease_until = ?4, last_error_code = NULL
         WHERE event_id = ?1 AND status = 'leased' AND lease_token = ?2 RETURNING event_id`
        )
        .bind(eventId, token, config.now, instantAfter(config.now, SEND_LEASE_SECONDS))
        .first()
    if (!sending) {
      report.lostLease++
      continue
    }
    let errorCode = 'provider_outcome_unknown'
    try {
      const receipt = catalogPolicyOwnJson(await sender.send(prepared.message)) as { messageId?: unknown }
      errorCode = 'provider_receipt_invalid'
      if (
        !receipt ||
        typeof receipt.messageId !== 'string' ||
        /\s/.test(receipt.messageId) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(receipt.messageId)
      )
        throw new Error('invalid_transactional_email_provider_receipt')
      errorCode = 'provider_ack_failed'
      const acknowledged = await database
        .prepare(
          `UPDATE transactional_email_deliveries
           SET status = 'sent', finished_at = ?3, provider_message_id = ?4,
               lease_token = NULL, lease_until = NULL, last_error_code = NULL
           WHERE event_id = ?1 AND status = 'sending' AND lease_token = ?2 RETURNING event_id`
        )
        .bind(eventId, token, config.now, receipt.messageId)
        .first()
      if (acknowledged) {
        report.sent++
        continue
      }
    } catch {
      // Acceptance + lost acknowledgement and provider rejection are both
      // ambiguous without an authoritative, idempotent provider replay API.
    }
    try {
      await database
        .prepare(
          `UPDATE transactional_email_deliveries
           SET status = 'manual_review', finished_at = ?3, last_error_code = ?4,
               lease_token = NULL, lease_until = NULL
           WHERE event_id = ?1 AND status = 'sending' AND lease_token = ?2`
        )
        .bind(eventId, token, config.now, errorCode)
        .run()
    } catch {
      // Durable sending marker remains non-retryable; a later sweep quarantines it.
    }
    report.manualReview++
  }
  return report
}
