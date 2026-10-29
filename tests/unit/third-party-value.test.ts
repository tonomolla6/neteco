import { describe, expect, it } from 'vitest'
import {
  evaluateThirdPartyExperiment,
  recordExperimentSchema,
  registerScriptSchema,
  type ThirdPartyExperimentInput
} from '../../shared/third-party-value'

const arm = (visitors: number, conversions: number, revenueCents: number, lcp: number) => ({
  visitors,
  conversions,
  revenueCents,
  lcpMsP75: lcp
})
function input(over: Partial<ThirdPartyExperimentInput> = {}): ThirdPartyExperimentInput {
  return {
    periodDays: 14,
    marginBps: 3000,
    monthlyCostCents: 5000,
    control: arm(10000, 200, 2_000_000, 2400),
    treatment: arm(10000, 200, 2_000_000, 2450),
    ...over
  }
}

describe('third-party value evaluation', () => {
  it('is inconclusive below the minimum sample per arm', () => {
    const r = evaluateThirdPartyExperiment(input({ treatment: arm(500, 20, 100_000, 2400) }))
    expect(r.verdict).toBe('inconclusive')
    expect(r.reasons).toContain('insufficient_sample')
  })

  it('recommends removal when there is no return and a cost', () => {
    const r = evaluateThirdPartyExperiment(input())
    expect(r.verdict).toBe('remove')
    expect(r.reasons).toContain('negative_roi')
    expect(r.incrementalProfitMonthlyCents).toBeLessThan(0)
  })

  it('recommends removal even for a free script that adds no value', () => {
    expect(evaluateThirdPartyExperiment(input({ monthlyCostCents: 0 })).verdict).toBe('remove')
  })

  it('keeps a script with significant positive profit', () => {
    const r = evaluateThirdPartyExperiment(input({ treatment: arm(10000, 300, 3_100_000, 2450) }))
    expect(r.verdict).toBe('keep')
    expect(r.significant).toBe(true)
    expect(r.incrementalProfitMonthlyCents).toBeGreaterThan(0)
    expect(r.conversionLiftBps).toBeGreaterThan(0)
  })

  it('is inconclusive when profit is positive but not significant', () => {
    const r = evaluateThirdPartyExperiment(input({ treatment: arm(10000, 206, 2_080_000, 2400) }))
    expect(r.verdict).toBe('inconclusive')
    expect(r.reasons).toContain('not_significant')
  })

  it('removes a not-proven script that regresses LCP beyond the budget', () => {
    const r = evaluateThirdPartyExperiment(input({ treatment: arm(10000, 206, 2_080_000, 2800) }))
    expect(r.verdict).toBe('remove')
    expect(r.reasons).toContain('lcp_regression_without_proven_return')
  })

  it('keeps a proven script but flags its performance cost', () => {
    const r = evaluateThirdPartyExperiment(input({ treatment: arm(10000, 300, 3_100_000, 3000) }))
    expect(r.verdict).toBe('keep')
    expect(r.reasons).toContain('keep_with_performance_cost')
  })

  it('removes when conversions rise but profit does not cover the cost', () => {
    const r = evaluateThirdPartyExperiment(
      input({ monthlyCostCents: 900_000, treatment: arm(10000, 300, 2_300_000, 2450) })
    )
    expect(r.verdict).toBe('remove')
    expect(r.reasons).toContain('negative_roi')
  })

  it('handles zero control revenue without NaN', () => {
    const r = evaluateThirdPartyExperiment(
      input({ control: arm(10000, 0, 0, 2400), treatment: arm(10000, 0, 0, 2400) })
    )
    expect(Number.isFinite(r.incrementalProfitMonthlyCents)).toBe(true)
    expect(r.conversionLiftBps).toBe(0)
    expect(r.verdict).toBe('remove')
  })

  it('rejects impossible inputs', () => {
    expect(() => evaluateThirdPartyExperiment(input({ periodDays: 0 }))).toThrow('invalid_experiment_input')
    expect(() => evaluateThirdPartyExperiment(input({ marginBps: 10001 }))).toThrow('invalid_experiment_input')
    expect(() => evaluateThirdPartyExperiment(input({ control: arm(10, 11, 0, 0) }))).toThrow(
      'invalid_experiment_input'
    )
  })

  it('validates registration and experiment payload schemas', () => {
    const base = { commandId: '30000000-0000-4000-8000-000000000001', idempotencyKey: 'k' }
    const script = { ...base, vendor: 'Meta', name: 'Pixel', kind: 'pixel', monthlyCostCents: 0, loadMsP75: 120 }
    expect(registerScriptSchema.safeParse(script).success).toBe(true)
    expect(registerScriptSchema.safeParse({ ...script, kind: 'tracker' }).success).toBe(false)
    expect(registerScriptSchema.safeParse({ ...script, monthlyCostCents: -1 }).success).toBe(false)
    expect(registerScriptSchema.safeParse({ ...script, monthlyCostCents: 1.5 }).success).toBe(false)
    const exp = {
      ...base,
      scriptId: '30000000-0000-4000-8000-000000000002',
      periodDays: 14,
      marginBps: 3000,
      control: arm(1000, 10, 1000, 1000),
      treatment: arm(1000, 10, 1000, 1000)
    }
    expect(recordExperimentSchema.safeParse(exp).success).toBe(true)
    expect(recordExperimentSchema.safeParse({ ...exp, extra: true }).success).toBe(false)
  })
})
