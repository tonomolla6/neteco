import type { Sql } from 'postgres'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyCatalogImport,
  catalogRecordsFromDatabase,
  previewCatalogImport,
  rollbackCatalogImport
} from '../../server/services/catalog-import'
import {
  exportCatalogCsv,
  exportCatalogXlsx,
  parseCatalogCsv,
  parseCatalogXlsx,
  validateCatalogRecords,
  type CatalogTabularRecord,
  type CatalogTabularValidation
} from '../../server/services/catalog-tabular'
import { deterministicTestData, type DeterministicTestData } from '../fixtures/deterministic'
import { isolatedPostgresDatabase, type IsolatedPostgresDatabase } from '../fixtures/postgres'

const baseConnection = process.env.DATABASE_URL ?? 'postgres://neteco:neteco-local@localhost:56432/neteco'
let database: IsolatedPostgresDatabase
let sql: Sql
let data: DeterministicTestData

beforeEach(async (context) => {
  data = deterministicTestData(`integration:catalog-import:${context.task.id}:${context.task.name}`)
  database = await isolatedPostgresDatabase(data.namespace)
  process.env.DATABASE_URL = database.connection
  sql = database.sql
})

afterEach(async () => {
  try {
    await database.dispose()
  } finally {
    process.env.DATABASE_URL = baseConnection
  }
})

interface References {
  sourceId: string
  categoryId: string
  categoryStatus: string
  brandId: string
  brandStatus: string
  taxClassId: string
  shippingProfileId: string
  locationId: string
}

async function references(): Promise<References> {
  const [result] = await sql<References[]>`
    SELECT source.id AS "sourceId", category.id AS "categoryId", category.status AS "categoryStatus",
      brand.id AS "brandId", brand.status AS "brandStatus", tax.id AS "taxClassId",
      shipping.id AS "shippingProfileId", location.id AS "locationId"
    FROM catalog_sources source
    CROSS JOIN LATERAL (SELECT id, status FROM categories WHERE status = 'published' ORDER BY id LIMIT 1) category
    CROSS JOIN LATERAL (SELECT id, status FROM brands WHERE status = 'published' ORDER BY id LIMIT 1) brand
    CROSS JOIN LATERAL (SELECT id FROM tax_classes ORDER BY id LIMIT 1) tax
    CROSS JOIN LATERAL (SELECT id FROM shipping_profiles ORDER BY id LIMIT 1) shipping
    CROSS JOIN LATERAL (SELECT id FROM inventory_locations WHERE active = true ORDER BY id LIMIT 1) location
    WHERE source.is_master = true
    LIMIT 1
  `
  if (!result) throw new Error('Catalog import references are unavailable')
  return result
}

function row(refs: References, ids: Record<string, string>, overrides: Partial<CatalogTabularRecord> = {}) {
  return {
    product_id: ids.product!,
    product_legacy_id: '990001',
    product_name: 'Detergente profesional 5 L',
    product_slug: `detergente-${ids.product!.slice(0, 8)}`,
    product_status: 'published',
    short_description: 'Detergente concentrado para limpieza profesional diaria.',
    description:
      'Fórmula profesional documentada para la limpieza diaria de superficies lavables y resistentes al agua.',
    category_id: refs.categoryId,
    category_status: refs.categoryStatus,
    brand_id: refs.brandId,
    brand_status: refs.brandStatus,
    source_id: refs.sourceId,
    source_version: 'supplier-2026.08',
    product_usage: 'Limpieza de superficies lavables',
    product_series: 'higiene-profesional',
    product_featured: 'true',
    product_attributes_json: `{"attrs":[{"label":"pH","value":"7"}],"badges":["Eco"],"image":"/media/${ids.image}","imageAlt":"Garrafa de detergente profesional de cinco litros","imageRights":{"owner":"NETECO","license":"Fotografía propia autorizada para ecommerce","authorizedAt":"2026-08-13T12:00:00.000Z"}}`,
    product_regulatory_json: '{"requiresSds":true,"reach":"compliant"}',
    variant_id: ids.variant!,
    variant_legacy_id: '991001',
    sku: `IMP-${ids.variant!.slice(0, 8)}`.toUpperCase(),
    ean: '4006381333931',
    gtin: '',
    mpn: '',
    identifier_exception_reason: '',
    format: 'Garrafa 5 L',
    variant_status: 'published',
    variant_source_version: 'supplier-2026.08',
    tax_class_id: refs.taxClassId,
    shipping_profile_id: refs.shippingProfileId,
    price_gross_cents: '1599',
    compare_at_gross_cents: '1799',
    cost_net_cents: '800',
    currency: 'EUR',
    unit_base: 'l',
    unit_label: 'litro',
    content_quantity: '5',
    units_per_case: '4',
    cases_per_pallet: '30',
    minimum_quantity: '1',
    quantity_increment: '1',
    maximum_quantity: '20',
    weight_grams: '5200',
    width_mm: '180',
    height_mm: '320',
    depth_mm: '130',
    safety_stock: '2',
    backorder_allowed: 'false',
    lead_time_days: '',
    variant_color: '#00AACC',
    variant_image: '/img/products/detergente.webp',
    inventory_json: `[{"locationId":"${refs.locationId}","physicalQuantity":40,"blockedQuantity":2,"version":1}]`,
    requires_sds: 'true',
    asset_id: ids.image!,
    asset_storage_key: `clean/${ids.image!}-detergente.png`,
    asset_original_name: 'detergente.png',
    asset_mime_type: 'image/png',
    asset_byte_size: '24000',
    asset_checksum_sha256: 'a'.repeat(64),
    asset_owner_name: 'NETECO',
    asset_source_url: `/media/${ids.image!}`,
    asset_license: 'Fotografía propia autorizada para ecommerce',
    asset_authorized_at: '2026-08-13T12:00:00.000Z',
    asset_rights_status: 'approved',
    asset_quarantine_status: 'clean',
    asset_alt_text: 'Garrafa de detergente profesional de cinco litros',
    asset_metadata_json: '{"language":"es","provenance":"supplier"}',
    media_role: 'primary',
    media_variant_id: '',
    media_version: '1',
    media_sort_order: '0',
    ...overrides
  } satisfies CatalogTabularRecord
}

async function fixture() {
  const sourceId = data.uuid('source')
  await sql.begin(async (transaction) => {
    await transaction`UPDATE catalog_sources SET is_master = false WHERE is_master = true`
    await transaction`
      INSERT INTO catalog_sources (id, code, name, owner, kind, is_master)
      VALUES (${sourceId}, ${`test-${sourceId.slice(0, 8)}`}, 'Proveedor de integración', 'NETECO tests', 'supplier', true)
    `
  })
  const refs = await references()
  const ids = {
    product: data.uuid('product'),
    variant: data.uuid('variant'),
    image: data.uuid('image'),
    sds: data.uuid('sds')
  }
  const records = [
    row(refs, ids),
    row(refs, ids, {
      asset_id: ids.sds,
      asset_storage_key: `clean/${ids.sds}-sds.pdf`,
      asset_original_name: 'sds-detergente.pdf',
      asset_mime_type: 'application/pdf',
      asset_byte_size: '48000',
      asset_checksum_sha256: 'b'.repeat(64),
      asset_source_url: `/media/${ids.sds}`,
      asset_alt_text: 'Ficha de datos de seguridad del detergente',
      asset_metadata_json: '{"documentType":"sds","language":"es"}',
      media_role: 'sds',
      media_variant_id: '',
      media_version: '2',
      media_sort_order: '1'
    })
  ]
  return { ids, records, validation: validateCatalogRecords(records) }
}

async function counts() {
  const [result] = await sql<
    { products: number; variants: number; assets: number; mappings: number; batches: number; releases: number }[]
  >`
    SELECT (SELECT count(*)::int FROM products) AS products,
      (SELECT count(*)::int FROM variants) AS variants,
      (SELECT count(*)::int FROM media_assets) AS assets,
      (SELECT count(*)::int FROM product_media) AS mappings,
      (SELECT count(*)::int FROM catalog_import_batches) AS batches,
      (SELECT count(*)::int FROM catalog_releases) AS releases
  `
  return result!
}

describe('catalog tabular import and export', () => {
  it('previews without writes, applies atomically, exports every governed field and rolls back explicitly', async () => {
    const input = await fixture()
    expect(input.validation.valid).toBe(true)
    const before = await counts()
    const preview = await previewCatalogImport(sql, input.validation)
    expect(preview).toMatchObject({ valid: true, creates: { products: 1, variants: 1, assets: 2, mappings: 2 } })
    const reordered = validateCatalogRecords([...input.records].reverse())
    expect((await previewCatalogImport(sql, reordered)).checksumSha256).toBe(preview.checksumSha256)
    expect(await counts()).toEqual(before)

    const staleReference = structuredClone(input.validation)
    staleReference.dataset.products[0]!.categoryStatus = 'draft'
    expect((await previewCatalogImport(sql, staleReference)).issues.map((issue) => issue.code)).toContain(
      'reference.category_status'
    )

    const applied = await applyCatalogImport(sql, input.validation, 'supplier-2026.08')
    expect(applied.checksumSha256).toBe(preview.checksumSha256)
    expect(await counts()).toEqual({
      products: before.products + 1,
      variants: before.variants + 1,
      assets: before.assets + 2,
      mappings: before.mappings + 2,
      batches: before.batches + 1,
      releases: before.releases + 1
    })

    const exported = await catalogRecordsFromDatabase(sql, { sourceId: input.validation.dataset.products[0]!.sourceId })
    const onlyImported = exported.filter((item) => item.product_id === input.ids.product)
    expect(onlyImported).toHaveLength(2)
    for (const roundTrip of [
      validateCatalogRecords(parseCatalogCsv(exportCatalogCsv(onlyImported))),
      validateCatalogRecords(await parseCatalogXlsx(await exportCatalogXlsx(onlyImported)))
    ]) {
      expect(roundTrip.valid).toBe(true)
      expect(roundTrip.dataset).toEqual(input.validation.dataset)
    }

    const replay = await previewCatalogImport(sql, input.validation)
    expect(replay.valid).toBe(false)
    expect(replay.issues.map((issue) => issue.code)).toContain('database.products_conflict')

    await rollbackCatalogImport(sql, applied.batchId)
    const rolledBack = await counts()
    expect(rolledBack).toEqual({ ...before, batches: before.batches + 1, releases: before.releases + 1 })
    const [batch] = await sql<
      { status: string }[]
    >`SELECT status FROM catalog_import_batches WHERE id = ${applied.batchId}`
    expect(batch?.status).toBe('rolled_back')
    const [release] = await sql<
      { status: string }[]
    >`SELECT status FROM catalog_releases WHERE import_batch_id = ${applied.batchId}`
    expect(release?.status).toBe('rolled_back')
  })

  it('rolls back the whole transaction when a database constraint fails after the batch insert', async () => {
    const input = await fixture()
    const before = await counts()
    const hostile = structuredClone(input.validation) as CatalogTabularValidation
    hostile.dataset.products[0]!.sourceVersion = 'supplier-2026.09'
    hostile.dataset.variants[0]!.sourceVersion = 'supplier-2026.09'
    hostile.dataset.assets[0]!.byteSize = -1
    await expect(applyCatalogImport(sql, hostile, 'supplier-2026.09')).rejects.toThrow()
    expect(await counts()).toEqual(before)
  })
})
