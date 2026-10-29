import { z } from 'zod'
import { catalogPolicyInstantSchema as instant, catalogPolicyUuidSchema as uuid } from './catalog-publication-policy'
import { promotionReasonSchema, promotionRuleSchema } from './promotions'

const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const signed = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)
const catalogIdentity = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
export const promotionBasketPreviewInputSchema = z
  .object({
    lines: z
      .array(z.object({ variantId: catalogIdentity, quantity: cents.min(1) }).strict())
      .min(1)
      .max(100),
    destination: z
      .object({ postalCode: z.string().regex(/^[0-9]{5}$/), city: z.string().trim().min(1).max(80) })
      .strict(),
    customerId: uuid.nullable(),
    rule: promotionRuleSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.lines.map((line) => line.variantId)).size !== value.lines.length)
      ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Duplicate variant' })
  })
const amounts = z.object({ netCents: cents, taxCents: cents, grossCents: cents }).strict()
const scenario = amounts
  .extend({
    costNetCents: cents.nullable(),
    marginNetCents: signed.nullable(),
    loss: z.boolean().nullable()
  })
  .strict()
export const promotionBasketPreviewResponseSchema = z
  .object({
    source: z.literal('cloudflare'),
    simulation: z.literal(true),
    ruleEvaluation: z.literal('proposed_active'),
    evaluatedAt: instant,
    ruleHash: z.string().regex(/^[0-9a-f]{64}$/),
    snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
    eligible: z.boolean(),
    reason: promotionReasonSchema.nullable(),
    lines: z
      .array(
        z
          .object({
            lineIndex: cents.max(99),
            variantId: catalogIdentity,
            sku: z.string().min(1).max(200),
            name: z.string().min(1).max(500),
            quantity: cents.min(1),
            priceVersionId: z.string().min(1).max(200),
            costUnitNetCents: cents.nullable(),
            costNetCents: cents.nullable(),
            base: amounts,
            volume: amounts,
            proposed: amounts,
            discountGrossCents: cents
          })
          .strict()
      )
      .min(1)
      .max(100),
    totals: z.object({ base: scenario, volume: scenario, proposed: scenario }).strict(),
    shipping: z
      .object({
        options: z
          .array(
            z
              .object({
                methodCode: z.enum(['pickup', 'own_delivery', 'parcel']),
                serviceProfile: z.enum(['parcel', 'pallet', 'adr']),
                zoneCode: z.string().min(1).max(200),
                netCents: cents,
                taxCents: cents,
                grossCents: cents,
                taxRateBasisPoints: cents.max(10000),
                etaMinDays: cents,
                etaMaxDays: cents,
                rateVersion: cents.min(1)
              })
              .strict()
          )
          .max(100),
        operationalCostNetCents: z.null()
      })
      .strict(),
    totalMarginNetCents: z.null()
  })
  .strict()
export type PromotionBasketPreviewInput = z.infer<typeof promotionBasketPreviewInputSchema>
export type PromotionBasketPreviewResponse = z.infer<typeof promotionBasketPreviewResponseSchema>
