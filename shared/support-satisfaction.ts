import { z } from 'zod'
import { supportCategory, supportInstant, supportRef, supportText, supportUuid } from './support-operations'

export const satisfactionSourceSchema = z.enum(['support', 'delivery'])
export type SatisfactionSource = z.infer<typeof satisfactionSourceSchema>
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const satisfactionTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('support'), id: supportRef, version: integer }).strict(),
  z.object({ kind: z.literal('delivery'), id: supportUuid, version: integer }).strict()
])
export const satisfactionInputSchema = z
  .object({
    score: z.number().int().min(1).max(5),
    comment: z.string().trim().pipe(supportText(1, 1000)).optional(),
    privacyAcknowledged: z.literal(true),
    expectedSourceVersion: integer.min(1),
    expectedPolicyHash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
export type SatisfactionInput = z.infer<typeof satisfactionInputSchema>
export const satisfactionReasonSchema = z.enum([
  'source_not_final',
  'policy_unavailable',
  'retention_expired',
  'already_submitted'
])
export const customerSatisfactionSchema = z
  .object({
    source: z.literal('cloudflare'),
    target: satisfactionTargetSchema,
    eligible: z.boolean(),
    reason: satisfactionReasonSchema.nullable(),
    feedback: z
      .object({
        score: z.number().int().min(1).max(5),
        comment: supportText(1, 1000).nullable(),
        submittedAt: supportInstant
      })
      .strict()
      .nullable(),
    privacy: z
      .object({
        noticePath: z.string().regex(/^\/[a-z0-9/-]+$/),
        retentionUntil: supportInstant,
        policyHash: z.string().regex(/^[a-f0-9]{64}$/)
      })
      .strict()
      .nullable(),
    evaluatedAt: supportInstant
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.eligible !== (value.reason === null) ||
      (value.eligible && (value.feedback !== null || value.privacy === null || value.target.version < 1))
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid eligibility' })
    }
  })
export type CustomerSatisfaction = z.infer<typeof customerSatisfactionSchema>
export const satisfactionReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: supportUuid,
    target: satisfactionTargetSchema.refine((value) => value.version >= 1),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    score: z.number().int().min(1).max(5),
    submittedAt: supportInstant,
    inventoryEffect: z.literal('none'),
    economicEffect: z.literal('none')
  })
  .strict()
export type SatisfactionReceipt = z.infer<typeof satisfactionReceiptSchema>
export const satisfactionCommandResponseSchema = z.discriminatedUnion('outcome', [
  z
    .object({ source: z.literal('cloudflare'), outcome: z.literal('applied'), receipt: satisfactionReceiptSchema })
    .strict(),
  z.object({ source: z.literal('cloudflare'), outcome: z.literal('unknown') }).strict()
])
export type SatisfactionCommandResponse = z.infer<typeof satisfactionCommandResponseSchema>
export const adminSatisfactionQuerySchema = z
  .object({
    source: satisfactionSourceSchema.optional(),
    category: supportCategory.optional(),
    shippingMethod: z.enum(['pickup', 'own_delivery', 'parcel']).optional(),
    score: z.coerce.number().int().min(1).max(5).optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    perPage: z.coerce.number().int().min(1).max(25).default(20),
    comments: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .default(false)
  })
  .strict()
export type AdminSatisfactionQuery = z.infer<typeof adminSatisfactionQuerySchema>
export const adminSatisfactionResponseSchema = z
  .object({
    source: z.literal('cloudflare'),
    items: z
      .array(
        z
          .object({
            target: satisfactionTargetSchema,
            score: z.number().int().min(1).max(5),
            submittedAt: supportInstant,
            category: supportCategory.nullable(),
            shippingMethod: z.enum(['pickup', 'own_delivery', 'parcel']).nullable(),
            comment: supportText(1, 1000).nullable()
          })
          .strict()
      )
      .max(25),
    total: integer,
    page: integer.min(1),
    perPage: integer.min(1).max(25),
    commentsIncluded: z.boolean(),
    stats: z
      .object({
        count: integer,
        average: z.number().min(1).max(5).nullable(),
        byScore: z.array(z.object({ score: z.number().int().min(1).max(5), count: integer }).strict()).length(5)
      })
      .strict(),
    evaluatedAt: supportInstant
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.commentsIncluded && value.items.some((item) => item.comment !== null))
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Comments not requested' })
  })
export type AdminSatisfactionResponse = z.infer<typeof adminSatisfactionResponseSchema>

/** Includes private comment only in the local hash input, never in URL/receipt/ledger. */
export async function satisfactionIntentHash(kind: SatisfactionSource, id: string, raw: unknown): Promise<string> {
  const body = satisfactionInputSchema.parse(raw)
  satisfactionTargetSchema.parse({ kind, id, version: body.expectedSourceVersion })
  const canonical = JSON.stringify({
    kind,
    id,
    score: body.score,
    comment: body.comment ?? null,
    privacyAcknowledged: true,
    expectedSourceVersion: body.expectedSourceVersion,
    expectedPolicyHash: body.expectedPolicyHash
  })
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
