import type { TransactionalEmail } from '../integrations/email-provider'
import { decryptSecret } from '../utils/secrets'
import { renderInvoiceEmail } from './invoice-email'
import { renderNewsletterEmail } from './newsletter-email'

export const transactionalEmailEventTypes = [
  'identity.verification.requested',
  'identity.password_reset.requested',
  'identity.email_change.requested',
  'identity.security.password_changed',
  'identity.security.email_changed',
  'order.created',
  'order.confirmed',
  'order.status.updated',
  'order.cancelled',
  'order.cancellation.requested',
  'order.reservation.expired',
  'order.shipped',
  'order.delivered',
  'refund.succeeded.email',
  'return.requested',
  'return.status.updated',
  'support.ticket.received',
  'support.ticket.reply',
  'invoice.issued',
  'newsletter.confirmation.requested',
  'newsletter.welcome'
] as const

export type TransactionalEmailEventType = (typeof transactionalEmailEventTypes)[number]

export interface TransactionalEmailEvent {
  id: string
  eventType: string
  payload: {
    recipient: string
    locale?: string
    orderId?: string
    name?: string
    tokenEnvelope?: string
    expiresAt?: string
    occurredAt?: string
    orderNumber?: string
    returnNumber?: string
    totalCents?: number
    ticketNumber?: string
    replyBody?: string
    statusLabel?: string
    trackingNumber?: string
    refundCents?: number
    invoiceId?: string
    code?: string
    policyVersion?: string
    unsubscribeTokenEnvelope?: string
    unsubscribeExpiresAt?: string
  }
}

interface EmailRenderConfig {
  baseUrl: string
  encryptionKey: string
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function assertSupportedLocale(event: TransactionalEmailEvent) {
  const locale = event.payload.locale ?? 'es-ES'
  if (locale !== 'es-ES') throw new Error(`Unsupported email locale: ${locale}`)
  return locale
}

export function renderTransactionalEmail(
  event: TransactionalEmailEvent,
  config: EmailRenderConfig
): TransactionalEmail {
  const locale = assertSupportedLocale(event)
  const invoiceEmail = renderInvoiceEmail(event, config)
  if (invoiceEmail) return invoiceEmail
  const newsletterEmail = renderNewsletterEmail(event, config)
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
    const total = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(
      event.payload.totalCents / 100
    )
    const link = new URL(`/pedido/${encodeURIComponent(event.payload.orderNumber)}`, config.baseUrl)
    if (event.payload.tokenEnvelope) {
      link.searchParams.set('token', decryptSecret(event.payload.tokenEnvelope, config.encryptionKey))
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
      'order.reservation.expired',
      'order.shipped',
      'order.delivered'
    ].includes(event.eventType)
  ) {
    if (!event.payload.orderNumber) throw new Error('Order status email is incomplete')
    const status =
      event.eventType === 'order.reservation.expired'
        ? 'cancelado porque caducó la reserva de stock'
        : event.payload.statusLabel
    if (!status) throw new Error('Order status email is incomplete')
    const tracking = event.payload.trackingNumber ? `\nSeguimiento: ${event.payload.trackingNumber}` : ''
    const safeOrderNumber = escapeHtml(event.payload.orderNumber)
    const safeStatus = escapeHtml(status)
    const safeTrackingNumber = event.payload.trackingNumber ? escapeHtml(event.payload.trackingNumber) : ''
    return {
      messageId: event.id,
      to: event.payload.recipient,
      subject: `${status} · pedido ${event.payload.orderNumber}`,
      text: `${displayName}: el pedido ${event.payload.orderNumber} está ${status}.${tracking}`,
      html: `<p>${safeName}:</p><p>El pedido <strong>${safeOrderNumber}</strong> está <strong>${safeStatus}</strong>.</p>${safeTrackingNumber ? `<p>Seguimiento: <strong>${safeTrackingNumber}</strong></p>` : ''}`
    }
  }
  if (event.eventType === 'refund.succeeded.email') {
    if (!event.payload.orderNumber || event.payload.refundCents === undefined) {
      throw new Error('Refund email payload is incomplete')
    }
    const total = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(
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
  if (event.eventType === 'return.requested' || event.eventType === 'return.status.updated') {
    if (!event.payload.orderNumber || !event.payload.returnNumber) {
      throw new Error('Return email payload is incomplete')
    }
    const status = event.eventType === 'return.requested' ? 'solicitada' : event.payload.statusLabel
    if (!status) throw new Error('Return status email payload is incomplete')
    const safeOrderNumber = escapeHtml(event.payload.orderNumber)
    const safeReturnNumber = escapeHtml(event.payload.returnNumber)
    const safeStatus = escapeHtml(status)
    return {
      messageId: event.id,
      to: event.payload.recipient,
      subject: `Devolución ${status} · ${event.payload.returnNumber}`,
      text: `${displayName}: la devolución ${event.payload.returnNumber} del pedido ${event.payload.orderNumber} está ${status}.`,
      html: `<p>${safeName}:</p><p>La devolución <strong>${safeReturnNumber}</strong> del pedido <strong>${safeOrderNumber}</strong> está <strong>${safeStatus}</strong>.</p>`
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
  if (
    ![
      'identity.verification.requested',
      'identity.password_reset.requested',
      'identity.email_change.requested'
    ].includes(event.eventType)
  ) {
    throw new Error(`Unsupported transactional email event: ${event.eventType}`)
  }
  if (!event.payload.tokenEnvelope || !event.payload.expiresAt) throw new Error('Email token payload is incomplete')
  const token = decryptSecret(event.payload.tokenEnvelope, config.encryptionKey)
  const verification = event.eventType === 'identity.verification.requested'
  const emailChange = event.eventType === 'identity.email_change.requested'
  const path = verification || emailChange ? '/verificar-email' : '/restablecer-clave'
  const link = new URL(path, config.baseUrl)
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
  const safeExpiry = escapeHtml(event.payload.expiresAt)
  return {
    messageId: event.id,
    to: event.payload.recipient,
    subject,
    text: `${displayName}: usa este enlace para ${action}: ${link.toString()}\nCaduca: ${event.payload.expiresAt}`,
    html: `<p>${safeName}:</p><p><a href="${safeLink}">Pulsa aquí para ${action}</a>.</p><p>Caduca: ${safeExpiry}</p>`
  }
}
