import { z } from 'zod'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from './catalog-publication-policy'

export const REPLENISHMENT_CAP = { maxQueued: 1, windowDays: 7 } as const
export const REPLENISHMENT_MIN_INTERVAL_DAYS = 7
export const REPLENISHMENT_MAX_INTERVAL_DAYS = 365
export const replenishmentVariantIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)
const version = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1)
const interval = z.number().int().min(REPLENISHMENT_MIN_INTERVAL_DAYS).max(REPLENISHMENT_MAX_INTERVAL_DAYS)
export const replenishmentPlanInputSchema = z
  .object({
    variantId: replenishmentVariantIdSchema,
    action: z.enum(['save', 'pause', 'resume', 'cancel']),
    expectedVersion: version,
    /** history: interval derived from paid purchases; declared: customer states the interval. */
    source: z.enum(['history', 'declared']).optional(),
    intervalDays: interval.optional()
  })
  .strict()
  .superRefine((v, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: 'custom', message })
    if (v.action !== 'save') {
      if (v.source !== undefined || v.intervalDays !== undefined) bad('only_save_configures_the_plan')
      return
    }
    if (v.source === undefined) bad('source_required')
    if (v.source === 'declared' && v.intervalDays === undefined) bad('interval_required')
    if (v.source === 'history' && v.intervalDays !== undefined) bad('interval_is_derived')
  })
export const replenishmentPlanReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: catalogPolicyUuidSchema,
    planId: catalogPolicyUuidSchema,
    variantId: replenishmentVariantIdSchema,
    version: z.number().int().min(1),
    status: z.enum(['active', 'paused', 'cancelled']),
    planSource: z.enum(['history', 'declared']),
    intervalDays: interval,
    nextDueAt: catalogPolicyInstantSchema,
    recordedAt: catalogPolicyInstantSchema
  })
  .strict()
export const replenishmentListSchema = z
  .object({
    source: z.literal('cloudflare'),
    consent: z.object({ replenishment: z.boolean() }).strict(),
    cap: z.object({ maxQueued: z.number(), windowDays: z.number() }).strict(),
    plans: z
      .array(
        z
          .object({
            id: catalogPolicyUuidSchema,
            variantId: replenishmentVariantIdSchema,
            sku: z.string(),
            name: z.string(),
            source: z.enum(['history', 'declared']),
            intervalDays: interval,
            status: z.enum(['active', 'paused', 'cancelled']),
            nextDueAt: catalogPolicyInstantSchema,
            lastRemindedAt: catalogPolicyInstantSchema.nullable(),
            version: z.number().int().min(1)
          })
          .strict()
      )
      .max(100),
    recent: z
      .array(
        z
          .object({
            variantId: replenishmentVariantIdSchema,
            sku: z.string(),
            status: z.enum(['queued', 'suppressed']),
            reason: z.string().nullable(),
            createdAt: catalogPolicyInstantSchema
          })
          .strict()
      )
      .max(10)
  })
  .strict()
export type ReplenishmentPlanInput = z.input<typeof replenishmentPlanInputSchema>
export type ReplenishmentPlanReceipt = z.infer<typeof replenishmentPlanReceiptSchema>
export type ReplenishmentList = z.infer<typeof replenishmentListSchema>
