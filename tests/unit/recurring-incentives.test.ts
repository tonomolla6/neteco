import { describe, expect, it } from 'vitest'
import {
  calculateTieredRebateBasisPoints,
  computeSettlementCalculation,
  createIncentiveAgreementSchema,
  SPANISH_LIVA_RAPPEL_FISCAL_CLAUSE,
  type VolumeTier
} from '../../shared/recurring-incentives'

describe('MKT-036: Recurring B2B Incentives (Domain Logic)', () => {
  const sampleVolumeTiers: VolumeTier[] = [
    { minVolumeCents: 300000, rebatePercentBasisPoints: 200 }, // €3,000 -> 2%
    { minVolumeCents: 1000000, rebatePercentBasisPoints: 400 }, // €10,000 -> 4%
    { minVolumeCents: 2500000, rebatePercentBasisPoints: 600 } // €25,000 -> 6%
  ]

  const validAgreement = {
    companyId: 'comp-turia-lavanderia',
    contractRef: 'CTR-B2B-2026-TURIA-01',
    contractTermsVersion: '2026.1',
    contractSignedAt: '2026-01-15T10:00:00Z',
    periodFrequency: 'quarterly' as const,
    volumeTiers: sampleVolumeTiers,
    minGrossMarginBasisPoints: 2000, // 20%
    slaPunctualPaymentRequired: true,
    slaMinAvgOrderNetCents: 50000,
    slaEinvoiceRequired: true,
    fiscalVatTreatment: 'credit_note_art80_liva' as const,
    fiscalNotes:
      'Acuerdo de rappel comercial trimestral documentado conforme al Art. 80.Uno.1ª Ley 37/1992 del IVA. Emisión mediante factura rectificativa con IVA repercutido desglosado.'
  }

  it('validates legitimate B2B incentive agreement schema', () => {
    const res = createIncentiveAgreementSchema.safeParse(validAgreement)
    expect(res.success).toBe(true)
  })

  it('rejects opaque points or gamification attempts in incentive terms', () => {
    // Attempting to define loyalty points instead of transparent volume tiers
    const withPoints = {
      ...validAgreement,
      pointsMultiplier: 10,
      rewardPoints: 500
    }
    // Zod schema strips unknown properties or rejects if custom fields inserted
    expect(createIncentiveAgreementSchema.safeParse(withPoints).success).toBe(true)
    // Points are not supported or admitted in schema
    const parsed = createIncentiveAgreementSchema.parse(withPoints) as Record<string, unknown>
    expect(parsed.pointsMultiplier).toBeUndefined()
    expect(parsed.rewardPoints).toBeUndefined()
  })

  it('requires signed contract reference and valid fiscal review notes', () => {
    // Missing contract ref
    expect(
      createIncentiveAgreementSchema.safeParse({
        ...validAgreement,
        contractRef: ''
      }).success
    ).toBe(false)

    // Insufficient fiscal notes (< 10 chars)
    expect(
      createIncentiveAgreementSchema.safeParse({
        ...validAgreement,
        fiscalNotes: 'corto'
      }).success
    ).toBe(false)
  })

  it('calculates tiered rebate basis points according to qualifying volume tiers', () => {
    // Below lowest tier (< €3,000) -> 0 bps
    expect(calculateTieredRebateBasisPoints(200000, sampleVolumeTiers)).toBe(0)

    // Tier 1 (€3,000 - €9,999) -> 200 bps (2%)
    expect(calculateTieredRebateBasisPoints(500000, sampleVolumeTiers)).toBe(200)

    // Tier 2 (€10,000 - €24,999) -> 400 bps (4%)
    expect(calculateTieredRebateBasisPoints(1500000, sampleVolumeTiers)).toBe(400)

    // Tier 3 (≥ €25,000) -> 600 bps (6%)
    expect(calculateTieredRebateBasisPoints(3000000, sampleVolumeTiers)).toBe(600)
  })

  it('computes transparent settlement with volume, margin check, SLA compliance and fiscal VAT breakdown', () => {
    const calculation = computeSettlementCalculation({
      qualifyingTurnoverNetCents: 2100000, // €21,000 -> qualifies for Tier 2 (400 bps = 4%)
      volumeTiers: sampleVolumeTiers,
      marginAchievedBasisPoints: 2400, // 24% >= min 20%
      minGrossMarginBasisPoints: 2000,
      slaPaymentMet: true,
      slaOrderSizeMet: true,
      slaEinvoiceMet: true
    })

    expect(calculation.marginThresholdMet).toBe(true)
    expect(calculation.slaConditionsAllMet).toBe(true)
    expect(calculation.appliedRebateBasisPoints).toBe(400) // 4%
    expect(calculation.rebateNetCents).toBe(84000) // €21,000 * 4% = €840.00
    expect(calculation.vatTaxRatePercent).toBe(21)
    expect(calculation.vatTaxCents).toBe(17640) // 21% of 840 = €176.40
    expect(calculation.totalCreditGrossCents).toBe(101640) // €1,016.40
  })

  it('penalizes or blocks rebate if margin falls below threshold or SLA is breached', () => {
    // Margin below threshold (e.g. 15% < 20% required) -> rebate cancelled or zeroed
    const subMargin = computeSettlementCalculation({
      qualifyingTurnoverNetCents: 2100000,
      volumeTiers: sampleVolumeTiers,
      marginAchievedBasisPoints: 1500, // Below min 2000 bps
      minGrossMarginBasisPoints: 2000,
      slaPaymentMet: true,
      slaOrderSizeMet: true,
      slaEinvoiceMet: true
    })
    expect(subMargin.marginThresholdMet).toBe(false)
    expect(subMargin.appliedRebateBasisPoints).toBe(0)
    expect(subMargin.rebateNetCents).toBe(0)

    // SLA breach (overdue payments) -> rebate penalized by 50%
    const slaBreach = computeSettlementCalculation({
      qualifyingTurnoverNetCents: 2100000,
      volumeTiers: sampleVolumeTiers,
      marginAchievedBasisPoints: 2500,
      minGrossMarginBasisPoints: 2000,
      slaPaymentMet: false, // Breached!
      slaOrderSizeMet: true,
      slaEinvoiceMet: true
    })
    expect(slaBreach.slaConditionsAllMet).toBe(false)
    expect(slaBreach.appliedRebateBasisPoints).toBe(200) // Penalized from 400 to 200 bps
    expect(slaBreach.rebateNetCents).toBe(42000)
  })

  it('provides official Spanish LIVA fiscal clause for rappel accounting', () => {
    expect(SPANISH_LIVA_RAPPEL_FISCAL_CLAUSE).toContain('Art. 80')
    expect(SPANISH_LIVA_RAPPEL_FISCAL_CLAUSE).toContain('Ley 37/1992')
    expect(SPANISH_LIVA_RAPPEL_FISCAL_CLAUSE).toContain('factura rectificativa')
  })
})
