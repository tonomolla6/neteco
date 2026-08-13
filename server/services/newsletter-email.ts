import type { TransactionalEmail } from '../integrations/email-provider'
import { decryptSecret } from '../utils/secrets'

interface NewsletterEmailEvent {
  id: string
  eventType: string
  payload: {
    recipient: string
    tokenEnvelope?: string
    expiresAt?: string
    unsubscribeTokenEnvelope?: string
    unsubscribeExpiresAt?: string
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export function renderNewsletterEmail(
  event: NewsletterEmailEvent,
  config: { baseUrl: string; encryptionKey: string }
): TransactionalEmail | null {
  if (event.eventType === 'newsletter.confirmation.requested') {
    if (!event.payload.tokenEnvelope || !event.payload.expiresAt) {
      throw new Error('Newsletter confirmation payload is incomplete')
    }
    const link = new URL('/newsletter/confirmar', config.baseUrl)
    link.searchParams.set('token', decryptSecret(event.payload.tokenEnvelope, config.encryptionKey))
    const safeLink = escapeHtml(link.toString())
    return {
      messageId: event.id,
      to: event.payload.recipient,
      subject: 'Confirma tu suscripción a la newsletter de NETECO',
      text: `Confirma que quieres recibir novedades de NETECO: ${link.toString()}\nEl enlace caduca: ${event.payload.expiresAt}`,
      html: `<h1>Confirma tu suscripción</h1><p>Solo recibirás novedades comerciales si confirmas esta solicitud.</p><p><a href="${safeLink}">Confirmar la newsletter</a></p><p>El enlace caduca en 48 horas. Si no lo solicitaste, ignora este mensaje.</p>`
    }
  }
  if (event.eventType !== 'newsletter.welcome') return null
  if (!event.payload.unsubscribeTokenEnvelope || !event.payload.unsubscribeExpiresAt) {
    throw new Error('Newsletter welcome payload is incomplete')
  }
  const unsubscribe = new URL('/newsletter/baja', config.baseUrl)
  unsubscribe.searchParams.set('token', decryptSecret(event.payload.unsubscribeTokenEnvelope, config.encryptionKey))
  const safeUnsubscribe = escapeHtml(unsubscribe.toString())
  return {
    messageId: event.id,
    to: event.payload.recipient,
    subject: 'Tu suscripción a NETECO está confirmada',
    text: `Tu suscripción está confirmada. Recibirás novedades y contenidos comerciales de NETECO.\nDarte de baja: ${unsubscribe.toString()}`,
    html: `<h1>Suscripción confirmada</h1><p>Recibirás novedades y contenidos comerciales de NETECO.</p><p><a href="${safeUnsubscribe}">Darme de baja de la newsletter</a></p>`,
    headers: { 'List-Unsubscribe': `<${unsubscribe.toString()}>` }
  }
}
