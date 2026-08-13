import { describe, expect, it } from 'vitest'
import {
  renderTransactionalEmail,
  transactionalEmailEventTypes,
  type TransactionalEmailEvent,
  type TransactionalEmailEventType
} from '../../server/services/transactional-email'
import { encryptSecret } from '../../server/utils/secrets'

const encryptionKey = Buffer.alloc(32, 7).toString('base64')
const config = { baseUrl: 'https://shop.neteco.test', encryptionKey }
const tokenEnvelope = encryptSecret('public-action-token', encryptionKey)

function event(eventType: TransactionalEmailEventType): TransactionalEmailEvent {
  return {
    id: `event-${eventType}`,
    eventType,
    payload: {
      recipient: 'customer@integration.invalid',
      locale: 'es-ES',
      name: 'Cliente de prueba',
      tokenEnvelope,
      expiresAt: '2026-08-20T12:00:00.000Z',
      orderId: '9c355bf4-a8ea-4a20-ad22-5a1fc6b2c735',
      orderNumber: 'NE-2026-0001',
      totalCents: 12_345,
      statusLabel: 'en preparación',
      trackingNumber: 'TRACK-0001',
      refundCents: 2_500,
      returnNumber: 'DEV-2026-0001',
      ticketNumber: 'SUP-2026-0001',
      replyBody: 'Primera línea\nSegunda línea',
      invoiceId: '5758944b-b17a-4412-8186-31d9472c3b34',
      code: 'F-2026-0001',
      unsubscribeTokenEnvelope: tokenEnvelope,
      unsubscribeExpiresAt: '2027-08-13T12:00:00.000Z'
    }
  }
}

describe('transactional email matrix', () => {
  it.each(transactionalEmailEventTypes)('renders %s in HTML and plain text with stable delivery data', (eventType) => {
    const rendered = renderTransactionalEmail(event(eventType), config)
    expect(rendered.messageId).toBe(`event-${eventType}`)
    expect(rendered.to).toBe('customer@integration.invalid')
    expect(rendered.subject.trim()).not.toBe('')
    expect(rendered.html.trim()).not.toBe('')
    expect(rendered.text.trim()).not.toBe('')
    expect(rendered.text).not.toMatch(/<\/?(?:p|strong|a|h1|br)\b/i)
  })

  it('keeps links actionable in HTML and plain text without leaking encrypted envelopes', () => {
    for (const eventType of [
      'identity.verification.requested',
      'identity.password_reset.requested',
      'identity.email_change.requested',
      'order.created',
      'order.confirmed',
      'invoice.issued',
      'newsletter.confirmation.requested',
      'newsletter.welcome'
    ] as const) {
      const rendered = renderTransactionalEmail(event(eventType), config)
      expect(rendered.html).toContain('https://shop.neteco.test')
      expect(rendered.text).toContain('https://shop.neteco.test')
      expect(rendered.html).not.toContain(tokenEnvelope)
      expect(rendered.text).not.toContain(tokenEnvelope)
    }
  })

  it('escapes every dynamic body field and preserves readable support line breaks', () => {
    const hostile = '<img src=x onerror="globalThis.pwned=true">&\''
    const status = event('order.shipped')
    status.payload.name = hostile
    status.payload.orderNumber = hostile
    status.payload.statusLabel = hostile
    status.payload.trackingNumber = hostile
    const renderedStatus = renderTransactionalEmail(status, config)
    expect(renderedStatus.html).not.toContain('<img')
    expect(renderedStatus.html).toContain('&lt;img')

    const support = event('support.ticket.reply')
    support.payload.name = hostile
    support.payload.ticketNumber = hostile
    support.payload.replyBody = `${hostile}\nsegunda línea`
    const renderedSupport = renderTransactionalEmail(support, config)
    expect(renderedSupport.html).not.toContain('<img')
    expect(renderedSupport.html).toContain('&lt;img')
    expect(renderedSupport.html).toContain('<br>segunda línea')
    expect(renderedSupport.text).toContain('\nsegunda línea')

    const returned = event('return.status.updated')
    returned.payload.name = hostile
    returned.payload.orderNumber = hostile
    returned.payload.returnNumber = hostile
    returned.payload.statusLabel = hostile
    expect(renderTransactionalEmail(returned, config).html).not.toContain('<img')
  })

  it('supports Spanish only for Alpha and rejects unknown events or incomplete payloads', () => {
    const unsupportedLocale = event('order.created')
    unsupportedLocale.payload.locale = 'en-GB'
    expect(() => renderTransactionalEmail(unsupportedLocale, config)).toThrow('Unsupported email locale')
    expect(() =>
      renderTransactionalEmail(
        { id: 'unknown', eventType: 'unknown.event', payload: { recipient: 'customer@integration.invalid' } },
        config
      )
    ).toThrow('Unsupported transactional email event')
    expect(() =>
      renderTransactionalEmail(
        { id: 'incomplete', eventType: 'order.created', payload: { recipient: 'customer@integration.invalid' } },
        config
      )
    ).toThrow('payload is incomplete')
  })
})
