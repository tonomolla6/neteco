import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportCatalogSnapshotXlsx } from '../../app/utils/catalog-export-xlsx.client'
import {
  CATALOG_EXPORT_COLUMNS,
  CATALOG_EXPORT_MAX_BYTES,
  CATALOG_EXPORT_MAX_CELL_CHARACTERS,
  CATALOG_EXPORT_MAX_ROWS,
  CATALOG_EXPORT_PROFILE,
  CATALOG_EXPORT_SHEET_NAMES,
  catalogExportHash,
  type CatalogExportSheet,
  type CatalogExportSnapshot
} from '../../shared/catalog-export'

type Value = string | number | boolean | null
type Name = (typeof CATALOG_EXPORT_SHEET_NAMES)[number]
const productId = '10000000-0000-4000-8000-000000000054',
  variantId = '20000000-0000-4000-8000-000000000054'

function record(name: Name, changes: Record<string, Value> = {}): string[] {
  const values: Record<string, Value> = Object.fromEntries(
    CATALOG_EXPORT_COLUMNS[name].filter((column) => column !== 'record_json').map((column) => [column, ''])
  )
  Object.assign(values, changes)
  return CATALOG_EXPORT_COLUMNS[name].map((column) => {
    if (column === 'record_json') return JSON.stringify(values)
    const value = values[column]!
    return value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  })
}
async function snapshot(sheets?: CatalogExportSheet[]): Promise<CatalogExportSnapshot> {
  const entities =
    sheets ??
    CATALOG_EXPORT_SHEET_NAMES.map((name) => ({
      name,
      columns: [...CATALOG_EXPORT_COLUMNS[name]],
      rows: [
        record(
          name,
          name === 'Products'
            ? {
                id: productId,
                legacy_id: '000001',
                name: 'Árbol · 漢字 · 🚀',
                short_description: '=HYPERLINK("https://example.invalid","not executable")',
                description: '+SUM(1,2)',
                usage: '-10',
                series: '@SUM(A1)',
                regulatory: null,
                source_version: '',
                featured: false,
                catalog_version: 1
              }
            : name === 'Variants'
              ? {
                  id: variantId,
                  product_id: productId,
                  sku: '000001',
                  ean: '0001234567890',
                  price_gross_cents: 1999,
                  compare_at_gross_cents: null,
                  currency: 'EUR',
                  backorder_allowed: false
                }
              : name === 'Inventory'
                ? { variant_id: variantId, physical_quantity: 0, blocked_quantity: 0, sellable_quantity: 0, version: 1 }
                : name === 'Prices'
                  ? { variant_id: variantId, gross_cents: 0, valid_until: null }
                  : name === 'Media'
                    ? { product_id: productId, variant_id: null, title: '=2+2', alt: 'Etiqueta española 🚀' }
                    : { kind: 'category', id: productId, name: 'https://example.invalid' }
        )
      ]
    }))
  const input: Omit<CatalogExportSnapshot, 'hash'> = {
    source: 'cloudflare',
    profile: CATALOG_EXPORT_PROFILE,
    snapshotId: '30000000-0000-4000-8000-000000000054',
    observedAt: '2026-10-03T12:34:56Z',
    filters: { q: 'limpieza', category: 3, status: 'draft' },
    counts: {
      products: entities[0]!.rows.length,
      variants: entities[1]!.rows.length,
      inventory: entities[2]!.rows.length,
      prices: entities[3]!.rows.length,
      media: entities[4]!.rows.length,
      references: entities[5]!.rows.length
    },
    sheets: entities
  }
  return { ...input, hash: await catalogExportHash(input) }
}
async function read(bytes: Uint8Array) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(bytes))
  return workbook
}
function emptySheets(): CatalogExportSheet[] {
  return CATALOG_EXPORT_SHEET_NAMES.map((name) => ({ name, columns: [...CATALOG_EXPORT_COLUMNS[name]], rows: [] }))
}
afterEach(() => {
  vi.restoreAllMocks()
})

describe('native read-only catalogue XLSX using real ExcelJS', () => {
  it('round-trips all six entity sheets, headers and every string without type drift', async () => {
    const input = await snapshot(),
      original = structuredClone(input),
      bytes = await exportCatalogSnapshotXlsx(input),
      workbook = await read(bytes)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.byteLength).toBeGreaterThan(0)
    expect(bytes.byteLength).toBeLessThanOrEqual(CATALOG_EXPORT_MAX_BYTES)
    expect(input).toEqual(original)
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([...CATALOG_EXPORT_SHEET_NAMES, 'Manifest'])
    for (const entity of input.sheets) {
      const sheet = workbook.getWorksheet(entity.name)!
      expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
      expect(sheet.autoFilter).toBeTruthy()
      expect(sheet.getRow(1).font).toMatchObject({ bold: true })
      for (const [rowIndex, row] of [entity.columns, ...entity.rows].entries())
        for (const [column, value] of row.entries()) {
          const cell = sheet.getRow(rowIndex + 1).getCell(column + 1)
          expect(cell.value).toBe(value)
          expect(cell.type).toBe(ExcelJS.ValueType.String)
          expect(cell.numFmt).toBe('@')
        }
    }
  })

  it('declares null/empty display semantics while preserving the original typed record_json', async () => {
    const input = await snapshot(),
      workbook = await read(await exportCatalogSnapshotXlsx(input)),
      products = workbook.getWorksheet('Products')!,
      cell = (column: (typeof CATALOG_EXPORT_COLUMNS.Products)[number]) =>
        products.getRow(2).getCell(CATALOG_EXPORT_COLUMNS.Products.indexOf(column) + 1).value
    expect(cell('id')).toBe(productId)
    expect(cell('legacy_id')).toBe('000001')
    expect(cell('name')).toBe('Árbol · 漢字 · 🚀')
    expect(cell('regulatory')).toBe('')
    expect(cell('source_version')).toBe('')
    expect(cell('featured')).toBe('false')
    expect(cell('catalog_version')).toBe('1')
    const original: unknown = JSON.parse(String(cell('record_json')))
    expect(original).toMatchObject({ regulatory: null, source_version: '', featured: false, catalog_version: 1 })
    const manifest = workbook.getWorksheet('Manifest')!
    expect(manifest.getCell('A9').value).toBe('nulls')
    expect(manifest.getCell('B9').value).toBe(
      'Blank display cells may be null or empty; record_json preserves the original value.'
    )
  })

  it('copies the verified backend manifest, filter, counts, timestamp and SHA-256 without inventing a new hash', async () => {
    const input = await snapshot(),
      workbook = await read(await exportCatalogSnapshotXlsx(input)),
      sheet = workbook.getWorksheet('Manifest')!
    expect(sheet.getRow(1).values).toEqual([undefined, 'Field', 'Value'])
    const fields = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [sheet.getCell(index + 2, 1).value, sheet.getCell(index + 2, 2).value])
    )
    expect(fields).toEqual({
      source: input.source,
      profile: input.profile,
      snapshotId: input.snapshotId,
      observedAt: input.observedAt,
      filters: JSON.stringify(input.filters),
      counts: JSON.stringify(input.counts),
      hash: input.hash,
      nulls: 'Blank display cells may be null or empty; record_json preserves the original value.',
      purpose: 'Read-only catalogue snapshot, not an import or live/publication authority.'
    })
    for (let row = 1; row <= 10; row++)
      for (let column = 1; column <= 2; column++) {
        expect(sheet.getCell(row, column).type).toBe(ExcelJS.ValueType.String)
        expect(sheet.getCell(row, column).numFmt).toBe('@')
      }
    expect(workbook.created.toISOString()).toBe(input.observedAt.replace('Z', '.000Z'))
  })

  it('stores formula-looking prefixes and URLs as actual XML string cells, never formulas or hyperlinks', async () => {
    const input = await snapshot(),
      bytes = await exportCatalogSnapshotXlsx(input),
      archive = await JSZip.loadAsync(bytes),
      workbook = await read(bytes),
      products = workbook.getWorksheet('Products')!
    for (const column of ['short_description', 'description', 'usage', 'series'] as const)
      expect(products.getRow(2).getCell(CATALOG_EXPORT_COLUMNS.Products.indexOf(column) + 1).value).toBe(
        input.sheets[0]!.rows[0]![CATALOG_EXPORT_COLUMNS.Products.indexOf(column)]
      )
    expect(workbook.getWorksheet('References')!.getCell('C2').value).toBe('https://example.invalid')
    const sheets = Object.values(archive.files).filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name))
    expect(sheets).toHaveLength(7)
    for (const sheet of sheets) {
      const xml = await sheet.async('string')
      expect(xml).not.toMatch(/<f(?:\s|>)/)
      expect(xml).not.toMatch(/<hyperlinks?\b/)
      const cells = xml.match(/<c\b[^>]*>/g) ?? []
      expect(cells.length).toBeGreaterThan(0)
      expect(cells.every((cell) => /\bt="s"/.test(cell))).toBe(true)
    }
    for (const entry of Object.values(archive.files).filter((entry) => entry.name.endsWith('.rels')))
      expect(await entry.async('string')).not.toMatch(/TargetMode="External"/)
  })

  it('supports an empty, complete snapshot with all readable headers and an observed manifest', async () => {
    const input = await snapshot(emptySheets()),
      workbook = await read(await exportCatalogSnapshotXlsx(input))
    expect(workbook.worksheets).toHaveLength(7)
    for (const name of CATALOG_EXPORT_SHEET_NAMES) expect(workbook.getWorksheet(name)!.actualRowCount).toBe(1)
  })

  it('copies the input before asynchronous hash/codec work, so later caller mutations cannot alter the export', async () => {
    const input = await snapshot(),
      pending = exportCatalogSnapshotXlsx(input)
    input.sheets[0]!.rows[0]![0] = 'changed-after-await'
    input.hash = '0'.repeat(64)
    const workbook = await read(await pending)
    expect(workbook.getWorksheet('Products')!.getCell('A2').value).toBe(productId)
    expect(workbook.getWorksheet('Manifest')!.getCell('B8').value).not.toBe(input.hash)
  })

  it.each(['wrong-hash', 'wrong-source', 'wrong-columns', 'wrong-count', 'wrong-flat-value', 'extra-key'])(
    'rejects %s before calling the real workbook writer',
    async (kind) => {
      const input = await snapshot(),
        writer = vi.spyOn(ExcelJS.Workbook.prototype, 'addWorksheet')
      if (kind === 'wrong-hash') input.hash = '0'.repeat(64)
      else if (kind === 'wrong-source') Object.assign(input, { source: 'node' })
      else if (kind === 'wrong-columns') input.sheets[0]!.columns.reverse()
      else if (kind === 'wrong-count') input.counts.products++
      else if (kind === 'wrong-flat-value') input.sheets[0]!.rows[0]![0] = 'not-the-original-record'
      else Object.assign(input, { unexpected: true })
      await expect(exportCatalogSnapshotXlsx(input)).rejects.toThrow('invalid_catalog_export_snapshot')
      expect(writer).not.toHaveBeenCalled()
    }
  )

  it.each(['root', 'sheet', 'row', 'coercion', 'inherited', 'sparse', 'symbol'])(
    'rejects hostile %s own-data without executing a getter or coercion',
    async (kind) => {
      let executions = 0
      const input = await snapshot(),
        writer = vi.spyOn(ExcelJS.Workbook.prototype, 'addWorksheet'),
        getter = () => {
          executions++
          return 'malicious'
        }
      let hostile: unknown = input
      if (kind === 'root') Object.defineProperty(input, 'source', { enumerable: true, get: getter })
      else if (kind === 'sheet') Object.defineProperty(input.sheets[0], 'name', { enumerable: true, get: getter })
      else if (kind === 'row') Object.defineProperty(input.sheets[0]!.rows[0], '0', { enumerable: true, get: getter })
      else if (kind === 'coercion')
        Object.defineProperty(input.sheets[0]!.rows[0], '0', {
          enumerable: true,
          value: { toString: getter, valueOf: getter, [Symbol.toPrimitive]: getter }
        })
      else if (kind === 'inherited') hostile = Object.create(input)
      else if (kind === 'sparse') delete input.sheets[0]!.rows[0]![0]
      else Object.defineProperty(input, Symbol('hidden'), { enumerable: true, value: 'not JSON' })
      await expect(exportCatalogSnapshotXlsx(hostile)).rejects.toThrow('invalid_catalog_export_snapshot')
      expect(executions).toBe(0)
      expect(writer).not.toHaveBeenCalled()
    }
  )

  it('rejects cells beyond the authoritative character limit before creating a workbook', async () => {
    const sheets = emptySheets()
    sheets[0]!.rows = [record('Products', { description: 'x'.repeat(CATALOG_EXPORT_MAX_CELL_CHARACTERS + 1) })]
    const input = await snapshot(sheets),
      writer = vi.spyOn(ExcelJS.Workbook.prototype, 'addWorksheet')
    await expect(exportCatalogSnapshotXlsx(input)).rejects.toThrow('invalid_catalog_export_snapshot')
    expect(writer).not.toHaveBeenCalled()
  })

  it('rejects aggregate UTF-8 payload beyond 8 MB even when each cell remains within its character bound', async () => {
    const sheets = emptySheets(),
      row = record('Products', { description: '界'.repeat(9500) })
    sheets[0]!.rows = Array.from({ length: 150 }, () => [...row])
    const input = await snapshot(sheets),
      writer = vi.spyOn(ExcelJS.Workbook.prototype, 'addWorksheet')
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeGreaterThan(CATALOG_EXPORT_MAX_BYTES)
    expect(row.every((value) => value.length <= CATALOG_EXPORT_MAX_CELL_CHARACTERS)).toBe(true)
    await expect(exportCatalogSnapshotXlsx(input)).rejects.toThrow('invalid_catalog_export_snapshot')
    expect(writer).not.toHaveBeenCalled()
  })

  it('rejects more than 10,000 entity rows before creating a workbook', async () => {
    const sheets = emptySheets(),
      row = record('Inventory')
    sheets[2]!.rows = Array.from({ length: CATALOG_EXPORT_MAX_ROWS + 1 }, () => [...row])
    const input = await snapshot(sheets),
      writer = vi.spyOn(ExcelJS.Workbook.prototype, 'addWorksheet')
    await expect(exportCatalogSnapshotXlsx(input)).rejects.toThrow('invalid_catalog_export_snapshot')
    expect(writer).not.toHaveBeenCalled()
  })

  it('accepts exactly 10,000 entity rows using the real codec, not the old 1,000-array own-data limit', async () => {
    const sheets = emptySheets(),
      row = record('Inventory', { variant_id: variantId, physical_quantity: 0, blocked_quantity: 0, version: 1 })
    sheets[2]!.rows = Array.from({ length: CATALOG_EXPORT_MAX_ROWS }, () => [...row])
    const input = await snapshot(sheets),
      bytes = await exportCatalogSnapshotXlsx(input),
      workbook = await read(bytes),
      sheet = workbook.getWorksheet('Inventory')!
    expect(bytes.byteLength).toBeLessThanOrEqual(CATALOG_EXPORT_MAX_BYTES)
    expect(sheet.actualRowCount).toBe(CATALOG_EXPORT_MAX_ROWS + 1)
    expect(sheet.getRow(CATALOG_EXPORT_MAX_ROWS + 1).getCell(1).value).toBe(variantId)
  })
})
