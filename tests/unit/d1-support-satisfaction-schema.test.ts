import { describe, expect, it } from 'vitest'
import {
  adminSatisfactionQuerySchema,
  satisfactionInputSchema,
  satisfactionIntentHash,
  satisfactionReceiptSchema
} from '../../shared/support-satisfaction'
import { deterministicUuid } from '../fixtures/deterministic'
describe('SUP010 bounded private contracts', () => {
  const body = {
    score: 5,
    comment: ' Texto privado ',
    privacyAcknowledged: true,
    expectedSourceVersion: 2,
    expectedPolicyHash: 'a'.repeat(64)
  }
  it('requires deliberate privacy acknowledgement and rejects unknown properties', () => {
    expect(satisfactionInputSchema.parse(body).comment).toBe('Texto privado')
    for (const value of [
      { ...body, score: 0 },
      { ...body, score: 6 },
      { ...body, privacyAcknowledged: false },
      { ...body, comment: 'x'.repeat(1001) },
      { ...body, email: 'secret@example.test' }
    ])
      expect(satisfactionInputSchema.safeParse(value).success).toBe(false)
  })
  it('normalizes the canonical private intent without exposing its text', async () => {
    const id = 'SOP-' + 'A'.repeat(24)
    const hash = await satisfactionIntentHash('support', id, body)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(await satisfactionIntentHash('support', id, { ...body, comment: body.comment.trim() })).toBe(hash)
    expect(await satisfactionIntentHash('support', id, { ...body, score: 4 })).not.toBe(hash)
  })
  it('keeps comments opt-in and bounded administrative pages', () => {
    expect(adminSatisfactionQuerySchema.parse({}).comments).toBe(false)
    expect(adminSatisfactionQuerySchema.parse({ comments: 'false' }).comments).toBe(false)
    expect(adminSatisfactionQuerySchema.safeParse({ perPage: '26' }).success).toBe(false)
  })
  it('rejects comment/PII in command receipts', () => {
    expect(
      satisfactionReceiptSchema.safeParse({
        source: 'cloudflare',
        commandId: deterministicUuid('csat'),
        target: { kind: 'support', id: 'SOP-' + 'A'.repeat(24), version: 2 },
        payloadHash: 'a'.repeat(64),
        score: 5,
        submittedAt: '2026-10-09T12:00:00Z',
        inventoryEffect: 'none',
        economicEffect: 'none',
        comment: 'private'
      }).success
    ).toBe(false)
  })
})
