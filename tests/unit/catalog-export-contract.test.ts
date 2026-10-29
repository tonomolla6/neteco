import { describe, expect, it } from 'vitest'
import {
  CATALOG_EXPORT_COLUMNS,
  CATALOG_EXPORT_SHEET_NAMES,
  catalogExportFiltersSchema,
  catalogExportHash,
  catalogExportOwnJson,
  catalogExportSnapshotSchema,
  exportCatalogSnapshotCsv,
  verifyCatalogExportSnapshot,
  type CatalogExportSnapshot
} from '../../shared/catalog-export'
import { parseCatalogCsvCells } from '../../shared/catalog-tabular-core'

async function empty(): Promise<CatalogExportSnapshot> {
  const snapshot = catalogExportSnapshotSchema.parse({
    source: 'cloudflare',
    profile: 'native_catalog_snapshot_v1',
    snapshotId: '10000000-0000-4000-8000-000000000001',
    observedAt: '2026-10-03T21:00:00Z',
    filters: {},
    counts: { products: 0, variants: 0, inventory: 0, prices: 0, media: 0, references: 0 },
    sheets: CATALOG_EXPORT_SHEET_NAMES.map((name) => ({ name, columns: [...CATALOG_EXPORT_COLUMNS[name]], rows: [] })),
    hash: '0'.repeat(64)
  })
  snapshot.hash = await catalogExportHash(snapshot)
  return snapshot
}
describe('native catalogue export contract', () => {
  it('keeps pending imported references distinct from verified Media and preserves their original nested JSON and composite identity', async () => {
    const snapshot = await empty(),
      metadata = ' { "approvalClaim": true, "original": "á 🚀" } '
    const association = {
      product_id: 'native-product',
      variant_id: null,
      asset_id: 'native-asset',
      role: 'primary',
      version: 'v,"1',
      sort_order: 0
    }
    const references = [
      {
        kind: 'imported_asset',
        id: 'native-asset',
        name: '',
        data: { id: 'native-asset', metadata, source_url: null, rights_status: 'pending', quarantine_status: 'pending' }
      },
      {
        kind: 'imported_media',
        id: JSON.stringify([
          association.product_id,
          association.variant_id,
          association.asset_id,
          association.role,
          association.version
        ]),
        name: association.role,
        data: association
      }
    ]
    const sheet = snapshot.sheets[5]!
    sheet.rows = references.map((record) => [record.kind, record.id, record.name, JSON.stringify(record)])
    snapshot.counts.references = 2
    snapshot.hash = await catalogExportHash(snapshot)
    expect(await verifyCatalogExportSnapshot(snapshot)).toEqual(snapshot)
    expect(snapshot.profile).toBe('native_catalog_snapshot_v1')
    expect(snapshot.sheets[4]!.rows).toEqual([])
    const csv = parseCatalogCsvCells(new TextDecoder().decode(await exportCatalogSnapshotCsv(snapshot)))
    expect(csv.filter((row) => row[0] === 'References').map((row) => row[2])).toEqual(sheet.rows.map((row) => row[3]))
    expect(JSON.parse(csv[2]![2]!).data.metadata).toBe(metadata)
    expect(JSON.parse(csv[3]![2]!).data.variant_id).toBeNull()
    const changed = structuredClone(snapshot)
    changed.sheets[5]!.rows[0]![3] = JSON.stringify({
      ...references[0],
      data: { ...references[0]!.data, rights_status: 'approved' }
    })
    await expect(verifyCatalogExportSnapshot(changed)).rejects.toThrow('invalid_catalog_export_hash')
  })
  it('verifies every entity and manifest, rejects hash/content tampering', async () => {
    const snapshot = await empty()
    expect(await verifyCatalogExportSnapshot(snapshot)).toEqual(snapshot)
    await expect(verifyCatalogExportSnapshot({ ...snapshot, observedAt: '2026-10-03T21:01:00Z' })).rejects.toThrow(
      'invalid_catalog_export_hash'
    )
    await expect(verifyCatalogExportSnapshot({ ...snapshot, source: 'node' })).rejects.toThrow()
    const cells = parseCatalogCsvCells(new TextDecoder().decode(await exportCatalogSnapshotCsv(snapshot)))
    expect(cells[0]).toEqual(['sheet', 'row_index', 'record_json'])
    expect(JSON.parse(cells[1]![2]!)).toMatchObject({
      hash: snapshot.hash,
      source: 'cloudflare',
      counts: snapshot.counts
    })
  })
  it('preserves typed null and blank fields and formula-like text without applying import restrictions', async () => {
    const snapshot = await empty(),
      record: Record<string, unknown> = {}
    for (const column of CATALOG_EXPORT_COLUMNS.Products) if (column !== 'record_json') record[column] = null
    Object.assign(record, {
      id: 'native-id-no-uuid',
      name: '=SUM(1,2)',
      description: '',
      attributes: JSON.stringify([{ k: 'a', v: 'ñ"\n' }]),
      status: 'hidden'
    })
    const row = CATALOG_EXPORT_COLUMNS.Products.map((column) =>
      column === 'record_json' ? JSON.stringify(record) : record[column] === null ? '' : String(record[column])
    )
    snapshot.sheets[0]!.rows = [row]
    snapshot.counts.products = 1
    snapshot.hash = await catalogExportHash(snapshot)
    const cells = parseCatalogCsvCells(new TextDecoder().decode(await exportCatalogSnapshotCsv(snapshot)))
    expect(cells[2]![0]).toBe('Products')
    expect(JSON.parse(cells[2]![2]!)).toEqual(record)
    expect(JSON.parse(cells[2]![2]!)).toMatchObject({ name: '=SUM(1,2)', description: '', short_description: null })
    const tampered = structuredClone(snapshot)
    tampered.sheets[0]!.rows[0]![0] = 'fabricated-id'
    expect(catalogExportSnapshotSchema.safeParse(tampered).success).toBe(false)
  })
  it.each([
    { q: 'a', page: 1 },
    { category: '7' },
    { category: 0 },
    { status: 'unknown' },
    { q: 'x\ny' },
    { q: 'x'.repeat(161) },
    { instant: '2026-10-03T00:00:00Z' },
    { perPage: 100 }
  ])('rejects extra, oversized or coerced filters %j', (filters) => {
    expect(catalogExportFiltersSchema.safeParse(filters).success).toBe(false)
  })
  it('accepts literal wildcard searches without allowing SQL/API fields', () => {
    expect(catalogExportFiltersSchema.parse({ q: '  %_Á  ', category: 7, status: 'draft' })).toEqual({
      q: '%_Á',
      category: 7,
      status: 'draft'
    })
  })
  it('rejects getters, prototype hooks, sparse arrays and cycles without reading them', () => {
    let calls = 0
    const getter = Object.defineProperty({}, 'q', {
      enumerable: true,
      get() {
        calls++
        return 'stolen'
      }
    })
    expect(catalogExportFiltersSchema.safeParse(getter).success).toBe(false)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    for (const bad of [
      cyclic,
      new Date(),
      new Array(2),
      Object.assign([], { extra: 1 }),
      {
        toJSON() {
          calls++
        }
      }
    ])
      expect(() => catalogExportOwnJson(bad)).toThrow()
    expect(calls).toBe(0)
  })
  it('rejects incomplete/reordered/mismatched sheets instead of producing a partial file', async () => {
    const snapshot = await empty()
    expect(catalogExportSnapshotSchema.safeParse({ ...snapshot, sheets: snapshot.sheets.slice(0, 5) }).success).toBe(
      false
    )
    expect(catalogExportSnapshotSchema.safeParse({ ...snapshot, sheets: [...snapshot.sheets].reverse() }).success).toBe(
      false
    )
    expect(
      catalogExportSnapshotSchema.safeParse({ ...snapshot, counts: { ...snapshot.counts, variants: 1 } }).success
    ).toBe(false)
    expect(() => catalogExportOwnJson({ text: 'x'.repeat(20001) })).toThrow('catalog_export_too_large')
  })
})
