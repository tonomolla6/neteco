import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from './catalog-publication-policy'
import { CATALOG_TYPED_ATTRIBUTE_UNITS, type CatalogTypedAttributeUnit } from './catalog-typed-attributes'
import type { TypedAttributeFilter } from './types/catalog'

export type CatalogTypedFilterParseResult =
  { success: true; data: TypedAttributeFilter[] } | { success: false; code: 'invalid_typed_filters' }

export const CATALOG_TYPED_FILTER_MAX_BYTES = 4096
const numeric = z.number().finite().min(-1e9).max(1e9)
const unit = z.enum(
  Object.keys(CATALOG_TYPED_ATTRIBUTE_UNITS) as [CatalogTypedAttributeUnit, ...CatalogTypedAttributeUnit[]]
)
const selection = z.union([
  numeric,
  z.boolean(),
  z
    .string()
    .min(1)
    .max(100)
    .refine((value) =>
      [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    ),
  z.object({ quantity: numeric, unit }).strict()
])
const filtersSchema = z
  .array(
    z
      .object({
        definitionId: catalogPolicyUuidSchema,
        values: z
          .array(selection)
          .min(1)
          .max(16)
          .refine((items) => new Set(items.map((value) => JSON.stringify(value))).size === items.length)
      })
      .strict()
  )
  .max(12)
  .refine((items) => new Set(items.map((item) => item.definitionId)).size === items.length)
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)
function normalized(raw: unknown): TypedAttributeFilter[] {
  const own = catalogPolicyOwnJson(raw)
  const result = filtersSchema.safeParse(own)
  if (!result.success) throw new Error('invalid_typed_filters')
  return result.data
    .map((filter) => ({
      definitionId: filter.definitionId,
      values: filter.values.sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right)))
    }))
    .sort((left, right) => compare(left.definitionId, right.definitionId))
}
export function parseCatalogTypedFilters(raw: string | undefined): CatalogTypedFilterParseResult {
  if (raw === undefined) return { success: true, data: [] }
  try {
    if (typeof raw !== 'string' || !raw || new TextEncoder().encode(raw).byteLength > CATALOG_TYPED_FILTER_MAX_BYTES)
      throw new Error('invalid_typed_filters')
    return { success: true, data: normalized(JSON.parse(raw) as unknown) }
  } catch {
    return { success: false, code: 'invalid_typed_filters' }
  }
}
export function serializeCatalogTypedFilters(filters: unknown): string | undefined {
  try {
    const data = normalized(filters)
    if (!data.length) return undefined
    const serialized = JSON.stringify(data)
    if (new TextEncoder().encode(serialized).byteLength > CATALOG_TYPED_FILTER_MAX_BYTES)
      throw new Error('invalid_typed_filters')
    return serialized
  } catch {
    throw new Error('invalid_typed_filters')
  }
}
