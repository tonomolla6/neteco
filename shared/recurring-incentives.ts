import { z } from 'zod'

export const SPANISH_LIVA_RAPPEL_FISCAL_CLAUSE =
  'Acuerdo de rappel por volumen comercial documentado conforme al Art. 80.Uno.1ª y 80.Dos de la Ley 37/1992 del IVA. Regularización de bases imponibles y rectificación de cuota tributaria mediante factura rectificativa (abono) con desglose de IVA repercutido.'

export const volumeTierSchema = z.object({
  minVolumeCents: z.number().int().min(0),
  rebatePercentBasisPoints: z.number().int().min(1).max(3000) // 0.01% - 30%
})

export type VolumeTier = z.infer<typeof volumeTierSchema>

export const PERIOD_FREQUENCIES = ['quarterly', 'annual'] as const
export const FISCAL_VAT_TREATMENTS = ['credit_note_art80_liva', 'commercial_discount_subsequent_invoice'] as const
export const FISCAL_REVIEW_STATUSES = ['pending_review', 'fiscal_approved', 'fiscal_rejected'] as const
export const AGREEMENT_STATUSES = ['draft', 'active', 'suspended', 'terminated'] as const
export const SETTLEMENT_STATUSES = ['calculated', 'approved', 'credit_issued', 'rejected'] as const

export const createIncentiveAgreementSchema = z.object({
  companyId: z.string().min(1).max(64),
  contractRef: z.string().min(5).max(64),
  contractTermsVersion: z.string().min(2).max(32),
  contractSignedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'contractSignedAt debe tener formato ISO YYYY-MM-DDTHH:MM:SSZ'),
  periodFrequency: z.enum(PERIOD_FREQUENCIES),
  volumeTiers: z.array(volumeTierSchema).min(1).max(10),
  minGrossMarginBasisPoints: z.number().int().min(500).max(5000).default(2000),
  slaPunctualPaymentRequired: z.boolean().default(true),
  slaMinAvgOrderNetCents: z.number().int().min(0).default(0),
  slaEinvoiceRequired: z.boolean().default(true),
  fiscalNotes: z.string().min(10).max(1000),
  fiscalVatTreatment: z.enum(FISCAL_VAT_TREATMENTS).default('credit_note_art80_liva'),
  status: z.enum(AGREEMENT_STATUSES).default('active')
})

export type CreateIncentiveAgreementInput = z.infer<typeof createIncentiveAgreementSchema>

export const updateIncentiveAgreementSchema = createIncentiveAgreementSchema.partial().extend({
  version: z.number().int().min(1)
})

export type UpdateIncentiveAgreementInput = z.infer<typeof updateIncentiveAgreementSchema>

export interface IncentiveAgreement {
  id: string
  companyId: string
  contractRef: string
  contractTermsVersion: string
  contractSignedAt: string
  periodFrequency: 'quarterly' | 'annual'
  volumeTiers: VolumeTier[]
  minGrossMarginBasisPoints: number
  slaPunctualPaymentRequired: boolean
  slaMinAvgOrderNetCents: number
  slaEinvoiceRequired: boolean
  fiscalNotes: string
  fiscalVatTreatment: 'credit_note_art80_liva' | 'commercial_discount_subsequent_invoice'
  fiscalReviewStatus: 'pending_review' | 'fiscal_approved' | 'fiscal_rejected'
  fiscalReviewedBy: string | null
  fiscalReviewedAt: string | null
  status: 'draft' | 'active' | 'suspended' | 'terminated'
  version: number
  createdAt: string
  updatedAt: string
}

export interface IncentiveSettlement {
  id: string
  agreementId: string
  companyId: string
  settlementPeriod: string
  periodStart: string
  periodEnd: string
  qualifyingTurnoverNetCents: number
  marginAchievedBasisPoints: number
  marginThresholdMet: boolean
  slaPaymentMet: boolean
  slaOrderSizeMet: boolean
  slaEinvoiceMet: boolean
  slaConditionsAllMet: boolean
  appliedRebateBasisPoints: number
  rebateNetCents: number
  vatTaxRatePercent: number
  vatTaxCents: number
  totalCreditGrossCents: number
  settlementStatus: 'calculated' | 'approved' | 'credit_issued' | 'rejected'
  creditNoteRef: string | null
  fiscalApprovalIdentityId: string | null
  fiscalApprovalAt: string | null
  notes: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export function calculateTieredRebateBasisPoints(turnoverNetCents: number, tiers: VolumeTier[]): number {
  const sortedTiers = [...tiers].sort((a, b) => b.minVolumeCents - a.minVolumeCents)
  for (const tier of sortedTiers) {
    if (turnoverNetCents >= tier.minVolumeCents) {
      return tier.rebatePercentBasisPoints
    }
  }
  return 0
}

export interface SettlementCalculationInput {
  qualifyingTurnoverNetCents: number
  volumeTiers: VolumeTier[]
  marginAchievedBasisPoints: number
  minGrossMarginBasisPoints: number
  slaPaymentMet: boolean
  slaOrderSizeMet: boolean
  slaEinvoiceMet: boolean
}

export interface SettlementCalculationResult {
  marginThresholdMet: boolean
  slaConditionsAllMet: boolean
  appliedRebateBasisPoints: number
  rebateNetCents: number
  vatTaxRatePercent: number
  vatTaxCents: number
  totalCreditGrossCents: number
}

export function computeSettlementCalculation(input: SettlementCalculationInput): SettlementCalculationResult {
  const marginThresholdMet = input.marginAchievedBasisPoints >= input.minGrossMarginBasisPoints
  const slaConditionsAllMet = input.slaPaymentMet && input.slaOrderSizeMet && input.slaEinvoiceMet

  if (!marginThresholdMet) {
    // If gross margin is below safety floor, rebate is completely zeroed to prevent negative margins
    return {
      marginThresholdMet: false,
      slaConditionsAllMet,
      appliedRebateBasisPoints: 0,
      rebateNetCents: 0,
      vatTaxRatePercent: 21,
      vatTaxCents: 0,
      totalCreditGrossCents: 0
    }
  }

  const baseTierRebateBps = calculateTieredRebateBasisPoints(input.qualifyingTurnoverNetCents, input.volumeTiers)

  // If SLA breached (e.g. overdue payments), penalize rebate by 50%
  const appliedRebateBasisPoints = slaConditionsAllMet ? baseTierRebateBps : Math.round(baseTierRebateBps / 2)

  const rebateNetCents = Math.round((input.qualifyingTurnoverNetCents * appliedRebateBasisPoints) / 10000)
  const vatTaxRatePercent = 21
  const vatTaxCents = Math.round((rebateNetCents * 21) / 100)
  const totalCreditGrossCents = rebateNetCents + vatTaxCents

  return {
    marginThresholdMet: true,
    slaConditionsAllMet,
    appliedRebateBasisPoints,
    rebateNetCents,
    vatTaxRatePercent,
    vatTaxCents,
    totalCreditGrossCents
  }
}
