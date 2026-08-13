import type { TransactionalEmail } from '../integrations/email-provider'
import { decryptSecret } from '../utils/secrets'

interface InvoiceEmailEvent {
  id: string
  eventType: string
  payload: {
    recipient: string
    name?: string
    invoiceId?: string
    orderNumber?: string
    code?: string
    tokenEnvelope?: string
    expiresAt?: string
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

export function renderInvoiceEmail(
  event: InvoiceEmailEvent,
  config: { baseUrl: string; encryptionKey: string }
): TransactionalEmail | null {
  if (event.eventType !== 'invoice.issued') return null
  const { invoiceId, orderNumber, code, tokenEnvelope, expiresAt } = event.payload
  if (!invoiceId || !orderNumber || !code || !tokenEnvelope || !expiresAt) {
    throw new Error('Invoice email payload is incomplete')
  }
  const token = decryptSecret(tokenEnvelope, config.encryptionKey)
  const link = new URL(`/api/orders/${encodeURIComponent(orderNumber)}/invoice`, config.baseUrl)
  link.searchParams.set('document', invoiceId)
  link.searchParams.set('token', token)
  const displayName = event.payload.name?.trim() || 'Hola'
  const safeName = escapeHtml(displayName)
  const safeCode = escapeHtml(code)
  const safeOrderNumber = escapeHtml(orderNumber)
  const safeLink = escapeHtml(link.toString())
  return {
    messageId: event.id,
    to: event.payload.recipient,
    subject: `Factura ${code} · pedido ${orderNumber}`,
    text: `${displayName}: tu factura ${code} del pedido ${orderNumber} ya está disponible.\nDescargar PDF: ${link.toString()}\nEl enlace caduca: ${expiresAt}`,
    html: `<p>${safeName}:</p><p>Tu factura <strong>${safeCode}</strong> del pedido <strong>${safeOrderNumber}</strong> ya está disponible.</p><p><a href="${safeLink}">Descargar la factura en PDF</a></p><p>El enlace caduca en 7 días.</p>`
  }
}
