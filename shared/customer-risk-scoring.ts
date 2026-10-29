import { z } from 'zod'

export const riskTierSchema = z.enum(['low', 'moderate', 'high', 'critical'])
export type RiskTier = z.infer<typeof riskTierSchema>

export const valueTierSchema = z.enum(['tier_a', 'tier_b', 'tier_c', 'tier_d'])
export type ValueTier = z.infer<typeof valueTierSchema>

export const paymentTermsSchema = z.enum(['prepayment', 'net_15', 'net_30', 'net_60'])
export type PaymentTerms = z.infer<typeof paymentTermsSchema>

export const scoringReviewStatusSchema = z.enum(['automatic', 'under_review', 'reviewed', 'overridden'])
export type ScoringReviewStatus = z.infer<typeof scoringReviewStatusSchema>

export const scoringFactorCategorySchema = z.enum([
  'payment_punctuality',
  'order_volume',
  'claims_returns',
  'company_profile',
  'credit_utilization'
])
export type ScoringFactorCategory = z.infer<typeof scoringFactorCategorySchema>

export const scoringFactorImpactSchema = z.enum(['positive', 'neutral', 'negative'])
export type ScoringFactorImpact = z.infer<typeof scoringFactorImpactSchema>

export interface ScoringFactor {
  category: ScoringFactorCategory
  name: string
  score: number // 0-100
  weightBasisPoints: number // 0-10000 (e.g. 3000 = 30%)
  impact: ScoringFactorImpact
  description: string
  evidence: Record<string, string | number | boolean | null>
}

export interface CustomerScoringProfile {
  id: string
  customerId: string
  companyId: string | null
  riskScore: number // 0-100 (lower is lower risk)
  riskTier: RiskTier
  valueScore: number // 0-100 (higher is higher value)
  valueTier: ValueTier
  recommendedCreditLimitCents: number
  recommendedPaymentTerms: PaymentTerms
  reviewStatus: ScoringReviewStatus
  factors: ScoringFactor[]
  modelVersion: string
  calculatedAt: string
  updatedAt: string
}

export const customerScoringReviewInputSchema = z
  .object({
    action: z.enum(['review', 'override']),
    newRiskTier: riskTierSchema,
    newCreditLimitCents: z.number().int().min(0).max(9007199254740991),
    justification: z
      .string()
      .trim()
      .min(10, 'justification_must_be_at_least_10_chars')
      .max(1000, 'justification_too_long')
  })
  .strict()

export type CustomerScoringReviewInput = z.infer<typeof customerScoringReviewInputSchema>

export interface ScoringQualityMetrics {
  modelVersion: string
  evaluatedAt: string
  sampleSize: number
  overrideRateBasisPoints: number
  highRiskDefaultRateBasisPoints: number
  brierScoreBasisPoints: number
  qualityStatus: 'optimal' | 'acceptable' | 'drift_warning' | 'recalibration_required'
  distribution: {
    lowRiskCount: number
    moderateRiskCount: number
    highRiskCount: number
    criticalRiskCount: number
    lowRiskPercent: number
    moderateRiskPercent: number
    highRiskPercent: number
    criticalRiskPercent: number
  }
}
