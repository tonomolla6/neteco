import { createHmac, timingSafeEqual } from 'node:crypto'

export function signWebhookPayload(payload: string, secret: string) {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`
}

export function verifyWebhookSignature(payload: string, signature: string | undefined, secret: string) {
  if (!signature?.startsWith('sha256=')) return false
  const actual = Buffer.from(signature.slice(7), 'hex')
  const expected = Buffer.from(signWebhookPayload(payload, secret).slice(7), 'hex')
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
}
