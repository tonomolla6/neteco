import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from './catalog-publication-policy'

/** Availability of separate D1 commands, never the legacy full-product PUT. */
export const CATALOG_DRAFT_AUTHORING_CAPABILITIES = {
  productDraftCreate: true,
  productDraftBrandUpdate: true,
  variantDraftCreate: true,
  variantDraftUpdate: true,
  variantDraftDiscontinue: true
} as const

const uuid = catalogPolicyUuidSchema
const integer = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const text = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine(
      (value) =>
        [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) &&
        value.trim().length > 0
    )
const instant = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  const date = new Date(value)
  return (
    !Number.isNaN(date.getTime()) &&
    (date.toISOString() === value || date.toISOString().replace('.000Z', 'Z') === value)
  )
})

/** Guard DTOs before schema access: inherited values, accessors, cycles and
 * sparse arrays are not confirmed reads. Do not normalize server values. */
function guarded<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => {
    try {
      // Copy into null-prototype records before Zod property access. Checking
      // own keys alone still lets a missing required field inherit a value.
      return catalogPolicyOwnJson(value)
    } catch {
      return undefined
    }
  }, schema)
}

const capabilities = z
  .object({
    productDraftCreate: z.boolean(),
    productDraftBrandUpdate: z.boolean(),
    variantDraftCreate: z.boolean(),
    variantDraftUpdate: z.boolean(),
    variantDraftDiscontinue: z.boolean()
  })
  .strict()

const optionsBody = z
  .object({
    source: z.literal('cloudflare'),
    capabilities,
    categories: z
      .array(
        z
          .object({
            id: integer,
            name: text(200),
            parentId: integer.nullable(),
            status: z.enum(['draft', 'review', 'published', 'hidden'])
          })
          .strict()
      )
      .max(500),
    brands: z
      .array(z.object({ id: uuid, name: text(200), status: z.enum(['draft', 'review', 'published']) }).strict())
      .max(500),
    taxClasses: z
      .array(
        z
          .object({
            id: uuid,
            code: text(100),
            name: text(200),
            rateBasisPoints: z.number().int().min(0).max(10000),
            validFrom: instant,
            validUntil: instant.nullable()
          })
          .strict()
      )
      .max(500),
    shippingProfiles: z
      .array(
        z
          .object({
            id: uuid,
            code: text(100),
            name: text(200),
            kind: z.enum(['parcel', 'multi_parcel', 'pallet', 'own_delivery', 'adr'])
          })
          .strict()
      )
      .max(500)
  })
  .strict()
  .superRefine((value, context) => {
    for (const key of ['categories', 'brands', 'taxClasses', 'shippingProfiles'] as const) {
      const ids = value[key].map((entry) => String(entry.id))
      if (new Set(ids).size !== ids.length)
        context.addIssue({ code: 'custom', path: [key], message: 'Duplicate reference' })
    }
    const categories = new Map(value.categories.map((entry) => [entry.id, entry]))
    for (const category of value.categories) {
      const seen = new Set<number>()
      let current: typeof category | undefined = category
      while (current) {
        if (seen.has(current.id) || seen.size > 128) {
          context.addIssue({ code: 'custom', path: ['categories'], message: 'Invalid category ancestry' })
          break
        }
        seen.add(current.id)
        current = current.parentId === null ? undefined : categories.get(current.parentId)
      }
    }
  })

export const catalogDraftAuthoringOptionsSchema = guarded(optionsBody)
export type CatalogDraftAuthoringOptions = z.infer<typeof catalogDraftAuthoringOptionsSchema>

const nullableIdentifier = z.string().max(64).nullable()
const variantBody = z
  .object({
    id: integer,
    uuid,
    status: z.enum(['draft', 'review', 'published', 'hidden', 'discontinued']),
    sku: text(64),
    format: text(200),
    ean: nullableIdentifier,
    gtin: nullableIdentifier,
    mpn: nullableIdentifier,
    taxClassId: uuid,
    shippingProfileId: uuid,
    unitBase: text(40),
    unitLabel: text(80),
    contentQuantity: z.number().positive().max(Number.MAX_SAFE_INTEGER),
    unitsPerCase: integer,
    casesPerPallet: integer.nullable(),
    minimumQuantity: integer,
    quantityIncrement: integer,
    maximumQuantity: integer.nullable(),
    weightGrams: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    widthMm: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    heightMm: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    depthMm: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    backorderAllowed: z.boolean(),
    leadTimeDays: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    color: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .nullable()
  })
  .strict()

export const catalogDraftAuthoringSnapshotSchema = guarded(
  z
    .object({
      productId: integer,
      productUuid: uuid,
      catalogVersion: integer,
      status: z.enum(['draft', 'review', 'published', 'hidden', 'discontinued']),
      brandId: uuid.nullable(),
      variants: z.array(variantBody).max(500)
    })
    .strict()
    .superRefine((value, context) => {
      if (
        new Set(value.variants.map((variant) => variant.id)).size !== value.variants.length ||
        new Set(value.variants.map((variant) => variant.uuid)).size !== value.variants.length
      )
        context.addIssue({ code: 'custom', path: ['variants'], message: 'Duplicate variant identity' })
    })
)
export type CatalogDraftAuthoringSnapshot = z.infer<typeof catalogDraftAuthoringSnapshotSchema>
