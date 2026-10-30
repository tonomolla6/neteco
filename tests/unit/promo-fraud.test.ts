import { describe, expect, it } from 'vitest'
import {
  PROMO_FRAUD_LIMITS,
  PROMO_FRAUD_WEIGHTS,
  appealInputSchema,
  assessInputSchema,
  caseDecisionInputSchema,
  evaluatePromoFraud,
  isPromoBenefitBlocked,
  normalizePromoSignal
} from '../../shared/promo-fraud'

const none = { identity: 0, address: 0, device: 0, payment: 0 }

describe('SEC-036 evaluatePromoFraud', () => {
  it('clears when no signal exceeds its limit', () => {
    const result = evaluatePromoFraud({
      identity: PROMO_FRAUD_LIMITS.identity,
      address: PROMO_FRAUD_LIMITS.address,
      device: PROMO_FRAUD_LIMITS.device,
      payment: PROMO_FRAUD_LIMITS.payment
    })
    expect(result).toEqual({ decision: 'clear', score: 0, exceededKinds: [] })
  })
  it('never holds on a single signal, whatever its size', () => {
    for (const kind of ['identity', 'address', 'device', 'payment'] as const) {
      const result = evaluatePromoFraud({ ...none, [kind]: 10_000 })
      expect(result.decision).toBe('review')
      expect(result.exceededKinds).toEqual([kind])
      expect(result.score).toBe(PROMO_FRAUD_WEIGHTS[kind])
    }
  })
  it('holds when at least two independent kinds exceed their limits', () => {
    const result = evaluatePromoFraud({
      ...none,
      identity: PROMO_FRAUD_LIMITS.identity + 1,
      payment: PROMO_FRAUD_LIMITS.payment + 1
    })
    expect(result.decision).toBe('hold')
    expect(result.exceededKinds).toEqual(['identity', 'payment'])
    expect(result.score).toBe(PROMO_FRAUD_WEIGHTS.identity + PROMO_FRAUD_WEIGHTS.payment)
  })
  it('keeps the score within 0..100 and lists kinds in a stable order', () => {
    const all = evaluatePromoFraud({ identity: 99, address: 99, device: 99, payment: 99 })
    expect(all.score).toBe(100)
    expect(all.exceededKinds).toEqual(['identity', 'address', 'device', 'payment'])
  })
  it('is exactly at-limit tolerant: limit+1 is the first exceeded value', () => {
    expect(evaluatePromoFraud({ ...none, device: PROMO_FRAUD_LIMITS.device }).decision).toBe('clear')
    expect(evaluatePromoFraud({ ...none, device: PROMO_FRAUD_LIMITS.device + 1 }).decision).toBe('review')
  })
  it('treats a missing signal as zero sharing', () => {
    expect(evaluatePromoFraud({}).decision).toBe('clear')
  })
})

describe('SEC-036 isPromoBenefitBlocked', () => {
  it.each([
    ['clear', 'closed', false],
    ['review', 'open', false],
    ['review', 'released', false],
    ['review', 'upheld', true],
    ['hold', 'open', true],
    ['hold', 'appealed', true],
    ['hold', 'released', false],
    ['hold', 'upheld', true],
    ['hold', 'appeal_accepted', false],
    ['hold', 'appeal_rejected', true],
    ['review', 'appeal_accepted', false],
    ['review', 'appeal_rejected', true]
  ] as const)('%s / %s => blocked=%s', (decision, status, blocked) => {
    expect(isPromoBenefitBlocked(decision, status)).toBe(blocked)
  })
})

describe('SEC-036 normalizePromoSignal', () => {
  it('normalises identity and address so cosmetic differences still match', () => {
    expect(normalizePromoSignal('identity', '  Ana.Pérez+promo@Example.COM ')).toBe(
      normalizePromoSignal('identity', 'ana.perez@example.com')
    )
    expect(normalizePromoSignal('address', 'Calle  Mayor 1,  46870 ONTINYENT')).toBe(
      normalizePromoSignal('address', 'calle mayor 1, 46870 ontinyent')
    )
  })
  it('keeps device and payment tokens verbatim apart from trimming', () => {
    expect(normalizePromoSignal('device', ' Abc-123 ')).toBe('Abc-123')
    expect(normalizePromoSignal('payment', 'tok_ABC')).not.toBe(normalizePromoSignal('payment', 'tok_abc'))
  })
})

describe('SEC-036 input schemas', () => {
  const base = {
    commandId: '10000000-0000-4000-8000-000000000001',
    context: 'referral',
    refId: 'attr-1',
    customerId: 'cust-1',
    signals: { device: 'dev-1' }
  }
  it('accepts a valid assessment and rejects unknown keys, empty signals and bad ids', () => {
    expect(assessInputSchema.safeParse(base).success).toBe(true)
    expect(assessInputSchema.safeParse({ ...base, signals: {} }).success).toBe(false)
    expect(assessInputSchema.safeParse({ ...base, signals: { cookie: 'x' } }).success).toBe(false)
    expect(assessInputSchema.safeParse({ ...base, decision: 'clear' }).success).toBe(false)
    expect(assessInputSchema.safeParse({ ...base, refId: 'bad id!' }).success).toBe(false)
    expect(assessInputSchema.safeParse({ ...base, context: 'other' }).success).toBe(false)
    expect(assessInputSchema.safeParse({ ...base, signals: { device: '' } }).success).toBe(false)
    expect(assessInputSchema.safeParse({ ...base, signals: { device: 'x'.repeat(301) } }).success).toBe(false)
  })
  it('validates decisions and appeals strictly', () => {
    expect(
      caseDecisionInputSchema.safeParse({ expectedVersion: 1, outcome: 'release', note: 'revisado' }).success
    ).toBe(true)
    expect(
      caseDecisionInputSchema.safeParse({ expectedVersion: 0, outcome: 'release', note: 'revisado' }).success
    ).toBe(false)
    expect(caseDecisionInputSchema.safeParse({ expectedVersion: 1, outcome: 'ban', note: 'revisado' }).success).toBe(
      false
    )
    expect(caseDecisionInputSchema.safeParse({ expectedVersion: 1, outcome: 'uphold', note: 'x' }).success).toBe(false)
    expect(appealInputSchema.safeParse({ caseVersion: 1, statement: 'Somos dos hermanos en casa.' }).success).toBe(true)
    expect(appealInputSchema.safeParse({ caseVersion: 1, statement: 'corto' }).success).toBe(false)
    expect(
      appealInputSchema.safeParse({ caseVersion: 1, statement: 'Somos dos hermanos.', customerId: 'x' }).success
    ).toBe(false)
  })
})
