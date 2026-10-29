import { NewsletterEditorialError } from './newsletter-editorial-core'

export interface NewsletterEditorialMessage {
  deliveryId: string
  to: string
  from: string
  subject: string
  html: string
  text: string
  headers: { 'List-Unsubscribe': string }
}
export interface NewsletterEmailServiceBinding {
  send(message: {
    to: string
    from: string
    subject: string
    html: string
    text: string
    headers?: Record<string, string>
  }): Promise<{ messageId: string }>
}
export interface NewsletterEditorialSender {
  kind: 'local-fake' | 'cloudflare-email'
  send(message: NewsletterEditorialMessage): Promise<{ messageId: string }>
}
export interface NewsletterEditorialTransport {
  mode: 'disabled' | 'local-fake' | 'cloudflare-email'
  environment: 'local' | 'preprod' | 'production'
  /** Explicit server authority, never request JSON or campaign approval. */
  externalEnabled?: boolean
  from?: string
  allowedRecipients?: readonly string[]
  senderFactory?: () => NewsletterEditorialSender | undefined
}
/** Worker-compatible real port. Construction performs no I/O and needs no API key.
 * Root supplies the dedicated newsletter binding; never the transactional sender. */
export function createNewsletterEmailServiceAdapter(binding: NewsletterEmailServiceBinding): NewsletterEditorialSender {
  return {
    kind: 'cloudflare-email',
    send: (message) =>
      binding.send({
        to: message.to,
        from: message.from,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: message.headers
      })
  }
}
export function editorialMailbox(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 254 &&
    /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) &&
    !value.includes('..') &&
    !/[\s\r\n]/.test(value)
  )
}
export function transportReady(transport: NewsletterEditorialTransport | undefined, publicOrigin: string) {
  if (!transport || transport.mode === 'disabled' || !editorialMailbox(transport.from) || !transport.senderFactory)
    return false
  if (!['local', 'preprod', 'production'].includes(transport.environment)) return false
  try {
    const origin = new URL(publicOrigin)
    if (origin.protocol !== 'https:' || origin.origin !== publicOrigin) return false
    const synthetic = origin.hostname.endsWith('.test') || origin.hostname.endsWith('.invalid')
    if (transport.mode === 'local-fake')
      return (
        transport.environment === 'local' &&
        synthetic &&
        transport.externalEnabled !== true &&
        /\.(test|invalid)$/i.test(transport.from!)
      )
    return (
      transport.mode === 'cloudflare-email' &&
      transport.externalEnabled === true &&
      transport.environment !== 'local' &&
      !synthetic &&
      !/\.(test|invalid)$/i.test(transport.from!) &&
      origin.hostname !== 'localhost' &&
      !origin.hostname.endsWith('.localhost') &&
      !/^\d+(?:\.\d+){3}$/.test(origin.hostname) &&
      !origin.hostname.includes(':') &&
      (transport.environment === 'production' ||
        (!!transport.allowedRecipients?.length && transport.allowedRecipients.every(editorialMailbox)))
    )
  } catch {
    return false
  }
}
export function transportRecipientAllowed(transport: NewsletterEditorialTransport, email: string) {
  if (!editorialMailbox(email)) return false
  if (transport.mode === 'local-fake') return /\.(?:test|invalid)$/i.test(email)
  return (
    transport.mode === 'cloudflare-email' &&
    (transport.environment === 'production' || transport.allowedRecipients?.includes(email) === true)
  )
}
export function resolveEditorialSender(transport: NewsletterEditorialTransport, origin: string) {
  if (!transportReady(transport, origin)) throw new NewsletterEditorialError('delivery_disabled')
  const sender = transport.senderFactory?.()
  if (!sender || sender.kind !== transport.mode || typeof sender.send !== 'function')
    throw new NewsletterEditorialError('sender_unavailable')
  return sender
}
