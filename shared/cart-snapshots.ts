import { z } from 'zod'
import { catalogPolicyInstantSchema as instant, catalogPolicyUuidSchema as uuid } from './catalog-publication-policy'

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const identity = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const printable = (value: string) =>
  [...value].every((char) => {
    const point = char.charCodeAt(0)
    return point >= 32 && !(point >= 127 && point <= 159) && point !== 0x2028 && point !== 0x2029
  })
export const cartSnapshotInputSchema = z
  .object({
    name: z
      .string()
      .refine(printable)
      .transform((value) => value.trim().normalize('NFC'))
      .pipe(
        z
          .string()
          .min(1)
          .max(80)
          .refine((value) => value !== 'Favoritos')
      ),
    expectedCartVersion: count.min(1),
    createShare: z.boolean()
  })
  .strict()
export const cartSnapshotReceiptSchema = z
  .object({
    commandId: uuid,
    payloadHash: hash,
    listId: uuid,
    shareId: uuid.nullable(),
    cartVersion: count.min(1),
    createdAt: instant,
    expiresAt: instant.nullable()
  })
  .strict()
  .refine((value) => (value.shareId === null) === (value.expiresAt === null), 'Share expiry must match share presence')
export const cartSnapshotShareSchema = z
  .object({ id: uuid, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: instant })
  .strict()
export const cartSnapshotResponseSchema = z
  .object({
    source: z.literal('cloudflare'),
    receipt: cartSnapshotReceiptSchema,
    share: cartSnapshotShareSchema.nullable()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.share === null) !== (value.receipt.shareId === null) ||
      (value.share !== null &&
        (value.share.id !== value.receipt.shareId || value.share.expiresAt !== value.receipt.expiresAt))
    )
      ctx.addIssue({ code: 'custom', message: 'Share receipt mismatch' })
  })
export const cartSnapshotCommandSchema = z.union([
  z
    .object({
      source: z.literal('cloudflare'),
      action: z.literal('create'),
      outcome: z.literal('applied'),
      receipt: cartSnapshotReceiptSchema,
      share: cartSnapshotShareSchema.nullable()
    })
    .strict(),
  z
    .object({
      source: z.literal('cloudflare'),
      action: z.literal('revoke'),
      outcome: z.literal('applied'),
      receipt: z
        .object({
          source: z.literal('cloudflare'),
          commandId: uuid,
          payloadHash: hash,
          shareId: uuid,
          revoked: z.literal(true),
          revokedAt: instant
        })
        .strict(),
      share: z.null()
    })
    .strict(),
  z
    .object({ source: z.literal('cloudflare'), outcome: z.literal('unknown'), receipt: z.null(), share: z.null() })
    .strict()
])
export const cartSnapshotRevokeInputSchema = z.object({}).strict()
export const cartSnapshotRevokeReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: uuid,
    payloadHash: hash,
    shareId: uuid,
    revoked: z.literal(true),
    revokedAt: instant
  })
  .strict()
export const cartSnapshotListSchema = z
  .object({
    source: z.literal('cloudflare'),
    items: z.array(z.object({ receipt: cartSnapshotReceiptSchema, revoked: z.boolean() }).strict()).max(20)
  })
  .strict()
export const sharedCartResolveInputSchema = z
  .object({ id: uuid, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict()
const unavailable = z
  .object({
    variantId: identity,
    quantity: count.min(1).max(999),
    available: z.literal(false),
    reason: z.enum(['variant_unavailable', 'quantity_invalid', 'cart_unmapped', 'out_of_stock'])
  })
  .strict()
const available = z
  .object({
    variantId: identity,
    quantity: count.min(1).max(999),
    available: z.literal(true),
    reason: z.null(),
    cartVariantId: count.min(1),
    name: z.string().min(1).max(500),
    sku: z.string().min(1).max(200),
    slug: z.string().min(1).max(300),
    format: z.string().max(500),
    unitLabel: z.string().max(100),
    baseUnitGrossCents: count,
    unitGrossCents: count,
    netCents: count,
    taxCents: count,
    grossCents: count,
    taxRateBasisPoints: count.max(10000),
    minimumQuantity: count.min(1),
    maximumQuantity: count.min(1).nullable(),
    quantityIncrement: count.min(1)
  })
  .strict()
export const sharedCartResolveResponseSchema = z
  .object({
    source: z.literal('cloudflare'),
    id: uuid,
    expiresAt: instant,
    evaluatedAt: instant,
    items: z
      .array(z.discriminatedUnion('available', [available, unavailable]))
      .min(1)
      .max(100)
  })
  .strict()
export type CartSnapshotInput = z.infer<typeof cartSnapshotInputSchema>
export type CartSnapshotReceipt = z.infer<typeof cartSnapshotReceiptSchema>
export type CartSnapshotResponse = z.infer<typeof cartSnapshotResponseSchema>
export type CartSnapshotCommand = z.infer<typeof cartSnapshotCommandSchema>
export type CartSnapshotList = z.infer<typeof cartSnapshotListSchema>
export type CartSnapshotRevokeReceipt = z.infer<typeof cartSnapshotRevokeReceiptSchema>
export type SharedCartResolveResponse = z.infer<typeof sharedCartResolveResponseSchema>
export async function cartSnapshotIntentHash(raw: unknown): Promise<string> {
  const input = cartSnapshotInputSchema.parse(raw)
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)))
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
export async function cartSnapshotRevokeIntentHash(shareId: string, raw: unknown): Promise<string> {
  uuid.parse(shareId)
  cartSnapshotRevokeInputSchema.parse(raw)
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify({ action: 'revoke', shareId }))
  )
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
