import { describe, expect, it } from 'vitest'
import {
  calculateQuote,
  quoteLine,
  roundRatio,
  selectVolumeUnitPrice,
  splitGross,
  validateQuantity
} from '../../server/domain/money'

describe('money', () => {
  it('rounds integer ratios half away from zero', () => {
    expect(roundRatio(1n, 3n)).toBe(0)
    expect(roundRatio(1n, 2n)).toBe(1)
    expect(roundRatio(-1n, 2n)).toBe(-1)
    expect(roundRatio(-2n, 3n)).toBe(-1)
    expect(() => roundRatio(1n, 0n)).toThrow('denominator must be positive')
  })

  it('splits a tax-inclusive amount without losing cents', () => {
    expect(splitGross(121, 2100)).toEqual({ netCents: 100, taxCents: 21, grossCents: 121, taxRateBasisPoints: 2100 })
    expect(splitGross(100, 0)).toEqual({ netCents: 100, taxCents: 0, grossCents: 100, taxRateBasisPoints: 0 })
    expect(splitGross(20_000, 10_000)).toEqual({
      netCents: 10_000,
      taxCents: 10_000,
      grossCents: 20_000,
      taxRateBasisPoints: 10_000
    })
    expect(() => splitGross(-1, 2100)).toThrow('grossCents cannot be negative')
    expect(() => splitGross(1.1, 2100)).toThrow('grossCents must be a safe integer')
    expect(() => splitGross(100, 10_001)).toThrow('taxRateBasisPoints must be between 0 and 10000')
    expect(() => splitGross(100, -1)).toThrow('taxRateBasisPoints must be between 0 and 10000')
    expect(() => splitGross(100, 2.1)).toThrow('taxRateBasisPoints must be a safe integer')
  })

  it('enforces minimum, maximum and increments', () => {
    expect(validateQuantity(1, {})).toBeUndefined()
    expect(validateQuantity(5, { minimumQuantity: 3, maximumQuantity: 9, quantityIncrement: 2 })).toBeUndefined()
    expect(validateQuantity(9, { maximumQuantity: 9 })).toBeUndefined()
    expect(validateQuantity(5, { minimumQuantity: 2, quantityIncrement: 3 })).toBeUndefined()
    expect(() => validateQuantity(2, { minimumQuantity: 3 })).toThrow('quantity must be at least 3')
    expect(() => validateQuantity(10, { maximumQuantity: 9 })).toThrow('quantity must not exceed 9')
    expect(() => validateQuantity(4, { minimumQuantity: 3, quantityIncrement: 2 })).toThrow(
      'quantity must increase by 2 from 3'
    )
    expect(() => validateQuantity(1.5, {})).toThrow('quantity must be a safe integer')
    expect(() => validateQuantity(1, { minimumQuantity: 0 })).toThrow('minimumQuantity must be positive')
    expect(() => validateQuantity(1, { minimumQuantity: 1.1 })).toThrow('minimumQuantity must be a safe integer')
    expect(() => validateQuantity(1, { quantityIncrement: 0 })).toThrow('quantityIncrement must be positive')
    expect(() => validateQuantity(1, { quantityIncrement: 1.1 })).toThrow('quantityIncrement must be a safe integer')
    expect(() => validateQuantity(1, { maximumQuantity: 0 })).toThrow('maximumQuantity must be positive')
    expect(() => validateQuantity(1, { maximumQuantity: 1.1 })).toThrow('maximumQuantity must be a safe integer')
  })

  it('selects volume prices at exact boundaries and rejects malformed scales', () => {
    const tiers = [
      { minimumQuantity: 10, unitGrossCents: 950 },
      { minimumQuantity: 25, unitGrossCents: 900 }
    ]
    expect(selectVolumeUnitPrice(1000, 1, tiers)).toBe(1000)
    expect(selectVolumeUnitPrice(1000, 10, tiers)).toBe(950)
    expect(selectVolumeUnitPrice(1000, 24, tiers)).toBe(950)
    expect(selectVolumeUnitPrice(1000, 25, tiers)).toBe(900)
    expect(() => selectVolumeUnitPrice(1.5, 1, [])).toThrow('baseGrossCents must be a safe integer')
    expect(() => selectVolumeUnitPrice(1, 1.5, [])).toThrow('quantity must be a safe integer')
    expect(() => selectVolumeUnitPrice(-1, 1, [])).toThrow('baseGrossCents cannot be negative')
    expect(() => selectVolumeUnitPrice(1, 0, [])).toThrow('quantity must be positive')
    expect(() => selectVolumeUnitPrice(100, 1, [{ minimumQuantity: 1.5, unitGrossCents: 90 }])).toThrow(
      'tier.minimumQuantity must be a safe integer'
    )
    expect(() => selectVolumeUnitPrice(100, 1, [{ minimumQuantity: 2, unitGrossCents: 1.5 }])).toThrow(
      'tier.unitGrossCents must be a safe integer'
    )
    expect(() =>
      selectVolumeUnitPrice(100, 2, [
        { minimumQuantity: 2, unitGrossCents: 90 },
        { minimumQuantity: 2, unitGrossCents: 80 }
      ])
    ).toThrow('volume tiers must have strictly increasing minimum quantities')
    expect(() => selectVolumeUnitPrice(100, 2, [{ minimumQuantity: 2, unitGrossCents: -1 }])).toThrow(
      'tier.unitGrossCents cannot be negative'
    )
    expect(() => selectVolumeUnitPrice(100, 2, [{ minimumQuantity: 2, unitGrossCents: 101 }])).toThrow(
      'volume tier prices cannot increase'
    )
  })

  it('quotes a line from server-side values', () => {
    expect(
      quoteLine({
        variantId: 'variant-1',
        sku: 'SKU-1',
        quantity: 2,
        unitGrossCents: 121,
        discountGrossCents: 24,
        taxRateBasisPoints: 2100
      })
    ).toEqual({
      variantId: 'variant-1',
      sku: 'SKU-1',
      quantity: 2,
      unitGrossCents: 121,
      discountGrossCents: 24,
      netCents: 180,
      taxCents: 38,
      grossCents: 218,
      taxRateBasisPoints: 2100
    })
    expect(() =>
      quoteLine({ variantId: 'v', sku: 's', quantity: 1, unitGrossCents: -1, taxRateBasisPoints: 2100 })
    ).toThrow('prices and discounts cannot be negative')
    expect(() =>
      quoteLine({
        variantId: 'v',
        sku: 's',
        quantity: 1,
        unitGrossCents: 1,
        discountGrossCents: -1,
        taxRateBasisPoints: 2100
      })
    ).toThrow('prices and discounts cannot be negative')
    expect(() =>
      quoteLine({
        variantId: 'v',
        sku: 's',
        quantity: 1,
        unitGrossCents: 1,
        discountGrossCents: 2,
        taxRateBasisPoints: 2100
      })
    ).toThrow('discount cannot exceed line gross amount')
    expect(() =>
      quoteLine({ variantId: 'v', sku: 's', quantity: 1, unitGrossCents: 1.1, taxRateBasisPoints: 2100 })
    ).toThrow('unitGrossCents must be a safe integer')
    expect(() =>
      quoteLine({
        variantId: 'v',
        sku: 's',
        quantity: 1,
        unitGrossCents: 1,
        discountGrossCents: 0.1,
        taxRateBasisPoints: 2100
      })
    ).toThrow('discountGrossCents must be a safe integer')
    expect(() =>
      quoteLine({
        variantId: 'v',
        sku: 's',
        quantity: Number.MAX_SAFE_INTEGER,
        unitGrossCents: 2,
        taxRateBasisPoints: 2100
      })
    ).toThrow('lineGrossCents must be a safe integer')
  })

  it('calculates one contractual quote for every consumer', () => {
    const quote = calculateQuote({
      pricingVersion: '2026-08-12T00:00:00Z',
      lines: [
        { variantId: 'v1', sku: 'ONE', quantity: 2, unitGrossCents: 121, taxRateBasisPoints: 2100 },
        {
          variantId: 'v2',
          sku: 'TWO',
          quantity: 1,
          unitGrossCents: 110,
          taxRateBasisPoints: 1000,
          discountGrossCents: 10
        }
      ],
      shippingGrossCents: 590,
      shippingTaxRateBasisPoints: 2100
    })
    expect(quote).toMatchObject({
      currency: 'EUR',
      pricingVersion: '2026-08-12T00:00:00Z',
      subtotalNetCents: 291,
      discountGrossCents: 10,
      taxCents: 153,
      totalGrossCents: 932
    })
    expect(quote.shipping).toEqual({ netCents: 488, taxCents: 102, grossCents: 590, taxRateBasisPoints: 2100 })
    expect(
      calculateQuote({
        currency: 'EUR',
        pricingVersion: 'v1',
        lines: [{ variantId: 'v', sku: 's', quantity: 1, unitGrossCents: 0, taxRateBasisPoints: 0 }],
        shippingGrossCents: 0,
        shippingTaxRateBasisPoints: 0
      }).currency
    ).toBe('EUR')
    expect(() =>
      calculateQuote({ pricingVersion: 'v1', lines: [], shippingGrossCents: 0, shippingTaxRateBasisPoints: 0 })
    ).toThrow('quote requires at least one line')
  })
})
