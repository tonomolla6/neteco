import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema, catalogPolicyInstantSchema } from './catalog-publication-policy'
import { inventoryIdempotencyKeySchema } from './inventory-commands'
import { supportMacroReplySchema } from './support-macros'

export const supportUuid = catalogPolicyUuidSchema
export const supportInstant = catalogPolicyInstantSchema
export const supportKey = inventoryIdempotencyKeySchema
export const supportRef = z.string().regex(/^SOP-[0-9A-F]{24}$/)
export const supportCategory = z.enum([
  'product',
  'order',
  'shipping',
  'payment',
  'invoice',
  'return',
  'account',
  'other'
])
export const supportState = z.enum(['open', 'waiting_customer', 'waiting_provider', 'resolved', 'closed'])
export const supportPriority = z.enum(['low', 'normal', 'high', 'urgent'])
export type SupportState = z.infer<typeof supportState>
const number = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const supportText = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(
      (value) =>
        value === value.trim() &&
        [...value].every((c) => c.charCodeAt(0) >= 32 || c === '\n' || c === '\t') &&
        !value.includes('\u007f')
    )
function own(value: unknown) {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
export const supportPolicySchema = z
  .object({
    reference: supportText(3, 100),
    version: number.min(1),
    privacyNoticePath: z.string().regex(/^\/[a-z0-9/-]+$/),
    retentionDays: number.min(1).max(36500),
    responseMinutes: number.min(1).max(525600).nullable(),
    serviceHoursDescription: supportText(3, 300).nullable()
  })
  .strict()
export type SupportPolicy = z.infer<typeof supportPolicySchema>
export const supportContactInputSchema = z.preprocess(
  own,
  z
    .object({
      name: supportText(2, 160),
      email: z.string().email().max(254),
      phone: supportText(6, 32).optional(),
      category: supportCategory,
      subject: supportText(5, 200),
      message: supportText(10, 5000),
      orderId: supportUuid.optional(),
      orderReference: supportText(1, 80).optional(),
      productSlug: z
        .string()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .max(180)
        .optional(),
      categorySlug: z
        .string()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .max(180)
        .optional(),
      privacyAcknowledged: z.literal(true),
      website: z.literal(''),
      challengeToken: z.string().min(1).max(2048).optional()
    })
    .strict()
)
export type SupportContactInput = z.infer<typeof supportContactInputSchema>
const common = { expectedVersion: number.min(1).max(Number.MAX_SAFE_INTEGER - 1), reason: supportText(3, 500) }
export const supportAdminInputSchema = z.preprocess(
  own,
  z.discriminatedUnion('action', [
    z
      .object({
        ...common,
        action: z.literal('update'),
        state: supportState,
        priority: supportPriority,
        ownerId: supportUuid.nullable(),
        nextActionAt: supportInstant.nullable(),
        slaDueAt: supportInstant.nullable(),
        resolution: supportText(10, 1000).optional()
      })
      .strict(),
    z
      .object({
        ...common,
        action: z.literal('reply'),
        message: supportText(1, 5000),
        macro: supportMacroReplySchema.optional()
      })
      .strict(),
    z.object({ ...common, action: z.literal('note'), message: supportText(1, 2000) }).strict(),
    z
      .object({
        ...common,
        action: z.literal('call'),
        message: supportText(3, 2000),
        occurredAt: supportInstant,
        nextActionAt: supportInstant.nullable()
      })
      .strict()
  ])
)
export type SupportAdminInput = z.infer<typeof supportAdminInputSchema>
export const supportCustomerReplySchema = z.preprocess(
  own,
  z
    .object({
      expectedVersion: common.expectedVersion,
      message: supportText(1, 5000)
    })
    .strict()
)
export const supportReceiptSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      commandId: supportUuid,
      publicRef: supportRef,
      version: number.min(1),
      state: supportState,
      updated: z.literal(true),
      emailStatus: z.enum(['queued', 'not_requested']),
      inventoryEffect: z.literal('none'),
      economicEffect: z.literal('none')
    })
    .strict()
)
export type SupportReceipt = z.infer<typeof supportReceiptSchema>
export const supportAttachmentSchema = z
  .object({
    id: supportUuid,
    filename: supportText(1, 180),
    mimeType: z.enum(['image/png', 'image/jpeg', 'application/pdf']),
    byteSize: number.min(1).max(10485760),
    state: z.enum(['staging', 'quarantined', 'clean', 'infected', 'expired']),
    visibility: z.enum(['public', 'internal']),
    downloadable: z.boolean(),
    createdAt: supportInstant
  })
  .strict()
const summary = {
  publicRef: supportRef,
  category: supportCategory,
  subject: supportText(5, 200),
  state: supportState,
  version: number.min(1),
  createdAt: supportInstant,
  updatedAt: supportInstant,
  nextActionAt: supportInstant.nullable(),
  slaDueAt: supportInstant.nullable(),
  policy: supportPolicySchema.nullable(),
  retentionUntil: supportInstant.nullable(),
  identityStatus: z.enum(['verified_customer', 'unverified_contact']),
  orderId: supportUuid.nullable(),
  productSlug: z.string().nullable(),
  categorySlug: z.string().nullable()
}
const page = z
  .object({ page: number.min(1).max(1000000), perPage: number.min(1).max(50), total: number, pages: number })
  .strict()
  .refine((value) => value.pages === Math.ceil(value.total / value.perPage))
const event = z
  .object({
    id: supportUuid,
    type: z.enum(['created', 'update', 'reply', 'note', 'call', 'attachment']),
    actorType: z.enum(['anonymous', 'customer', 'admin']),
    body: z.string().max(5000).nullable(),
    visibility: z.enum(['public', 'internal']),
    state: supportState,
    createdAt: supportInstant,
    occurredAt: supportInstant.nullable()
  })
  .strict()
const capabilities = z
  .object({
    reply: z.boolean(),
    manage: z.boolean(),
    attachments: z.boolean(),
    refunds: z.literal(false),
    fiscal: z.literal(false),
    inventory: z.literal(false),
    carrier: z.literal(false)
  })
  .strict()
export const supportContextSchema = z
  .object({
    order: z
      .object({
        id: supportUuid,
        status: z.string(),
        currency: z.string(),
        totalGrossCents: number,
        shippingMethod: z.string(),
        lines: z
          .array(
            z
              .object({
                index: number,
                sku: z.string(),
                name: z.string(),
                quantity: number.min(1),
                unitGrossCents: number,
                grossCents: number
              })
              .strict()
          )
          .max(100)
      })
      .strict()
      .nullable(),
    payment: z.object({ status: z.string(), paidGrossCents: number }).strict().nullable(),
    fulfillment: z.object({ status: z.string(), updatedAt: supportInstant }).strict().nullable(),
    returns: z
      .array(z.object({ publicRef: z.string(), state: z.string(), updatedAt: supportInstant }).strict())
      .max(50),
    fiscal: z
      .object({ status: z.string(), validationOnly: z.boolean(), pdfAvailable: z.boolean() })
      .strict()
      .nullable(),
    redacted: z.array(z.enum(['order', 'payment', 'fiscal'])).max(3)
  })
  .strict()
export const supportCustomerTicketSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      ...summary,
      timeline: z.array(event).max(50),
      attachments: z.array(supportAttachmentSchema).max(100),
      pagination: page,
      context: supportContextSchema,
      capabilities
    })
    .strict()
    .refine(
      (value) =>
        value.timeline.every((item) => item.visibility === 'public') &&
        value.attachments.every((item) => item.visibility === 'public') &&
        value.identityStatus === 'verified_customer'
    )
)
export type SupportCustomerTicket = z.infer<typeof supportCustomerTicketSchema>
export const supportAdminTicketSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      ...summary,
      priority: supportPriority,
      ownerId: supportUuid.nullable(),
      requester: z.object({ name: z.string(), email: z.string(), phone: z.string().nullable() }).strict(),
      declaredOrderReference: z.string().nullable(),
      timeline: z.array(event).max(50),
      attachments: z.array(supportAttachmentSchema).max(100),
      pagination: page,
      staff: z.array(z.object({ id: supportUuid, label: z.string() }).strict()).max(100),
      context: supportContextSchema,
      capabilities
    })
    .strict()
)
export type SupportAdminTicket = z.infer<typeof supportAdminTicketSchema>
export const supportCustomerListSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      items: z.array(z.object(summary).strict()).max(50),
      pagination: page
    })
    .strict()
)
export const supportAdminListSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      items: z
        .array(
          z
            .object({
              ...summary,
              priority: supportPriority,
              ownerId: supportUuid.nullable()
            })
            .strict()
        )
        .max(50),
      pagination: page
    })
    .strict()
)
export const supportChallengeConfigurationSchema = z.preprocess(
  own,
  z
    .object({
      provider: z.literal('turnstile'),
      siteKey: z
        .string()
        .min(1)
        .max(200)
        .regex(/^[a-zA-Z0-9_-]+$/),
      action: z.literal('neteco_support')
    })
    .strict()
)
export type SupportChallengeConfiguration = z.infer<typeof supportChallengeConfigurationSchema>
export const supportOptionsSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      categories: z.array(supportCategory).length(8),
      policy: supportPolicySchema.nullable(),
      attachments: z.boolean(),
      challengeAvailable: z.boolean(),
      challenge: supportChallengeConfigurationSchema.optional(),
      privacyReviewRequired: z.boolean()
    })
    .strict()
    .refine((value) => !value.challenge || value.challengeAvailable)
)
export type SupportOptions = z.infer<typeof supportOptionsSchema>
export type SupportAdminList = z.infer<typeof supportAdminListSchema>
export type SupportCustomerList = z.infer<typeof supportCustomerListSchema>
export const SUPPORT_CATEGORIES = supportCategory.options
export function allowedSupportTransition(from: SupportState, to: SupportState) {
  if (from === to) return true
  if (from === 'closed') return to === 'open'
  if (from === 'resolved') return ['open', 'closed'].includes(to)
  return ['open', 'waiting_customer', 'waiting_provider', 'resolved'].includes(to)
}
