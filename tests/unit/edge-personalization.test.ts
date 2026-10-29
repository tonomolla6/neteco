import { describe, expect, it } from 'vitest'
import {
  deriveEdgeSegment,
  evaluatePersonalizationEvidence,
  resolveEdgePersonalization,
  safeResolveEdgePersonalization,
  createRuleSchema,
  recordEvidenceSchema,
  type EdgeEvidenceInput,
  type EdgeRule
} from '../../shared/edge-personalization'

const evidence = (over: Partial<EdgeEvidenceInput> = {}): EdgeEvidenceInput => ({
  controlVisitors: 5000,
  controlConversions: 100,
  treatmentVisitors: 5000,
  treatmentConversions: 150,
  lcpDeltaMs: 10,
  cacheHitRateBps: 9000,
  baselineCacheHitRateBps: 9100,
  ...over
})
const rule = (over: Partial<EdgeRule> = {}): EdgeRule => ({
  slot: 'home_hero',
  segment: 'b2b',
  variantKey: 'bulk_offer',
  status: 'enabled',
  ...over
})

describe('edge personalization evidence gate', () => {
  it('passes with enough sample, significant lift, no LCP/cache regression', () => {
    const r = evaluatePersonalizationEvidence(evidence())
    expect(r.eligible).toBe(true)
    expect(r.reasons).toEqual([])
    expect(r.liftBps).toBeGreaterThan(0)
  })
  it('fails with a small sample', () => {
    const r = evaluatePersonalizationEvidence(evidence({ treatmentVisitors: 300, treatmentConversions: 20 }))
    expect(r.eligible).toBe(false)
    expect(r.reasons).toContain('insufficient_sample')
  })
  it('fails when the lift is not significant', () => {
    const r = evaluatePersonalizationEvidence(evidence({ treatmentConversions: 104 }))
    expect(r.reasons).toContain('not_significant')
  })
  it('fails when the lift is below the minimum relative lift', () => {
    const r = evaluatePersonalizationEvidence(
      evidence({
        controlVisitors: 400000,
        controlConversions: 8000,
        treatmentVisitors: 400000,
        treatmentConversions: 8100
      })
    )
    expect(r.reasons).toContain('lift_below_minimum')
  })
  it('fails when LCP regresses', () => {
    expect(evaluatePersonalizationEvidence(evidence({ lcpDeltaMs: 120 })).reasons).toContain('lcp_regression')
  })
  it('fails when the cache hit rate drops too much (cache must be kept)', () => {
    const r = evaluatePersonalizationEvidence(evidence({ cacheHitRateBps: 7000 }))
    expect(r.reasons).toContain('cache_hit_rate_drop')
    expect(r.eligible).toBe(false)
  })
  it('collects multiple reasons and never passes a negative lift', () => {
    const r = evaluatePersonalizationEvidence(evidence({ treatmentConversions: 60, lcpDeltaMs: 500 }))
    expect(r.eligible).toBe(false)
    expect(r.reasons.length).toBeGreaterThanOrEqual(2)
  })
  it('rejects impossible counts', () => {
    expect(() => evaluatePersonalizationEvidence(evidence({ controlConversions: 9999999 }))).toThrow('invalid_evidence')
  })
})

describe('edge segment and resolution', () => {
  it('derives only three coarse segments, B2B taking priority', () => {
    expect(deriveEdgeSegment({ isB2b: true, returning: true })).toBe('b2b')
    expect(deriveEdgeSegment({ isB2b: false, returning: true })).toBe('b2c_returning')
    expect(deriveEdgeSegment({ isB2b: false, returning: false })).toBe('b2c_new')
  })

  it('personalises with consent, an enabled rule and a matching segment', () => {
    const r = resolveEdgePersonalization({ slot: 'home_hero', segment: 'b2b', consent: true, rules: [rule()] })
    expect(r).toMatchObject({ variant: 'bulk_offer', personalized: true, cacheVariant: 'b2b', reason: 'rule_match' })
  })

  it('falls back deterministically without consent, regardless of rules', () => {
    const r = resolveEdgePersonalization({ slot: 'home_hero', segment: 'b2b', consent: false, rules: [rule()] })
    expect(r).toMatchObject({ variant: 'default', personalized: false, cacheVariant: 'default', reason: 'no_consent' })
  })

  it('falls back for disabled/draft rules, other slots, other segments and the kill switch', () => {
    const base = { slot: 'home_hero', segment: 'b2b' as const, consent: true }
    expect(resolveEdgePersonalization({ ...base, rules: [rule({ status: 'disabled' })] }).reason).toBe('no_rule')
    expect(resolveEdgePersonalization({ ...base, rules: [rule({ status: 'draft' })] }).reason).toBe('no_rule')
    expect(resolveEdgePersonalization({ ...base, rules: [rule({ slot: 'other' })] }).reason).toBe('no_rule')
    expect(resolveEdgePersonalization({ ...base, rules: [rule({ segment: 'b2c_new' })] }).reason).toBe('no_rule')
    const killed = resolveEdgePersonalization({ ...base, rules: [rule()], killSwitch: true })
    expect(killed).toMatchObject({ variant: 'default', reason: 'kill_switch' })
  })

  it('honours a custom default variant', () => {
    const r = resolveEdgePersonalization({
      slot: 's',
      segment: 'b2b',
      consent: false,
      rules: [],
      defaultVariant: 'base'
    })
    expect(r.variant).toBe('base')
  })

  it('bounds cache variants to the segment set', () => {
    const segs = ['b2b', 'b2c_new', 'b2c_returning'] as const
    const variants = new Set(
      segs.map(
        (segment) =>
          resolveEdgePersonalization({
            slot: 'home_hero',
            segment,
            consent: true,
            rules: segs.map((s) => rule({ segment: s, variantKey: `v_${s}` }))
          }).cacheVariant
      )
    )
    expect(variants.size).toBe(3)
  })

  it('is a pure function: same input, same output', () => {
    const input = { slot: 'home_hero', segment: 'b2b' as const, consent: true, rules: [rule()] }
    expect(resolveEdgePersonalization(input)).toEqual(resolveEdgePersonalization(input))
  })

  it('safe resolver degrades to the fallback when resolution throws', () => {
    const poison = { slot: 'home_hero', segment: 'b2b', consent: true, rules: null } as never
    expect(safeResolveEdgePersonalization(poison)).toMatchObject({
      variant: 'default',
      personalized: false,
      reason: 'error_fallback'
    })
  })
})

describe('edge personalization schemas', () => {
  const base = { commandId: '30000000-0000-4000-8000-000000000001', idempotencyKey: 'k' }
  it('validates rule creation', () => {
    const ok = { ...base, slot: 'home_hero', segment: 'b2b', variantKey: 'bulk_offer' }
    expect(createRuleSchema.safeParse(ok).success).toBe(true)
    expect(createRuleSchema.safeParse({ ...ok, segment: 'vip_by_email' }).success).toBe(false)
    expect(createRuleSchema.safeParse({ ...ok, slot: 'Home Hero' }).success).toBe(false)
    expect(createRuleSchema.safeParse({ ...ok, variantKey: 'default' }).success).toBe(false)
  })
  it('validates evidence', () => {
    const ok = { ...base, ruleId: '30000000-0000-4000-8000-000000000002', ...evidence() }
    expect(recordEvidenceSchema.safeParse(ok).success).toBe(true)
    expect(recordEvidenceSchema.safeParse({ ...ok, cacheHitRateBps: 10001 }).success).toBe(false)
    expect(recordEvidenceSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false)
  })
})
