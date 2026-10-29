import { z } from 'zod'
import { catalogPolicyOwnJson } from './catalog-publication-policy'
import { CATALOG_NATIVE_IMPORT_MAX_BYTES } from './catalog-native-import'
import { CATALOG_TABULAR_MAX_CELL_CHARACTERS } from './catalog-tabular-core'

// A review duplicates original fields in claimed/after. Its private DTO budget
// is twice one normalized entry, not a smaller replacement for the file format.
export const CATALOG_IMPORT_JOB_REVIEW_MAX_BYTES = 1_800_000
export const CATALOG_IMPORT_JOB_REVIEW_MAX_NODES = 60_000
export const CATALOG_IMPORT_JOB_REVIEW_MAX_DEPTH = 10

export const CATALOG_IMPORT_JOB_REVIEW_WARNINGS = [
  'new_records_only',
  'draft_not_publication',
  'claimed_media_not_verified',
  'prices_stock_require_live_apply',
  'identifier_explanation_not_publication_exception'
] as const
export const CATALOG_IMPORT_JOB_REVIEW_WARNING_TEXT = {
  new_records_only: 'Crea registros nuevos: before es null, no reemplaza registros existentes.',
  draft_not_publication:
    'Los estados del archivo son declaraciones; productos y variantes se crearán como borradores, sin publicación.',
  claimed_media_not_verified:
    'Los derechos y análisis declarados no son verificaciones: los medios quedan pendientes y no autorizan publicación ni acreditan una subida.',
  prices_stock_require_live_apply:
    'Precios y stock sólo se inicializan tras una aplicación explícita con autorización vigente; la revisión no cambia el catálogo.',
  identifier_explanation_not_publication_exception:
    'La explicación de identificadores no concede una excepción de publicación.'
} as const

/** A single normalized staging entry, not the whole-file/page authorization
 * boundary. Reject hooks before reading them and bound cumulative JSON text. */
function own(value: unknown) {
  let nodes = 0,
    bytes = 0
  function visit(input: unknown, depth: number): void {
    if (++nodes > CATALOG_IMPORT_JOB_REVIEW_MAX_NODES || depth > CATALOG_IMPORT_JOB_REVIEW_MAX_DEPTH)
      throw new Error('invalid_catalog_import_review')
    if (typeof input === 'string') {
      if (input.length > CATALOG_TABULAR_MAX_CELL_CHARACTERS) throw new Error('invalid_catalog_import_review')
      bytes += new TextEncoder().encode(input).byteLength
      if (bytes > CATALOG_IMPORT_JOB_REVIEW_MAX_BYTES) throw new Error('invalid_catalog_import_review')
      return
    }
    if (!input || typeof input !== 'object') return
    const array = Array.isArray(input),
      prototype = Object.getPrototypeOf(input),
      keys = Reflect.ownKeys(input)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw new Error('invalid_catalog_import_review')
    if (keys.length > CATALOG_IMPORT_JOB_REVIEW_MAX_NODES - nodes + 1 || (array && keys.length > 1001))
      throw new Error('invalid_catalog_import_review')
    for (const key of keys) {
      if (array && key === 'length') continue
      if (typeof key !== 'string') throw new Error('invalid_catalog_import_review')
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
        throw new Error('invalid_catalog_import_review')
      visit(descriptor.value, depth + 1)
    }
  }
  visit(value, 0)
  return catalogPolicyOwnJson(value)
}
function safeOwn(value: unknown) {
  try {
    return own(value)
  } catch {
    return undefined
  }
}
const text = (max = 20_000, min = 0) => z.string().min(min).max(max)
// Source UUIDs use the same non-coercing validator as tabular normalization;
// unlike session identities they may retain uppercase hexadecimal spelling.
const uuid = z.string().uuid()
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const positive = integer.min(1)
const status = z.enum(['draft', 'review', 'published', 'hidden', 'discontinued'])
const object = z.record(z.string(), z.unknown())
const product = z
  .object({
    id: uuid,
    legacyId: positive,
    name: text(240, 3),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    status,
    shortDescription: text(),
    description: text(),
    categoryId: uuid,
    categoryStatus: text(),
    brandId: uuid,
    brandStatus: text(),
    sourceId: uuid,
    sourceVersion: text(80, 1),
    usage: text().nullable(),
    series: text().nullable(),
    featured: z.boolean(),
    attributes: object,
    regulatory: object,
    requiresSds: z.boolean()
  })
  .strict()
const balance = z
  .object({ locationId: uuid, physicalQuantity: integer, blockedQuantity: integer, version: z.literal(1) })
  .strict()
  .refine((value) => value.blockedQuantity <= value.physicalQuantity)
const variant = z
  .object({
    id: uuid,
    legacyId: positive,
    productId: uuid,
    sku: text(64, 1),
    ean: text().nullable(),
    gtin: text().nullable(),
    mpn: text().nullable(),
    identifierExceptionReason: text().nullable(),
    format: text(160, 1),
    status,
    sourceVersion: text(80, 1),
    taxClassId: uuid,
    shippingProfileId: uuid,
    priceGrossCents: positive,
    compareAtGrossCents: integer.nullable(),
    costNetCents: integer.nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    unitBase: text(),
    unitLabel: text(),
    contentQuantity: z.number().finite().positive(),
    unitsPerCase: positive,
    casesPerPallet: positive.nullable(),
    minimumQuantity: positive,
    quantityIncrement: positive,
    maximumQuantity: positive.nullable(),
    weightGrams: integer,
    widthMm: integer,
    heightMm: integer,
    depthMm: integer,
    safetyStock: integer,
    backorderAllowed: z.boolean(),
    leadTimeDays: integer.nullable(),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .nullable(),
    image: text().nullable(),
    inventory: z.array(balance).max(1)
  })
  .strict()
const asset = z
  .object({
    id: uuid,
    storageKey: text(500, 1),
    originalName: text(255, 1),
    mimeType: text(120, 3),
    byteSize: positive,
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
    ownerName: text(240, 1),
    sourceUrl: text().nullable(),
    license: text(500, 1),
    authorizedAt: z.string().datetime(),
    rightsStatus: z.enum(['pending', 'approved', 'blocked', 'expired']),
    quarantineStatus: z.enum(['pending', 'clean', 'rejected']),
    altText: text(500, 5),
    metadata: object
  })
  .strict()
const media = z
  .object({
    productId: uuid,
    variantId: uuid.nullable(),
    assetId: uuid,
    role: z.enum(['primary', 'gallery', 'label', 'scale', 'datasheet', 'sds', 'certificate', 'video']),
    version: text(80, 1),
    sortOrder: integer
  })
  .strict()
const context = z.object({ warehouseId: uuid }).strict()
const publication = z.literal('not_granted')
const price = z
  .object({
    grossCents: positive,
    compareAtGrossCents: integer.nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    taxClassId: uuid,
    validFrom: z.null(),
    validFromPolicy: z.literal('server_on_apply'),
    authorization: z.literal('requires_live_apply_authorization')
  })
  .strict()
const inventory = z
  .object({
    warehouseId: uuid,
    onHand: integer,
    blocked: integer,
    safetyStock: integer,
    backorderAllowed: z.boolean(),
    version: z.literal(1),
    authorization: z.literal('requires_live_apply_authorization')
  })
  .strict()
const warningSchema = z.tuple([
  z.literal('new_records_only'),
  z.literal('draft_not_publication'),
  z.literal('claimed_media_not_verified'),
  z.literal('prices_stock_require_live_apply'),
  z.literal('identifier_explanation_not_publication_exception')
])
const common = {
  source: z.literal('cloudflare'),
  outcome: z.literal('review_entry'),
  id: text(20_000, 1),
  before: z.null(),
  context,
  warnings: warningSchema
}
const dto = z.discriminatedUnion('kind', [
  z
    .object({
      ...common,
      kind: z.literal('products'),
      claimed: product,
      after: product
        .extend({ status: z.literal('draft'), publishedAt: z.null(), publicationAuthority: publication })
        .strict()
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('variants'),
      claimed: variant,
      after: variant
        .omit({ inventory: true })
        .extend({ status: z.literal('draft'), price, inventory, publicationAuthority: publication })
        .strict()
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('assets'),
      claimed: asset,
      after: asset
        .extend({
          rightsStatus: z.literal('pending'),
          quarantineStatus: z.literal('pending'),
          uploadId: z.null(),
          storageAuthority: z.literal('unverified_descriptor'),
          publicationAuthority: publication
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('media'),
      claimed: media,
      after: media
        .extend({
          rightsStatus: z.literal('pending'),
          quarantineStatus: z.literal('pending'),
          uploadId: z.null(),
          storageAuthority: z.literal('unverified_descriptor'),
          publicationAuthority: publication
        })
        .strict()
    })
    .strict()
])
type Dto = z.infer<typeof dto>
type Kind = Dto['kind']
function mediaId(value: z.infer<typeof media>) {
  return JSON.stringify([value.productId, value.variantId, value.assetId, value.role, value.version])
}
function derived(kind: Kind, input: unknown, warehouseId: string) {
  if (kind === 'products')
    return { ...product.parse(input), status: 'draft', publishedAt: null, publicationAuthority: 'not_granted' }
  if (kind === 'variants') {
    const value = variant.parse(input),
      { inventory: balances, ...fields } = value,
      initial = balances[0]
    return {
      ...fields,
      status: 'draft',
      publicationAuthority: 'not_granted',
      price: {
        grossCents: value.priceGrossCents,
        compareAtGrossCents: value.compareAtGrossCents,
        currency: value.currency,
        taxClassId: value.taxClassId,
        validFrom: null,
        validFromPolicy: 'server_on_apply',
        authorization: 'requires_live_apply_authorization'
      },
      inventory: {
        warehouseId,
        onHand: initial?.physicalQuantity ?? 0,
        blocked: initial?.blockedQuantity ?? 0,
        safetyStock: value.safetyStock,
        backorderAllowed: value.backorderAllowed,
        version: 1,
        authorization: 'requires_live_apply_authorization'
      }
    }
  }
  return {
    ...(kind === 'assets' ? asset.parse(input) : media.parse(input)),
    rightsStatus: 'pending',
    quarantineStatus: 'pending',
    uploadId: null,
    storageAuthority: 'unverified_descriptor',
    publicationAuthority: 'not_granted'
  }
}
function equivalent(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equivalent(value, right[index]))
    )
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>,
    keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equivalent(a[key], b[key]))
  )
}
function consistent(value: Dto) {
  if (value.kind === 'products' && Boolean(value.claimed.regulatory.requiresSds) !== value.claimed.requiresSds)
    return false
  if (value.kind === 'variants') {
    const source = value.claimed
    if (source.inventory.some((item) => item.locationId !== value.context.warehouseId)) return false
    if (source.compareAtGrossCents !== null && source.compareAtGrossCents <= source.priceGrossCents) return false
    if (source.maximumQuantity !== null && source.maximumQuantity < source.minimumQuantity) return false
  }
  const id = value.kind === 'media' ? mediaId(value.claimed) : value.claimed.id
  return value.id === id && equivalent(value.after, derived(value.kind, value.claimed, value.context.warehouseId))
}
export const catalogImportJobReviewEntrySchema = z.preprocess(
  safeOwn,
  dto.refine(consistent, 'invalid_catalog_import_review')
)
export type CatalogImportJobReviewEntry = z.infer<typeof catalogImportJobReviewEntrySchema>

/** Project normalized immutable job-entry payloads. The envelope is deliberately
 * limited to kind/itemId/payload: actor/session/SQL/audit rows are never DTO data.
 * All source fields are retained in claimed; only the three generated internal
 * variant command IDs are excluded, after validating the complete input shape. */
export function projectCatalogImportJobReviewEntry(raw: unknown, rawContext: unknown): CatalogImportJobReviewEntry {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid')
    const prototype = Object.getPrototypeOf(raw),
      keys = Reflect.ownKeys(raw)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length !== 3 ||
      keys.some((key) => !['kind', 'itemId', 'payload'].includes(String(key)))
    )
      throw new Error('invalid')
    const field = (key: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('invalid')
      return descriptor.value as unknown
    }
    const kind = z.enum(['products', 'variants', 'assets', 'media']).parse(field('kind')),
      itemId = text(20_000, 1).parse(field('itemId'))
    const parameters = context.parse(own(rawContext))
    const value = field('payload')
    if (typeof value === 'string' && new TextEncoder().encode(value).byteLength > CATALOG_NATIVE_IMPORT_MAX_BYTES)
      throw new Error('invalid')
    const payload = own(typeof value === 'string' ? JSON.parse(value) : value)
    let claimed: unknown
    if (kind === 'variants') {
      const staged = variant
        .extend({
          initialPriceId: uuid.optional(),
          initialMovementId: uuid.optional(),
          compensationMovementId: uuid.optional()
        })
        .strict()
        .parse(payload)
      const { initialPriceId, initialMovementId, compensationMovementId, ...fields } = staged
      const generated = [initialPriceId, initialMovementId, compensationMovementId]
      if (generated.some((id) => id !== undefined) && generated.some((id) => id === undefined))
        throw new Error('invalid')
      claimed = fields
    } else claimed = (kind === 'products' ? product : kind === 'assets' ? asset : media).parse(payload)
    return catalogImportJobReviewEntrySchema.parse({
      source: 'cloudflare',
      outcome: 'review_entry',
      kind,
      id: itemId,
      before: null,
      context: parameters,
      claimed,
      after: derived(kind, claimed, parameters.warehouseId),
      warnings: [...CATALOG_IMPORT_JOB_REVIEW_WARNINGS]
    })
  } catch {
    throw new Error('invalid_catalog_import_review')
  }
}
