import { z } from 'zod'
import { catalogPolicyInstantSchema as instant, catalogPolicyUuidSchema as uuid } from './catalog-publication-policy'

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const text = z
  .string()
  .max(500)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.codePointAt(0)!
      return code > 31 && !(code >= 127 && code <= 159) && code !== 0x2028 && code !== 0x2029
    })
  )
  .transform((value) => value.normalize('NFC').trim())
const reason = text.pipe(z.string().min(10).max(500))
export const salesQuoteDefinitionSchema = z
  .object({
    customerId: uuid,
    lines: z
      .array(
        z
          .object({
            variantId: z
              .string()
              .min(1)
              .max(200)
              .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
            quantity: integer.min(1)
          })
          .strict()
      )
      .min(1)
      .max(100)
      .refine((lines) => new Set(lines.map((line) => line.variantId)).size === lines.length),
    destination: z
      .object({ postalCode: z.string().regex(/^\d{5}$/), city: text.pipe(z.string().min(1).max(80)) })
      .strict(),
    shippingMethod: z.enum(['pickup', 'own_delivery', 'parcel']),
    validUntil: instant
  })
  .strict()
export const salesQuoteCreateInputSchema = salesQuoteDefinitionSchema.extend({ reason }).strict()
export const salesQuoteReviseInputSchema = salesQuoteCreateInputSchema
  .extend({ expectedVersion: integer.min(1) })
  .strict()
export const salesQuoteReviewInputSchema = z.object({ expectedVersion: integer.min(1), reason }).strict()
export const salesQuoteApproveInputSchema = salesQuoteReviewInputSchema.extend({ reviewedHash: hash }).strict()
export const salesQuoteRevokeInputSchema = salesQuoteReviewInputSchema
const checkoutAddress = z
  .object({
    recipientName: text.pipe(z.string().min(2).max(120)),
    companyName: text.optional(),
    taxId: text.optional(),
    line1: text.pipe(z.string().min(3).max(160)),
    line2: text.pipe(z.string().max(160)).optional(),
    instructions: z.string().max(1000).optional(),
    city: text.pipe(z.string().min(1).max(80)),
    province: text.pipe(z.string().min(1).max(80)),
    postalCode: z.string().regex(/^\d{5}$/),
    countryCode: z.literal('ES').optional(),
    phone: text.optional(),
    nif: text.optional()
  })
  .strict()
/** No cart token, claims, server instant, unit price or trusted approval object. */
export const salesQuoteConvertInputSchema = z
  .object({
    expectedVersion: integer.min(1),
    approvedHash: hash,
    checkout: z
      .object({
        expectedVersion: integer.min(1),
        quoteId: uuid,
        shippingQuoteId: uuid,
        selectedOptionIndex: integer,
        selectedOptionHash: hash,
        expectedTotalGrossCents: integer.optional(),
        contactEmail: z.string().email().max(254),
        contactName: text.optional(),
        contactPhone: text.optional(),
        buyerCompanyName: text.optional(),
        buyerTaxId: text.optional(),
        purchaseOrderReference: text.pipe(z.string().max(120)).optional(),
        shippingAddress: checkoutAddress.extend({ phone: text.pipe(z.string().regex(/^[0-9 +()-]{6,24}$/)) }).strict(),
        billingAddress: checkoutAddress.optional(),
        consentTos: z.literal(true),
        consentPrivacy: z.literal(true)
      })
      .strict()
  })
  .strict()
export type SalesQuoteAction = 'create' | 'revise' | 'review' | 'approve' | 'revoke'
export type SalesQuoteDefinition = z.infer<typeof salesQuoteDefinitionSchema>
const amounts = z.object({ netCents: integer, taxCents: integer, grossCents: integer }).strict()
export const salesQuoteAdminSnapshotSchema = z
  .object({
    source: z.literal('cloudflare'),
    id: uuid,
    version: integer.min(1),
    status: z.enum(['draft', 'reviewed', 'approved', 'revoked', 'converted']),
    definition: salesQuoteDefinitionSchema,
    lines: z
      .array(
        z
          .object({
            variantId: z.string().min(1).max(200),
            quantity: integer.min(1),
            unitGrossCents: integer,
            taxRateBasisPoints: integer.max(10000),
            priceVersionId: z.string().min(1).max(200),
            costUnitNetCents: integer.nullable(),
            amounts
          })
          .strict()
      )
      .max(100),
    goods: amounts.nullable(),
    shipping: amounts.nullable(),
    total: amounts.nullable(),
    goodsCostNetCents: integer.nullable(),
    goodsMarginNetCents: z.number().int().safe().nullable(),
    shippingOperationalCostNetCents: z.null(),
    totalMarginNetCents: z.null(),
    reviewedHash: hash.nullable(),
    approvedHash: hash.nullable(),
    orderId: uuid.nullable(),
    createdAt: instant,
    updatedAt: instant
  })
  .strict()
export const salesQuoteReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: uuid,
    action: z.enum(['create', 'revise', 'review', 'approve', 'revoke', 'convert']),
    quoteId: uuid,
    version: integer.min(1),
    payloadHash: hash,
    orderId: uuid.nullable(),
    recordedAt: instant
  })
  .strict()
export const salesQuoteCommandSchema = z.discriminatedUnion('outcome', [
  z
    .object({ source: z.literal('cloudflare'), outcome: z.literal('applied'), receipt: salesQuoteReceiptSchema })
    .strict(),
  z.object({ source: z.literal('cloudflare'), outcome: z.literal('unknown'), receipt: z.null() }).strict()
])
export type SalesQuoteAdminSnapshot = z.infer<typeof salesQuoteAdminSnapshotSchema>
export type SalesQuoteReceipt = z.infer<typeof salesQuoteReceiptSchema>
export type SalesQuoteCommand = z.infer<typeof salesQuoteCommandSchema>
/** Receipt fingerprint is computable before transport. No credentials or internal correlation IDs. */
export async function salesQuoteConversionIntentHash(quoteId: string, cartId: string, raw: unknown) {
  const input = salesQuoteConvertInputSchema.parse(raw)
  const value = JSON.stringify(['sales-quote-convert-v1', uuid.parse(quoteId), uuid.parse(cartId), input])
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
export async function salesQuoteIntentHash(action: SalesQuoteAction, quoteId: string | null, raw: unknown) {
  const schema =
    action === 'create'
      ? salesQuoteCreateInputSchema
      : action === 'revise'
        ? salesQuoteReviseInputSchema
        : action === 'approve'
          ? salesQuoteApproveInputSchema
          : salesQuoteReviewInputSchema
  if (action === 'create' ? quoteId !== null : !uuid.safeParse(quoteId).success) throw new Error('invalid_input')
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify({
        purpose: 'sales-quote-v1',
        action,
        quoteId,
        input: schema.parse(raw)
      })
    )
  )
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
