import { z } from 'zod'

/** PDP-014/015/020: alternatives, complements and single-warehouse availability on the product page. */
export const COPURCHASE_MIN_SUPPORT = 3
export const COPURCHASE_MIN_CONFIDENCE_PERMILLE = 200
export const LOW_STOCK_THRESHOLD = 5
export const PUBLIC_SELLABLE_CAP = 999
export const DETAIL_EXTRAS_NOTICE =
  'Las relaciones son dirigidas y revisadas manualmente; no garantizan compatibilidad química. Compruebe etiqueta, ficha de datos de seguridad y peligros antes de sustituir o mezclar productos.'

const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const slug = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
export const availabilityStatusSchema = z.enum(['in_stock', 'low_stock', 'backorder', 'out_of_stock', 'unavailable'])
export type AvailabilityStatus = z.infer<typeof availabilityStatusSchema>
export const detailExtrasSortSchema = z.enum(['relevance', 'price', 'availability'])
export type DetailExtrasSort = z.infer<typeof detailExtrasSortSchema>

export const hazardSummarySchema = z
  .object({
    signalWord: z.string().min(1).max(40).nullable(),
    hazardStatements: z.array(z.string().min(1).max(400)).max(30),
    hasHazardData: z.boolean()
  })
  .strict()
const itemBase = {
  productId: id,
  slug,
  name: z.string().min(1).max(500),
  brand: z.string().min(1).max(200),
  minPrice: money,
  minNetPrice: money,
  formats: z.number().int().min(1).max(10000),
  availability: availabilityStatusSchema,
  pickupAvailable: z.boolean(),
  hazard: hazardSummarySchema
}
export const alternativeSchema = z
  .object({ ...itemBase, kind: z.enum(['substitute', 'equivalent']), reviewed: z.literal(true) })
  .strict()
export const complementSchema = z.discriminatedUnion('basis', [
  z.object({ ...itemBase, kind: z.enum(['accessory', 'compatible']), basis: z.literal('curated') }).strict(),
  z
    .object({
      ...itemBase,
      kind: z.literal('co_purchase'),
      basis: z.literal('co_purchase'),
      support: z.number().int().min(COPURCHASE_MIN_SUPPORT).max(Number.MAX_SAFE_INTEGER),
      confidencePermille: z.number().int().min(COPURCHASE_MIN_CONFIDENCE_PERMILLE).max(1000)
    })
    .strict()
])
export const variantAvailabilitySchema = z
  .object({
    variantId: id,
    sku: z.string().min(1).max(200),
    status: availabilityStatusSchema,
    sellable: z.number().int().min(0).max(PUBLIC_SELLABLE_CAP),
    pickupAvailable: z.boolean()
  })
  .strict()
export const productDetailExtrasSchema = z
  .object({
    source: z.literal('cloudflare'),
    productSlug: slug,
    warehouse: z.object({ single: z.boolean(), pickupEnabled: z.boolean() }).strict(),
    availability: z.array(variantAvailabilitySchema).max(200),
    hazard: hazardSummarySchema,
    alternatives: z.array(alternativeSchema).max(20),
    complements: z.array(complementSchema).max(20),
    notice: z.string().min(1).max(600)
  })
  .strict()
export type ProductDetailExtras = z.infer<typeof productDetailExtrasSchema>
export type DetailAlternative = z.infer<typeof alternativeSchema>
export type DetailComplement = z.infer<typeof complementSchema>

export interface DetailExtrasQuery {
  slug: string
  sort: DetailExtrasSort
  availableOnly: boolean
}
/** Strict: exactly one slug, known keys only. Null means invalid_input. */
export function parseDetailExtrasQuery(params: URLSearchParams): DetailExtrasQuery | null {
  const allowed = new Set(['slug', 'sort', 'availableOnly'])
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) return null
  const parsedSlug = slug.safeParse(params.get('slug') ?? '')
  if (!parsedSlug.success) return null
  const sort = detailExtrasSortSchema.safeParse(params.get('sort') ?? 'relevance')
  const only = params.get('availableOnly')
  if (!sort.success || (only !== null && only !== '0' && only !== '1')) return null
  return { slug: parsedSlug.data, sort: sort.data, availableOnly: only === '1' }
}

export function classifyAvailability(input: {
  sellable: number
  minimumQuantity: number
  backorderAllowed: boolean
}): AvailabilityStatus {
  const { sellable, minimumQuantity, backorderAllowed } = input
  if (!Number.isSafeInteger(sellable) || sellable < 0 || !Number.isSafeInteger(minimumQuantity) || minimumQuantity < 1)
    return 'unavailable'
  if (sellable >= minimumQuantity) return sellable <= LOW_STOCK_THRESHOLD ? 'low_stock' : 'in_stock'
  return backorderAllowed ? 'backorder' : 'out_of_stock'
}

const rank: Record<AvailabilityStatus, number> = {
  in_stock: 0,
  low_stock: 1,
  backorder: 2,
  out_of_stock: 3,
  unavailable: 4
}
/** Filtering only ever concerns availability: hazard and compatibility data are never a filter criterion. */
export function arrangeAlternatives<T extends { minPrice: number; availability: AvailabilityStatus }>(
  items: readonly T[],
  sort: DetailExtrasSort,
  availableOnly: boolean
): T[] {
  const kept = items
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item }) => !availableOnly || (item.availability !== 'out_of_stock' && item.availability !== 'unavailable')
    )
  if (sort === 'price') kept.sort((a, b) => a.item.minPrice - b.item.minPrice || a.index - b.index)
  else if (sort === 'availability')
    kept.sort((a, b) => rank[a.item.availability] - rank[b.item.availability] || a.index - b.index)
  return kept.map(({ item }) => item)
}

export function selectCoPurchases(
  rows: readonly { productId: number; support: number }[],
  options: { sourceOrders: number; excludeProductIds: ReadonlySet<number>; limit: number }
): Array<{ productId: number; support: number; confidencePermille: number }> {
  if (!Number.isSafeInteger(options.sourceOrders) || options.sourceOrders < 1) return []
  return rows
    .filter((row) => !options.excludeProductIds.has(row.productId) && row.support >= COPURCHASE_MIN_SUPPORT)
    .map((row) => ({
      productId: row.productId,
      support: row.support,
      confidencePermille: Math.min(1000, Math.floor((row.support * 1000) / options.sourceOrders))
    }))
    .filter((row) => row.confidencePermille >= COPURCHASE_MIN_CONFIDENCE_PERMILLE)
    .sort((a, b) => b.support - a.support || a.productId - b.productId)
    .slice(0, options.limit)
}
