import { z } from 'zod'
import { catalogPolicyInstantSchema as instant, catalogPolicyUuidSchema as uuid } from './catalog-publication-policy'

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
/** ASCII identifiers only; Unicode confusables never become redeemable codes. */
export function normalizePromotionCode(value: string): string {
  for (let index = 0; index < value.length; index++)
    if (value.charCodeAt(index) > 127) throw new Error('invalid_promotion_code')
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(normalized)) throw new Error('invalid_promotion_code')
  return normalized
}
export const promotionCodeSchema = z.string().transform((value, ctx) => {
  try {
    return normalizePromotionCode(value)
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid promotion code' })
    return z.NEVER
  }
})
export const promotionVolumeModeSchema = z.enum(['exclude_volume', 'stack_volume', 'best_of_volume'])
export const promotionBenefitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), grossCents: integer.min(1) }).strict(),
  z.object({ kind: z.literal('percent'), basisPoints: integer.min(1).max(10000) }).strict()
])
export const promotionScopeSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('all') }).strict(),
    z.object({ kind: z.literal('product'), ids: z.array(uuid).min(1).max(100) }).strict(),
    z.object({ kind: z.literal('category'), ids: z.array(uuid).min(1).max(100) }).strict()
  ])
  .superRefine((value, ctx) => {
    if (value.kind !== 'all' && new Set(value.ids).size !== value.ids.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate scope identity' })
  })
export const promotionRuleSchema = z
  .object({
    id: uuid,
    version: integer.min(1),
    code: promotionCodeSchema,
    status: z.enum(['active', 'paused']),
    channel: z.literal('online'),
    startsAt: instant,
    endsAt: instant.nullable(),
    benefit: promotionBenefitSchema,
    scope: promotionScopeSchema,
    segment: z.enum(['all', 'registered', 'approved_company']),
    totalLimit: integer.min(1).nullable(),
    perCustomerLimit: integer.min(1).nullable(),
    volumeMode: promotionVolumeModeSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.endsAt !== null && Date.parse(value.endsAt) <= Date.parse(value.startsAt))
      ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'End must follow start' })
  })
export type PromotionRule = z.infer<typeof promotionRuleSchema>
export const promotionReasonSchema = z.enum([
  'unavailable',
  'not_started',
  'expired',
  'segment_not_eligible',
  'customer_required',
  'usage_limit',
  'no_eligible_lines',
  'no_benefit'
])
export type PromotionReason = z.infer<typeof promotionReasonSchema>

// Persisted catalog identities predate UUID-only authoring in several fixtures/imports.
// Keep them exact, bounded and parameter-only; do not synthesize replacement UUIDs.
const catalogIdentity = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
export const promotionContextLineSchema = z
  .object({
    lineIndex: integer.max(99),
    variantId: catalogIdentity,
    productId: catalogIdentity,
    categoryId: catalogIdentity,
    sku: z.string().min(1).max(200),
    quantity: integer.min(1),
    baseUnitGrossCents: integer,
    volumeUnitGrossCents: integer,
    taxRateBasisPoints: integer.max(10000)
  })
  .strict()
  .refine((value) => value.volumeUnitGrossCents <= value.baseUnitGrossCents, 'Volume cannot exceed base')
export const promotionContextSchema = z
  .object({
    now: instant,
    channel: z.literal('online'),
    customerId: uuid.nullable(),
    companyApproved: z.boolean(),
    redemptions: z.object({ total: integer, customer: integer }).strict(),
    lines: z.array(promotionContextLineSchema).min(1).max(100)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.lines.map((line) => line.lineIndex)).size !== value.lines.length ||
      new Set(value.lines.map((line) => line.variantId)).size !== value.lines.length
    )
      ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Duplicate cart line' })
    if (
      value.lines.some((line) => !Number.isSafeInteger(line.baseUnitGrossCents * line.quantity)) ||
      !Number.isSafeInteger(value.lines.reduce((sum, line) => sum + line.baseUnitGrossCents * line.quantity, 0))
    )
      ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Unsafe basket total' })
  })
export type PromotionContext = z.infer<typeof promotionContextSchema>
