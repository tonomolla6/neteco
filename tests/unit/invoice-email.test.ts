import { describe, expect, it } from 'vitest'
import { renderInvoiceEmail } from '../../server/services/invoice-email'
import { encryptSecret } from '../../server/utils/secrets'

const encryptionKey = Buffer.alloc(32, 5).toString('base64')

describe('invoice email rendering', () => {
  it('renders a short-lived PDF link without leaking the encrypted envelope', () => {
    const envelope = encryptSecret('invoice-access-token', encryptionKey)
    const email = renderInvoiceEmail(
      {
        id: 'invoice-event',
        eventType: 'invoice.issued',
        payload: {
          recipient: 'customer@example.test',
          name: '<img src=x onerror="globalThis.pwned=true">&Cliente',
          invoiceId: 'f3b554c0-5a9a-4f60-b6fe-625ad0e14b23',
          orderNumber: 'NE12345',
          code: 'F-2026-001',
          tokenEnvelope: envelope,
          expiresAt: '2026-08-20T00:00:00.000Z'
        }
      },
      { baseUrl: 'https://shop.neteco.test', encryptionKey }
    )
    expect(email?.text).toContain(
      '/api/orders/NE12345/invoice?document=f3b554c0-5a9a-4f60-b6fe-625ad0e14b23&token=invoice-access-token'
    )
    expect(email?.text).not.toContain(envelope)
    expect(email?.html).toContain('&lt;img src=x onerror=&quot;globalThis.pwned=true&quot;&gt;&amp;Cliente')
    expect(email?.html).not.toContain('<img')
    expect(email?.subject).toBe('Factura F-2026-001 · pedido NE12345')
  })

  it('ignores unrelated events and rejects an incomplete invoice event', () => {
    const config = { baseUrl: 'https://shop.neteco.test', encryptionKey }
    expect(
      renderInvoiceEmail(
        { id: 'order-event', eventType: 'order.created', payload: { recipient: 'customer@example.test' } },
        config
      )
    ).toBeNull()
    expect(() =>
      renderInvoiceEmail(
        { id: 'invoice-event', eventType: 'invoice.issued', payload: { recipient: 'customer@example.test' } },
        config
      )
    ).toThrow('payload is incomplete')
  })
})
