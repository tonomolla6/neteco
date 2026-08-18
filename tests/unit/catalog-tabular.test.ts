import ExcelJS from 'exceljs'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { checkProperty } from '../support/property'
import { safeCsvValue } from '../../server/utils/csv'
import {
  CATALOG_TABULAR_MAX_BYTES,
  CATALOG_TABULAR_MAX_CELL_CHARACTERS,
  CATALOG_TABULAR_MAX_ROWS,
  catalogTabularColumns,
  exportCatalogCsv,
  exportCatalogXlsx,
  parseCatalogCsv,
  parseCatalogXlsx,
  validateCatalogRecords,
  type CatalogTabularRecord
} from '../../server/services/catalog-tabular'

const ids = {
  product: '53e3a51a-94ca-4ac8-b710-60958cf955c3',
  variant: '77a871dd-15a1-4844-901e-208ef2f4186b',
  category: '7de268ab-b16d-46c8-98f6-82898669f1f3',
  brand: '5e612d78-48e9-48a4-b71e-9b97bfed7ae5',
  source: 'bf98f612-3a3b-46a8-9b50-b336bccd37ce',
  tax: '487487a6-bad3-4e61-ab68-b2b1fd1a25e8',
  shipping: '71652b69-1d0d-4fae-ab21-d8bba98ceac4',
  image: '7db6a455-b008-46f7-9f85-793e85e60b09',
  sds: 'd5f2cf6f-0571-4a5e-941c-01da1772b6bb'
}

function record(overrides: Partial<CatalogTabularRecord> = {}): CatalogTabularRecord {
  return {
    product_id: ids.product,
    product_legacy_id: '900001',
    product_name: 'Detergente profesional 5 L',
    product_slug: 'detergente-profesional-5l',
    product_status: 'published',
    short_description: 'Detergente profesional concentrado, con coma y\nnueva línea segura.',
    description:
      'Fórmula profesional documentada para la limpieza diaria de superficies lavables y resistentes al agua.',
    category_id: ids.category,
    category_status: 'published',
    brand_id: ids.brand,
    brand_status: 'published',
    source_id: ids.source,
    source_version: 'supplier-2026.08',
    product_usage: 'Limpieza profesional de superficies lavables',
    product_series: 'higiene-profesional',
    product_featured: 'true',
    product_attributes_json: `{"attrs":[{"label":"pH","value":"7"}],"badges":["Eco"],"image":"/media/${ids.image}","imageAlt":"Garrafa de detergente profesional de cinco litros","imageRights":{"owner":"NETECO","license":"Fotografía propia autorizada para ecommerce","authorizedAt":"2026-08-13T12:00:00.000Z"}}`,
    product_regulatory_json: '{"requiresSds":true,"reach":"compliant"}',
    variant_id: ids.variant,
    variant_legacy_id: '910001',
    sku: 'DET-5L',
    ean: '4006381333931',
    gtin: '',
    mpn: '',
    identifier_exception_reason: '',
    format: 'Garrafa 5 L',
    variant_status: 'published',
    variant_source_version: 'supplier-2026.08',
    tax_class_id: ids.tax,
    shipping_profile_id: ids.shipping,
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
    inventory_json:
      '[{"locationId":"71652b69-1d0d-4fae-ab21-d8bba98ceac4","physicalQuantity":40,"blockedQuantity":2,"version":1}]',
    requires_sds: 'true',
    asset_id: ids.image,
    asset_storage_key: `clean/${ids.image}-detergente.png`,
    asset_original_name: 'detergente-principal.webp',
    asset_mime_type: 'image/png',
    asset_byte_size: '24000',
    asset_checksum_sha256: 'a'.repeat(64),
    asset_owner_name: 'NETECO',
    asset_source_url: `/media/${ids.image}`,
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
  }
}

function completeRecords() {
  return [
    record(),
    record({
      asset_id: ids.sds,
      asset_storage_key: `clean/${ids.sds}-sds.pdf`,
      asset_original_name: 'sds-detergente.pdf',
      asset_mime_type: 'application/pdf',
      asset_byte_size: '48000',
      asset_checksum_sha256: 'b'.repeat(64),
      asset_source_url: `/media/${ids.sds}`,
      asset_alt_text: 'Ficha de datos de seguridad del detergente',
      media_role: 'sds',
      media_version: '2',
      media_sort_order: '1'
    })
  ]
}

const catalogTextArbitrary = fc
  .array(fc.constantFrom(...'abcXYZ0123 ,"\n\r\t=+-@áñ'), { maxLength: 80 })
  .map((characters) => characters.join(''))

const catalogRecordArbitrary = fc
  .array(catalogTextArbitrary, { minLength: catalogTabularColumns.length, maxLength: catalogTabularColumns.length })
  .map(
    (values) =>
      Object.fromEntries(
        catalogTabularColumns.map((column, index) => [column, values[index] ?? ''])
      ) as CatalogTabularRecord
  )

describe('catalog tabular contract', () => {
  it('round-trips quoted UTF-8 CSV with BOM and maps complete assets and documents', () => {
    const exported = exportCatalogCsv(completeRecords())
    expect(exported.slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]))
    const parsed = parseCatalogCsv(exported)
    expect(parsed).toEqual(completeRecords())
    const validation = validateCatalogRecords(parsed)
    expect(validation.issues).toEqual([])
    expect(validation.summary).toEqual({ rows: 2, products: 1, variants: 1, assets: 2, documents: 1 })
  })

  it('round-trips the same versioned contract through XLSX without type drift', async () => {
    const exported = await exportCatalogXlsx(completeRecords())
    const parsed = await parseCatalogXlsx(exported)
    expect(parsed).toEqual(completeRecords())
    expect(validateCatalogRecords(parsed).valid).toBe(true)
  })

  it('rejects formulas, malformed encoding, oversized input, wrong headers and hostile XLSX', async () => {
    expect(validateCatalogRecords([record({ product_name: '=HYPERLINK("https://attacker.invalid")' })]).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'field.formula', field: 'product_name' })])
    )
    expect(() => parseCatalogCsv(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow()
    expect(() => parseCatalogCsv(new Uint8Array(CATALOG_TABULAR_MAX_BYTES + 1))).toThrow('20 MB')
    expect(() => parseCatalogCsv(new TextEncoder().encode('wrong,headers\n1,2\n'))).toThrow('headers')
    expect(() => parseCatalogCsv(new TextEncoder().encode('"abc"junk,def\n'))).toThrow('closing quote')
    expect(() => exportCatalogCsv(Array(CATALOG_TABULAR_MAX_ROWS + 1).fill(record()))).toThrow('25000 row')
    expect(() =>
      exportCatalogCsv([record({ description: 'x'.repeat(CATALOG_TABULAR_MAX_CELL_CHARACTERS + 1) })])
    ).toThrow('cell limit')

    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('Catalog')
    worksheet.addRow([...catalogTabularColumns])
    worksheet.addRow(catalogTabularColumns.map((column) => record()[column]))
    worksheet.getCell('B2').value = { formula: 'HYPERLINK("https://attacker.invalid")', result: 'click' }
    await expect(parseCatalogXlsx(new Uint8Array(await workbook.xlsx.writeBuffer()))).rejects.toThrow('formulas')
  })

  it('reports duplicates, inconsistent rows and incomplete publication or document mappings before apply', () => {
    const duplicateVariant = record({
      variant_id: '752d203d-9ffb-4574-95eb-20f451aff252',
      asset_id: '4d9b429f-f2fc-4aab-9655-f749285778f3',
      asset_storage_key: 'clean/duplicate.png',
      asset_source_url: '/media/4d9b429f-f2fc-4aab-9655-f749285778f3',
      asset_checksum_sha256: 'c'.repeat(64)
    })
    const duplicateIssues = validateCatalogRecords([...completeRecords(), duplicateVariant]).issues
    expect(duplicateIssues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'variant.sku_duplicate' })])
    )
    expect(duplicateIssues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'variant.ean_duplicate' })])
    )
    const duplicateProduct = record({
      product_id: '03989845-b99a-4fd4-96fa-cbc00fb1e120',
      product_legacy_id: '900002',
      variant_id: '625dbf39-c0ab-4342-8837-45329046104a',
      variant_legacy_id: '910002',
      sku: 'SECOND-SKU',
      ean: '5012345678900',
      product_attributes_json: `{"image":"/media/965be1dd-57df-4c14-89f2-b0d4656546f9","imageAlt":"Imagen de producto secundario autorizado","imageRights":{"owner":"NETECO","license":"Fotografía propia autorizada para ecommerce","authorizedAt":"2026-08-13T12:00:00.000Z"}}`,
      asset_id: '965be1dd-57df-4c14-89f2-b0d4656546f9',
      asset_storage_key: 'clean/secondary.png',
      asset_checksum_sha256: 'd'.repeat(64),
      asset_source_url: '/media/965be1dd-57df-4c14-89f2-b0d4656546f9',
      asset_alt_text: 'Imagen de producto secundario autorizado'
    })
    expect(validateCatalogRecords([...completeRecords(), duplicateProduct]).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'product.slug_duplicate' })])
    )
    expect(
      validateCatalogRecords([...completeRecords(), { ...duplicateProduct, media_variant_id: ids.variant }]).issues
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'media.variant_product' })]))

    expect(validateCatalogRecords([record(), record()]).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'row.duplicate' })])
    )
    expect(validateCatalogRecords([record(), record({ media_sort_order: '9' })]).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'media.inconsistent' })])
    )

    const invalidAsset = validateCatalogRecords(
      completeRecords().map((item) => ({ ...item, asset_storage_key: 'quarantine/file.svg', asset_source_url: 'x' }))
    ).issues.map((issue) => issue.code)
    expect(invalidAsset).toContain('asset.storage_key')
    expect(invalidAsset).toContain('asset.source_url')

    expect(
      validateCatalogRecords(completeRecords().map((item) => ({ ...item, variant_status: 'draft' }))).issues
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'completeness.variant_published' })]))

    const inconsistent = validateCatalogRecords([record(), record({ product_name: 'Nombre diferente' })]).issues
    expect(inconsistent).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'product.inconsistent' })]))

    const incomplete = validateCatalogRecords([
      record({ requires_sds: 'true', media_role: 'gallery', asset_mime_type: 'image/webp' })
    ]).issues.map((issue) => issue.code)
    expect(incomplete).toContain('completeness.media.primary')
    expect(incomplete).toContain('completeness.sds')

    const wrongDocument = validateCatalogRecords([
      record({ media_role: 'sds', asset_mime_type: 'image/svg+xml' })
    ]).issues.map((issue) => issue.code)
    expect(wrongDocument).toContain('media.document_mime')

    const ungoverned = validateCatalogRecords(
      completeRecords().map((item) => ({ ...item, asset_rights_status: 'pending' }))
    )
    expect(ungoverned.issues.map((issue) => issue.code)).toContain('completeness.asset_governance')
  })

  it('preserves generated CSV cells, validates arbitrary text safely and keeps valid datasets stable', async () => {
    await checkProperty(
      'TST038-catalog-csv-roundtrip',
      fc.property(catalogRecordArbitrary, (candidate) => {
        const parsed = parseCatalogCsv(exportCatalogCsv([candidate]))
        const expected = Object.fromEntries(
          catalogTabularColumns.map((column) => [column, safeCsvValue(candidate[column])])
        )
        expect(parsed).toEqual([expected])
      })
    )

    await checkProperty(
      'TST038-catalog-validation-totality',
      fc.property(
        catalogRecordArbitrary,
        fc.constantFrom(...catalogTabularColumns),
        catalogTextArbitrary,
        (candidate, column, value) => {
          const deepCandidate = record({ [column]: value })
          for (const generated of [candidate, deepCandidate]) {
            expect(() => validateCatalogRecords([generated])).not.toThrow()
            const validation = validateCatalogRecords([generated])
            expect(validation.valid).toBe(validation.issues.length === 0)
            expect(validation.summary.rows).toBe(1)
          }
        }
      )
    )

    await checkProperty(
      'TST038-catalog-valid-import-stability',
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (sequence) => {
        const records = completeRecords().map((item) => ({
          ...item,
          product_name: `Producto profesional property ${sequence}`,
          short_description: `Descripción corta válida generada para el producto ${sequence}.`,
          description: `Descripción completa válida y estable para comprobar el contrato tabular del producto ${sequence}.`
        }))
        const direct = validateCatalogRecords(records)
        const parsedRecords = parseCatalogCsv(exportCatalogCsv(records))
        const afterCsv = validateCatalogRecords(parsedRecords)

        expect(direct.valid).toBe(true)
        expect(parsedRecords).toEqual(records)
        expect(afterCsv).toEqual(direct)
      })
    )
  })
})
