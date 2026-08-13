import { describe, expect, it } from 'vitest'
import { signWebhookPayload, verifyWebhookSignature } from '../../server/utils/webhook-signature'

describe('webhook signatures', () => {
  it('accepts only an exact HMAC-SHA256 signature', () => {
    const body = '{"event":"delivered"}'
    const secret = 'webhook-secret-with-enough-entropy'
    const signature = signWebhookPayload(body, secret)
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/)
    expect(verifyWebhookSignature(body, signature, secret)).toBe(true)
    expect(verifyWebhookSignature(`${body} `, signature, secret)).toBe(false)
    expect(verifyWebhookSignature(body, 'sha256=00', secret)).toBe(false)
    expect(verifyWebhookSignature(body, 'invalid', secret)).toBe(false)
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false)
  })
})
