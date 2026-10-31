import { z } from 'zod'
import { promotionRuleSchema, promotionContextSchema } from './promotions'

export const promotionMatrixCaseSchema = z
  .object({
    id: z.string().min(1).max(100),
    rule: promotionRuleSchema,
    context: promotionContextSchema
  })
  .strict()

export type PromotionMatrixCase = z.infer<typeof promotionMatrixCaseSchema>

export const promotionMatrixEvaluationResultSchema = z
  .object({
    caseId: z.string(),
    eligible: z.boolean(),
    reason: z.string().nullable(),
    discountGrossCents: z.number().int().nonnegative(),
    netCents: z.number().int().nonnegative(),
    taxCents: z.number().int().nonnegative(),
    grossCents: z.number().int().nonnegative()
  })
  .strict()

export type PromotionMatrixEvaluationResult = z.infer<typeof promotionMatrixEvaluationResultSchema>

export const marginEvaluationInputSchema = z
  .object({
    lines: z.array(
      z.object({
        grossCents: z.number().int().nonnegative(),
        netCents: z.number().int().nonnegative(),
        costNetCents: z.number().int().nonnegative().nullable(),
        discountGrossCents: z.number().int().nonnegative()
      })
    ),
    marginFloorBps: z.number().int().min(0).max(10000)
  })
  .strict()

export type MarginEvaluationInput = z.infer<typeof marginEvaluationInputSchema>

export const marginEvaluationResultSchema = z
  .object({
    allowed: z.boolean(),
    totalNetCents: z.number().int().nonnegative(),
    totalCostNetCents: z.number().int().nonnegative().nullable(),
    marginNetCents: z.number().int().nullable(),
    marginBasisPoints: z.number().nullable(),
    loss: z.boolean().nullable()
  })
  .strict()

export type MarginEvaluationResult = z.infer<typeof marginEvaluationResultSchema>

export const frequencyCooldownCheckInputSchema = z
  .object({
    totalRedemptions: z.number().int().nonnegative().optional(),
    totalLimit: z.number().int().nonnegative().nullable().optional(),
    customerRedemptions: z.number().int().nonnegative().optional(),
    perCustomerLimit: z.number().int().nonnegative().nullable().optional(),
    automationKind: z.enum(['winback', 'welcome_discount', 'cart_recovery', 'replenishment']).optional(),
    lastDispatchedAt: z.string().nullable().optional(),
    now: z.string().optional(),
    cooldownDays: z.number().int().min(0).optional()
  })
  .strict()

export type FrequencyCooldownCheckInput = z.infer<typeof frequencyCooldownCheckInputSchema>

export const frequencyCooldownCheckResultSchema = z
  .object({
    allowed: z.boolean(),
    reason: z.enum(['usage_limit', 'cooldown_active', 'already_claimed']).nullable()
  })
  .strict()

export type FrequencyCooldownCheckResult = z.infer<typeof frequencyCooldownCheckResultSchema>

export const marketingConsentCheckInputSchema = z
  .object({
    channel: z.enum(['email', 'sms']),
    stream: z.enum([
      'transactional_safety_usage',
      'commercial_replenishment',
      'winback_promotional',
      'welcome_promotional'
    ]),
    marketingConsent: z.boolean(),
    customerSuppressed: z.boolean()
  })
  .strict()

export type MarketingConsentCheckInput = z.infer<typeof marketingConsentCheckInputSchema>

export const marketingConsentCheckResultSchema = z
  .object({
    allowed: z.boolean(),
    status: z.enum(['delivered', 'skipped_no_consent', 'suppressed'])
  })
  .strict()

export type MarketingConsentCheckResult = z.infer<typeof marketingConsentCheckResultSchema>

export const promotionRefundCalculationInputSchema = z
  .object({
    orderId: z.string().min(1),
    lines: z.array(
      z.object({
        lineIndex: z.number().int(),
        variantId: z.string(),
        quantity: z.number().int().positive(),
        unitGrossCents: z.number().int().positive(),
        taxRateBasisPoints: z.number().int().min(0).max(10000),
        costUnitNetCents: z.number().int().positive().nullable(),
        originalGrossCents: z.number().int().positive(),
        originalDiscountGrossCents: z.number().int().nonnegative(),
        netCents: z.number().int().nonnegative(),
        taxCents: z.number().int().nonnegative()
      })
    ),
    returnLines: z.array(
      z.object({
        lineIndex: z.number().int(),
        returnQuantity: z.number().int().positive()
      })
    )
  })
  .strict()

export type PromotionRefundCalculationInput = z.infer<typeof promotionRefundCalculationInputSchema>

export const promotionRefundCalculationResultSchema = z
  .object({
    orderId: z.string(),
    totalRefundGrossCents: z.number().int().nonnegative(),
    totalRefundNetCents: z.number().int().nonnegative(),
    totalRefundTaxCents: z.number().int().nonnegative(),
    discountClawedBackGrossCents: z.number().int().nonnegative(),
    remainingPaidGrossCents: z.number().int().nonnegative(),
    remainingOrderMarginNetCents: z.number().int().nonnegative()
  })
  .strict()

export type PromotionRefundCalculationResult = z.infer<typeof promotionRefundCalculationResultSchema>
