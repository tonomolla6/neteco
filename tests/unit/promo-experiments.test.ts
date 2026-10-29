import { describe, expect, it } from 'vitest'
import {
  analyzeExperiment,
  armStats,
  assignArm,
  marginOf,
  promoExperimentInputSchema,
  promoObservationInputSchema,
  rankPromoCandidates,
  type ArmStats
} from '../../shared/promo-experiments'

const PARAMS = { holdoutBasisPoints: 1000, minSamplePerArm: 30, minIncrementalMarginCents: 0 }

/** Deterministic arm with exactly `n` subjects, mean `mean` and spread +-`spread`. */
function arm(n: number, mean: number, spread: number): ArmStats {
  const values = Array.from({ length: n }, (_v, i) => mean + (i % 2 === 0 ? spread : -spread))
  return armStats(values)
}

describe('PRI-022 experiment input', () => {
  const valid = {
    code: 'EXP-ENVIO-GRATIS',
    name: 'Envío gratis sobre 80 EUR',
    promotionCode: 'ENVIO80',
    holdoutBasisPoints: 1000,
    minSamplePerArm: 200,
    minIncrementalMarginCents: 50
  }
  it('accepts a complete definition', () => {
    expect(promoExperimentInputSchema.parse(valid).holdoutBasisPoints).toBe(1000)
  })
  it.each([
    ['no holdout', { holdoutBasisPoints: 0 }],
    ['holdout below 5 %', { holdoutBasisPoints: 499 }],
    ['holdout above 50 %', { holdoutBasisPoints: 5001 }],
    ['tiny sample', { minSamplePerArm: 29 }],
    ['negative threshold', { minIncrementalMarginCents: -1 }],
    ['lowercase code', { code: 'exp' }],
    ['unknown field', { winnerBy: 'revenue' }]
  ])('rejects %s', (_l, patch) => {
    expect(promoExperimentInputSchema.safeParse({ ...valid, ...patch }).success).toBe(false)
  })
})

describe('PRI-022 observation input and margin', () => {
  const valid = {
    subjectKey: 'customer-123',
    orderRef: 'order-2026-0001',
    revenueGrossCents: 12100,
    netRevenueCents: 10000,
    cogsCents: 6000,
    variableCostCents: 500
  }
  it('derives the contribution margin from net revenue, COGS and variable cost, ignoring gross revenue', () => {
    expect(marginOf(promoObservationInputSchema.parse(valid))).toBe(3500)
    expect(marginOf(promoObservationInputSchema.parse({ ...valid, revenueGrossCents: 999999 }))).toBe(3500)
  })
  it('allows a negative margin (loss-making order)', () => {
    expect(marginOf(promoObservationInputSchema.parse({ ...valid, cogsCents: 11000 }))).toBe(-1500)
  })
  it.each([
    ['negative cost', { cogsCents: -1 }],
    ['fractional cents', { netRevenueCents: 10.5 }],
    ['net revenue above gross', { netRevenueCents: 12101 }],
    ['e-mail as subject', { subjectKey: 'ana@example.com' }],
    ['empty subject', { subjectKey: '' }],
    ['short order ref', { orderRef: 'a' }],
    ['unknown field', { email: 'a@b.es' }]
  ])('rejects %s', (_l, patch) => {
    expect(promoObservationInputSchema.safeParse({ ...valid, ...patch }).success).toBe(false)
  })
})

describe('PRI-022 deterministic assignment', () => {
  it('is stable for the same experiment and subject', async () => {
    const a = await assignArm('exp-1', 'customer-1', 1000)
    expect(await assignArm('exp-1', 'customer-1', 1000)).toEqual(a)
  })
  it('keeps the holdout share close to the configured basis points', async () => {
    let holdout = 0
    const total = 4000
    for (let i = 0; i < total; i++) if ((await assignArm('exp-2', `subject-${i}`, 1000)).arm === 'holdout') holdout++
    expect(holdout / total).toBeGreaterThan(0.08)
    expect(holdout / total).toBeLessThan(0.12)
  })
  it('re-randomises across experiments', async () => {
    let differing = 0
    for (let i = 0; i < 500; i++) {
      const a = await assignArm('exp-a', `s-${i}`, 5000)
      const b = await assignArm('exp-b', `s-${i}`, 5000)
      if (a.arm !== b.arm) differing++
    }
    expect(differing).toBeGreaterThan(150)
  })
  it('returns a 64-hex subject hash that does not contain the subject key', async () => {
    const r = await assignArm('exp-1', 'customer-abc', 1000)
    expect(r.subjectHash).toMatch(/^[0-9a-f]{64}$/)
    expect(r.subjectHash).not.toContain('customer')
  })
  it('rejects a holdout outside the allowed range', async () => {
    await expect(assignArm('exp-1', 's', 0)).rejects.toThrow('invalid_holdout')
    await expect(assignArm('exp-1', 's', 6000)).rejects.toThrow('invalid_holdout')
  })
})

describe('PRI-022 armStats', () => {
  it('aggregates n, sum and sum of squares of per-subject margins, including zeros', () => {
    expect(armStats([0, 0, 100, -50])).toEqual({ n: 4, sum: 50, sumSquares: 12500 })
  })
  it('handles an empty arm', () => {
    expect(armStats([])).toEqual({ n: 0, sum: 0, sumSquares: 0 })
  })
})

describe('PRI-022 analysis: holdout and sample guards', () => {
  it('refuses to decide without a holdout', () => {
    const r = analyzeExperiment(PARAMS, { holdout: armStats([]), treatment: arm(500, 1000, 100) })
    expect(r.decision).toBe('insufficient_sample')
    expect(r.reasons).toContain('holdout_missing')
  })
  it('refuses to decide with too few subjects in either arm', () => {
    const r = analyzeExperiment(PARAMS, { holdout: arm(10, 100, 10), treatment: arm(500, 1000, 100) })
    expect(r.decision).toBe('insufficient_sample')
    expect(r.reasons).toContain('holdout_below_minimum')
    const t = analyzeExperiment(PARAMS, { holdout: arm(100, 100, 10), treatment: arm(29, 1000, 100) })
    expect(t.reasons).toContain('treatment_below_minimum')
  })
  it('detects a sample ratio mismatch and invalidates the result', () => {
    // 10 % holdout expected but 40 % observed
    const r = analyzeExperiment(PARAMS, { holdout: arm(400, 100, 10), treatment: arm(600, 5000, 100) })
    expect(r.decision).toBe('sample_ratio_mismatch')
  })
})

describe('PRI-022 analysis: incremental margin decisions', () => {
  it('promotes only when the lower confidence bound of the incremental margin is positive', () => {
    const r = analyzeExperiment(PARAMS, { holdout: arm(200, 1000, 300), treatment: arm(1800, 1300, 300) })
    expect(r.decision).toBe('promote')
    expect(r.incrementalMarginPerSubjectCents).toBe(300)
    expect(r.incrementalMarginTotalCents).toBe(300 * 1800)
    expect(r.confidenceLowCents).toBeGreaterThan(0)
  })
  it('continues when the interval still contains zero', () => {
    const r = analyzeExperiment(PARAMS, { holdout: arm(200, 1000, 3000), treatment: arm(1800, 1050, 3000) })
    expect(r.decision).toBe('continue')
  })
  it('rejects when even the upper bound cannot reach the threshold', () => {
    const r = analyzeExperiment(PARAMS, { holdout: arm(200, 1000, 100), treatment: arm(1800, 700, 100) })
    expect(r.decision).toBe('reject')
    expect(r.incrementalMarginTotalCents).toBeLessThan(0)
  })
  it('requires the lower bound to beat the minimum incremental margin threshold', () => {
    const stats = { holdout: arm(200, 1000, 100), treatment: arm(1800, 1100, 100) }
    expect(analyzeExperiment(PARAMS, stats).decision).toBe('promote')
    const strict = analyzeExperiment({ ...PARAMS, minIncrementalMarginCents: 150 }, stats)
    expect(strict.decision).not.toBe('promote')
  })
  it('counts non-buyers: a promo that only shifts margin among few buyers is judged per assigned subject', () => {
    // 20 % of treated buy 5000 margin, holdout 20 % buy 5000: no lift despite heavy "revenue"
    const mixed = (n: number, share: number, value: number) =>
      armStats(Array.from({ length: n }, (_v, i) => (i < n * share ? value : 0)))
    const r = analyzeExperiment(PARAMS, { holdout: mixed(200, 0.2, 5000), treatment: mixed(1800, 0.2, 5000) })
    expect(r.decision).not.toBe('promote')
    expect(r.incrementalMarginPerSubjectCents).toBe(0)
  })
  it('never promotes a lift in gross revenue that destroys margin', () => {
    // revenue is not even an input; the margin of treated subjects is lower
    const r = analyzeExperiment(PARAMS, { holdout: arm(200, 900, 50), treatment: arm(1800, 400, 50) })
    expect(r.decision).toBe('reject')
  })
  it('does not depend on revenue: identical margin stats give identical decisions', () => {
    const a = analyzeExperiment(PARAMS, { holdout: arm(200, 1000, 300), treatment: arm(1800, 1300, 300) })
    const b = analyzeExperiment(PARAMS, { holdout: arm(200, 1000, 300), treatment: arm(1800, 1300, 300) })
    expect(a).toEqual(b)
    expect(Object.keys(a)).not.toContain('revenue')
  })
  it('handles zero variance in both arms', () => {
    const flat = (n: number, v: number) => armStats(Array.from({ length: n }, () => v))
    const r = analyzeExperiment(PARAMS, { holdout: flat(200, 100), treatment: flat(1800, 200) })
    expect(r.decision).toBe('promote')
    const same = analyzeExperiment(PARAMS, { holdout: flat(200, 100), treatment: flat(1800, 100) })
    expect(same.decision).toBe('continue')
  })
})

describe('PRI-022 ranking', () => {
  const win = (code: string, treatedMean: number) => ({
    code,
    analysis: analyzeExperiment(PARAMS, { holdout: arm(200, 1000, 200), treatment: arm(1800, treatedMean, 200) })
  })
  it('ranks only promotable candidates by incremental margin, ignoring revenue-like hints', () => {
    const ranked = rankPromoCandidates([
      { ...win('SMALL', 1200), grossRevenueCents: 99_999_999 },
      win('BIG', 1600),
      {
        code: 'LOSS',
        analysis: analyzeExperiment(PARAMS, { holdout: arm(200, 1000, 200), treatment: arm(1800, 600, 200) }),
        grossRevenueCents: 1e9
      }
    ])
    expect(ranked.map((c) => c.code)).toEqual(['BIG', 'SMALL'])
  })
  it('returns an empty list when nothing is promotable', () => {
    expect(rankPromoCandidates([])).toEqual([])
  })
})
