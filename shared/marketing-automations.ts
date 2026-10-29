import { z } from 'zod'
import {
  catalogPolicyInstantSchema,
  catalogPolicyUuidSchema
} from './catalog-publication-policy'

export const WELCOME_STEPS = [
  'professional_value',
  'categories_overview',
  'local_service',
  'preferences_prompt',
  'welcome_discount'
] as const

export type WelcomeStep = (typeof WELCOME_STEPS)[number]

export const welcomeStepSchema = z.enum(WELCOME_STEPS)

export const WINBACK_STATUSES = [
  'eligible',
  'excluded_incidents',
  'excluded_debt',
  'excluded_suppressed',
  'excluded_cooldown',
  'dispatched'
] as const

export type WinbackStatus = (typeof WINBACK_STATUSES)[number]

export const winbackStatusSchema = z.enum(WINBACK_STATUSES)

export const POSTPURCHASE_STREAMS = [
  'transactional_safety_usage',
  'commercial_replenishment'
] as const

export type PostpurchaseStream = (typeof POSTPURCHASE_STREAMS)[number]

export const postpurchaseStreamSchema = z.enum(POSTPURCHASE_STREAMS)

export const POSTPURCHASE_STATUSES = [
  'delivered',
  'skipped_no_consent',
  'suppressed'
] as const

export type PostpurchaseStatus = (typeof POSTPURCHASE_STATUSES)[number]

export const postpurchaseStatusSchema = z.enum(POSTPURCHASE_STATUSES)

export const PREFERRED_FREQUENCY = ['weekly', 'biweekly', 'monthly'] as const
export type PreferredFrequency = (typeof PREFERRED_FREQUENCY)[number]

export const PREFERRED_CHANNEL = ['email', 'sms', 'portal'] as const
export type PreferredChannel = (typeof PREFERRED_CHANNEL)[number]

export const customerPreferencesSchema = z
  .object({
    customerId: catalogPolicyUuidSchema,
    preferredCategories: z.array(z.string().min(1).max(50)).max(20),
    frequency: z.enum(PREFERRED_FREQUENCY),
    channel: z.enum(PREFERRED_CHANNEL),
    technicalContentOptIn: z.boolean(),
    version: z.number().int().positive(),
    updatedAt: catalogPolicyInstantSchema
  })
  .strict()

export type CustomerPreferences = z.infer<typeof customerPreferencesSchema>

export const customerPreferencesInputSchema = z
  .object({
    preferredCategories: z.array(z.string().min(1).max(50)).max(20),
    frequency: z.enum(PREFERRED_FREQUENCY).default('weekly'),
    channel: z.enum(PREFERRED_CHANNEL).default('email'),
    technicalContentOptIn: z.boolean().default(true),
    expectedVersion: z.number().int().nonnegative()
  })
  .strict()

export type CustomerPreferencesInput = z.infer<typeof customerPreferencesInputSchema>

export const marketingAutomationPolicySchema = z
  .object({
    id: z.literal('global'),
    version: z.number().int().positive(),
    welcomeSeriesEnabled: z.boolean(),
    welcomeDiscountEnabled: z.boolean(),
    welcomeDiscountPercent: z.number().int().min(1).max(30),
    welcomeDiscountMaxCents: z.number().int().min(100).max(10000),
    welcomeMinOrderCents: z.number().int().min(1000).max(50000),
    welcomeMarginFloorBasisPoints: z.number().int().min(1000).max(5000),
    winbackEnabled: z.boolean(),
    winbackInactivityDays: z.number().int().min(14).max(365),
    winbackCooldownDays: z.number().int().min(14).max(365),
    winbackDiscountPercent: z.number().int().min(1).max(25),
    winbackDiscountMaxCents: z.number().int().min(100).max(10000),
    winbackMarginFloorBasisPoints: z.number().int().min(1000).max(5000),
    postpurchaseEnabled: z.boolean(),
    postpurchaseDelayHours: z.number().int().min(0).max(168),
    updatedAt: catalogPolicyInstantSchema,
    updatedBy: catalogPolicyUuidSchema
  })
  .strict()

export type MarketingAutomationPolicy = z.infer<typeof marketingAutomationPolicySchema>

export const marketingAutomationPolicyInputSchema = z
  .object({
    welcomeSeriesEnabled: z.boolean(),
    welcomeDiscountEnabled: z.boolean(),
    welcomeDiscountPercent: z.number().int().min(1).max(30),
    welcomeDiscountMaxCents: z.number().int().min(100).max(10000),
    welcomeMinOrderCents: z.number().int().min(1000).max(50000),
    welcomeMarginFloorBasisPoints: z.number().int().min(1000).max(5000),
    winbackEnabled: z.boolean(),
    winbackInactivityDays: z.number().int().min(14).max(365),
    winbackCooldownDays: z.number().int().min(14).max(365),
    winbackDiscountPercent: z.number().int().min(1).max(25),
    winbackDiscountMaxCents: z.number().int().min(100).max(10000),
    winbackMarginFloorBasisPoints: z.number().int().min(1000).max(5000),
    postpurchaseEnabled: z.boolean(),
    postpurchaseDelayHours: z.number().int().min(0).max(168),
    expectedVersion: z.number().int().nonnegative()
  })
  .strict()

export type MarketingAutomationPolicyInput = z.infer<typeof marketingAutomationPolicyInputSchema>

export const welcomeDispatchSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    customerId: catalogPolicyUuidSchema,
    step: welcomeStepSchema,
    discountCode: z.string().min(3).max(32).nullable(),
    discountCentsCap: z.number().int().positive().nullable(),
    minOrderCents: z.number().int().positive().nullable(),
    marginFloorBasisPoints: z.number().int().min(1000).max(5000).nullable(),
    status: z.enum(['delivered', 'skipped', 'suppressed']),
    recipientEmailHash: z.string().length(64),
    dispatchedAt: catalogPolicyInstantSchema,
    createdAt: catalogPolicyInstantSchema
  })
  .strict()

export type WelcomeDispatch = z.infer<typeof welcomeDispatchSchema>

export const welcomeDispatchInputSchema = z
  .object({
    customerId: catalogPolicyUuidSchema,
    step: welcomeStepSchema,
    idempotencyKey: z.string().min(8).max(128)
  })
  .strict()

export type WelcomeDispatchInput = z.infer<typeof welcomeDispatchInputSchema>

export const winbackEvaluationSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    customerId: catalogPolicyUuidSchema,
    lastOrderId: catalogPolicyUuidSchema.nullable(),
    lastOrderAt: catalogPolicyInstantSchema.nullable(),
    daysInactive: z.number().int().nonnegative(),
    eligibilityStatus: winbackStatusSchema,
    exclusionReason: z.string().max(255).nullable(),
    discountCode: z.string().min(3).max(32).nullable(),
    discountPercent: z.number().int().min(1).max(25).nullable(),
    discountMaxCents: z.number().int().positive().nullable(),
    marginFloorBasisPoints: z.number().int().min(1000).max(5000).nullable(),
    dispatchedAt: catalogPolicyInstantSchema.nullable(),
    createdAt: catalogPolicyInstantSchema
  })
  .strict()

export type WinbackEvaluation = z.infer<typeof winbackEvaluationSchema>

export const winbackEvaluationInputSchema = z
  .object({
    customerId: catalogPolicyUuidSchema.optional(),
    idempotencyKey: z.string().min(8).max(128)
  })
  .strict()

export type WinbackEvaluationInput = z.infer<typeof winbackEvaluationInputSchema>

export const postpurchaseUsageGuideSchema = z
  .object({
    orderId: catalogPolicyUuidSchema,
    dilutionProtocol: z.string().min(5).max(500),
    applicationGuide: z.string().min(5).max(500),
    sdsUrl: z.string().min(5).max(200),
    ppeRequirements: z.array(z.string().min(2).max(50)).min(1),
    supportContact: z.string().min(5).max(100)
  })
  .strict()

export type PostpurchaseUsageGuide = z.infer<typeof postpurchaseUsageGuideSchema>

export const postpurchaseCommercialRecommendationSchema = z
  .object({
    orderId: catalogPolicyUuidSchema,
    estimatedReplenishmentDays: z.number().int().positive(),
    replenishmentDate: catalogPolicyInstantSchema,
    recommendedAccessories: z.array(
      z.object({
        sku: z.string().min(2).max(50),
        name: z.string().min(2).max(100),
        reason: z.string().min(2).max(200)
      })
    )
  })
  .strict()

export type PostpurchaseCommercialRecommendation = z.infer<
  typeof postpurchaseCommercialRecommendationSchema
>

export const postpurchaseDispatchSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    orderId: catalogPolicyUuidSchema,
    customerId: catalogPolicyUuidSchema.nullable(),
    streamType: postpurchaseStreamSchema,
    status: postpurchaseStatusSchema,
    contentJson: z.string().min(2),
    hasMarketingConsent: z.boolean(),
    dispatchedAt: catalogPolicyInstantSchema,
    createdAt: catalogPolicyInstantSchema
  })
  .strict()

export type PostpurchaseDispatch = z.infer<typeof postpurchaseDispatchSchema>

export const postpurchaseDispatchInputSchema = z
  .object({
    orderId: catalogPolicyUuidSchema,
    idempotencyKey: z.string().min(8).max(128)
  })
  .strict()

export type PostpurchaseDispatchInput = z.infer<typeof postpurchaseDispatchInputSchema>

export const automationReceiptSchema = z
  .object({
    commandId: catalogPolicyUuidSchema,
    action: z.enum([
      'update_policy',
      'dispatch_welcome',
      'save_preferences',
      'evaluate_winback',
      'dispatch_postpurchase'
    ]),
    appliedVersion: z.number().int().positive(),
    payloadHash: z.string().length(64),
    recordedAt: catalogPolicyInstantSchema
  })
  .strict()

export type AutomationReceipt = z.infer<typeof automationReceiptSchema>

export const automationsOverviewSchema = z
  .object({
    policy: marketingAutomationPolicySchema,
    counts: z.object({
      welcomeDispatches: z.record(welcomeStepSchema, z.number().int().nonnegative()),
      winbackEvaluations: z.record(winbackStatusSchema, z.number().int().nonnegative()),
      postpurchaseDispatches: z.record(postpurchaseStreamSchema, z.number().int().nonnegative())
    })
  })
  .strict()

export type AutomationsOverview = z.infer<typeof automationsOverviewSchema>

/** Canonical JSON serialization preserving key ordering. */
function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalizeJson(element)).join(',')}]`
  }
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalizeJson((value as Record<string, unknown>)[key])}`
    )
    .join(',')}}`
}

export async function automationIntentHash(payload: unknown): Promise<string> {
  const text = canonicalizeJson(payload)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Calculates estimated replenishment cycle in days based on total chemical volume in liters. */
export function calculateReplenishmentDays(totalVolumeLiters: number): number {
  if (totalVolumeLiters <= 5) return 30
  if (totalVolumeLiters <= 25) return 60
  if (totalVolumeLiters <= 100) return 90
  return 120
}

/**
 * Validates that an offer or discount respects the required minimum gross margin floor.
 * marginFloorBasisPoints: e.g. 2000 bp = 20.00%.
 */
export function checkMarginAllowed(
  orderGrossCents: number,
  discountCents: number,
  estimatedCostCents: number,
  marginFloorBasisPoints: number
): boolean {
  if (orderGrossCents <= 0) return false
  const effectiveRevenueCents = orderGrossCents - discountCents
  if (effectiveRevenueCents <= estimatedCostCents) return false
  const marginCents = effectiveRevenueCents - estimatedCostCents
  // margin % in basis points = (marginCents / effectiveRevenueCents) * 10000
  const actualMarginBp = Math.floor((marginCents * 10000) / effectiveRevenueCents)
  return actualMarginBp >= marginFloorBasisPoints
}
