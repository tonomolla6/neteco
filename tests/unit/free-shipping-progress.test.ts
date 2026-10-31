import { describe, expect, it } from 'vitest'
import { evaluateFreeShippingProgress, type FreeShippingCartLine } from '../../shared/free-shipping-progress'

const baseLine = (over: Partial<FreeShippingCartLine> = {}): FreeShippingCartLine => ({
  variantId: 'v-100',
  quantity: 2,
  unitGrossCents: 2500, // 25 € -> line 50 €
  unitNetCents: 2066,
  costUnitNetCents: 1200,
  weightGrams: 500,
  profileKind: 'parcel',
  ...over
})

describe('MKT-022: Free Shipping Threshold and Contextual Progress', () => {
  const threshold = 15000 // 150.00 €

  describe('Standard Peninsular Parcel (Eligible)', () => {
    it('returns not_applicable when cart is empty or subtotal is zero', () => {
      const res = evaluateFreeShippingProgress({
        items: [],
        subtotalGrossCents: 0,
        thresholdGrossCents: threshold,
        destinationPostalCode: '28001'
      })
      expect(res.status).toBe('not_applicable')
      expect(res.eligible).toBe(false)
      expect(res.canBecomeFree).toBe(true)
      expect(res.progressPercent).toBe(0)
      expect(res.missingCents).toBe(threshold)
      expect(res.badgeText).toContain('Envío gratis')
    })

    it('calculates progress and missing amount accurately when below threshold', () => {
      const res = evaluateFreeShippingProgress({
        items: [baseLine({ quantity: 1, unitGrossCents: 6000 })], // 60 €
        subtotalGrossCents: 6000,
        thresholdGrossCents: threshold,
        destinationPostalCode: '28001'
      })
      expect(res.status).toBe('in_progress')
      expect(res.eligible).toBe(true)
      expect(res.canBecomeFree).toBe(true)
      expect(res.progressPercent).toBe(40) // 60 / 150 = 40%
      expect(res.missingCents).toBe(9000) // 90.00 €
      expect(res.message).toMatch(/90/)
      expect(res.reason).toBe('below_threshold')
    })

    it('handles exact boundary: 1 cent below threshold', () => {
      const res = evaluateFreeShippingProgress({
        items: [baseLine({ quantity: 1, unitGrossCents: 14999 })],
        subtotalGrossCents: 14999,
        thresholdGrossCents: threshold,
        destinationPostalCode: '28001'
      })
      expect(res.status).toBe('in_progress')
      expect(res.eligible).toBe(true)
      expect(res.missingCents).toBe(1)
      expect(res.progressPercent).toBe(99)
    })

    it('marks threshold as reached and 100% when subtotal meets threshold', () => {
      const res = evaluateFreeShippingProgress({
        items: [baseLine({ quantity: 3, unitGrossCents: 5000 })], // 150 €
        subtotalGrossCents: 15000,
        thresholdGrossCents: threshold,
        destinationPostalCode: '28001'
      })
      expect(res.status).toBe('reached')
      expect(res.eligible).toBe(true)
      expect(res.canBecomeFree).toBe(true)
      expect(res.progressPercent).toBe(100)
      expect(res.missingCents).toBe(0)
      expect(res.reason).toBe('granted')
      expect(res.message).toContain('alcanzado el umbral')
    })

    it('caps progress at 100% when subtotal exceeds threshold', () => {
      const res = evaluateFreeShippingProgress({
        items: [baseLine({ quantity: 4, unitGrossCents: 5000 })], // 200 €
        subtotalGrossCents: 20000,
        thresholdGrossCents: threshold,
        destinationPostalCode: '28001'
      })
      expect(res.status).toBe('reached')
      expect(res.progressPercent).toBe(100)
      expect(res.missingCents).toBe(0)
    })
  })

  describe('ADR Exclusion — Never promises free shipping', () => {
    it('excludes cart when containing an ADR chemical item, even with high cart value', () => {
      const res = evaluateFreeShippingProgress({
        items: [
          baseLine({ profileKind: 'adr', unitGrossCents: 20000 }) // 200 € ADR item
        ],
        subtotalGrossCents: 20000,
        thresholdGrossCents: threshold,
        destinationPostalCode: '28001'
      })
      expect(res.status).toBe('excluded')
      expect(res.eligible).toBe(false)
      expect(res.canBecomeFree).toBe(false)
      expect(res.reason).toBe('adr_excluded')
      expect(res.progressPercent).toBe(0)
      expect(res.missingCents).toBe(0)
      expect(res.message).toMatch(/ADR|peligrosas/i)
      expect(res.message).not.toContain('alcanzado el umbral')
    })

    it('excludes mixed basket containing both standard items and an ADR item', () => {
      const res = evaluateFreeShippingProgress({
        items: [
          baseLine({ profileKind: 'parcel', unitGrossCents: 14000 }),
          baseLine({ profileKind: 'adr', unitGrossCents: 3000 })
        ],
        subtotalGrossCents: 17000,
        thresholdGrossCents: threshold,
        destinationPostalCode: '28001'
      })
      expect(res.status).toBe('excluded')
      expect(res.reason).toBe('adr_excluded')
      expect(res.canBecomeFree).toBe(false)
    })
  })

  describe('Pallet Exclusion — Weight > 20 kg or explicit pallet item', () => {
    it('excludes basket when an item explicitly requires pallet handling', () => {
      const res = evaluateFreeShippingProgress({
        items: [baseLine({ profileKind: 'pallet', unitGrossCents: 18000, weightGrams: 5000 })],
        subtotalGrossCents: 18000,
        thresholdGrossCents: threshold,
        destinationPostalCode: '28001'
      })
      expect(res.status).toBe('excluded')
      expect(res.eligible).toBe(false)
      expect(res.canBecomeFree).toBe(false)
      expect(res.reason).toBe('pallet_excluded')
      expect(res.message).toMatch(/palé|palet/i)
    })

    it('excludes basket when aggregate weight exceeds parcel threshold of 20 kg', () => {
      const res = evaluateFreeShippingProgress({
        items: [
          baseLine({ quantity: 5, weightGrams: 4500, unitGrossCents: 3500 }) // 22.5 kg total
        ],
        subtotalGrossCents: 17500,
        thresholdGrossCents: threshold,
        destinationPostalCode: '28001'
      })
      expect(res.status).toBe('excluded')
      expect(res.reason).toBe('pallet_excluded')
      expect(res.message).toContain('20 kg')
    })
  })

  describe('Zone Exclusion — Islands, Enclaves and Non-peninsular', () => {
    it.each([
      ['07001', 'Baleares'],
      ['35001', 'Las Palmas'],
      ['38001', 'Santa Cruz de Tenerife'],
      ['51001', 'Ceuta'],
      ['52001', 'Melilla'],
      ['99999', 'Código postal inválido']
    ])('excludes destination in %s (%s) from peninsular free shipping', (postalCode, _name) => {
      const res = evaluateFreeShippingProgress({
        items: [baseLine({ unitGrossCents: 18000 })],
        subtotalGrossCents: 18000,
        thresholdGrossCents: threshold,
        destinationPostalCode: postalCode
      })
      expect(res.status).toBe('excluded')
      expect(res.eligible).toBe(false)
      expect(res.reason).toBe('zone_excluded')
      expect(res.canBecomeFree).toBe(false)
      expect(res.message).toMatch(/Península|fuera de península/i)
    })

    it('accepts valid peninsular postal codes', () => {
      for (const cp of ['28001', '46001', '08001', '41001', '48001']) {
        const res = evaluateFreeShippingProgress({
          items: [baseLine({ unitGrossCents: 18000 })],
          subtotalGrossCents: 18000,
          thresholdGrossCents: threshold,
          destinationPostalCode: cp
        })
        expect(res.status).toBe('reached')
        expect(res.eligible).toBe(true)
      }
    })
  })

  describe('Margin Floor & Cost Unknown Protection', () => {
    it('denies free shipping when absorbing shipping would breach the required margin floor', () => {
      // Net goods = 100.00 €, Cost = 95.00 €, Shipping net = 8.00 € -> Margin would be negative (-3.00 €)
      const res = evaluateFreeShippingProgress({
        items: [
          baseLine({
            quantity: 1,
            unitGrossCents: 12100,
            unitNetCents: 10000,
            costUnitNetCents: 9500
          })
        ],
        subtotalGrossCents: 12100,
        thresholdGrossCents: 10000,
        destinationPostalCode: '28001',
        shippingNetCents: 800,
        minMarginBasisPoints: 1500 // requires 15% margin
      })
      expect(res.status).toBe('excluded')
      expect(res.reason).toBe('margin_floor')
      expect(res.eligible).toBe(false)
      expect(res.message).toMatch(/margen/i)
    })

    it('fails closed when goods cost is unknown and margin check is active', () => {
      const res = evaluateFreeShippingProgress({
        items: [
          baseLine({
            quantity: 1,
            unitGrossCents: 15000,
            unitNetCents: 12397,
            costUnitNetCents: null
          })
        ],
        subtotalGrossCents: 15000,
        thresholdGrossCents: 10000,
        destinationPostalCode: '28001',
        shippingNetCents: 600,
        minMarginBasisPoints: 1000
      })
      expect(res.status).toBe('excluded')
      expect(res.reason).toBe('cost_unknown')
    })
  })

  describe('Conscious Subsidy Override for Special Cases', () => {
    it('grants free shipping for pallet when a conscious subsidy rule covers it', () => {
      const res = evaluateFreeShippingProgress({
        items: [
          baseLine({
            profileKind: 'pallet',
            quantity: 1,
            unitGrossCents: 20000,
            unitNetCents: 16529,
            costUnitNetCents: 5000
          })
        ],
        subtotalGrossCents: 20000,
        thresholdGrossCents: threshold,
        destinationPostalCode: '28001',
        activeRule: {
          id: 'rule-cs-1',
          code: 'PALLET_VIP',
          status: 'active',
          version: 1,
          profile: 'pallet',
          zone: 'peninsular',
          customerProfile: 'any',
          thresholdGrossCents: 15000,
          minMarginBasisPoints: 0,
          consciousSubsidy: true,
          subsidyCapNetCents: 5000,
          subsidyReason: 'Subsidio comercial pallet autorizado'
        },
        shippingNetCents: 4500
      })
      expect(res.status).toBe('reached')
      expect(res.eligible).toBe(true)
      expect(res.reason).toBe('granted')
    })
  })
})
