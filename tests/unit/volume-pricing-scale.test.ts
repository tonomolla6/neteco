import { describe, expect, it } from 'vitest'
import {
  buildVolumePricingScale,
  calculateVolumePricingBreakdown,
  verifyVolumePricingContractMatch,
  type VolumePriceTierWithMultiple
} from '../../shared/volume-pricing-scale'

describe('MKT-023: Promociones por volumen y escalas claras', () => {
  const baseGrossCents = 5000 // 50.00 € / ud
  const taxRateBasisPoints = 2100 // 21% IVA
  const tiers: VolumePriceTierWithMultiple[] = [
    { minimumQuantity: 6, unitGrossCents: 4500, packagingMultiple: 6, label: 'Caja de 6 uds' }, // 10% desc
    { minimumQuantity: 12, unitGrossCents: 4000, packagingMultiple: 12, label: 'Pack 2 cajas (12 uds)' }, // 20% desc
    { minimumQuantity: 24, unitGrossCents: 3500, packagingMultiple: 24, label: 'Lote mayorista (24 uds)' } // 30% desc
  ]

  describe('Scale Building and Table Display Before Purchase', () => {
    it('generates clear scale entries including base tier and non-increasing tiers', () => {
      const scale = buildVolumePricingScale({
        baseGrossCents,
        taxRateBasisPoints,
        tiers,
        currentQuantity: 1
      })

      expect(scale).toHaveLength(4)
      // Tier 0: Base
      expect(scale[0]).toMatchObject({
        tierIndex: 0,
        minimumQuantity: 1,
        maximumQuantity: 5,
        unitGrossCents: 5000,
        effectiveDiscountPercent: 0,
        effectiveUnitDiscountGrossCents: 0,
        isActive: true
      })
      // Tier 1: 6-11
      expect(scale[1]).toMatchObject({
        tierIndex: 1,
        minimumQuantity: 6,
        maximumQuantity: 11,
        packagingMultiple: 6,
        unitGrossCents: 4500,
        effectiveDiscountPercent: 10,
        effectiveUnitDiscountGrossCents: 500,
        sampleTotalSavingsGrossCents: 3000, // 6 * 5.00 = 30.00 € savings
        isActive: false
      })
      // Tier 2: 12-23
      expect(scale[2]).toMatchObject({
        tierIndex: 2,
        minimumQuantity: 12,
        maximumQuantity: 23,
        unitGrossCents: 4000,
        effectiveDiscountPercent: 20,
        effectiveUnitDiscountGrossCents: 1000,
        sampleTotalSavingsGrossCents: 12000,
        isActive: false
      })
      // Tier 3: 24+
      expect(scale[3]).toMatchObject({
        tierIndex: 3,
        minimumQuantity: 24,
        maximumQuantity: null,
        unitGrossCents: 3500,
        effectiveDiscountPercent: 30,
        effectiveUnitDiscountGrossCents: 1500,
        sampleTotalSavingsGrossCents: 36000,
        isActive: false
      })
    })

    it('highlights active tier dynamically based on current cart/input quantity', () => {
      const scaleFor8 = buildVolumePricingScale({
        baseGrossCents,
        taxRateBasisPoints,
        tiers,
        currentQuantity: 8
      })
      expect(scaleFor8[0]!.isActive).toBe(false)
      expect(scaleFor8[1]!.isActive).toBe(true) // 6-11
      expect(scaleFor8[2]!.isActive).toBe(false)
      expect(scaleFor8[3]!.isActive).toBe(false)

      const scaleFor30 = buildVolumePricingScale({
        baseGrossCents,
        taxRateBasisPoints,
        tiers,
        currentQuantity: 30
      })
      expect(scaleFor30[3]!.isActive).toBe(true) // 24+
    })

    it('validates strictly increasing quantities and non-increasing prices', () => {
      expect(() =>
        buildVolumePricingScale({
          baseGrossCents: 1000,
          taxRateBasisPoints: 2100,
          tiers: [{ minimumQuantity: 5, unitGrossCents: 1200 }] // Price increases: invalid
        })
      ).toThrow(/volume tier prices cannot increase/i)

      expect(() =>
        buildVolumePricingScale({
          baseGrossCents: 1000,
          taxRateBasisPoints: 2100,
          tiers: [
            { minimumQuantity: 5, unitGrossCents: 800 },
            { minimumQuantity: 5, unitGrossCents: 700 } // Duplicate min qty
          ]
        })
      ).toThrow(/strictly increasing/i)
    })
  })

  describe('Volume Pricing Engine Calculation & Next Tier Incentives', () => {
    it('calculates full line breakdown with net, tax and effective discounts for active tier', () => {
      // 8 units: matches tier 1 (45.00 €/ud, base 50.00 €/ud)
      const breakdown = calculateVolumePricingBreakdown({
        baseGrossCents,
        quantity: 8,
        taxRateBasisPoints,
        tiers
      })

      expect(breakdown.effectiveUnitGrossCents).toBe(4500)
      expect(breakdown.unitDiscountGrossCents).toBe(500)
      expect(breakdown.totalDiscountGrossCents).toBe(4000) // 8 * 500 = 40.00 €
      expect(breakdown.totalGrossCents).toBe(36000) // 8 * 4500 = 360.00 €

      // Net + tax reconciliation
      expect(breakdown.totalGrossCents).toBe(breakdown.totalNetCents + breakdown.totalTaxCents)

      // Next tier incentive: 4 units needed to reach 12 units (20% discount)
      expect(breakdown.nextTierIncentive).toBeDefined()
      expect(breakdown.nextTierIncentive?.additionalQuantityNeeded).toBe(4)
      expect(breakdown.nextTierIncentive?.nextTierMinQty).toBe(12)
      expect(breakdown.nextTierIncentive?.nextTierUnitGrossCents).toBe(4000)
      expect(breakdown.nextTierIncentive?.message).toMatch(/4 unidades más.*ahorrar.*20/i)
    })

    it('returns null nextTierIncentive when already at highest tier', () => {
      const breakdown = calculateVolumePricingBreakdown({
        baseGrossCents,
        quantity: 30,
        taxRateBasisPoints,
        tiers
      })
      expect(breakdown.appliedTierMinQty).toBe(24)
      expect(breakdown.nextTierIncentive).toBeNull()
    })
  })

  describe('Contractual Match: Pricing Engine -> Order Snapshot -> Invoice Line', () => {
    it('guarantees exact triple match across pricing engine, order line and invoice line', () => {
      const quantity = 15 // matches tier 2 (40.00 €/ud, 20% discount)
      const engineBreakdown = calculateVolumePricingBreakdown({
        baseGrossCents,
        quantity,
        taxRateBasisPoints,
        tiers
      })

      // Simulated order line snapshot created from engine
      const orderLine = {
        lineIndex: 0,
        sku: 'ECO-DESENG-05L',
        name: 'Desengrasante Ecológico 5L',
        quantity,
        unitGrossCents: baseGrossCents, // contractual base unit price
        effectiveUnitGrossCents: engineBreakdown.effectiveUnitGrossCents,
        discountGrossCents: engineBreakdown.totalDiscountGrossCents,
        netCents: engineBreakdown.totalNetCents,
        taxCents: engineBreakdown.totalTaxCents,
        grossCents: engineBreakdown.totalGrossCents,
        taxRateBasisPoints
      }

      // Simulated fiscal invoice line created from order line
      const invoiceLine = {
        lineIndex: 0,
        sku: 'ECO-DESENG-05L',
        description: 'Desengrasante Ecológico 5L (Escala por volumen: 15 uds @ 40,00 €)',
        quantity,
        unitPriceNetCents: engineBreakdown.effectiveUnitNetCents,
        unitGrossCents: engineBreakdown.effectiveUnitGrossCents,
        discountNetCents: engineBreakdown.totalDiscountNetCents,
        discountGrossCents: engineBreakdown.totalDiscountGrossCents,
        netCents: engineBreakdown.totalNetCents,
        taxCents: engineBreakdown.totalTaxCents,
        grossCents: engineBreakdown.totalGrossCents,
        taxRateBasisPoints
      }

      const match = verifyVolumePricingContractMatch({
        engine: engineBreakdown,
        orderLine,
        invoiceLine
      })

      expect(match.isConsistent).toBe(true)
      expect(match.discrepancies).toHaveLength(0)
      expect(match.summary.grossMatches).toBe(true)
      expect(match.summary.netMatches).toBe(true)
      expect(match.summary.taxMatches).toBe(true)
      expect(match.summary.discountMatches).toBe(true)
    })

    it('detects and flags discrepancies if order or invoice line diverges from pricing engine', () => {
      const engineBreakdown = calculateVolumePricingBreakdown({
        baseGrossCents,
        quantity: 10,
        taxRateBasisPoints,
        tiers
      })

      // Tampered order line with 1 cent rounding drift
      const corruptedOrderLine = {
        lineIndex: 0,
        sku: 'ECO-01',
        name: 'Item',
        quantity: 10,
        unitGrossCents: baseGrossCents,
        effectiveUnitGrossCents: 4500,
        discountGrossCents: 5000,
        netCents: engineBreakdown.totalNetCents - 1, // corrupted
        taxCents: engineBreakdown.totalTaxCents,
        grossCents: engineBreakdown.totalGrossCents - 1,
        taxRateBasisPoints
      }

      const invoiceLine = {
        lineIndex: 0,
        sku: 'ECO-01',
        description: 'Item',
        quantity: 10,
        unitPriceNetCents: engineBreakdown.effectiveUnitNetCents,
        unitGrossCents: 4500,
        discountNetCents: engineBreakdown.totalDiscountNetCents,
        discountGrossCents: 5000,
        netCents: engineBreakdown.totalNetCents,
        taxCents: engineBreakdown.totalTaxCents,
        grossCents: engineBreakdown.totalGrossCents,
        taxRateBasisPoints
      }

      const match = verifyVolumePricingContractMatch({
        engine: engineBreakdown,
        orderLine: corruptedOrderLine,
        invoiceLine
      })

      expect(match.isConsistent).toBe(false)
      expect(match.discrepancies.length).toBeGreaterThan(0)
      expect(match.discrepancies[0]).toMatch(/discrepancy/i)
    })
  })
})
