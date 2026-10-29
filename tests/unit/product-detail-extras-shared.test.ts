import { describe, expect, it } from 'vitest'
import {
  arrangeAlternatives,
  classifyAvailability,
  COPURCHASE_MIN_CONFIDENCE_PERMILLE,
  COPURCHASE_MIN_SUPPORT,
  parseDetailExtrasQuery,
  productDetailExtrasSchema,
  selectCoPurchases
} from '../../shared/product-detail-extras'

const base = {
  productId: 2,
  slug: 'alt-2',
  name: 'Alt 2',
  brand: 'NETECO',
  minPrice: 1000,
  minNetPrice: 826,
  formats: 1,
  availability: 'in_stock' as const,
  pickupAvailable: true,
  hazard: { signalWord: null, hazardStatements: [], hasHazardData: false }
}
describe('query', () => {
  it('accepts a slug with defaults', () => {
    expect(parseDetailExtrasQuery(new URLSearchParams('slug=producto-1'))).toEqual({
      slug: 'producto-1',
      sort: 'relevance',
      availableOnly: false
    })
  })
  it('accepts sort and availableOnly', () => {
    expect(parseDetailExtrasQuery(new URLSearchParams('slug=a&sort=price&availableOnly=1'))).toMatchObject({
      sort: 'price',
      availableOnly: true
    })
  })
  it.each(['', 'slug=A', 'slug=a&slug=b', 'slug=a&sort=cheap', 'slug=a&x=1', 'slug=a&availableOnly=yes', 'sort=price'])(
    'rejects %s',
    (query) => {
      expect(parseDetailExtrasQuery(new URLSearchParams(query))).toBeNull()
    }
  )
})
describe('classifyAvailability', () => {
  it('in stock', () =>
    expect(classifyAvailability({ sellable: 20, minimumQuantity: 1, backorderAllowed: false })).toBe('in_stock'))
  it('low stock at threshold', () =>
    expect(classifyAvailability({ sellable: 5, minimumQuantity: 1, backorderAllowed: false })).toBe('low_stock'))
  it('out of stock below minimum quantity', () =>
    expect(classifyAvailability({ sellable: 3, minimumQuantity: 6, backorderAllowed: false })).toBe('out_of_stock'))
  it('backorder only when allowed and no stock', () => {
    expect(classifyAvailability({ sellable: 0, minimumQuantity: 1, backorderAllowed: true })).toBe('backorder')
    expect(classifyAvailability({ sellable: 0, minimumQuantity: 1, backorderAllowed: false })).toBe('out_of_stock')
  })
  it('negative or non integer is unavailable', () => {
    expect(classifyAvailability({ sellable: -1, minimumQuantity: 1, backorderAllowed: false })).toBe('unavailable')
    expect(classifyAvailability({ sellable: 1.5, minimumQuantity: 1, backorderAllowed: false })).toBe('unavailable')
  })
})
describe('arrangeAlternatives', () => {
  const items = [
    { ...base, kind: 'substitute' as const, productId: 1, minPrice: 900, availability: 'out_of_stock' as const },
    { ...base, kind: 'equivalent' as const, productId: 2, minPrice: 1500 },
    { ...base, kind: 'substitute' as const, productId: 3, minPrice: 700, availability: 'backorder' as const }
  ]
  it('keeps curated order for relevance', () =>
    expect(arrangeAlternatives(items, 'relevance', false).map((i) => i.productId)).toEqual([1, 2, 3]))
  it('sorts by price ascending, stable', () =>
    expect(arrangeAlternatives(items, 'price', false).map((i) => i.productId)).toEqual([3, 1, 2]))
  it('sorts available first', () =>
    expect(arrangeAlternatives(items, 'availability', false).map((i) => i.productId)).toEqual([2, 3, 1]))
  it('availableOnly removes out of stock and unavailable but never hazard items', () => {
    const hazardous = {
      ...items[0]!,
      productId: 9,
      availability: 'in_stock' as const,
      hazard: { signalWord: 'Peligro', hazardStatements: ['H314'], hasHazardData: true }
    }
    const out = arrangeAlternatives([...items, hazardous], 'relevance', true).map((i) => i.productId)
    expect(out).toEqual([2, 3, 9])
  })
  it('does not mutate input', () => {
    const copy = structuredClone(items)
    arrangeAlternatives(items, 'price', true)
    expect(items).toEqual(copy)
  })
})
describe('selectCoPurchases', () => {
  const row = (productId: number, support: number) => ({ productId, support })
  it('requires minimum support and confidence', () => {
    const out = selectCoPurchases([row(1, COPURCHASE_MIN_SUPPORT), row(2, COPURCHASE_MIN_SUPPORT - 1), row(3, 3)], {
      sourceOrders: 10,
      excludeProductIds: new Set(),
      limit: 8
    })
    expect(out).toEqual([
      { productId: 1, support: 3, confidencePermille: 300 },
      { productId: 3, support: 3, confidencePermille: 300 }
    ])
  })
  it('drops low confidence even with high support', () => {
    expect(selectCoPurchases([row(1, 5)], { sourceOrders: 100, excludeProductIds: new Set(), limit: 8 })).toEqual([])
    expect(COPURCHASE_MIN_CONFIDENCE_PERMILLE).toBeGreaterThan(0)
  })
  it('excludes substitutes and applies limit sorted by support', () => {
    const out = selectCoPurchases([row(1, 4), row(2, 9), row(3, 6), row(4, 5)], {
      sourceOrders: 10,
      excludeProductIds: new Set([3]),
      limit: 2
    })
    expect(out.map((r) => r.productId)).toEqual([2, 4])
  })
  it('empty when no orders', () =>
    expect(selectCoPurchases([row(1, 5)], { sourceOrders: 0, excludeProductIds: new Set(), limit: 8 })).toEqual([]))
})
describe('response schema', () => {
  const valid = {
    source: 'cloudflare',
    productSlug: 'p',
    warehouse: { single: true, pickupEnabled: true },
    availability: [{ variantId: 1, sku: 'S', status: 'in_stock', sellable: 20, pickupAvailable: true }],
    hazard: { signalWord: null, hazardStatements: [], hasHazardData: false },
    alternatives: [{ ...base, kind: 'substitute', reviewed: true }],
    complements: [{ ...base, kind: 'accessory', basis: 'curated' }],
    notice: 'x'
  }
  it('parses valid', () => expect(productDetailExtrasSchema.safeParse(valid).success).toBe(true))
  it('rejects unreviewed alternatives', () =>
    expect(
      productDetailExtrasSchema.safeParse({
        ...valid,
        alternatives: [{ ...base, kind: 'substitute', reviewed: false }]
      }).success
    ).toBe(false))
  it('rejects alternatives of accessory kind', () =>
    expect(
      productDetailExtrasSchema.safeParse({ ...valid, alternatives: [{ ...base, kind: 'accessory', reviewed: true }] })
        .success
    ).toBe(false))
  it('rejects co-purchase without measurement', () =>
    expect(
      productDetailExtrasSchema.safeParse({
        ...valid,
        complements: [{ ...base, kind: 'accessory', basis: 'co_purchase' }]
      }).success
    ).toBe(false))
  it('rejects extra keys (no PII / cost leakage)', () =>
    expect(productDetailExtrasSchema.safeParse({ ...valid, costNet: 1 }).success).toBe(false))
  it('caps public sellable quantity', () =>
    expect(
      productDetailExtrasSchema.safeParse({ ...valid, availability: [{ ...valid.availability[0], sellable: 100000 }] })
        .success
    ).toBe(false))
})
