import { z } from 'zod'
import { promotionRuleSchema, promotionContextSchema, promotionReasonSchema } from './promotions'
import { catalogPolicyInstantSchema as instant, catalogPolicyUuidSchema as uuid } from './catalog-publication-policy'

const integer = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1)
const printable = (value: string) => [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
export const adminPromotionInputSchema = z
  .object({
    expectedVersion: integer,
    rule: promotionRuleSchema,
    reason: z.string().trim().min(10).max(500).refine(printable)
  })
  .strict()
  .refine((value) => value.rule.version === value.expectedVersion + 1, 'Expected next rule version')
export const adminPromotionQuerySchema = z
  .object({
    q: z.string().trim().max(100).refine(printable).default(''),
    status: z.enum(['all', 'active', 'paused']).default('all'),
    page: z.number().int().min(1).max(1000000).default(1),
    perPage: z.number().int().min(1).max(25).default(25)
  })
  .strict()
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const item = z
  .object({ rule: promotionRuleSchema, redemptions: integer, createdAt: instant, updatedAt: instant })
  .strict()
export const adminPromotionListSchema = z
  .object({
    source: z.literal('cloudflare'),
    items: z.array(item).max(25),
    total: integer,
    page: integer.min(1),
    perPage: integer.min(1).max(25)
  })
  .strict()
export const adminPromotionDetailSchema = item
  .extend({
    source: z.literal('cloudflare'),
    history: z
      .array(z.object({ rule: promotionRuleSchema, reason: z.string().min(10).max(500), createdAt: instant }).strict())
      .max(20),
    historyTotal: integer,
    historyPage: integer.min(1)
  })
  .strict()
export const adminPromotionReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: uuid,
    ruleId: uuid,
    version: integer.min(1),
    ruleHash: hash,
    payloadHash: hash,
    createdAt: instant
  })
  .strict()
export const adminPromotionCommandSchema = z.discriminatedUnion('outcome', [
  z
    .object({ source: z.literal('cloudflare'), outcome: z.literal('applied'), receipt: adminPromotionReceiptSchema })
    .strict(),
  z.object({ source: z.literal('cloudflare'), outcome: z.literal('unknown') }).strict()
])
export const adminPromotionPreviewInputSchema = z
  .object({ rule: promotionRuleSchema, context: promotionContextSchema })
  .strict()
export const adminPromotionPreviewSchema = z
  .object({
    source: z.literal('cloudflare'),
    simulation: z.literal(true),
    ruleHash: hash,
    eligible: z.boolean(),
    reason: promotionReasonSchema.nullable(),
    totals: z
      .object({ discountGrossCents: integer, netCents: integer, taxCents: integer, grossCents: integer })
      .strict()
  })
  .strict()
export type AdminPromotionInput = z.infer<typeof adminPromotionInputSchema>
export type AdminPromotionDetail = z.infer<typeof adminPromotionDetailSchema>
export type AdminPromotionReceipt = z.infer<typeof adminPromotionReceiptSchema>
export async function adminPromotionIntentHash(raw: unknown) {
  const normalized = adminPromotionInputSchema.parse(raw)
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(normalized)))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
