import { z } from 'zod'
import { selectVolumeUnitPrice } from '../server/domain/money'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from './catalog-publication-policy'

function own(value: unknown) {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
export const catalogPriceIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127))
/** Both spellings already exist in governed imports; no offset/coercion. */
export const catalogPriceInstantSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  const time = Date.parse(value)
  return (
    Number.isFinite(time) &&
    (value.length === 24
      ? new Date(time).toISOString() === value
      : new Date(time).toISOString().replace('.000Z', 'Z') === value)
  )
})
const reason = z
  .string()
  .max(500)
  .refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127))
  .transform((value) => value.trim())
  .pipe(z.string().min(3).max(500))
export const catalogPriceTierSchema = z.object({ minimumQuantity: positive, unitGrossCents: positive }).strict()
const common = {
  expectedCatalogVersion: positive,
  expectedLatestApprovedId: catalogPriceIdSchema.nullable(),
  reason
}
export const catalogPriceScheduleInputSchema = z.preprocess(
  own,
  z
    .object({
      ...common,
      variantId: catalogPolicyUuidSchema,
      grossCents: positive,
      compareAtGrossCents: positive.nullable(),
      volumeTiers: z.array(catalogPriceTierSchema).max(20),
      validFrom: catalogPriceInstantSchema
    })
    .strict()
    .superRefine((value, context) => {
      if (value.compareAtGrossCents !== null && value.compareAtGrossCents <= value.grossCents)
        context.addIssue({
          code: 'custom',
          path: ['compareAtGrossCents'],
          message: 'El precio anterior debe ser mayor.'
        })
      try {
        selectVolumeUnitPrice(value.grossCents, 1, value.volumeTiers)
      } catch {
        context.addIssue({ code: 'custom', path: ['volumeTiers'], message: 'Los tramos no son válidos.' })
      }
    })
)
export const catalogPriceCancelInputSchema = z.preprocess(
  own,
  z
    .object({
      ...common,
      expectedLatestApprovedId: catalogPriceIdSchema
    })
    .strict()
)
export type CatalogPriceScheduleInput = z.infer<typeof catalogPriceScheduleInputSchema>
export type CatalogPriceCancelInput = z.infer<typeof catalogPriceCancelInputSchema>
export const catalogPriceReceiptSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      action: z.enum(['price_schedule', 'price_cancel']),
      commandId: catalogPolicyUuidSchema,
      priceId: catalogPriceIdSchema,
      variantId: catalogPolicyUuidSchema,
      variantLegacyId: positive,
      updated: z.literal(true)
    })
    .strict()
    .superRefine((value, context) => {
      if (value.action === 'price_schedule' && !catalogPolicyUuidSchema.safeParse(value.priceId).success)
        context.addIssue({ code: 'custom', path: ['priceId'], message: 'Identidad de la nueva aprobación inválida.' })
    })
)
export type CatalogPriceReceipt = z.infer<typeof catalogPriceReceiptSchema>
const zero = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const pagination = z
  .object({ page: positive.max(1_000_000), perPage: positive.max(500), total: zero, pages: zero })
  .strict()
const version = z
  .object({
    id: catalogPriceIdSchema,
    grossCents: positive,
    compareAtGrossCents: positive.nullable(),
    referenceGrossCents30d: positive.nullable(),
    volumeTiers: z.array(catalogPriceTierSchema).max(20),
    validFrom: catalogPriceInstantSchema,
    validUntil: catalogPriceInstantSchema.nullable(),
    status: z.enum(['approved', 'cancelled']),
    reason: z.string().max(500)
  })
  .strict()
  .refine((value) => value.validUntil === null || Date.parse(value.validUntil) > Date.parse(value.validFrom))
export const catalogPriceItemSchema = z
  .object({
    variantId: catalogPolicyUuidSchema,
    id: positive,
    sku: z.string().min(1).max(160),
    format: z.string().max(500),
    product: z.string().min(1).max(500),
    productId: positive,
    productUuid: catalogPolicyUuidSchema,
    catalogVersion: positive,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    grossCents: zero,
    compareAtGrossCents: positive.nullable(),
    referenceGrossCents30d: positive.nullable(),
    volumeTiers: z.array(catalogPriceTierSchema).max(20),
    pricingVersion: catalogPriceIdSchema,
    currentPrice: z
      .object({ kind: z.enum(['legacy', 'governed']), versionId: catalogPriceIdSchema.nullable() })
      .strict(),
    quantityRules: z
      .object({ minimumQuantity: positive, maximumQuantity: positive.nullable(), quantityIncrement: positive })
      .strict(),
    validFrom: catalogPriceInstantSchema.nullable(),
    history: z.array(version).max(100),
    historyPagination: pagination,
    scheduled: version.nullable(),
    latestApproved: version.nullable(),
    cancellable: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.currentPrice.kind === 'legacy') !== (value.currentPrice.versionId === null))
      context.addIssue({ code: 'custom', path: ['currentPrice'], message: 'Identidad del precio incoherente.' })
    if (value.currentPrice.versionId !== null && value.currentPrice.versionId !== value.pricingVersion)
      context.addIssue({ code: 'custom', path: ['currentPrice'], message: 'Versión del precio incoherente.' })
    try {
      selectVolumeUnitPrice(value.grossCents, 1, value.volumeTiers)
    } catch {
      context.addIssue({ code: 'custom', path: ['volumeTiers'], message: 'Tramos incoherentes.' })
    }
    if (
      value.quantityRules.maximumQuantity !== null &&
      value.quantityRules.maximumQuantity < value.quantityRules.minimumQuantity
    )
      context.addIssue({ code: 'custom', path: ['quantityRules'], message: 'Ventana de cantidades incoherente.' })
    if (value.latestApproved && value.latestApproved.status !== 'approved')
      context.addIssue({ code: 'custom', path: ['latestApproved'], message: 'Cabeza aprobada incoherente.' })
  })
export const catalogPriceListSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      capabilities: z
        .object({
          pricesRead: z.literal(true),
          priceHistoryRead: z.boolean().optional(),
          priceSchedulesRead: z.boolean().optional(),
          priceWrite: z.boolean().optional(),
          priceSchedule: z.boolean().optional(),
          priceCancel: z.boolean().optional()
        })
        .strict(),
      items: z.array(catalogPriceItemSchema).max(500),
      pagination,
      pricingInstant: catalogPriceInstantSchema,
      referenceEvidence: z.literal('available_approved_windows_only'),
      limits: z
        .object({
          itemsPerPageMax: z.literal(500),
          historyPerPageMax: positive.max(100),
          returnedVersionRecordsMax: positive.max(5000)
        })
        .strict()
    })
    .strict()
    .superRefine((value, context) => {
      if (
        new Set(value.items.map((item) => item.variantId)).size !== value.items.length ||
        new Set(value.items.map((item) => item.id)).size !== value.items.length
      )
        context.addIssue({ code: 'custom', path: ['items'], message: 'Referencias duplicadas.' })
      for (const [index, item] of value.items.entries()) {
        if (
          item.cancellable !==
          !!(item.latestApproved && Date.parse(item.latestApproved.validFrom) > Date.parse(value.pricingInstant))
        )
          context.addIssue({
            code: 'custom',
            path: ['items', index, 'cancellable'],
            message: 'Vigencia de cancelación incoherente.'
          })
      }
    })
)
export type CatalogPriceItem = z.infer<typeof catalogPriceItemSchema>
export type CatalogPriceList = z.infer<typeof catalogPriceListSchema>
