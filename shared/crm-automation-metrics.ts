import { z } from 'zod'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from './catalog-publication-policy'

export const CRM_AUTOMATION_FLOWS = [
  'welcome_series',
  'inactivity_winback',
  'postpurchase_replenishment',
  'abandoned_cart'
] as const

export type CrmAutomationFlow = (typeof CRM_AUTOMATION_FLOWS)[number] | (string & {})

export const CRM_AUTOMATION_EVENT_TYPES = ['delivery', 'click', 'conversion', 'unsubscribe', 'complaint'] as const

export type CrmAutomationEventType = (typeof CRM_AUTOMATION_EVENT_TYPES)[number]

export const CRM_GROUP_TYPES = ['treatment', 'holdout'] as const
export type CrmGroupType = (typeof CRM_GROUP_TYPES)[number]

export const crmHoldoutPolicySchema = z
  .object({
    flowId: z.string().min(3).max(64),
    version: z.number().int().positive(),
    holdoutPercentage: z.number().int().min(0).max(50),
    holdoutEnabled: z.boolean(),
    salt: z.string().min(8).max(64),
    minSampleSize: z.number().int().positive(),
    updatedAt: catalogPolicyInstantSchema,
    updatedBy: catalogPolicyUuidSchema
  })
  .strict()

export type CrmHoldoutPolicy = z.infer<typeof crmHoldoutPolicySchema>

export const crmHoldoutPolicyInputSchema = z
  .object({
    flowId: z.string().min(3).max(64),
    holdoutPercentage: z.number().int().min(0).max(50),
    holdoutEnabled: z.boolean(),
    minSampleSize: z.number().int().positive().default(20),
    expectedVersion: z.number().int().nonnegative()
  })
  .strict()

export type CrmHoldoutPolicyInput = z.infer<typeof crmHoldoutPolicyInputSchema>

export const crmAutomationEventInputSchema = z
  .object({
    flowId: z.string().min(3).max(64),
    step: z.string().min(1).max(64),
    customerId: catalogPolicyUuidSchema,
    groupType: z.enum(CRM_GROUP_TYPES),
    eventType: z.enum(CRM_AUTOMATION_EVENT_TYPES),
    orderId: catalogPolicyUuidSchema.optional(),
    revenueCents: z.number().int().nonnegative().optional(),
    costCents: z.number().int().nonnegative().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    occurredAt: catalogPolicyInstantSchema,
    idempotencyKey: z.string().min(8).max(128)
  })
  .strict()

export type CrmAutomationEventInput = z.infer<typeof crmAutomationEventInputSchema>

export const crmHoldoutEvaluationInputSchema = z
  .object({
    flowId: z.string().min(3).max(64),
    step: z.string().min(1).max(64),
    customerId: catalogPolicyUuidSchema,
    idempotencyKey: z.string().min(8).max(128)
  })
  .strict()

export type CrmHoldoutEvaluationInput = z.infer<typeof crmHoldoutEvaluationInputSchema>

export const crmMetricsQuerySchema = z
  .object({
    flowId: z.string().min(3).max(64).optional(),
    startDate: catalogPolicyInstantSchema.optional(),
    endDate: catalogPolicyInstantSchema.optional()
  })
  .strict()

export type CrmMetricsQuery = z.infer<typeof crmMetricsQuerySchema>

export interface TreatmentMetrics {
  deliveries: number
  clicks: number
  ctrPercent: number
  conversions: number
  conversionRatePercent: number
  unsubscribes: number
  unsubscribeRatePercent: number
  complaints: number
  complaintRatePercent: number
  totalRevenueCents: number
  totalCostCents: number
  totalMarginCents: number
  marginBasisPoints: number
  averageOrderValueCents: number
}

export interface HoldoutMetrics {
  allocations: number
  conversions: number
  conversionRatePercent: number
  totalRevenueCents: number
  totalCostCents: number
  totalMarginCents: number
  marginBasisPoints: number
  averageOrderValueCents: number
}

export interface IncrementalLiftMetrics {
  holdoutViable: boolean
  viabilityReason?: string
  incrementalConversions: number
  incrementalConversionRatePercent: number
  incrementalLiftPercent: number
  incrementalMarginCents: number
}

export interface FlowMetricsSummary {
  flowId: string
  treatment: TreatmentMetrics
  holdout: HoldoutMetrics
  incremental: IncrementalLiftMetrics
  holdoutPolicy: CrmHoldoutPolicy
}

/** Deterministic hash-based assignment to treatment or holdout group. */
export async function calculateDeterministicHoldoutGroup(
  customerId: string,
  flowId: string,
  salt: string,
  holdoutPercentage: number,
  holdoutEnabled: boolean
): Promise<CrmGroupType> {
  if (!holdoutEnabled || holdoutPercentage <= 0) {
    return 'treatment'
  }
  const input = `${customerId}:${flowId}:${salt}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  const bytes = new Uint8Array(digest)
  // Use first 4 bytes as unsigned 32-bit int modulo 100
  const val = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0
  const bucket = val % 100
  return bucket < holdoutPercentage ? 'holdout' : 'treatment'
}

/** Computes financial gross margin in cents and basis points. */
export function calculateMargin(
  revenueCents: number,
  costCents: number
): { marginCents: number; marginBasisPoints: number } {
  const marginCents = revenueCents - costCents
  const marginBasisPoints = revenueCents > 0 ? Math.floor((marginCents * 10000) / revenueCents) : 0
  return { marginCents, marginBasisPoints }
}

/** Calculates incremental lift and validates holdout viability. */
export function calculateIncrementalLift(
  treatment: TreatmentMetrics,
  holdout: HoldoutMetrics,
  minSampleSize: number,
  holdoutEnabled: boolean
): IncrementalLiftMetrics {
  if (!holdoutEnabled) {
    return {
      holdoutViable: false,
      viabilityReason: 'holdout_disabled',
      incrementalConversions: 0,
      incrementalConversionRatePercent: 0,
      incrementalLiftPercent: 0,
      incrementalMarginCents: 0
    }
  }

  if (holdout.allocations < minSampleSize || treatment.deliveries < minSampleSize) {
    return {
      holdoutViable: false,
      viabilityReason: `insufficient_sample_size (treatment: ${treatment.deliveries}, holdout: ${holdout.allocations}, min: ${minSampleSize})`,
      incrementalConversions: 0,
      incrementalConversionRatePercent: 0,
      incrementalLiftPercent: 0,
      incrementalMarginCents: 0
    }
  }

  const treatmentConvRate = treatment.deliveries > 0 ? treatment.conversions / treatment.deliveries : 0
  const holdoutConvRate = holdout.allocations > 0 ? holdout.conversions / holdout.allocations : 0

  const expectedHoldoutConversions = holdoutConvRate * treatment.deliveries
  const incrementalConversions = Math.round((treatment.conversions - expectedHoldoutConversions) * 100) / 100
  const incrementalConversionRatePercent = Math.round((treatmentConvRate - holdoutConvRate) * 10000) / 100

  const incrementalLiftPercent =
    holdoutConvRate > 0
      ? Math.round(((treatmentConvRate - holdoutConvRate) / holdoutConvRate) * 10000) / 100
      : treatmentConvRate > 0
        ? 100
        : 0

  // Incremental margin = treatment total margin - (holdout margin per recipient * treatment recipients)
  const holdoutMarginPerRecipient = holdout.allocations > 0 ? holdout.totalMarginCents / holdout.allocations : 0
  const baselineExpectedMarginCents = Math.round(holdoutMarginPerRecipient * treatment.deliveries)
  const incrementalMarginCents = treatment.totalMarginCents - baselineExpectedMarginCents

  return {
    holdoutViable: true,
    incrementalConversions,
    incrementalConversionRatePercent,
    incrementalLiftPercent,
    incrementalMarginCents
  }
}
