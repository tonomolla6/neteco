import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as core from '../../shared/catalog-tabular-core'
import * as legacy from '../../server/services/catalog-tabular'
import { safeCsvValue } from '../../server/utils/csv'
import type { CatalogTabularRecord } from '../../shared/catalog-tabular-core'

afterEach(() => vi.unstubAllGlobals())
// The established synthetic Node fixture retains the same full v1 wire data.
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

describe('catalog tabular pure Worker-compatible core', () => {
  it('rejects zero-byte asset descriptors before preview or staging, matching the native schema', () => {
    const result = core.validateCatalogRecords([{ ...completeRecords()[0]!, asset_byte_size: '0' }])
    expect(result.valid).toBe(false)
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'field.invalid', field: 'asset_byte_size' })])
    )
  })
  it('retains the exact original Node runtime exports, using the same CSV function objects and limits', () => {
    expect(Object.keys(legacy).sort()).toEqual(
      [
        'CATALOG_TABULAR_MAX_BYTES',
        'CATALOG_TABULAR_MAX_CELL_CHARACTERS',
        'CATALOG_TABULAR_MAX_ROWS',
        'catalogTabularColumns',
        'exportCatalogCsv',
        'exportCatalogXlsx',
        'parseCatalogCsv',
        'parseCatalogXlsx',
        'validateCatalogRecords'
      ].sort()
    )
    for (const name of [
      'parseCatalogCsv',
      'exportCatalogCsv',
      'validateCatalogRecords',
      'catalogTabularColumns',
      'CATALOG_TABULAR_MAX_BYTES',
      'CATALOG_TABULAR_MAX_ROWS',
      'CATALOG_TABULAR_MAX_CELL_CHARACTERS'
    ] as const)
      expect(legacy[name]).toBe(core[name])
    expect(core.CATALOG_TABULAR_MAX_BYTES).toBe(20_000_000)
    expect(core.CATALOG_TABULAR_MAX_ROWS).toBe(25_000)
    expect(core.CATALOG_TABULAR_MAX_CELL_CHARACTERS).toBe(20_000)
  })
  it('has no Node/ExcelJS/PostgreSQL runtime import in the complete local dependency graph', () => {
    const expected = [
      {
        path: '../../shared/catalog-tabular-core.ts',
        allowed: ['zod', '../server/domain/catalog-publication', '../server/utils/csv', './catalog-typed-attributes']
      },
      { path: '../../shared/catalog-typed-attributes.ts', allowed: ['zod', './catalog-publication-policy'] },
      { path: '../../shared/catalog-publication-policy.ts', allowed: ['zod'] },
      { path: '../../server/domain/catalog-publication.ts', allowed: [] },
      { path: '../../server/utils/csv.ts', allowed: [] }
    ]
    for (const file of expected) {
      const source = readFileSync(new URL(file.path, import.meta.url), 'utf8')
      const parsed = ts.createSourceFile(file.path, source, ts.ScriptTarget.Latest, true)
      const imports = parsed.statements.filter(ts.isImportDeclaration).map((item) => {
        if (!ts.isStringLiteral(item.moduleSpecifier)) throw Error('unexpected_import')
        return item.moduleSpecifier.text
      })
      expect(imports).toEqual(file.allowed)
      const nodeGlobals: string[] = []
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node) && ['Buffer', 'process', 'require'].includes(node.text)) nodeGlobals.push(node.text)
        ts.forEachChild(node, visit)
      }
      visit(parsed)
      expect(nodeGlobals).toEqual([])
    }
  })
  it('CSV decoding, validation and export run without Buffer or process, preserving UTF-8, BOM and quoted multiline values', () => {
    let exported: Uint8Array, parsed: CatalogTabularRecord[], validation: core.CatalogTabularValidation
    const records = completeRecords()
    try {
      vi.stubGlobal('Buffer', undefined)
      vi.stubGlobal('process', undefined)
      exported = core.exportCatalogCsv(records)
      parsed = core.parseCatalogCsv(exported)
      validation = core.validateCatalogRecords(parsed)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(exported!.slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]))
    expect(parsed!).toEqual(records)
    expect(validation!.issues).toEqual([])
    expect(validation!.summary).toEqual({ rows: 2, products: 1, variants: 1, assets: 2, documents: 1 })
  })
  it('CSV/XLSX still share the same Node v1 data and validation, without exporting XLSX from the pure core', async () => {
    const records = completeRecords(),
      bytes = await legacy.exportCatalogXlsx(records)
    expect(await legacy.parseCatalogXlsx(bytes)).toEqual(records)
    expect(core.validateCatalogRecords(await legacy.parseCatalogXlsx(bytes))).toEqual(
      legacy.validateCatalogRecords(records)
    )
    expect(Object.hasOwn(core, 'parseCatalogXlsx')).toBe(false)
    expect(Object.hasOwn(core, 'exportCatalogXlsx')).toBe(false)
  })
  it.each(['=1+1', '+SUM(1,2)', '-1+1', '@HYPERLINK("https://attacker.invalid")', ' \t=1+1'])(
    'preserves formula rejection and spreadsheet-safe CSV neutralization for %s',
    (value) => {
      const input = record({ product_name: value })
      expect(core.validateCatalogRecords([input]).issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'field.formula', field: 'product_name' })])
      )
      const decoded = core.parseCatalogCsv(core.exportCatalogCsv([input]))
      expect(decoded[0]!.product_name).toBe(safeCsvValue(value))
    }
  )
  it.each([
    { name: 'characters after closed quote', text: '"cell"junk,value\n', message: 'closing quote' },
    { name: 'unterminated quote', text: '"unterminated', message: 'unterminated' },
    { name: 'quote inside unquoted cell', text: 'bad"quote,value\n', message: 'beginning' },
    { name: 'unknown headers', text: 'wrong,headers\n1,2\n', message: 'headers' },
    { name: 'header only', text: core.catalogTabularColumns.join(',') + '\n', message: 'at least one' },
    {
      name: 'wrong row width',
      text: core.catalogTabularColumns.join(',') + '\nonly,three,cells\n',
      message: 'wrong width'
    }
  ])('rejects hostile CSV $name with the unchanged contract error', ({ text, message }) => {
    expect(() => core.parseCatalogCsv(new TextEncoder().encode(text))).toThrow(message)
  })
  it('rejects reordered, missing and extra headers rather than remapping fields', () => {
    const bytes = core.exportCatalogCsv(completeRecords()),
      text = new TextDecoder().decode(bytes)
    const [first, ...rest] = text.split('\r\n')
    for (const changed of [
      first!.replace('"product_id","product_legacy_id"', '"product_legacy_id","product_id"'),
      first!.replace(',"media_sort_order"', ''),
      first! + ',"unexpected"'
    ])
      expect(() => core.parseCatalogCsv(new TextEncoder().encode([changed, ...rest].join('\r\n')))).toThrow('headers')
  })
  it.each([new Uint8Array(), new Uint8Array([0xff, 0xfe]), new Uint8Array([0xc3, 0x28])])(
    'rejects empty or malformed UTF-8 bytes %#',
    (bytes) => {
      expect(() => core.parseCatalogCsv(bytes)).toThrow()
    }
  )
  it('rejects oversized raw input before decoding and preserves both export limits', () => {
    expect(() => core.parseCatalogCsv(new Uint8Array(core.CATALOG_TABULAR_MAX_BYTES + 1))).toThrow('20 MB')
    expect(() => core.exportCatalogCsv(Array(core.CATALOG_TABULAR_MAX_ROWS + 1).fill(record()))).toThrow('25000 row')
    expect(() =>
      core.exportCatalogCsv([record({ description: 'x'.repeat(core.CATALOG_TABULAR_MAX_CELL_CHARACTERS + 1) })])
    ).toThrow('cell limit')
  })
  it('accepts the exact CSV row boundary and rejects +1 without truncating', () => {
    const header = core.catalogTabularColumns.join(',') + '\n',
      empty = ','.repeat(core.catalogTabularColumns.length - 1) + '\n'
    expect(
      core.parseCatalogCsv(new TextEncoder().encode(header + empty.repeat(core.CATALOG_TABULAR_MAX_ROWS)))
    ).toHaveLength(core.CATALOG_TABULAR_MAX_ROWS)
    expect(() =>
      core.parseCatalogCsv(new TextEncoder().encode(header + empty.repeat(core.CATALOG_TABULAR_MAX_ROWS + 1)))
    ).toThrow('25000 row')
  })
  it('shares the XLSX row-width helper without relaxing header, row or cell validation', () => {
    const rows = [Array.from(core.catalogTabularColumns), core.catalogTabularColumns.map((column) => record()[column])]
    expect(core.catalogTabularRecordsFromRows(rows)).toEqual([record()])
    const oversized = core.catalogTabularColumns.map(
      (column) => record({ description: 'x'.repeat(core.CATALOG_TABULAR_MAX_CELL_CHARACTERS + 1) })[column]
    )
    expect(() => core.catalogTabularRecordsFromRows([Array.from(core.catalogTabularColumns), oversized])).toThrow(
      'cell limit'
    )
  })
  it('retains duplicate/reference/governance and regulated publication errors without interpreting CSV claims as approvals', () => {
    expect(core.validateCatalogRecords([record(), record()]).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'row.duplicate' })])
    )
    const invalid = core.validateCatalogRecords(
      completeRecords().map((item) => ({ ...item, asset_rights_status: 'pending', asset_quarantine_status: 'pending' }))
    )
    expect(invalid.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'completeness.asset_governance' })])
    )
    expect(core.validateCatalogRecords([record({ product_regulatory_json: '[]' })]).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'field.invalid' })])
    )
    expect(core.validateCatalogRecords([record({ requires_sds: 'false' })]).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'field.invalid' })])
    )
  })
})
