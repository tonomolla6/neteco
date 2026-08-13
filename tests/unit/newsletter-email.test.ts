import { describe, expect, it } from 'vitest'
import { renderNewsletterEmail } from '../../server/services/newsletter-email'
import { encryptSecret } from '../../server/utils/secrets'

const encryptionKey = Buffer.alloc(32, 4).toString('base64')
const config = { baseUrl: 'https://shop.neteco.test', encryptionKey }

describe('newsletter email rendering', () => {
  it('renders the double opt-in link from an encrypted token', () => {
    const email = renderNewsletterEmail(
      {
        id: 'event-confirm',
        eventType: 'newsletter.confirmation.requested',
        payload: {
          recipient: 'customer@example.test',
          tokenEnvelope: encryptSecret('confirmation-token', encryptionKey),
          expiresAt: '2026-08-15T00:00:00.000Z'
        }
      },
      config
    )
    expect(email?.text).toContain('/newsletter/confirmar?token=confirmation-token')
    expect(email?.subject).toContain('Confirma')
    expect(email?.headers).toBeUndefined()
  })

  it('renders a public unsubscribe URL in every commercial message', () => {
    const email = renderNewsletterEmail(
      {
        id: 'event-welcome',
        eventType: 'newsletter.welcome',
        payload: {
          recipient: 'customer@example.test',
          unsubscribeTokenEnvelope: encryptSecret('unsubscribe-token', encryptionKey),
          unsubscribeExpiresAt: '2027-08-13T00:00:00.000Z'
        }
      },
      config
    )
    const unsubscribeUrl = 'https://shop.neteco.test/newsletter/baja?token=unsubscribe-token'
    expect(email?.text).toContain(unsubscribeUrl)
    expect(email?.html).toContain('/newsletter/baja?token=unsubscribe-token')
    expect(email?.headers).toEqual({ 'List-Unsubscribe': `<${unsubscribeUrl}>` })
  })

  it('ignores non-newsletter events and rejects incomplete marketing payloads', () => {
    expect(
      renderNewsletterEmail(
        { id: 'event-order', eventType: 'order.created', payload: { recipient: 'customer@example.test' } },
        config
      )
    ).toBeNull()
    expect(() =>
      renderNewsletterEmail(
        { id: 'event-welcome', eventType: 'newsletter.welcome', payload: { recipient: 'customer@example.test' } },
        config
      )
    ).toThrow('payload is incomplete')
  })
})
