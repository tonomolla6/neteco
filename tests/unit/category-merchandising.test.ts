import { describe, expect, it } from 'vitest'
import {
  CATEGORY_MERCHANDISING_MAX_VALIDITY_DAYS,
  categoryMerchandisingInputSchema,
  categoryMerchandisingState,
  rankCategoryProducts,
  type CategoryProductSignals
} from '../../shared/category-merchandising'

const id = (n: number, group = 'a') => `${group}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const product = (n: number, extra: Partial<CategoryProductSignals> = {}): CategoryProductSignals => ({
  productId: id(n),
  baselineRank: n,
  sellableStock: 10,
  backorderAllowed: false,
  marginBps: 2000,
  units30d: 0,
  contract: false,
  campaign: false,
  ...extra
})
const weights = (extra: Partial<Record<'stock' | 'margin' | 'popularity' | 'contract' | 'campaign', number>> = {}) => ({
  stock: 0,
  margin: 0,
  popularity: 0,
  contract: 0,
  campaign: 0,
  ...extra
})
const guardrails = (extra = {}) => ({ minStock: 0, minMarginBps: null as number | null, maxBoosted: 10, ...extra })
const order = (
  rule: { weights: ReturnType<typeof weights>; guardrails: ReturnType<typeof guardrails> },
  items: CategoryProductSignals[]
) => rankCategoryProducts(rule, items).items.map((item) => item.productId)
const ids = (...ns: number[]) => ns.map((n) => id(n))

describe('SEA-015 rankCategoryProducts: single signals', () => {
  it('ranks by stock', () => {
    const items = [
      product(1, { sellableStock: 5 }),
      product(2, { sellableStock: 80 }),
      product(3, { sellableStock: 20 })
    ]
    expect(order({ weights: weights({ stock: 5 }), guardrails: guardrails() }, items)).toEqual(ids(2, 3, 1))
  })
  it('ranks by margin and treats unknown margin as no boost', () => {
    const items = [product(1, { marginBps: null }), product(2, { marginBps: 1000 }), product(3, { marginBps: 4500 })]
    expect(order({ weights: weights({ margin: 5 }), guardrails: guardrails() }, items)).toEqual(ids(3, 2, 1))
  })
  it('ranks by popularity relative to the best seller', () => {
    const items = [product(1, { units30d: 3 }), product(2, { units30d: 40 }), product(3, { units30d: 10 })]
    const ranking = rankCategoryProducts({ weights: weights({ popularity: 4 }), guardrails: guardrails() }, items)
    expect(ranking.items.map((i) => i.productId)).toEqual(ids(2, 3, 1))
    expect(ranking.items[0]!.score).toBe(100)
    expect(ranking.items[1]!.score).toBe(25)
  })
  it('lifts contract and campaign products', () => {
    const items = [product(1), product(2, { contract: true }), product(3, { campaign: true })]
    expect(order({ weights: weights({ contract: 5 }), guardrails: guardrails() }, items)).toEqual(ids(2, 1, 3))
    expect(order({ weights: weights({ campaign: 5 }), guardrails: guardrails() }, items)).toEqual(ids(3, 1, 2))
  })
})

describe('SEA-015 rankCategoryProducts: combination', () => {
  it('normalises the weights and combines every signal with an explanation', () => {
    const items = [
      product(1, { sellableStock: 100, marginBps: 6000, units30d: 10, contract: true, campaign: true }),
      product(2, { sellableStock: 0, backorderAllowed: true, marginBps: 0, units30d: 0 })
    ]
    const ranking = rankCategoryProducts(
      { weights: weights({ stock: 2, margin: 2, popularity: 2, contract: 2, campaign: 2 }), guardrails: guardrails() },
      items
    )
    expect(ranking.items[0]).toMatchObject({ productId: id(1), score: 100, group: 'boosted', position: 1 })
    const parts = ranking.items[0]!.contributions
    expect(parts.map((p) => p.signal)).toEqual(['stock', 'margin', 'popularity', 'contract', 'campaign'])
    expect(parts.reduce((sum, p) => sum + p.points, 0)).toBeCloseTo(100, 5)
    expect(ranking.items[1]).toMatchObject({ score: 0, group: 'neutral' })
  })
  it('a heavier weight dominates a lighter one', () => {
    const items = [product(1, { sellableStock: 100, units30d: 0 }), product(2, { sellableStock: 10, units30d: 50 })]
    expect(order({ weights: weights({ stock: 1, popularity: 9 }), guardrails: guardrails() }, items)).toEqual(ids(2, 1))
    expect(order({ weights: weights({ stock: 9, popularity: 1 }), guardrails: guardrails() }, items)).toEqual(ids(1, 2))
  })
  it('keeps the baseline order when no product has a positive score', () => {
    const items = [product(3), product(1), product(2)]
    expect(order({ weights: weights({ contract: 5 }), guardrails: guardrails() }, items)).toEqual(ids(1, 2, 3))
  })
  it('breaks ties by baseline rank, then by product id', () => {
    const items = [product(2, { baselineRank: 2, contract: true }), product(1, { baselineRank: 1, contract: true })]
    expect(order({ weights: weights({ contract: 1 }), guardrails: guardrails() }, items)).toEqual(ids(1, 2))
    const same = [product(2, { baselineRank: 1, contract: true }), product(1, { baselineRank: 1, contract: true })]
    expect(order({ weights: weights({ contract: 1 }), guardrails: guardrails() }, same)).toEqual(ids(1, 2))
  })
  it('is pure: it does not mutate its input and is repeatable', () => {
    const items = [product(1, { units30d: 1 }), product(2, { units30d: 9 })]
    const copy = structuredClone(items)
    const rule = { weights: weights({ popularity: 3 }), guardrails: guardrails() }
    expect(rankCategoryProducts(rule, items)).toEqual(rankCategoryProducts(rule, items))
    expect(items).toEqual(copy)
  })
  it('handles empty and single-product categories', () => {
    const rule = { weights: weights({ stock: 1 }), guardrails: guardrails() }
    expect(rankCategoryProducts(rule, []).items).toEqual([])
    expect(rankCategoryProducts(rule, [product(1)]).items[0]).toMatchObject({ position: 1 })
  })
})

describe('SEA-015 guardrails', () => {
  const rule = (g = {}, w = weights({ campaign: 5, popularity: 5 })) => ({ weights: w, guardrails: guardrails(g) })
  it('always sinks out-of-stock products, whatever their other signals', () => {
    const items = [
      product(1, { sellableStock: 0, campaign: true, units30d: 99 }),
      product(2),
      product(3, { contract: true })
    ]
    const ranking = rankCategoryProducts(rule(), items)
    expect(ranking.items.map((i) => i.productId)).toEqual(ids(2, 3, 1))
    expect(ranking.items[2]).toMatchObject({ group: 'demoted', guardrails: ['out_of_stock'] })
  })
  it('does not sink an out-of-stock product that allows backorder', () => {
    const items = [product(1, { sellableStock: 0, backorderAllowed: true, campaign: true }), product(2)]
    expect(order(rule(), items)).toEqual(ids(1, 2))
  })
  it('keeps several demoted products in baseline order', () => {
    const items = [product(1, { sellableStock: 0 }), product(2), product(3, { sellableStock: 0 })]
    expect(order(rule(), items)).toEqual(ids(2, 1, 3))
  })
  it('minStock blocks a boost but does not demote', () => {
    const items = [
      product(1, { sellableStock: 3, campaign: true }),
      product(2, { sellableStock: 50, campaign: true }),
      product(3)
    ]
    const ranking = rankCategoryProducts(rule({ minStock: 10 }), items)
    expect(ranking.items.map((i) => i.productId)).toEqual(ids(2, 1, 3))
    expect(ranking.items.find((i) => i.productId === id(1))).toMatchObject({
      group: 'neutral',
      guardrails: ['below_min_stock']
    })
  })
  it('margin floor blocks low and unknown margins (fail closed) but only when configured', () => {
    const items = [
      product(1, { marginBps: 500, campaign: true }),
      product(2, { marginBps: null, campaign: true }),
      product(3, { marginBps: 2500, campaign: true })
    ]
    const guarded = rankCategoryProducts(rule({ minMarginBps: 1000 }), items)
    expect(guarded.items.map((i) => i.productId)).toEqual(ids(3, 1, 2))
    expect(guarded.items.find((i) => i.productId === id(1))!.guardrails).toEqual(['margin_floor'])
    expect(guarded.items.find((i) => i.productId === id(2))!.guardrails).toEqual(['margin_unknown'])
    expect(order(rule({ minMarginBps: null }), items)).toEqual(ids(1, 2, 3))
  })
  it('the cap limits how many products can jump ahead', () => {
    const items = [1, 2, 3, 4, 5].map((n) => product(n, { baselineRank: n, units30d: n * 10 }))
    const ranking = rankCategoryProducts(rule({ maxBoosted: 2 }, weights({ popularity: 5 })), items)
    expect(ranking.items.map((i) => i.productId)).toEqual(ids(5, 4, 1, 2, 3))
    expect(ranking.items.filter((i) => i.group === 'boosted')).toHaveLength(2)
    expect(ranking.items.find((i) => i.productId === id(3))!.guardrails).toEqual(['boost_cap'])
    expect(ranking.boostedIds).toEqual(ids(5, 4))
  })
  it('lists demoted ids for the SQL layer', () => {
    const ranking = rankCategoryProducts(rule(), [product(1, { sellableStock: 0 }), product(2, { campaign: true })])
    expect(ranking.demotedIds).toEqual(ids(1))
    expect(ranking.boostedIds).toEqual(ids(2))
  })
})

describe('SEA-015 input schema', () => {
  const now = Date.now()
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const DAY = 86_400_000
  const save = (extra: Record<string, unknown> = {}) => ({
    action: 'save',
    id: null,
    expectedVersion: 0,
    categoryId: id(1, 'c'),
    weights: weights({ stock: 3, campaign: 5 }),
    guardrails: guardrails({ minStock: 5, minMarginBps: 1000, maxBoosted: 6 }),
    campaign: { campaignId: null, productIds: [id(10)] },
    reason: 'Campaña de otoño revisada',
    validFrom: iso(-DAY),
    validUntil: iso(30 * DAY),
    ...extra
  })
  const ok = (value: unknown) => categoryMerchandisingInputSchema.safeParse(value).success
  it('accepts a complete rule and a retirement', () => {
    expect(ok(save())).toBe(true)
    expect(ok({ action: 'retire', id: id(1, 'd'), expectedVersion: 1, reason: 'Fin de campaña' })).toBe(true)
  })
  it('rejects unknown keys, prototype pollution and missing parts', () => {
    expect(ok(save({ extra: 1 }))).toBe(false)
    expect(ok(JSON.parse('{"__proto__":{"x":1},' + JSON.stringify(save()).slice(1)))).toBe(false)
    const { campaign: _campaign, ...withoutCampaign } = save()
    expect(ok(withoutCampaign)).toBe(false)
  })
  it('validates weights: bounds, integers and a positive total', () => {
    expect(ok(save({ weights: weights() }))).toBe(false)
    expect(ok(save({ weights: weights({ stock: 11 }) }))).toBe(false)
    expect(ok(save({ weights: weights({ stock: -1, margin: 5 }) }))).toBe(false)
    expect(ok(save({ weights: weights({ stock: 1.5 }) }))).toBe(false)
    expect(ok(save({ weights: { stock: 1 } }))).toBe(false)
  })
  it('validates guardrails bounds', () => {
    expect(ok(save({ guardrails: guardrails({ maxBoosted: 0 }) }))).toBe(false)
    expect(ok(save({ guardrails: guardrails({ maxBoosted: 51 }) }))).toBe(false)
    expect(ok(save({ guardrails: guardrails({ minMarginBps: 10001 }) }))).toBe(false)
    expect(ok(save({ guardrails: guardrails({ minStock: -1 }) }))).toBe(false)
    expect(ok(save({ guardrails: guardrails({ extra: 1 }) }))).toBe(false)
  })
  it('requires campaign products when the campaign signal has weight, and rejects duplicates', () => {
    expect(ok(save({ weights: weights({ campaign: 4 }), campaign: { campaignId: null, productIds: [] } }))).toBe(false)
    expect(ok(save({ weights: weights({ stock: 4 }), campaign: { campaignId: null, productIds: [] } }))).toBe(true)
    expect(ok(save({ campaign: { campaignId: null, productIds: [id(10), id(10)] } }))).toBe(false)
    expect(ok(save({ campaign: { campaignId: 'nope', productIds: [id(10)] } }))).toBe(false)
    expect(
      ok(save({ campaign: { campaignId: null, productIds: Array.from({ length: 101 }, (_, i) => id(i + 1)) } }))
    ).toBe(false)
  })
  it('validates validity span, reason, identity and version consistency', () => {
    expect(CATEGORY_MERCHANDISING_MAX_VALIDITY_DAYS).toBe(180)
    expect(ok(save({ validUntil: iso(-DAY) }))).toBe(false)
    expect(ok(save({ validUntil: iso(200 * DAY) }))).toBe(false)
    expect(ok(save({ validUntil: iso(30 * DAY).replace('Z', '.000Z') }))).toBe(false)
    expect(ok(save({ reason: 'x' }))).toBe(false)
    expect(ok(save({ reason: 'bad\u0000reason' }))).toBe(false)
    expect(ok(save({ id: id(2, 'd'), expectedVersion: 0 }))).toBe(false)
    expect(ok(save({ id: null, expectedVersion: 2 }))).toBe(false)
    expect(ok(save({ id: id(2, 'd'), expectedVersion: 2 }))).toBe(true)
    expect(ok({ action: 'retire', id: id(1, 'd'), expectedVersion: 0, reason: 'Fin de campaña' })).toBe(false)
  })
})

describe('SEA-015 categoryMerchandisingState', () => {
  const rule = { status: 'active' as const, validFrom: '2026-01-01T00:00:00Z', validUntil: '2026-02-01T00:00:00Z' }
  it('derives live, scheduled, expired and retired from the instant', () => {
    expect(categoryMerchandisingState(rule, '2025-12-31T23:59:59Z')).toBe('scheduled')
    expect(categoryMerchandisingState(rule, '2026-01-01T00:00:00Z')).toBe('live')
    expect(categoryMerchandisingState(rule, '2026-01-31T23:59:59Z')).toBe('live')
    expect(categoryMerchandisingState(rule, '2026-02-01T00:00:00Z')).toBe('expired')
    expect(categoryMerchandisingState({ ...rule, status: 'retired' }, '2026-01-10T00:00:00Z')).toBe('retired')
  })
})
