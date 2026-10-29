import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from './catalog-publication-policy'
import { parseCatalogCsvCells } from './catalog-tabular-core'
import { csvCell } from '../server/utils/csv'

/** Explicit editorial-only CSV profile v1. This is NOT the complete, unrelated
 * legacy 71-column catalogue format and carries no price, stock, media,
 * category, legal approval or publication authority.
 */
export const EDITORIAL_CSV_COLUMNS = [
  'product_id',
  'product_legacy_id',
  'catalog_version',
  'product_name',
  'short_description',
  'description',
  'product_usage',
  'product_series',
  'product_featured'
] as const
export const MAX_BYTES = 1_000_000
export const MAX_PRODUCTS = 100

type EditorialCsvField = (typeof EDITORIAL_CSV_COLUMNS)[number]
type EditorialCsvErrorCode =
  | 'editorial_csv_own_data_required'
  | 'editorial_csv_duplicate_product'
  | 'editorial_csv_integer_invalid'
  | 'editorial_csv_boolean_invalid'
  | 'editorial_csv_bytes_invalid'
  | 'editorial_csv_encoding_invalid'
  | 'editorial_csv_bom_invalid'
  | 'editorial_csv_header_invalid'
  | 'editorial_csv_products_required'
  | 'editorial_csv_row_width_invalid'
  | 'editorial_csv_product_id_invalid'
  | 'editorial_csv_row_invalid'
  | 'metadata_field_invalid'

/** Safe operator feedback: neither messages nor hints contain cell values. */
export class EditorialCsvError extends Error {
  constructor(
    readonly code: EditorialCsvErrorCode,
    readonly row?: number,
    readonly field?: EditorialCsvField
  ) {
    super(code)
    this.name = 'EditorialCsvError'
  }
}

export interface EditorialCsvRow {
  productId: string
  legacyId: number
  expectedVersion: number
  metadata: {
    name: string
    shortDesc: string
    description: string
    usage: string | null
    series: string | null
    featured: boolean
  }
}

const fail = (code: EditorialCsvErrorCode, row?: number, field?: EditorialCsvField): never => {
  throw new EditorialCsvError(code, row, field)
}
function invalidControl(value: string, multiline: boolean) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code === 127 || code === 0xfeff || (code < 32 && !(multiline && [9, 10, 13].includes(code)))
  })
}
function unsafeFormula(value: string) {
  // Also inspect the normalized prefix: the authority's trim must not turn
  // Unicode-leading whitespace into a spreadsheet formula after validation.
  return /^[=+\-@]/.test(value.trimStart())
}
function text(minimum: number, maximum: number, multiline: boolean, template: boolean) {
  const safe = z.string().refine((value) => !invalidControl(value, multiline) && !unsafeFormula(value))
  // Templates may contain incomplete drafts and must preserve unedited text.
  // Parsing applies the exact existing metadata trim/minimum rules instead.
  return template
    ? safe.pipe(z.string().max(maximum))
    : safe.transform((value) => value.trim()).pipe(z.string().min(minimum).max(maximum))
}
function rowSchema(template: boolean) {
  const nullable = (maximum: number, multiline: boolean) => {
    const field = text(0, maximum, multiline, template).nullable()
    return template ? field : field.transform((value) => value || null)
  }
  return z
    .object({
      productId: catalogPolicyUuidSchema,
      legacyId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      expectedVersion: z
        .number()
        .int()
        .min(1)
        .max(Number.MAX_SAFE_INTEGER - 2),
      metadata: z
        .object({
          name: text(3, 160, false, template),
          shortDesc: text(5, 500, false, template),
          description: text(5, 10_000, true, template),
          usage: nullable(2_000, true),
          series: nullable(160, false),
          featured: z.boolean()
        })
        .strict()
    })
    .strict()
}
const parsedRow = rowSchema(false)
const templateRows = z.array(rowSchema(true)).max(MAX_PRODUCTS)

function ownedRows(value: unknown): EditorialCsvRow[] {
  let owned: unknown
  try {
    owned = catalogPolicyOwnJson(value)
  } catch {
    return fail('editorial_csv_own_data_required')
  }
  return templateRows.parse(owned)
}
function uniqueRows(rows: readonly EditorialCsvRow[]) {
  const uuids = new Set<string>(),
    legacyIds = new Set<number>()
  for (const row of rows) {
    if (uuids.has(row.productId) || legacyIds.has(row.legacyId)) fail('editorial_csv_duplicate_product')
    uuids.add(row.productId)
    legacyIds.add(row.legacyId)
  }
}
function positiveInteger(value: string, maximum: number, field: EditorialCsvField) {
  if (!/^[1-9]\d*$/.test(value)) return fail('editorial_csv_integer_invalid', undefined, field)
  const integer = Number(value)
  if (!Number.isSafeInteger(integer) || integer > maximum)
    return fail('editorial_csv_integer_invalid', undefined, field)
  return integer
}
function boolean(value: string) {
  if (unsafeFormula(value) || invalidControl(value, false))
    return fail('metadata_field_invalid', undefined, 'product_featured')
  if (value === 'true') return true
  if (value === 'false') return false
  return fail('editorial_csv_boolean_invalid', undefined, 'product_featured')
}
function ownedBytes(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array)) return fail('editorial_csv_bytes_invalid')
  // Use the intrinsic brand/length accessor and typed-array copy, not a
  // caller-defined getter, iterator, constructor, coercion or Buffer API.
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')
  if (!descriptor?.get) return fail('editorial_csv_bytes_invalid')
  const length: unknown = Reflect.apply(descriptor.get, bytes, [])
  if (typeof length !== 'number' || length < 1 || length > MAX_BYTES) return fail('editorial_csv_bytes_invalid')
  const owned = new Uint8Array(length)
  owned.set(bytes)
  return owned
}

function validationField(path: readonly PropertyKey[]): EditorialCsvField | undefined {
  if (path.length === 1) {
    switch (path[0]) {
      case 'productId':
        return 'product_id'
      case 'legacyId':
        return 'product_legacy_id'
      case 'expectedVersion':
        return 'catalog_version'
    }
  }
  if (path.length === 2 && path[0] === 'metadata') {
    switch (path[1]) {
      case 'name':
        return 'product_name'
      case 'shortDesc':
        return 'short_description'
      case 'description':
        return 'description'
      case 'usage':
        return 'product_usage'
      case 'series':
        return 'product_series'
      case 'featured':
        return 'product_featured'
    }
  }
  return undefined
}

function rowError(failure: unknown, row: number): never {
  if (failure instanceof EditorialCsvError) return fail(failure.code, row, failure.field)
  if (failure instanceof z.ZodError) {
    const field = validationField(failure.issues[0]?.path ?? [])
    switch (field) {
      case 'product_id':
        return fail('editorial_csv_product_id_invalid', row, field)
      case 'product_legacy_id':
      case 'catalog_version':
        return fail('editorial_csv_integer_invalid', row, field)
      case 'product_name':
      case 'short_description':
      case 'description':
      case 'product_usage':
      case 'product_series':
      case 'product_featured':
        return fail('metadata_field_invalid', row, field)
    }
  }
  return fail('editorial_csv_row_invalid', row)
}

export function parseEditorialCsv(bytes: Uint8Array): EditorialCsvRow[] {
  const owned = ownedBytes(bytes)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(owned)
  } catch {
    return fail('editorial_csv_encoding_invalid')
  }
  if (text.startsWith('\uFEFF')) text = text.slice(1)
  if (text.includes('\uFEFF')) return fail('editorial_csv_bom_invalid')
  const cells = parseCatalogCsvCells(text, {
    maxRows: MAX_PRODUCTS + 1,
    maxColumns: EDITORIAL_CSV_COLUMNS.length,
    maxCellCharacters: 10_000
  })
  const header = cells[0]
  if (
    !header ||
    header.length !== EDITORIAL_CSV_COLUMNS.length ||
    header.some((value, index) => value !== EDITORIAL_CSV_COLUMNS[index])
  )
    return fail('editorial_csv_header_invalid')
  if (cells.length < 2) return fail('editorial_csv_products_required')
  const rows = cells.slice(1).map((values, index) => {
    const row = index + 2
    if (values.length !== EDITORIAL_CSV_COLUMNS.length) return fail('editorial_csv_row_width_invalid', row)
    try {
      return parsedRow.parse({
        productId: values[0],
        legacyId: positiveInteger(values[1]!, Number.MAX_SAFE_INTEGER, 'product_legacy_id'),
        expectedVersion: positiveInteger(values[2]!, Number.MAX_SAFE_INTEGER - 2, 'catalog_version'),
        metadata: {
          name: values[3],
          shortDesc: values[4],
          description: values[5],
          usage: values[6] === '' ? null : values[6],
          series: values[7] === '' ? null : values[7],
          featured: boolean(values[8]!)
        }
      })
    } catch (failure) {
      return rowError(failure, row)
    }
  })
  uniqueRows(rows)
  return rows
}

export function exportEditorialCsv(input: EditorialCsvRow[]): Uint8Array {
  const rows = ownedRows(input)
  uniqueRows(rows)
  const lines = [EDITORIAL_CSV_COLUMNS.map((column) => csvCell(column)).join(',')]
  for (const row of rows) {
    const values = [
      row.productId,
      row.legacyId,
      row.expectedVersion,
      row.metadata.name,
      row.metadata.shortDesc,
      row.metadata.description,
      row.metadata.usage ?? '',
      row.metadata.series ?? '',
      row.metadata.featured ? 'true' : 'false'
    ]
    // All cells are owned primitives already checked for formula prefixes.
    // csvCell escaping therefore cannot silently rewrite any editorial text.
    lines.push(values.map((value) => csvCell(value)).join(','))
  }
  const bytes = new TextEncoder().encode(lines.join('\r\n') + '\r\n')
  if (bytes.byteLength > MAX_BYTES) return fail('editorial_csv_bytes_invalid')
  return bytes
}
