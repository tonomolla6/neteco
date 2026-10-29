import { z } from 'zod'
import { csvCell } from '../server/utils/csv'
import {
  catalogPolicyInstantSchema,
  catalogPolicyStatusSchema,
  catalogPolicyUuidSchema
} from './catalog-publication-policy'

export const CATALOG_EXPORT_MAX_BYTES = 8_000_000
export const CATALOG_EXPORT_MAX_ROWS = 10_000
export const CATALOG_EXPORT_MAX_PRODUCTS = 1_000
export const CATALOG_EXPORT_MAX_CELL_CHARACTERS = 20_000
export const CATALOG_EXPORT_PROFILE = 'native_catalog_snapshot_v1' as const
export const CATALOG_EXPORT_SHEET_NAMES = [
  'Products',
  'Variants',
  'Inventory',
  'Prices',
  'Media',
  'References'
] as const
export const CATALOG_EXPORT_COLUMNS = {
  Products: [
    'id',
    'legacy_id',
    'category_id',
    'brand_id',
    'source_id',
    'name',
    'slug',
    'short_description',
    'description',
    'usage',
    'series',
    'status',
    'featured',
    'attributes',
    'regulatory',
    'source_version',
    'published_at',
    'created_at',
    'updated_at',
    'catalog_version',
    'record_json'
  ],
  Variants: [
    'id',
    'legacy_id',
    'product_id',
    'tax_class_id',
    'shipping_profile_id',
    'sku',
    'ean',
    'gtin',
    'mpn',
    'identifier_exception_reason',
    'format',
    'status',
    'unit_base',
    'unit_label',
    'content_quantity',
    'units_per_case',
    'cases_per_pallet',
    'minimum_quantity',
    'quantity_increment',
    'maximum_quantity',
    'price_gross_cents',
    'compare_at_gross_cents',
    'cost_net_cents',
    'currency',
    'weight_grams',
    'width_mm',
    'height_mm',
    'depth_mm',
    'safety_stock',
    'backorder_allowed',
    'lead_time_days',
    'color',
    'image',
    'source_version',
    'created_at',
    'updated_at',
    'effective_gross_cents',
    'effective_price_version_id',
    'record_json'
  ],
  Inventory: [
    'variant_id',
    'location_id',
    'physical_quantity',
    'blocked_quantity',
    'version',
    'created_at',
    'updated_at',
    'sellable_quantity',
    'record_json'
  ],
  Prices: [
    'id',
    'variant_id',
    'gross_cents',
    'compare_at_gross_cents',
    'reference_gross_cents_30d',
    'volume_tiers',
    'valid_from',
    'valid_until',
    'status',
    'reason',
    'created_at',
    'cancelled_at',
    'cancellation_reason',
    'record_json'
  ],
  Media: [
    'id',
    'product_id',
    'variant_id',
    'upload_id',
    'role',
    'title',
    'alt',
    'language',
    'version',
    'valid_from',
    'valid_until',
    'created_at',
    'withdrawn_at',
    'record_json'
  ],
  // Pending import descriptors/associations belong here, not in the verified
  // publication Media sheet. imported_media uses its canonical JSON-array
  // composite key [product_id,variant_id,asset_id,role,version], never a UUID.
  References: ['kind', 'id', 'name', 'record_json']
} as const

/** Larger than the policy-command own-JSON boundary, but bounded cumulatively.
 * No getters, symbols, coercions, sparse arrays or prototype hooks are read. */
export function catalogExportOwnJson(input: unknown): unknown {
  let nodes = 0,
    textBytes = 0
  const seen = new Set<object>()
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > 1_000_000 || depth > 10) throw Error('invalid_catalog_export_data')
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      if (value.length > CATALOG_EXPORT_MAX_CELL_CHARACTERS) throw Error('catalog_export_too_large')
      textBytes += new TextEncoder().encode(value).byteLength
      if (textBytes > CATALOG_EXPORT_MAX_BYTES) throw Error('catalog_export_too_large')
      return value
    }
    if (!value || typeof value !== 'object' || seen.has(value)) throw Error('invalid_catalog_export_data')
    const array = Array.isArray(value),
      prototype = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw Error('invalid_catalog_export_data')
    const length: unknown = array ? Object.getOwnPropertyDescriptor(value, 'length')?.value : undefined
    if (array && (typeof length !== 'number' || length > CATALOG_EXPORT_MAX_ROWS))
      throw Error('catalog_export_too_large')
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key !== 'string') || (array ? keys.length !== Number(length) + 1 : keys.length > 96))
      throw Error('invalid_catalog_export_data')
    seen.add(value)
    const output: Record<string, unknown> = Object.create(null),
      items: unknown[] = []
    for (const key of keys) {
      if (typeof key !== 'string' || (array && key === 'length')) continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        ['__proto__', 'constructor', 'prototype'].includes(key) ||
        (array && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= Number(length)))
      )
        throw Error('invalid_catalog_export_data')
      const next = visit(descriptor.value, depth + 1)
      if (array) items[Number(key)] = next
      else output[key] = next
    }
    seen.delete(value)
    return array ? items : output
  }
  return visit(input, 0)
}
function owned(value: unknown) {
  try {
    return catalogExportOwnJson(value)
  } catch {
    return undefined
  }
}
const safeQuery = z
  .string()
  .max(160)
  .refine((value) => ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
  .transform((value) => value.trim())
export const catalogExportFiltersSchema = z.preprocess(
  owned,
  z
    .object({
      q: safeQuery.default(''),
      category: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
      status: catalogPolicyStatusSchema.optional()
    })
    .strict()
)
export type CatalogExportFilters = z.infer<typeof catalogExportFiltersSchema>
const count = z.number().int().min(0).max(CATALOG_EXPORT_MAX_ROWS)
const countsSchema = z
  .object({
    products: count.max(CATALOG_EXPORT_MAX_PRODUCTS),
    variants: count,
    inventory: count,
    prices: count,
    media: count,
    references: count
  })
  .strict()
const sheetSchema = z
  .object({
    name: z.enum(CATALOG_EXPORT_SHEET_NAMES),
    columns: z.array(z.string().min(1).max(80)).min(1).max(64),
    rows: z.array(z.array(z.string().max(CATALOG_EXPORT_MAX_CELL_CHARACTERS)).max(64)).max(CATALOG_EXPORT_MAX_ROWS)
  })
  .strict()
export type CatalogExportSheet = z.infer<typeof sheetSchema>
const rawSchema = z
  .object({
    source: z.literal('cloudflare'),
    profile: z.literal(CATALOG_EXPORT_PROFILE),
    snapshotId: catalogPolicyUuidSchema,
    observedAt: catalogPolicyInstantSchema,
    filters: catalogExportFiltersSchema,
    counts: countsSchema,
    sheets: z.array(sheetSchema).length(6),
    hash: z.string().regex(/^[0-9a-f]{64}$/)
  })
  .strict()
  .superRefine((snapshot, context) => {
    const bad = () => context.addIssue({ code: 'custom', message: 'invalid_catalog_export_snapshot' })
    let total = 0
    for (let index = 0; index < snapshot.sheets.length; index++) {
      const sheet = snapshot.sheets[index]!,
        name = CATALOG_EXPORT_SHEET_NAMES[index]!
      if (sheet.name !== name || JSON.stringify(sheet.columns) !== JSON.stringify(CATALOG_EXPORT_COLUMNS[name])) {
        bad()
        continue
      }
      const expectedCount = snapshot.counts[name.toLowerCase() as keyof typeof snapshot.counts]
      if (sheet.rows.length !== expectedCount) bad()
      total += sheet.rows.length
      for (const row of sheet.rows) {
        if (row.length !== sheet.columns.length) {
          bad()
          continue
        }
        try {
          const record = catalogExportOwnJson(JSON.parse(row[row.length - 1]!))
          if (!record || typeof record !== 'object' || Array.isArray(record)) {
            bad()
            continue
          }
          for (let column = 0; column < sheet.columns.length - 1; column++) {
            const descriptor = Object.getOwnPropertyDescriptor(record, sheet.columns[column]!)
            if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
              bad()
              break
            }
            const value: unknown = descriptor.value
            if (!(
              value === null ||
              typeof value === 'string' ||
              typeof value === 'boolean' ||
              (typeof value === 'number' && Number.isFinite(value))
            )) {
              bad()
              break
            }
            if (row[column] !== (value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value))) {
              bad()
              break
            }
          }
        } catch {
          bad()
        }
      }
    }
    if (
      total > CATALOG_EXPORT_MAX_ROWS ||
      new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > CATALOG_EXPORT_MAX_BYTES
    )
      bad()
  })
export const catalogExportSnapshotSchema = z.preprocess(owned, rawSchema)
export type CatalogExportSnapshot = z.infer<typeof catalogExportSnapshotSchema>
export function catalogExportHashInput(snapshot: Omit<CatalogExportSnapshot, 'hash'>) {
  const { source, profile, snapshotId, observedAt, filters, counts, sheets } = snapshot
  return JSON.stringify({ source, profile, snapshotId, observedAt, filters, counts, sheets })
}
export async function catalogExportHash(snapshot: Omit<CatalogExportSnapshot, 'hash'>) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(catalogExportHashInput(snapshot)))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
export async function verifyCatalogExportSnapshot(input: unknown): Promise<CatalogExportSnapshot> {
  const snapshot = catalogExportSnapshotSchema.parse(input)
  if ((await catalogExportHash(snapshot)) !== snapshot.hash) throw Error('invalid_catalog_export_hash')
  return snapshot
}
/** Complete multi-entity CSV, not a product-only file and NOT importable via
 * editorial-v1 or the unrelated legacy 71-column import format. JSON preserves
 * exact types/nulls; XLSX supplies readable sheets of the same records. */
export async function exportCatalogSnapshotCsv(input: unknown): Promise<Uint8Array> {
  const snapshot = await verifyCatalogExportSnapshot(input)
  const lines = [['sheet', 'row_index', 'record_json'].map(csvCell).join(',')]
  const manifest = {
    source: snapshot.source,
    profile: snapshot.profile,
    snapshotId: snapshot.snapshotId,
    observedAt: snapshot.observedAt,
    filters: snapshot.filters,
    counts: snapshot.counts,
    hash: snapshot.hash,
    nulls: 'Blank display cells may be null or empty; record_json preserves the original value.',
    purpose: 'Read-only catalogue snapshot, not an import or live/publication authority.'
  }
  lines.push(['Manifest', '1', JSON.stringify(manifest)].map(csvCell).join(','))
  for (const sheet of snapshot.sheets)
    for (let index = 0; index < sheet.rows.length; index++)
      lines.push([sheet.name, String(index + 1), sheet.rows[index]![sheet.columns.length - 1]!].map(csvCell).join(','))
  const bytes = new TextEncoder().encode(lines.join('\r\n') + '\r\n')
  if (bytes.byteLength > CATALOG_EXPORT_MAX_BYTES) throw Error('catalog_export_too_large')
  return bytes
}
