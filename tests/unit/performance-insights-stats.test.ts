import { describe, expect, it } from 'vitest'
import { assignExperimentArm, normalCdf, twoProportionTest } from '../../shared/performance-insights-stats'

describe('performance insights statistics', () => {
  it('normalCdf is symmetric and anchored', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6)
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3)
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3)
  })

  it('detects a clear conversion lift as significant', () => {
    const result = twoProportionTest({ visitors: 5000, conversions: 100 }, { visitors: 5000, conversions: 160 })
    expect(result.z).toBeGreaterThan(3)
    expect(result.pValue).toBeLessThan(0.01)
  })

  it('does not flag identical arms', () => {
    const result = twoProportionTest({ visitors: 4000, conversions: 80 }, { visitors: 4000, conversions: 80 })
    expect(result.z).toBe(0)
    expect(result.pValue).toBe(1)
  })

  it('returns p=1 for empty arms and for degenerate pooled variance', () => {
    expect(twoProportionTest({ visitors: 0, conversions: 0 }, { visitors: 100, conversions: 5 }).pValue).toBe(1)
    expect(twoProportionTest({ visitors: 100, conversions: 0 }, { visitors: 100, conversions: 0 }).pValue).toBe(1)
    expect(twoProportionTest({ visitors: 100, conversions: 100 }, { visitors: 100, conversions: 100 }).pValue).toBe(1)
  })

  it('rejects impossible counts', () => {
    expect(() => twoProportionTest({ visitors: 10, conversions: 11 }, { visitors: 10, conversions: 1 })).toThrow(
      'invalid_arm_counts'
    )
    expect(() => twoProportionTest({ visitors: -1, conversions: 0 }, { visitors: 10, conversions: 1 })).toThrow(
      'invalid_arm_counts'
    )
  })

  it('assigns arms deterministically and roughly 50/50', () => {
    expect(assignExperimentArm('visitor-1', 'exp-a')).toBe(assignExperimentArm('visitor-1', 'exp-a'))
    let treatment = 0
    for (let i = 0; i < 2000; i++) if (assignExperimentArm(`v-${i}`, 'exp-a') === 'treatment') treatment++
    expect(treatment).toBeGreaterThan(900)
    expect(treatment).toBeLessThan(1100)
  })

  it('decorrelates assignment across experiments', () => {
    let same = 0
    for (let i = 0; i < 1000; i++)
      if (assignExperimentArm(`v-${i}`, 'exp-a') === assignExperimentArm(`v-${i}`, 'exp-b')) same++
    expect(same).toBeGreaterThan(400)
    expect(same).toBeLessThan(600)
  })

  it('rejects empty identifiers', () => {
    expect(() => assignExperimentArm('', 'exp')).toThrow('invalid_assignment_input')
    expect(() => assignExperimentArm('v', '')).toThrow('invalid_assignment_input')
  })
})
