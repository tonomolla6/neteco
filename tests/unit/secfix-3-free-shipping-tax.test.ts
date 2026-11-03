import { describe, expect, it } from 'vitest'
import { evaluateFreeShippingProgress } from '../../shared/free-shipping-progress'

// SECFIX-3 finding 21: net amounts must use each line's VAT rate (integer basis points), not a fixed 1.21.
describe('SECFIX-3 free shipping net derivation', () => {
  const base = {
    subtotalGrossCents: 11000,
    thresholdGrossCents: 10000,
    minMarginBasisPoints: 500,
    shippingNetCents: 0
  }

  it('derives net from a reduced 10% VAT line instead of assuming 21%', () => {
    const result = evaluateFreeShippingProgress({
      ...base,
      items: [
        { variantId: 'v-10', quantity: 1, unitGrossCents: 11000, taxRateBasisPoints: 1000, costUnitNetCents: 9000 }
      ]
    })
    // net 10000, cost 9000 => 10% margin >= 5% floor; with /1.21 the net would be 9091 (1% margin).
    expect(result.reason).not.toBe('margin_floor')
    expect(result.eligible).toBe(true)
  })

  it('uses the supplied standard 21% rate for margin checks', () => {
    const result = evaluateFreeShippingProgress({
      ...base,
      items: [
        { variantId: 'v-21', quantity: 1, unitGrossCents: 11000, taxRateBasisPoints: 2100, costUnitNetCents: 9000 }
      ]
    })
    expect(result.reason).toBe('margin_floor')
  })

  it('does not grant a margin-based promotion when net price and tax rate are both unknown', () => {
    const result = evaluateFreeShippingProgress({
      ...base,
      items: [{ variantId: 'v-unknown', quantity: 1, unitGrossCents: 11000, costUnitNetCents: 5000 }]
    })
    expect(result.eligible).toBe(false)
    expect(result.reason).toBe('tax_unknown')
  })
})
