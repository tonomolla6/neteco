import { z } from 'zod'
import { validGtin } from '../server/domain/catalog-publication'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from './catalog-publication-policy'

export const catalogDraftAuthoringActionSchema = z.enum([
  'create_draft',
  'assign_brand',
  'create_variant',
  'update_variant',
  'discontinue_variant'
])
export type CatalogDraftAuthoringAction = z.infer<typeof catalogDraftAuthoringActionSchema>
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const positive = integer.min(1)
const version = positive.max(Number.MAX_SAFE_INTEGER - 1)
const text = (minimum: number, maximum: number, multiline = false) =>
  z
    .string()
    .refine((value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0)
        return code !== 127 && (code >= 32 || (multiline && [9, 10, 13].includes(code)))
      })
    )
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .max(maximum, `String must contain at most ${maximum} character(s)`)
        .superRefine((value, context) => {
          // Preserve the UTF-16 limits used by Zod 3, including supplementary characters.
          if (value.length < minimum) {
            context.addIssue({
              code: 'too_small',
              origin: 'string',
              minimum,
              inclusive: true,
              message: `String must contain at least ${minimum} character(s)`
            })
          }
          if (value.length > maximum && Array.from(value).length <= maximum) {
            context.addIssue({
              code: 'too_big',
              origin: 'string',
              maximum,
              inclusive: true,
              message: `String must contain at most ${maximum} character(s)`
            })
          }
        })
    )
const nullableText = (maximum: number, multiline = false) =>
  text(0, maximum, multiline)
    .nullable()
    .transform((value) => value || null)
const reason = text(3, 500)
const color = z
  .string()
  .length(7)
  .regex(/^#[0-9a-fA-F]{6}$/)
function own(value: unknown) {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
export const catalogDraftVariantFields = {
  sku: text(1, 64).pipe(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/)),
  format: text(1, 160),
  ean: nullableText(64).refine((value) => value === null || validGtin(value)),
  gtin: nullableText(64).refine((value) => value === null || validGtin(value)),
  mpn: nullableText(64),
  taxClassId: catalogPolicyUuidSchema,
  shippingProfileId: catalogPolicyUuidSchema,
  unitBase: text(1, 40),
  unitLabel: text(1, 80),
  contentQuantity: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER),
  unitsPerCase: positive,
  casesPerPallet: positive.nullable(),
  minimumQuantity: positive,
  quantityIncrement: positive,
  maximumQuantity: positive.nullable(),
  weightGrams: integer,
  widthMm: integer,
  heightMm: integer,
  depthMm: integer,
  backorderAllowed: z.boolean(),
  leadTimeDays: integer.nullable(),
  color: color.nullable()
} as const
const quantityWindow = (value: { minimumQuantity: number; maximumQuantity: number | null }) =>
  value.maximumQuantity === null || value.maximumQuantity >= value.minimumQuantity
export const draftVariantInputSchema = z.preprocess(
  own,
  z.object(catalogDraftVariantFields).strict().refine(quantityWindow)
)
export type DraftVariantInput = z.infer<typeof draftVariantInputSchema>
export const createDraftInputSchema = z.preprocess(
  own,
  z
    .object({
      expectedVersion: z.literal(0),
      reason,
      name: text(3, 160),
      categoryId: positive,
      brandId: catalogPolicyUuidSchema,
      shortDesc: text(5, 500),
      description: text(5, 10000, true),
      usage: nullableText(2000, true),
      series: nullableText(160),
      featured: z.boolean(),
      badges: z
        .array(z.enum(['eco', 'alimentaria', 'concentrado']))
        .max(3)
        .refine((values) => new Set(values).size === values.length),
      visual: z
        .object({
          type: z.enum([
            'garrafa',
            'botella',
            'spray',
            'caja',
            'saco',
            'capsulas',
            'difusor',
            'cubo',
            'rollo',
            'vaso',
            'guante'
          ]),
          color
        })
        .strict(),
      attrs: z.array(z.object({ k: text(1, 100), v: text(1, 1000) }).strict()).max(50),
      initialVariant: draftVariantInputSchema
    })
    .strict()
)
export const assignBrandInputSchema = z.preprocess(
  own,
  z.object({ expectedVersion: version, reason, brandId: catalogPolicyUuidSchema }).strict()
)
export const createVariantInputSchema = z.preprocess(
  own,
  z
    .object({ expectedVersion: version, reason, ...catalogDraftVariantFields })
    .strict()
    .refine(quantityWindow)
)
const editableVariant = z.object(catalogDraftVariantFields).omit({ sku: true }).partial().strict()
const editableFields = editableVariant.shape
export const updateVariantInputSchema = z.preprocess(
  own,
  editableVariant
    .extend({ expectedVersion: version, reason })
    .strict()
    .refine((value) => Object.keys(editableFields).some((key) => Object.hasOwn(value, key)))
)
export const discontinueVariantInputSchema = z.preprocess(own, z.object({ expectedVersion: version, reason }).strict())
export type CreateDraftInput = z.infer<typeof createDraftInputSchema>
export type AssignBrandInput = z.infer<typeof assignBrandInputSchema>
export type CreateVariantInput = z.infer<typeof createVariantInputSchema>
export type UpdateVariantInput = z.infer<typeof updateVariantInputSchema>
export type DiscontinueVariantInput = z.infer<typeof discontinueVariantInputSchema>
export const catalogDraftAuthoringReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    action: catalogDraftAuthoringActionSchema,
    productId: positive,
    productUuid: catalogPolicyUuidSchema,
    variantId: positive.nullable(),
    variantUuid: catalogPolicyUuidSchema.nullable(),
    catalogVersion: positive,
    updated: z.literal(true)
  })
  .strict()
  .refine((value) => (value.variantId === null) === (value.variantUuid === null))
  .refine((value) => (value.action === 'assign_brand') === (value.variantId === null))
export type CatalogDraftAuthoringReceipt = z.infer<typeof catalogDraftAuthoringReceiptSchema>
