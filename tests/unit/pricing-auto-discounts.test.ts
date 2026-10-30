import { describe, expect, it } from 'vitest'
import {
  autoDiscountRuleInputSchema,
  evaluateAutoDiscounts,
  type AutoDiscountLine,
  type AutoDiscountRule
} from '../../shared/auto-discounts'

const at = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
const now = at()

function rule(over: Partial<AutoDiscountRule> & { id: string }): AutoDiscountRule {
  return {
    code: over.id.toUpperCase(),
    name: 'Regla',
    status: 'active',
    version: 1,
    kind: 'product',
    scopeIds: ['p1'],
    benefit: { kind: 'percent', basisPoints: 1000 },
    minBasketGrossCents: 0,
    priority: 10,
    stacking: 'exclusive',
    segment: 'all',
    marginFloorBasisPoints: 0,
    customerMessage: 'Descuento automatico',
    startsAt: at(-3_600_000),
    endsAt: null,
    ...over
  } as AutoDiscountRule
}
function line(index: number, over: Partial<AutoDiscountLine> = {}): AutoDiscountLine {
  return {
    lineIndex: index,
    variantId: `v${index}`,
    productId: `p${index + 1}`,
    categoryId: 'c1',
    sku: `SKU${index}`,
    quantity: 1,
    unitGrossCents: 1000,
    costUnitNetCents: 100,
    taxRateBasisPoints: 2100,
    ...over
  }
}
const ctx = (lines: AutoDiscountLine[], over: Record<string, unknown> = {}) => ({
  now,
  customerId: null,
  companyApproved: false,
  lines,
  ...over
})

describe('automatic discounts (PRI-014)', () => {
  it('applies a product percentage with explicit half-up rounding and explains it', () => {
    const r = evaluateAutoDiscounts(
      [rule({ id: 'a', benefit: { kind: 'percent', basisPoints: 1250 } })],
      ctx([line(0, { unitGrossCents: 999 })])
    )
    expect(r.totals.discountGrossCents).toBe(125) // 999 * 12.5% = 124.875 -> 125
    expect(r.explanations).toEqual([{ message: 'Descuento automatico', discountGrossCents: 125 }])
    expect(r.lines[0]!.grossCents).toBe(874)
    expect(JSON.stringify(r.explanations)).not.toContain('cost')
  })
  it('applies a category rule only to lines of that category', () => {
    const r = evaluateAutoDiscounts(
      [rule({ id: 'a', kind: 'category', scopeIds: ['c2'] })],
      ctx([line(0), line(1, { categoryId: 'c2' })])
    )
    expect(r.lines.map((l) => l.discountGrossCents)).toEqual([0, 100])
  })
  it('applies volume tiers per line using the highest reached tier', () => {
    const volume = rule({
      id: 'v',
      kind: 'volume',
      scopeIds: [],
      benefit: {
        kind: 'tiers',
        tiers: [
          { minQuantity: 5, basisPoints: 500 },
          { minQuantity: 20, basisPoints: 1500 }
        ]
      }
    })
    const r = evaluateAutoDiscounts(
      [volume],
      ctx([line(0, { quantity: 4 }), line(1, { quantity: 5 }), line(2, { quantity: 25 })])
    )
    expect(r.lines.map((l) => l.discountGrossCents)).toEqual([0, 250, 3750])
  })
  it('basket rule needs the threshold and allocates every cent (largest remainder)', () => {
    const basket = rule({
      id: 'b',
      kind: 'basket',
      scopeIds: [],
      minBasketGrossCents: 2000,
      benefit: { kind: 'fixed', grossCents: 100 }
    })
    const below = evaluateAutoDiscounts([basket], ctx([line(0), line(1, { unitGrossCents: 900 })]))
    expect(below.totals.discountGrossCents).toBe(0)
    const ok = evaluateAutoDiscounts([basket], ctx([line(0), line(1), line(2, { unitGrossCents: 1001 })]))
    expect(ok.totals.discountGrossCents).toBe(100)
    expect(ok.lines.reduce((n, l) => n + l.discountGrossCents, 0)).toBe(100)
  })
  it('exclusive rules: the best priority wins and others do not touch the line', () => {
    const r = evaluateAutoDiscounts(
      [
        rule({ id: 'low', priority: 50, benefit: { kind: 'percent', basisPoints: 3000 } }),
        rule({ id: 'high', priority: 5, benefit: { kind: 'percent', basisPoints: 1000 } })
      ],
      ctx([line(0)])
    )
    expect(r.applied.map((a) => a.code)).toEqual(['HIGH'])
    expect(r.totals.discountGrossCents).toBe(100)
  })
  it('stackable rules compound on the remaining amount, and ties break by code', () => {
    const r = evaluateAutoDiscounts(
      [
        rule({ id: 'b', priority: 10, stacking: 'stackable', benefit: { kind: 'percent', basisPoints: 1000 } }),
        rule({ id: 'a', priority: 10, stacking: 'stackable', benefit: { kind: 'percent', basisPoints: 1000 } })
      ],
      ctx([line(0)])
    )
    expect(r.applied.map((a) => a.code)).toEqual(['A', 'B'])
    expect(r.totals.discountGrossCents).toBe(100 + 90)
  })
  it('an exclusive rule cannot add to a line that already has a discount', () => {
    const r = evaluateAutoDiscounts(
      [
        rule({ id: 's', priority: 1, stacking: 'stackable', benefit: { kind: 'percent', basisPoints: 1000 } }),
        rule({ id: 'x', priority: 2, stacking: 'exclusive', benefit: { kind: 'percent', basisPoints: 1000 } })
      ],
      ctx([line(0)])
    )
    expect(r.applied.map((a) => a.code)).toEqual(['S'])
  })
  it('never leaks below the margin floor: the discount is capped', () => {
    // net price 826 (1000 gross @21%); cost 700 -> a 20% floor needs net >= 875, so no discount fits
    const tight = rule({ id: 'a', marginFloorBasisPoints: 2000, benefit: { kind: 'percent', basisPoints: 5000 } })
    const none = evaluateAutoDiscounts([tight], ctx([line(0, { costUnitNetCents: 700 })]))
    expect(none.totals.discountGrossCents).toBe(0)
    const capped = evaluateAutoDiscounts([tight], ctx([line(0, { costUnitNetCents: 400 })]))
    const l = capped.lines[0]!
    expect(l.netCents * 10000).toBeGreaterThanOrEqual(400 * 12500) // net >= cost / (1 - 20%)
    expect(l.discountGrossCents).toBeGreaterThan(0)
    expect(l.discountGrossCents).toBeLessThan(500)
    // one more cent of discount would break the floor
    const next = evaluateAutoDiscounts(
      [
        rule({
          id: 'a',
          benefit: { kind: 'fixed', grossCents: l.discountGrossCents + 1 },
          marginFloorBasisPoints: 2000
        })
      ],
      ctx([line(0, { costUnitNetCents: 400 })])
    )
    expect(next.lines[0]!.discountGrossCents).toBe(l.discountGrossCents)
  })
  it('fails closed when the cost is unknown', () => {
    const r = evaluateAutoDiscounts([rule({ id: 'a' })], ctx([line(0, { costUnitNetCents: null })]))
    expect(r.totals.discountGrossCents).toBe(0)
    expect(r.skipped).toEqual([{ ruleId: 'a', reason: 'cost_unknown' }])
  })
  it('respects status, window and segment', () => {
    const lines = [line(0)]
    expect(evaluateAutoDiscounts([rule({ id: 'a', status: 'paused' })], ctx(lines)).applied).toEqual([])
    expect(evaluateAutoDiscounts([rule({ id: 'a', startsAt: at(60_000) })], ctx(lines)).applied).toEqual([])
    expect(evaluateAutoDiscounts([rule({ id: 'a', endsAt: now })], ctx(lines)).applied).toEqual([])
    const seg = rule({ id: 'a', segment: 'approved_company' })
    expect(evaluateAutoDiscounts([seg], ctx(lines)).applied).toEqual([])
    expect(evaluateAutoDiscounts([seg], ctx(lines, { customerId: 'cu', companyApproved: false })).applied).toEqual([])
    expect(evaluateAutoDiscounts([seg], ctx(lines, { customerId: 'cu', companyApproved: true })).applied).toHaveLength(
      1
    )
    const reg = rule({ id: 'a', segment: 'registered' })
    expect(evaluateAutoDiscounts([reg], ctx(lines)).applied).toEqual([])
    expect(evaluateAutoDiscounts([reg], ctx(lines, { customerId: 'cu' })).applied).toHaveLength(1)
  })
  it('never discounts a line below zero and is deterministic', () => {
    const big = rule({ id: 'a', benefit: { kind: 'fixed', grossCents: 999_999 }, marginFloorBasisPoints: 0 })
    const a = evaluateAutoDiscounts([big], ctx([line(0, { costUnitNetCents: 0 })]))
    const b = evaluateAutoDiscounts([big], ctx([line(0, { costUnitNetCents: 0 })]))
    expect(a).toEqual(b)
    expect(a.lines[0]!.grossCents).toBeGreaterThanOrEqual(0)
    expect(a.lines[0]!.discountGrossCents).toBeLessThanOrEqual(1000)
  })
  it('totals reconcile with lines', () => {
    const r = evaluateAutoDiscounts(
      [rule({ id: 'a', kind: 'category', scopeIds: ['c1'] })],
      ctx([line(0), line(1, { quantity: 3 })])
    )
    expect(r.totals.grossCents).toBe(r.lines.reduce((n, l) => n + l.grossCents, 0))
    expect(r.totals.netCents + r.totals.taxCents).toBe(r.totals.grossCents)
  })
  it('rejects unsafe or malformed input', () => {
    const base = {
      code: 'ok-1',
      name: 'Nombre',
      kind: 'product',
      scopeIds: ['p1'],
      benefit: { kind: 'percent', basisPoints: 1000 },
      minBasketGrossCents: 0,
      priority: 10,
      stacking: 'exclusive',
      segment: 'all',
      marginFloorBasisPoints: 0,
      customerMessage: 'Mensaje',
      startsAt: at(),
      endsAt: null
    }
    expect(autoDiscountRuleInputSchema.safeParse(base).success).toBe(true)
    for (const bad of [
      { ...base, benefit: { kind: 'percent', basisPoints: 0 } },
      { ...base, benefit: { kind: 'percent', basisPoints: 1.5 } },
      { ...base, benefit: { kind: 'fixed', grossCents: -1 } },
      { ...base, kind: 'product', scopeIds: [] },
      { ...base, kind: 'volume', benefit: { kind: 'percent', basisPoints: 100 } },
      {
        ...base,
        kind: 'volume',
        scopeIds: [],
        benefit: {
          kind: 'tiers',
          tiers: [
            { minQuantity: 5, basisPoints: 100 },
            { minQuantity: 5, basisPoints: 200 }
          ]
        }
      },
      {
        ...base,
        kind: 'volume',
        scopeIds: [],
        benefit: {
          kind: 'tiers',
          tiers: [
            { minQuantity: 5, basisPoints: 300 },
            { minQuantity: 9, basisPoints: 200 }
          ]
        }
      },
      { ...base, priority: 0 },
      { ...base, endsAt: base.startsAt },
      { ...base, marginFloorBasisPoints: 9500 },
      { ...base, extra: true },
      { ...base, customerMessage: 'x' },
      { ...base, scopeIds: ['p1', 'p1'] }
    ])
      expect(autoDiscountRuleInputSchema.safeParse(bad).success).toBe(false)
  })
})
