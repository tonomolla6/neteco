import { describe, expect, it } from 'vitest'
import { calculateBundlePricing } from '../../shared/bundles'

// SECFIX-3 findings 6 + 14: component prices are VAT-inclusive (variants.price_gross_cents), so the
// bundle price is already the total; VAT must be the part included in it, and lines keep their variant.
describe('SECFIX-3 calculateBundlePricing', () => {
  it('does not add VAT on top of a VAT-inclusive bundle price (finding 6)', () => {
    const result = calculateBundlePricing({
      baseBundlePriceCents: 10000,
      kitQuantity: 1,
      components: [{ variantId: 'v-1', unitPriceCents: 5000, taxRate: 0.21, defaultQuantity: 2 }]
    })
    expect(result.bundlePriceCents).toBe(10000)
    expect(result.taxCents).toBe(1736) // 10000 - round(10000 / 1.21)
    expect(result.totalCents).toBe(10000)
  })

  it('computes included VAT on the discounted bundle price, with lines summing exactly to it', () => {
    const result = calculateBundlePricing({
      baseBundlePriceCents: 4500,
      kitQuantity: 1,
      components: [
        { variantId: 'v-1', unitPriceCents: 2500, taxRate: 0.21, defaultQuantity: 2 },
        { variantId: 'v-2', unitPriceCents: 1000, taxRate: 0.1, defaultQuantity: 1 }
      ]
    })
    expect(result.totalCents).toBe(4500)
    expect(result.items.reduce((sum, item) => sum + item.lineGrossCents, 0)).toBe(4500)
    for (const item of result.items) {
      expect(item.lineNetCents + item.lineTaxCents).toBe(item.lineGrossCents)
      expect(Number.isInteger(item.lineTaxCents)).toBe(true)
    }
    expect(result.taxCents).toBe(result.items.reduce((sum, item) => sum + item.lineTaxCents, 0))
    expect(result.items.map((item) => item.lineGrossCents)).toEqual([3750, 750])
    expect(result.taxCents).toBe(3750 - Math.round(3750 / 1.21) + (750 - Math.round(750 / 1.1)))
  })

  it('preserves each component variantId in the breakdown (finding 14)', () => {
    const result = calculateBundlePricing({
      baseBundlePriceCents: 5000,
      kitQuantity: 1,
      components: [{ variantId: 'var-abc-123', unitPriceCents: 2500, taxRate: 0.21, defaultQuantity: 2 }]
    })
    expect(result.items[0]?.variantId).toBe('var-abc-123')
  })

  it('rejects a component without an identifiable variant', () => {
    expect(() =>
      calculateBundlePricing({
        baseBundlePriceCents: 5000,
        kitQuantity: 1,
        components: [{ variantId: '', unitPriceCents: 2500, taxRate: 0.21, defaultQuantity: 2 }]
      })
    ).toThrow('invalid_variant_id')
  })
})
