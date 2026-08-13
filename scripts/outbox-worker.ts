import postgres from 'postgres'
import { createHash } from 'node:crypto'
import {
  emailProviderFromEnvironment,
  marketingEmailProviderFromEnvironment
} from '../server/integrations/email-provider'
import { renderNewsletterEmail } from '../server/services/newsletter-email'
import { decryptSecret } from '../server/utils/secrets'

interface OutboxEvent {
  id: string
  eventType: string
  payload: {
    recipient: string
    name?: string
    tokenEnvelope?: string
    expiresAt?: string
    occurredAt?: string
    orderNumber?: string
    totalCents?: number
    ticketNumber?: string
    replyBody?: string
    statusLabel?: string
    trackingNumber?: string
    refundCents?: number
    policyVersion?: string
    unsubscribeTokenEnvelope?: string
    unsubscribeExpiresAt?: string
  }
  attempts: number
}

const connection = process.env.DATABASE_URL?.trim()
const encryptionKey = process.env.AUTH_ENCRYPTION_KEY?.trim()
const baseUrl = process.env.APP_BASE_URL?.trim()
if (!connection) throw new Error('DATABASE_URL is required')
if (!encryptionKey) throw new Error('AUTH_ENCRYPTION_KEY is required')
if (!baseUrl) throw new Error('APP_BASE_URL is required')

const sql = postgres(connection, { max: 2, connect_timeout: 10 })
const transactionalProvider = emailProviderFromEnvironment()
const marketingProvider = marketingEmailProviderFromEnvironment()
const workerId = `email-${process.pid}`

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

async function claim(): Promise<OutboxEvent | undefined> {
  return sql.begin(async (transaction) => {
    await transaction`
      UPDATE outbox_events
      SET status = 'retry', available_at = now(), locked_at = NULL, locked_by = NULL,
          last_error_code = 'stale_worker_lease', last_error_message = 'Recovered an expired email worker lease'
      WHERE status = 'processing' AND locked_at < now() - interval '15 minutes'
        AND event_type IN (
          'identity.verification.requested', 'identity.password_reset.requested',
          'identity.email_change.requested', 'identity.security.password_changed',
          'identity.security.email_changed', 'order.created', 'order.confirmed', 'support.ticket.received',
          'support.ticket.reply'
          , 'order.status.updated', 'order.cancelled', 'order.cancellation.requested',
          'order.shipped', 'order.delivered', 'refund.succeeded.email',
          'newsletter.confirmation.requested', 'newsletter.welcome'
        )
    `
    const [event] = await transaction<OutboxEvent[]>`
      SELECT event.id, event.event_type AS "eventType",
             event.payload || CASE WHEN orders.id IS NOT NULL THEN jsonb_build_object(
               'recipient', orders.customer_snapshot ->> 'email',
               'name', orders.customer_snapshot ->> 'name',
               'orderNumber', orders.public_number,
               'totalCents', orders.total_gross_cents,
               'tokenEnvelope', COALESCE(
                 event.payload ->> 'tokenEnvelope',
                 (
                   SELECT created.payload ->> 'tokenEnvelope' FROM outbox_events created
                   WHERE created.aggregate_id = orders.id AND created.event_type = 'order.created'
                   ORDER BY created.created_at LIMIT 1
                 )
               )
             ) ELSE '{}'::jsonb END AS payload,
             event.attempts
      FROM outbox_events event
      LEFT JOIN refunds ON event.aggregate_type = 'refund' AND refunds.id = event.aggregate_id
      LEFT JOIN orders ON
        (event.aggregate_type = 'order' AND orders.id = event.aggregate_id)
        OR (event.aggregate_type = 'refund' AND orders.id = refunds.order_id)
      WHERE event.status IN ('pending', 'retry')
        AND event.available_at <= now()
        AND event.event_type IN (
          'identity.verification.requested', 'identity.password_reset.requested',
          'identity.email_change.requested', 'identity.security.password_changed',
          'identity.security.email_changed', 'order.created', 'order.confirmed', 'support.ticket.received',
          'support.ticket.reply'
          , 'order.status.updated', 'order.cancelled', 'order.cancellation.requested',
          'order.shipped', 'order.delivered', 'refund.succeeded.email',
          'newsletter.confirmation.requested', 'newsletter.welcome'
        )
      ORDER BY event.created_at
      FOR UPDATE OF event SKIP LOCKED
      LIMIT 1
    `
    if (!event) return undefined
    await transaction`
      UPDATE outbox_events
      SET status = 'processing', attempts = attempts + 1, locked_at = now(), locked_by = ${workerId}
      WHERE id = ${event.id}
    `
    return { ...event, attempts: event.attempts + 1 }
  })
}

function render(event: OutboxEvent) {
  const newsletterEmail = renderNewsletterEmail(event, {
    baseUrl: baseUrl!,
    encryptionKey: encryptionKey!
  })
  if (newsletterEmail) return newsletterEmail
  const displayName = event.payload.name?.trim() || 'Hola'
  const safeName = escapeHtml(displayName)
  if (event.eventType === 'identity.security.password_changed') {
    return {
      messageId: event.id,
      to: event.payload.recipient,
      subject: 'Tu contraseña de NETECO ha cambiado',
      text: `${displayName}: la contraseña de tu cuenta NETECO ha cambiado. Si no has sido tú, contacta con soporte de inmediato.`,
      html: `<p>${safeName}:</p><p>La contraseña de tu cuenta NETECO ha cambiado.</p><p>Si no has sido tú, contacta con soporte de inmediato.</p>`
    }
  }
  if (event.eventType === 'identity.security.email_changed') {
    return {
      messageId: event.id,
      to: event.payload.recipient,
      subject: 'El email de tu cuenta NETECO ha cambiado',
      text: `${displayName}: el email de acceso a tu cuenta NETECO ha cambiado. Si no has sido tú, contacta con soporte de inmediato.`,
      html: `<p>${safeName}:</p><p>El email de acceso a tu cuenta NETECO ha cambiado.</p><p>Si no has sido tú, contacta con soporte de inmediato.</p>`
    }
  }
  if (event.eventType === 'order.created' || event.eventType === 'order.confirmed') {
    if (!event.payload.orderNumber || event.payload.totalCents === undefined) {
      throw new Error('Order email payload is incomplete')
    }
    const confirmed = event.eventType === 'order.confirmed'
    const total = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(
      event.payload.totalCents / 100
    )
    const link = new URL(`/pedido/${encodeURIComponent(event.payload.orderNumber)}`, baseUrl)
    if (event.payload.tokenEnvelope) {
      link.searchParams.set('token', decryptSecret(event.payload.tokenEnvelope, encryptionKey!))
    }
    const subject = confirmed
      ? `Pago confirmado · pedido ${event.payload.orderNumber}`
      : `Pedido recibido · ${event.payload.orderNumber}`
    const state = confirmed
      ? 'Hemos confirmado el pago y el pedido pasa a preparación.'
      : 'Hemos recibido el pedido. Consulta el enlace para comprobar su estado de pago y preparación.'
    const safeOrderNumber = escapeHtml(event.payload.orderNumber)
    const safeTotal = escapeHtml(total)
    const safeLink = escapeHtml(link.toString())
    return {
      messageId: event.id,
      to: event.payload.recipient,
      subject,
      text: `${displayName}: ${state}\nPedido: ${event.payload.orderNumber}\nTotal: ${total}\nEstado: ${link}`,
      html: `<p>${safeName}:</p><p>${state}</p><p><strong>Pedido:</strong> ${safeOrderNumber}<br><strong>Total:</strong> ${safeTotal}</p><p><a href="${safeLink}">Consultar el estado del pedido</a></p>`
    }
  }
  if (
    [
      'order.status.updated',
      'order.cancelled',
      'order.cancellation.requested',
      'order.shipped',
      'order.delivered'
    ].includes(event.eventType)
  ) {
    if (!event.payload.orderNumber || !event.payload.statusLabel) throw new Error('Order status email is incomplete')
    const tracking = event.payload.trackingNumber ? `\nSeguimiento: ${event.payload.trackingNumber}` : ''
    const safeOrderNumber = escapeHtml(event.payload.orderNumber)
    const safeStatusLabel = escapeHtml(event.payload.statusLabel)
    const safeTrackingNumber = event.payload.trackingNumber ? escapeHtml(event.payload.trackingNumber) : ''
    return {
      messageId: event.id,
      to: event.payload.recipient,
      subject: `${event.payload.statusLabel} · pedido ${event.payload.orderNumber}`,
      text: `${displayName}: el pedido ${event.payload.orderNumber} está ${event.payload.statusLabel}.${tracking}`,
      html: `<p>${safeName}:</p><p>El pedido <strong>${safeOrderNumber}</strong> está <strong>${safeStatusLabel}</strong>.</p>${safeTrackingNumber ? `<p>Seguimiento: <strong>${safeTrackingNumber}</strong></p>` : ''}`
    }
  }
  if (event.eventType === 'refund.succeeded.email') {
    if (!event.payload.orderNumber || event.payload.refundCents === undefined) {
      throw new Error('Refund email payload is incomplete')
    }
    const total = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(
      event.payload.refundCents / 100
    )
    const safeOrderNumber = escapeHtml(event.payload.orderNumber)
    const safeTotal = escapeHtml(total)
    return {
      messageId: event.id,
      to: event.payload.recipient,
      subject: `Reembolso confirmado · pedido ${event.payload.orderNumber}`,
      text: `${displayName}: se ha confirmado un reembolso de ${total} para el pedido ${event.payload.orderNumber}. La fecha de abono final depende del banco.`,
      html: `<p>${safeName}:</p><p>Se ha confirmado un reembolso de <strong>${safeTotal}</strong> para el pedido <strong>${safeOrderNumber}</strong>.</p><p>La fecha de abono final depende del banco.</p>`
    }
  }
  if (event.eventType === 'support.ticket.received') {
    if (!event.payload.ticketNumber) throw new Error('Support email payload is incomplete')
    const safeTicketNumber = escapeHtml(event.payload.ticketNumber)
    return {
      messageId: event.id,
      to: event.payload.recipient,
      subject: `Consulta recibida · ${event.payload.ticketNumber}`,
      text: `${displayName}: hemos registrado tu consulta con la referencia ${event.payload.ticketNumber}. Conserva este número para cualquier seguimiento.`,
      html: `<p>${safeName}:</p><p>Hemos registrado tu consulta con la referencia <strong>${safeTicketNumber}</strong>.</p><p>Conserva este número para cualquier seguimiento.</p>`
    }
  }
  if (event.eventType === 'support.ticket.reply') {
    if (!event.payload.ticketNumber || !event.payload.replyBody) throw new Error('Support reply payload is incomplete')
    const safeReply = escapeHtml(event.payload.replyBody).replaceAll('\n', '<br>')
    const safeTicketNumber = escapeHtml(event.payload.ticketNumber)
    return {
      messageId: event.id,
      to: event.payload.recipient,
      subject: `Actualización de tu consulta · ${event.payload.ticketNumber}`,
      text: `${displayName}:\n\n${event.payload.replyBody}\n\nReferencia: ${event.payload.ticketNumber}`,
      html: `<p>${safeName}:</p><p>${safeReply}</p><p><strong>Referencia:</strong> ${safeTicketNumber}</p>`
    }
  }
  if (!event.payload.tokenEnvelope || !event.payload.expiresAt) throw new Error('Email token payload is incomplete')
  const token = decryptSecret(event.payload.tokenEnvelope, encryptionKey!)
  const verification = event.eventType === 'identity.verification.requested'
  const emailChange = event.eventType === 'identity.email_change.requested'
  const path = verification || emailChange ? '/verificar-email' : '/restablecer-clave'
  const link = new URL(path, baseUrl)
  link.searchParams.set('token', token)
  const subject = verification
    ? 'Verifica tu cuenta de NETECO'
    : emailChange
      ? 'Confirma tu nuevo email de NETECO'
      : 'Restablece tu contraseña de NETECO'
  const action = verification
    ? 'verificar tu dirección de correo'
    : emailChange
      ? 'confirmar el nuevo email de tu cuenta'
      : 'elegir una nueva contraseña'
  const safeLink = escapeHtml(link.toString())
  return {
    messageId: event.id,
    to: event.payload.recipient,
    subject,
    text: `${displayName}: usa este enlace para ${action}: ${link.toString()}\nCaduca: ${event.payload.expiresAt}`,
    html: `<p>${safeName}:</p><p><a href="${safeLink}">Pulsa aquí para ${action}</a>.</p><p>El enlace caduca en la fecha indicada en este mensaje.</p>`
  }
}

async function processOne(event: OutboxEvent) {
  try {
    const email = render(event)
    const marketing = event.eventType === 'newsletter.welcome'
    const provider = marketing ? marketingProvider : transactionalProvider
    const recipientHash = createHash('sha256').update(email.to.trim().toLowerCase()).digest('hex')
    const suppressionReasons = marketing
      ? ['unsubscribe', 'hard_bounce', 'complaint', 'manual', 'legal']
      : ['hard_bounce', 'complaint', 'manual', 'legal']
    const [suppression] = await sql<{ reason: string }[]>`
      SELECT reason FROM communication_suppressions
      WHERE channel = 'email' AND destination_hash = ${recipientHash}
        AND reason IN ${sql(suppressionReasons)}
    `
    if (suppression) {
      await sql.begin(async (transaction) => {
        await transaction`
          INSERT INTO communication_deliveries (
            outbox_event_id, provider, provider_message_id, channel, status, recipient_hash
          ) VALUES (
            ${event.id}, ${provider.name}, ${`suppressed:${event.id}`}, 'email', 'suppressed', ${recipientHash}
          ) ON CONFLICT (outbox_event_id) DO NOTHING
        `
        await transaction`
          UPDATE outbox_events
          SET status = 'completed', completed_at = now(), locked_at = NULL, locked_by = NULL,
              last_error_code = ${`email_suppressed_${suppression.reason}`},
              last_error_message = 'Delivery blocked by communication suppression'
          WHERE id = ${event.id} AND locked_by = ${workerId}
        `
      })
      return
    }
    const delivery = await provider.send(email)
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO communication_deliveries (
          outbox_event_id, provider, provider_message_id, channel, status, recipient_hash
        ) VALUES (
          ${event.id}, ${provider.name}, ${delivery.providerMessageId}, 'email', 'accepted',
          ${recipientHash}
        ) ON CONFLICT (outbox_event_id) DO NOTHING
      `
      await transaction`
        UPDATE outbox_events
        SET status = 'completed', completed_at = now(), locked_at = NULL, locked_by = NULL,
            last_error_code = NULL, last_error_message = NULL
        WHERE id = ${event.id} AND locked_by = ${workerId}
      `
    })
  } catch (error) {
    const terminal = event.attempts >= 10
    const delaySeconds = Math.min(2 ** event.attempts * 30, 3600)
    await sql`
      UPDATE outbox_events
      SET status = ${terminal ? 'dead' : 'retry'}, available_at = now() + (${delaySeconds} * interval '1 second'),
          locked_at = NULL, locked_by = NULL, last_error_code = 'email_delivery_failed',
          last_error_message = ${error instanceof Error ? error.message.slice(0, 500) : 'unknown'}
      WHERE id = ${event.id} AND locked_by = ${workerId}
    `
    if (terminal) process.exitCode = 1
  }
}

try {
  const once = process.argv.includes('--once')
  do {
    const event = await claim()
    if (!event) break
    await processOne(event)
  } while (!once)
} finally {
  await sql.end({ timeout: 5 })
}
