import { z } from 'zod'
import {
  catalogPolicyOwnJson,
  catalogPolicyUuidSchema as uuid,
  catalogPolicyInstantSchema as instant
} from './catalog-publication-policy'

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const productId = integer.positive()
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const text = (min: number, max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => {
      for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index)
        if ((code < 32 && code !== 10) || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029)
          return false
      }
      return true
    })
    .transform((value) => value.trim().normalize('NFC'))
    .pipe(z.string().min(min).max(max))
const own = (raw: unknown) => {
  try {
    return catalogPolicyOwnJson(raw)
  } catch {
    return undefined
  }
}
export const productContributionKindSchema = z.enum(['review', 'question'])
export const productContributionStateSchema = z.enum(['pending', 'published', 'withdrawn'])
export const productContributionOriginSchema = z.enum(['verified_purchase', 'unverified'])
export const productContributionSubmitInputSchema = z.preprocess(
  own,
  z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('review'),
        productId,
        score: integer.min(1).max(5),
        title: text(3, 160),
        body: text(10, 3000),
        orderId: uuid.optional(),
        privacyAcknowledged: z.literal(true)
      })
      .strict(),
    z
      .object({
        kind: z.literal('question'),
        productId,
        title: text(3, 160),
        body: text(10, 3000),
        privacyAcknowledged: z.literal(true)
      })
      .strict()
  ])
)
export const productContributionReplyInputSchema = z.preprocess(
  own,
  z.object({ expectedVersion: integer.positive(), body: text(3, 2000) }).strict()
)
const moderation = { expectedVersion: integer.positive(), reason: text(10, 500) }
export const productContributionModerationInputSchema = z.preprocess(
  own,
  z.discriminatedUnion('action', [
    z
      .object({
        ...moderation,
        action: z.literal('publish'),
        reviewReference: text(3, 200),
        slaDueAt: instant.nullable()
      })
      .strict(),
    z
      .object({ ...moderation, action: z.literal('answer'), body: text(10, 3000), reviewReference: text(3, 200) })
      .strict(),
    z.object({ ...moderation, action: z.literal('close') }).strict(),
    z.object({ ...moderation, action: z.literal('withdraw') }).strict()
  ])
)
export const productContributionQuerySchema = z
  .object({
    productId: productId.optional(),
    kind: productContributionKindSchema.optional(),
    state: productContributionStateSchema.optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    perPage: z.coerce.number().int().min(1).max(25).default(25)
  })
  .strict()
export const publicProductContributionQuerySchema = z
  .object({
    kind: productContributionKindSchema.optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    perPage: z.coerce.number().int().min(1).max(25).default(25)
  })
  .strict()
const publicFields = {
  id: uuid,
  productId,
  kind: productContributionKindSchema,
  score: integer.min(1).max(5).nullable(),
  title: text(3, 160),
  body: text(10, 3000),
  origin: productContributionOriginSchema,
  answer: text(10, 3000).nullable(),
  reply: text(3, 2000).nullable(),
  questionStatus: z.enum(['open', 'answered', 'closed']).nullable(),
  createdAt: instant,
  updatedAt: instant
}
export const publicProductContributionSchema = z.object(publicFields).strict()
export const productContributionSnapshotSchema = z
  .object({
    source: z.literal('cloudflare'),
    ...publicFields,
    version: integer.positive(),
    state: productContributionStateSchema,
    slaDueAt: instant.nullable(),
    capabilities: z.object({ canReply: z.boolean(), canModerate: z.boolean() }).strict(),
    history: z
      .array(
        z
          .object({
            action: z.enum(['submit', 'reply', 'publish', 'answer', 'close', 'withdraw']),
            version: integer.positive(),
            recordedAt: instant
          })
          .strict()
      )
      .max(100)
  })
  .strict()
const pagination = { page: integer.positive(), perPage: integer.positive().max(25), total: integer, pages: integer }
export const productContributionListSchema = z
  .object({ source: z.literal('cloudflare'), items: z.array(productContributionSnapshotSchema).max(25), ...pagination })
  .strict()
export const publicProductContributionListSchema = z
  .object({
    source: z.literal('cloudflare'),
    productId,
    items: z.array(publicProductContributionSchema).max(25),
    ...pagination
  })
  .strict()
export const productContributionReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: uuid,
    contributionId: uuid,
    action: z.enum(['submit', 'reply', 'publish', 'answer', 'close', 'withdraw']),
    expectedVersion: integer,
    version: integer.positive(),
    payloadHash: hash,
    recordedAt: instant,
    inventoryEffect: z.literal('none'),
    economicEffect: z.literal('none'),
    senderInvoked: z.literal(false)
  })
  .strict()
  .refine((value) => value.version === value.expectedVersion + 1)
export const productContributionCommandSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      source: z.literal('cloudflare'),
      outcome: z.literal('applied'),
      receipt: productContributionReceiptSchema
    })
    .strict(),
  z.object({ source: z.literal('cloudflare'), outcome: z.literal('unknown'), receipt: z.null() }).strict()
])
export type ProductContributionSnapshot = z.infer<typeof productContributionSnapshotSchema>
export type ProductContributionList = z.infer<typeof productContributionListSchema>
export type PublicProductContributionList = z.infer<typeof publicProductContributionListSchema>
export type ProductContributionReceipt = z.infer<typeof productContributionReceiptSchema>
export type ProductContributionCommand = z.infer<typeof productContributionCommandSchema>
export async function productContributionIntentHash(
  action: ProductContributionReceipt['action'],
  targetId: string | null,
  raw: unknown
): Promise<string> {
  const input =
    action === 'submit'
      ? productContributionSubmitInputSchema.parse(raw)
      : action === 'reply'
        ? productContributionReplyInputSchema.parse(raw)
        : productContributionModerationInputSchema.parse(raw)
  if (action === 'submit' ? targetId !== null : !uuid.safeParse(targetId).success) throw new Error('invalid_input')
  if ('action' in input && input.action !== action) throw new Error('invalid_input')
  const data = new TextEncoder().encode(JSON.stringify({ action, targetId, input }))
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}
