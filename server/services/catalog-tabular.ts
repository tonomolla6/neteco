import ExcelJS from 'exceljs'
import { z } from 'zod'
import { catalogPublicationIssues, type PublicationCandidate } from '../domain/catalog-publication'
import { csvCell } from '../utils/csv'

export const CATALOG_TABULAR_MAX_BYTES = 20_000_000
export const CATALOG_TABULAR_MAX_ROWS = 25_000
export const CATALOG_TABULAR_MAX_CELL_CHARACTERS = 20_000
const CATALOG_XLSX_MAX_EXPANDED_BYTES = 100_000_000
const CATALOG_XLSX_MAX_ENTRIES = 1_000

export const catalogTabularColumns = [
  'product_id',
  'product_legacy_id',
  'product_name',
  'product_slug',
  'product_status',
  'short_description',
  'description',
  'category_id',
  'category_status',
  'brand_id',
  'brand_status',
  'source_id',
  'source_version',
  'product_usage',
  'product_series',
  'product_featured',
  'product_attributes_json',
  'product_regulatory_json',
  'variant_id',
  'variant_legacy_id',
  'sku',
  'ean',
  'gtin',
  'mpn',
  'identifier_exception_reason',
  'format',
  'variant_status',
  'variant_source_version',
  'tax_class_id',
  'shipping_profile_id',
  'price_gross_cents',
  'compare_at_gross_cents',
  'cost_net_cents',
  'currency',
  'unit_base',
  'unit_label',
  'content_quantity',
  'units_per_case',
  'cases_per_pallet',
  'minimum_quantity',
  'quantity_increment',
  'maximum_quantity',
  'weight_grams',
  'width_mm',
  'height_mm',
  'depth_mm',
  'safety_stock',
  'backorder_allowed',
  'lead_time_days',
  'variant_color',
  'variant_image',
  'inventory_json',
  'requires_sds',
  'asset_id',
  'asset_storage_key',
  'asset_original_name',
  'asset_mime_type',
  'asset_byte_size',
  'asset_checksum_sha256',
  'asset_owner_name',
  'asset_source_url',
  'asset_license',
  'asset_authorized_at',
  'asset_rights_status',
  'asset_quarantine_status',
  'asset_alt_text',
  'asset_metadata_json',
  'media_role',
  'media_variant_id',
  'media_version',
  'media_sort_order'
] as const

export type CatalogTabularColumn = (typeof catalogTabularColumns)[number]
export type CatalogTabularRecord = Record<CatalogTabularColumn, string>

export interface CatalogTabularIssue {
  code: string
  row?: number
  field?: CatalogTabularColumn
  message: string
}

export interface CatalogImportProduct {
  id: string
  legacyId: number
  name: string
  slug: string
  status: 'draft' | 'review' | 'published' | 'hidden' | 'discontinued'
  shortDescription: string
  description: string
  categoryId: string
  categoryStatus: string
  brandId: string
  brandStatus: string
  sourceId: string
  sourceVersion: string
  usage: string | null
  series: string | null
  featured: boolean
  attributes: Record<string, unknown>
  regulatory: Record<string, unknown>
  requiresSds: boolean
}

export interface CatalogImportVariant {
  id: string
  legacyId: number
  productId: string
  sku: string
  ean: string | null
  gtin: string | null
  mpn: string | null
  identifierExceptionReason: string | null
  format: string
  status: 'draft' | 'review' | 'published' | 'hidden' | 'discontinued'
  sourceVersion: string
  taxClassId: string
  shippingProfileId: string
  priceGrossCents: number
  compareAtGrossCents: number | null
  costNetCents: number | null
  currency: string
  unitBase: string
  unitLabel: string
  contentQuantity: number
  unitsPerCase: number
  casesPerPallet: number | null
  minimumQuantity: number
  quantityIncrement: number
  maximumQuantity: number | null
  weightGrams: number
  widthMm: number
  heightMm: number
  depthMm: number
  safetyStock: number
  backorderAllowed: boolean
  leadTimeDays: number | null
  color: string | null
  image: string | null
  inventory: Array<{ locationId: string; physicalQuantity: number; blockedQuantity: number; version: number }>
}

export interface CatalogImportAsset {
  id: string
  storageKey: string
  originalName: string
  mimeType: string
  byteSize: number
  checksumSha256: string
  ownerName: string
  sourceUrl: string | null
  license: string
  authorizedAt: string
  rightsStatus: 'pending' | 'approved' | 'blocked' | 'expired'
  quarantineStatus: 'pending' | 'clean' | 'rejected'
  altText: string
  metadata: Record<string, unknown>
}

export interface CatalogImportMedia {
  productId: string
  variantId: string | null
  assetId: string
  role: 'primary' | 'gallery' | 'label' | 'scale' | 'datasheet' | 'sds' | 'certificate' | 'video'
  version: string
  sortOrder: number
}

export interface CatalogImportDataset {
  products: CatalogImportProduct[]
  variants: CatalogImportVariant[]
  assets: CatalogImportAsset[]
  media: CatalogImportMedia[]
}

export interface CatalogTabularValidation {
  valid: boolean
  issues: CatalogTabularIssue[]
  dataset: CatalogImportDataset
  summary: { rows: number; products: number; variants: number; assets: number; documents: number }
}

const uuid = z.string().uuid()
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const editorialStatus = z.enum(['draft', 'review', 'published', 'hidden', 'discontinued'])
const rightsStatus = z.enum(['pending', 'approved', 'blocked', 'expired'])
const quarantineStatus = z.enum(['pending', 'clean', 'rejected'])
const mediaRole = z.enum(['primary', 'gallery', 'label', 'scale', 'datasheet', 'sds', 'certificate', 'video'])
const FORMULA_PREFIX = /^[\t\r\n ]*[=+\-@]/

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let quoteClosed = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
        quoteClosed = true
      } else cell += character
      continue
    }
    if (quoteClosed && ![',', '\n', '\r'].includes(character)) {
      throw new Error('CSV contains characters after a closing quote')
    }
    if (character === '"') {
      if (cell) throw new Error('CSV quote must start at the beginning of a cell')
      quoted = true
      quoteClosed = false
    } else if (character === ',') {
      row.push(cell)
      cell = ''
      quoteClosed = false
    } else if (character === '\n') {
      row.push(cell.replace(/\r$/, ''))
      rows.push(row)
      row = []
      cell = ''
      quoteClosed = false
    } else if (character !== '\r' || !quoteClosed) cell += character
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted cell')
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ''))
    rows.push(row)
  }
  return rows
}

function assertFileSize(bytes: Uint8Array) {
  if (bytes.byteLength > CATALOG_TABULAR_MAX_BYTES) throw new Error('Catalog file exceeds the 20 MB limit')
  if (!bytes.byteLength) throw new Error('Catalog file is empty')
}

function recordsFromRows(rows: string[][]): CatalogTabularRecord[] {
  if (rows.length < 2) throw new Error('Catalog file requires a header and at least one data row')
  if (rows.length - 1 > CATALOG_TABULAR_MAX_ROWS) throw new Error('Catalog file exceeds the 25000 row limit')
  const headers = rows[0]!.map((header, index) => (index === 0 ? header.replace(/^\uFEFF/, '') : header))
  if (
    headers.length !== catalogTabularColumns.length ||
    headers.some((header, index) => header !== catalogTabularColumns[index])
  ) {
    throw new Error('Catalog headers do not match the versioned tabular contract')
  }
  return rows.slice(1).map((values, index) => {
    if (values.length !== catalogTabularColumns.length) throw new Error(`Catalog row ${index + 2} has the wrong width`)
    const record = {} as CatalogTabularRecord
    catalogTabularColumns.forEach((column, columnIndex) => {
      const value = values[columnIndex] ?? ''
      if (value.length > CATALOG_TABULAR_MAX_CELL_CHARACTERS) {
        throw new Error(`Catalog row ${index + 2} field ${column} exceeds the cell limit`)
      }
      record[column] = value
    })
    return record
  })
}

export function parseCatalogCsv(bytes: Uint8Array): CatalogTabularRecord[] {
  assertFileSize(bytes)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return recordsFromRows(parseCsv(text))
}

function excelCell(value: ExcelJS.CellValue): string {
  if (value == null) return ''
  if (typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) throw new Error('Catalog XLSX formulas are not allowed')
    if ('text' in value && typeof value.text === 'string') return value.text
    if (value instanceof Date) return value.toISOString()
    throw new Error('Catalog XLSX contains an unsupported rich cell value')
  }
  return String(value)
}

function assertSafeXlsxArchive(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let index = Math.max(0, bytes.byteLength - 65_557); index <= bytes.byteLength - 22; index += 1) {
    if (view.getUint32(index, true) === 0x06054b50) end = index
  }
  if (end < 0) throw new Error('Catalog XLSX ZIP directory is missing')
  const entries = view.getUint16(end + 10, true)
  const directorySize = view.getUint32(end + 12, true)
  let offset = view.getUint32(end + 16, true)
  if (entries === 0xffff || directorySize === 0xffffffff || offset === 0xffffffff) {
    throw new Error('Catalog XLSX ZIP64 archives are not allowed')
  }
  if (entries > CATALOG_XLSX_MAX_ENTRIES || offset + directorySize > end) {
    throw new Error('Catalog XLSX archive exceeds its structural limits')
  }
  let expandedBytes = 0
  for (let entry = 0; entry < entries; entry += 1) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('Catalog XLSX ZIP directory is malformed')
    }
    if ((view.getUint16(offset + 8, true) & 1) !== 0) throw new Error('Encrypted catalog XLSX archives are not allowed')
    expandedBytes += view.getUint32(offset + 24, true)
    if (expandedBytes > CATALOG_XLSX_MAX_EXPANDED_BYTES) throw new Error('Catalog XLSX expands beyond the 100 MB limit')
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
      throw new Error('Catalog XLSX contains an unsafe archive path')
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
}

export async function parseCatalogXlsx(bytes: Uint8Array): Promise<CatalogTabularRecord[]> {
  assertFileSize(bytes)
  assertSafeXlsxArchive(bytes)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(bytes))
  if (workbook.worksheets.length !== 1) throw new Error('Catalog XLSX must contain exactly one worksheet')
  const worksheet = workbook.worksheets[0]!
  if (worksheet.actualColumnCount > catalogTabularColumns.length) {
    throw new Error('Catalog XLSX contains columns outside the versioned contract')
  }
  const rows: string[][] = []
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    rows.push(catalogTabularColumns.map((_, index) => excelCell(row.getCell(index + 1).value)))
  })
  return recordsFromRows(rows)
}

function integer(value: string, nullable = false) {
  if (nullable && value === '') return null
  if (!/^-?\d+$/.test(value)) throw new Error('must be an integer')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error('must be a safe integer')
  return parsed
}

function nonNegativeInteger(value: string, nullable = false) {
  const result = integer(value, nullable)
  if (result !== null && result < 0) throw new Error('must be a non-negative integer')
  return result
}

function positiveInteger(value: string, nullable = false) {
  const result = integer(value, nullable)
  if (result !== null && result <= 0) throw new Error('must be a positive integer')
  return result
}

function decimal(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value)) throw new Error('must be a positive decimal')
  const result = Number(value)
  if (result <= 0) throw new Error('must be a positive decimal')
  return result
}

function boolean(value: string) {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('must be true or false')
}

function nullable(value: string) {
  return value.trim() || null
}

function jsonObject(value: string) {
  const result = JSON.parse(value) as unknown
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('must be a JSON object')
  return result as Record<string, unknown>
}

function inventory(value: string) {
  const result = JSON.parse(value) as unknown
  return z
    .array(
      z
        .object({
          locationId: uuid,
          physicalQuantity: z.number().int().nonnegative(),
          blockedQuantity: z.number().int().nonnegative(),
          version: z.number().int().positive()
        })
        .refine((item) => item.blockedQuantity <= item.physicalQuantity, 'blocked quantity exceeds physical quantity')
    )
    .min(1)
    .parse(result)
}

function parsed<T>(issues: CatalogTabularIssue[], row: number, field: CatalogTabularColumn, read: () => T): T | null {
  try {
    return read()
  } catch (error) {
    issues.push({
      code: 'field.invalid',
      row,
      field,
      message: error instanceof Error ? error.message : 'Invalid field'
    })
    return null
  }
}

function sameRecord(left: object, right: object) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function validateCatalogRecords(records: CatalogTabularRecord[]): CatalogTabularValidation {
  const issues: CatalogTabularIssue[] = []
  const products = new Map<string, CatalogImportProduct>()
  const variants = new Map<string, CatalogImportVariant>()
  const assets = new Map<string, CatalogImportAsset>()
  const media = new Map<string, CatalogImportMedia>()
  const uniqueValues = new Map<string, string>()
  const recordValues = new Set<string>()

  records.forEach((record, index) => {
    const row = index + 2
    const recordValue = JSON.stringify(record)
    if (recordValues.has(recordValue)) {
      issues.push({ code: 'row.duplicate', row, message: 'Duplicate catalog row' })
    } else recordValues.add(recordValue)
    for (const field of catalogTabularColumns) {
      if (FORMULA_PREFIX.test(record[field])) {
        issues.push({ code: 'field.formula', row, field, message: 'Spreadsheet formulas are not allowed' })
      }
    }
    const productId = parsed(issues, row, 'product_id', () => uuid.parse(record.product_id))
    const variantId = parsed(issues, row, 'variant_id', () => uuid.parse(record.variant_id))
    const assetId = parsed(issues, row, 'asset_id', () => uuid.parse(record.asset_id))
    const productSlug = parsed(issues, row, 'product_slug', () => slug.parse(record.product_slug))
    if (!productId || !variantId || !assetId || !productSlug) return

    const product = parsed(issues, row, 'product_status', () => {
      const regulatory = jsonObject(record.product_regulatory_json)
      const requiresSds = boolean(record.requires_sds)
      if (Boolean(regulatory.requiresSds) !== requiresSds) {
        throw new Error('requires_sds must match product_regulatory_json.requiresSds')
      }
      return {
        id: productId,
        legacyId: positiveInteger(record.product_legacy_id)!,
        name: z.string().trim().min(3).max(240).parse(record.product_name),
        slug: productSlug,
        status: editorialStatus.parse(record.product_status),
        shortDescription: record.short_description,
        description: record.description,
        categoryId: uuid.parse(record.category_id),
        categoryStatus: record.category_status,
        brandId: uuid.parse(record.brand_id),
        brandStatus: record.brand_status,
        sourceId: uuid.parse(record.source_id),
        sourceVersion: z.string().trim().min(1).max(80).parse(record.source_version),
        usage: nullable(record.product_usage),
        series: nullable(record.product_series),
        featured: boolean(record.product_featured),
        attributes: jsonObject(record.product_attributes_json),
        regulatory,
        requiresSds
      }
    })
    const variant = parsed(issues, row, 'sku', () => ({
      id: variantId,
      legacyId: positiveInteger(record.variant_legacy_id)!,
      productId,
      sku: z.string().trim().min(1).max(64).parse(record.sku).toUpperCase(),
      ean: nullable(record.ean),
      gtin: nullable(record.gtin),
      mpn: nullable(record.mpn),
      identifierExceptionReason: nullable(record.identifier_exception_reason),
      format: z.string().trim().min(1).max(160).parse(record.format),
      status: editorialStatus.parse(record.variant_status),
      sourceVersion: z.string().trim().min(1).max(80).parse(record.variant_source_version),
      taxClassId: uuid.parse(record.tax_class_id),
      shippingProfileId: uuid.parse(record.shipping_profile_id),
      priceGrossCents: nonNegativeInteger(record.price_gross_cents)!,
      compareAtGrossCents: nonNegativeInteger(record.compare_at_gross_cents, true),
      costNetCents: nonNegativeInteger(record.cost_net_cents, true),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .parse(record.currency),
      unitBase: record.unit_base,
      unitLabel: record.unit_label,
      contentQuantity: decimal(record.content_quantity),
      unitsPerCase: positiveInteger(record.units_per_case)!,
      casesPerPallet: positiveInteger(record.cases_per_pallet, true),
      minimumQuantity: positiveInteger(record.minimum_quantity)!,
      quantityIncrement: positiveInteger(record.quantity_increment)!,
      maximumQuantity: positiveInteger(record.maximum_quantity, true),
      weightGrams: nonNegativeInteger(record.weight_grams)!,
      widthMm: nonNegativeInteger(record.width_mm)!,
      heightMm: nonNegativeInteger(record.height_mm)!,
      depthMm: nonNegativeInteger(record.depth_mm)!,
      safetyStock: nonNegativeInteger(record.safety_stock)!,
      backorderAllowed: boolean(record.backorder_allowed),
      leadTimeDays: nonNegativeInteger(record.lead_time_days, true),
      color:
        record.variant_color === ''
          ? null
          : z
              .string()
              .regex(/^#[0-9A-Fa-f]{6}$/)
              .parse(record.variant_color),
      image: nullable(record.variant_image),
      inventory: inventory(record.inventory_json)
    }))
    const asset = parsed(issues, row, 'asset_storage_key', () => ({
      id: assetId,
      storageKey: z.string().trim().min(1).max(500).parse(record.asset_storage_key),
      originalName: z.string().trim().min(1).max(255).parse(record.asset_original_name),
      mimeType: z.string().trim().min(3).max(120).parse(record.asset_mime_type),
      byteSize: nonNegativeInteger(record.asset_byte_size)!,
      checksumSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(record.asset_checksum_sha256),
      ownerName: z.string().trim().min(1).max(240).parse(record.asset_owner_name),
      sourceUrl: nullable(record.asset_source_url),
      license: z.string().trim().min(1).max(500).parse(record.asset_license),
      authorizedAt: z.string().datetime().parse(record.asset_authorized_at),
      rightsStatus: rightsStatus.parse(record.asset_rights_status),
      quarantineStatus: quarantineStatus.parse(record.asset_quarantine_status),
      altText: z.string().trim().min(5).max(500).parse(record.asset_alt_text),
      metadata: jsonObject(record.asset_metadata_json)
    }))
    const mapping = parsed(issues, row, 'media_role', () => ({
      productId,
      variantId: record.media_variant_id === '' ? null : uuid.parse(record.media_variant_id),
      assetId,
      role: mediaRole.parse(record.media_role),
      version: z.string().trim().min(1).max(80).parse(record.media_version),
      sortOrder: nonNegativeInteger(record.media_sort_order)!
    }))

    for (const [kind, key, value, target] of [
      ['product', productId, product, products],
      ['variant', variantId, variant, variants],
      ['asset', assetId, asset, assets]
    ] as const) {
      if (!value) continue
      const previous = target.get(key as never) as object | undefined
      if (previous && !sameRecord(previous, value)) {
        issues.push({ code: `${kind}.inconsistent`, row, message: `${kind} data differs between repeated rows` })
      } else (target as Map<string, typeof value>).set(key, value)
    }
    if (mapping) {
      const mappingKey = `${mapping.productId}:${mapping.variantId ?? ''}:${mapping.assetId}:${mapping.role}:${mapping.version}`
      const previousMapping = media.get(mappingKey)
      if (previousMapping && !sameRecord(previousMapping, mapping)) {
        issues.push({ code: 'media.inconsistent', row, message: 'Media mapping differs between repeated rows' })
      } else if (!previousMapping) media.set(mappingKey, mapping)
      if (
        asset &&
        ['datasheet', 'sds', 'certificate', 'label'].includes(mapping.role) &&
        asset.mimeType !== 'application/pdf'
      ) {
        issues.push({ code: 'media.document_mime', row, field: 'asset_mime_type', message: 'Documents must be PDF' })
      }
      if (asset && ['primary', 'gallery', 'scale'].includes(mapping.role) && !asset.mimeType.startsWith('image/')) {
        issues.push({
          code: 'media.image_mime',
          row,
          field: 'asset_mime_type',
          message: 'Image roles require image MIME'
        })
      }
    }
  })

  for (const variant of variants.values()) {
    for (const [field, value] of [
      ['legacy_id', String(variant.legacyId)],
      ['sku', variant.sku],
      ['ean', variant.ean],
      ['gtin', variant.gtin]
    ] as const) {
      if (!value) continue
      const key = `${field}:${value}`
      const previous = uniqueValues.get(key)
      if (previous && previous !== variant.id) {
        issues.push({ code: `variant.${field}_duplicate`, message: `Duplicate ${field.toUpperCase()} ${value}` })
      } else uniqueValues.set(key, variant.id)
    }
  }

  for (const product of products.values()) {
    for (const [field, value] of [
      ['legacy_id', String(product.legacyId)],
      ['slug', product.slug]
    ] as const) {
      const key = `product_${field}:${value}`
      const previous = uniqueValues.get(key)
      if (previous && previous !== product.id) {
        issues.push({ code: `product.${field}_duplicate`, message: `Duplicate product ${field} ${value}` })
      } else uniqueValues.set(key, product.id)
    }
  }

  for (const asset of assets.values()) {
    for (const [field, value] of [
      ['storage_key', asset.storageKey],
      ['checksum', asset.checksumSha256]
    ] as const) {
      const key = `asset_${field}:${value}`
      const previous = uniqueValues.get(key)
      if (previous && previous !== asset.id) {
        issues.push({ code: `asset.${field}_duplicate`, message: `Duplicate asset ${field} ${value}` })
      } else uniqueValues.set(key, asset.id)
    }
    if (!/^clean\/[^/\\]+$/.test(asset.storageKey)) {
      issues.push({ code: 'asset.storage_key', message: `${asset.id}: storage key must be a clean basename` })
    }
    if (!['image/jpeg', 'image/png', 'application/pdf'].includes(asset.mimeType)) {
      issues.push({ code: 'asset.mime_type', message: `${asset.id}: unsupported catalog asset MIME` })
    }
    if (asset.sourceUrl !== `/media/${asset.id}`) {
      issues.push({ code: 'asset.source_url', message: `${asset.id}: source URL must be /media/${asset.id}` })
    }
  }

  for (const product of products.values()) {
    const productVariants = [...variants.values()].filter((variant) => variant.productId === product.id)
    const productMedia = [...media.values()].filter((mapping) => mapping.productId === product.id)
    const primary = productMedia.find((mapping) => mapping.role === 'primary')
    const primaryAsset = primary ? assets.get(primary.assetId) : undefined
    const candidate: PublicationCandidate = {
      name: product.name,
      shortDescription: product.shortDescription,
      description: product.description,
      categoryStatus: product.categoryStatus,
      brandStatus: product.brandStatus,
      image: primaryAsset?.storageKey,
      imageAlt: primaryAsset?.altText,
      imageRightsOwner: primaryAsset?.ownerName,
      imageRightsLicense: primaryAsset?.license,
      imageAuthorizedAt: primaryAsset?.authorizedAt,
      variants: productVariants.map((variant) => ({
        sku: variant.sku,
        ean: variant.ean,
        gtin: variant.gtin,
        mpn: variant.mpn,
        identifierExceptionReason: variant.identifierExceptionReason,
        priceCents: variant.priceGrossCents,
        unitBase: variant.unitBase,
        unitLabel: variant.unitLabel,
        contentQuantity: variant.contentQuantity,
        minimumQuantity: variant.minimumQuantity,
        quantityIncrement: variant.quantityIncrement,
        maximumQuantity: variant.maximumQuantity,
        weightGrams: variant.weightGrams,
        widthMm: variant.widthMm,
        heightMm: variant.heightMm,
        depthMm: variant.depthMm,
        backorderAllowed: variant.backorderAllowed,
        leadTimeDays: variant.leadTimeDays
      }))
    }
    if (product.status === 'published') {
      if (!productVariants.some((variant) => variant.status === 'published')) {
        issues.push({ code: 'completeness.variant_published', message: `${product.slug}: no published variant` })
      }
      for (const issue of catalogPublicationIssues(candidate)) {
        issues.push({ code: `completeness.${issue.code}`, message: `${product.slug}: ${issue.message}` })
      }
      if (product.requiresSds && !productMedia.some((mapping) => mapping.role === 'sds')) {
        issues.push({ code: 'completeness.sds', message: `${product.slug}: hazardous product requires an SDS` })
      }
      for (const mapping of productMedia) {
        const asset = assets.get(mapping.assetId)
        if (asset && (asset.rightsStatus !== 'approved' || asset.quarantineStatus !== 'clean')) {
          issues.push({
            code: 'completeness.asset_governance',
            message: `${product.slug}: mapped assets must be approved and clean`
          })
        }
      }
      const productPrimary = productMedia.filter((mapping) => mapping.role === 'primary' && mapping.variantId === null)
      if (productPrimary.length !== 1) {
        issues.push({ code: 'completeness.primary_mapping', message: `${product.slug}: requires one product primary` })
      } else {
        const asset = assets.get(productPrimary[0]!.assetId)
        const rights = product.attributes.imageRights
        if (
          asset &&
          (product.attributes.image !== asset.sourceUrl ||
            product.attributes.imageAlt !== asset.altText ||
            !rights ||
            typeof rights !== 'object' ||
            Array.isArray(rights) ||
            !sameRecord(rights, {
              owner: asset.ownerName,
              license: asset.license,
              authorizedAt: asset.authorizedAt
            }))
        ) {
          issues.push({
            code: 'completeness.primary_attributes',
            message: `${product.slug}: primary attributes differ`
          })
        }
      }
    }
  }

  for (const mapping of media.values()) {
    if (!products.has(mapping.productId))
      issues.push({ code: 'media.product_missing', message: 'Mapped product is missing' })
    if (mapping.variantId && !variants.has(mapping.variantId)) {
      issues.push({ code: 'media.variant_missing', message: 'Mapped variant is missing' })
    }
    if (mapping.variantId && variants.get(mapping.variantId)?.productId !== mapping.productId) {
      issues.push({ code: 'media.variant_product', message: 'Mapped variant belongs to a different product' })
    }
    if (!assets.has(mapping.assetId)) issues.push({ code: 'media.asset_missing', message: 'Mapped asset is missing' })
  }

  const dataset = {
    products: [...products.values()],
    variants: [...variants.values()],
    assets: [...assets.values()],
    media: [...media.values()]
  }
  return {
    valid: issues.length === 0,
    issues,
    dataset,
    summary: {
      rows: records.length,
      products: dataset.products.length,
      variants: dataset.variants.length,
      assets: dataset.assets.length,
      documents: dataset.media.filter((mapping) => ['datasheet', 'sds', 'certificate', 'label'].includes(mapping.role))
        .length
    }
  }
}

export function exportCatalogCsv(records: CatalogTabularRecord[]): Uint8Array {
  assertExportRecords(records)
  const lines = [catalogTabularColumns.map(csvCell).join(',')]
  for (const record of records) lines.push(catalogTabularColumns.map((column) => csvCell(record[column])).join(','))
  const result = new TextEncoder().encode(`\uFEFF${lines.join('\r\n')}\r\n`)
  if (result.byteLength > CATALOG_TABULAR_MAX_BYTES) throw new Error('Catalog export exceeds the 20 MB limit')
  return result
}

export async function exportCatalogXlsx(records: CatalogTabularRecord[]): Promise<Uint8Array> {
  assertExportRecords(records)
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'NETECO'
  workbook.created = new Date('2026-08-13T12:00:00.000Z')
  workbook.modified = workbook.created
  const worksheet = workbook.addWorksheet('Catalog')
  worksheet.addRow([...catalogTabularColumns])
  for (const record of records) {
    worksheet.addRow(catalogTabularColumns.map((column) => record[column]))
  }
  worksheet.views = [{ state: 'frozen', ySplit: 1 }]
  const buffer = await workbook.xlsx.writeBuffer()
  const result = new Uint8Array(buffer)
  if (result.byteLength > CATALOG_TABULAR_MAX_BYTES) throw new Error('Catalog export exceeds the 20 MB limit')
  return result
}

function assertExportRecords(records: CatalogTabularRecord[]) {
  if (!records.length) throw new Error('Catalog export requires at least one row')
  if (records.length > CATALOG_TABULAR_MAX_ROWS) throw new Error('Catalog export exceeds the 25000 row limit')
  records.forEach((record, index) => {
    for (const column of catalogTabularColumns) {
      if (typeof record[column] !== 'string')
        throw new Error(`Catalog export row ${index + 2} field ${column} is not text`)
      if (record[column].length > CATALOG_TABULAR_MAX_CELL_CHARACTERS) {
        throw new Error(`Catalog export row ${index + 2} field ${column} exceeds the cell limit`)
      }
    }
  })
}
