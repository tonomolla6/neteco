import { describe, expect, it, vi } from 'vitest'
import {
  CatalogImportJobError,
  planCatalogImportJob,
  catalogImportJobSchema,
  catalogImportJobCreateInputSchema,
  catalogImportJobPageInputSchema,
  catalogImportJobFinalizeInputSchema
} from '../../shared/catalog-import-job'
import { catalogTabularColumns, type CatalogTabularRecord } from '../../shared/catalog-tabular-core'

const empty = () => Object.fromEntries(catalogTabularColumns.map((key) => [key, ''])) as CatalogTabularRecord
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
const id = '00540000-0000-4000-8000-000000000001'
const job = () => ({
  source: 'cloudflare',
  outcome: 'job',
  id,
  status: 'uploading',
  createdAt: '2026-10-04T10:00:00Z',
  expiresAt: '2026-10-04T11:00:00Z',
  totalPages: 3,
  receivedPages: 0,
  recordCount: 1001,
  hash: null,
  counts: { products: 0, variants: 0, assets: 0, mappings: 0 },
  policy: { publication: 'draft_only', media: 'pending_verification', priceStock: 'authorized_initialization' }
})
function failure(value: unknown, code: string) {
  try {
    planCatalogImportJob(value)
    throw new Error('expected_failure')
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogImportJobError)
    expect(error).toMatchObject({ code })
    expect((error as Error).message).not.toContain('PRIVATE')
  }
}
describe('complete catalog import job planner', () => {
  it('retains every record in stable sequential pages beyond a single500-row request', () => {
    const rows = Array.from({ length: 1001 }, (_, index) => ({ ...empty(), sku: String(index) }))
    const result = planCatalogImportJob(rows)
    expect(result.recordCount).toBe(1001)
    expect(result.pages.map((page) => page.index)).toEqual([0, 1, 2])
    expect(result.pages.map((page) => page.records.length)).toEqual([500, 500, 1])
    expect(result.pages.flatMap((page) => page.records)).toEqual(rows)
    expect(result.totalBytes).toBe(result.pages.reduce((sum, page) => sum + page.byteLength, 0))
    for (const page of result.pages) expect(page.byteLength).toBe(bytes({ records: page.records }))
  })
  it('accepts25000 records, preserves repeated shared references and does not mutate callers', () => {
    const shared = Object.freeze(empty())
    const rows = Object.freeze(Array.from({ length: 25000 }, () => shared))
    const result = planCatalogImportJob(rows)
    expect(result.recordCount).toBe(25000)
    expect(result.pages).toHaveLength(50)
    expect(result.pages.flatMap((page) => page.records)).toHaveLength(25000)
    expect(result.pages[0]!.records[0]).toEqual(shared)
    expect(result.pages[0]!.records[0]).not.toBe(shared)
    result.pages[0]!.records[0]!.sku = 'changed'
    expect(shared.sku).toBe('')
    expect(result.pages[0]!.records[1]!.sku).toBe('')
    failure(Array.from({ length: 25001 }, empty), 'catalog_row_limit')
  })
  it('splits on exactUTF8 JSON bytes, accounting for escapes, commas and payload envelope', () => {
    const row = empty()
    for (const key of catalogTabularColumns.slice(0, 20)) row[key] = 'á'.repeat(20000)
    row.sku = 'emoji😀,quote"backslash\\newline\n'
    const result = planCatalogImportJob([row, row, row])
    expect(result.pages).toHaveLength(3)
    for (const page of result.pages) {
      expect(page.byteLength).toBe(bytes({ records: page.records }))
      expect(page.byteLength).toBeLessThanOrEqual(900000)
    }
    const exact = empty()
    for (const key of catalogTabularColumns.slice(0, 44)) exact[key] = 'x'.repeat(20000)
    exact[catalogTabularColumns[44]!] = 'x'.repeat(900000 - bytes({ records: [exact] }))
    const page = planCatalogImportJob([exact]).pages[0]!
    expect(page.byteLength).toBe(900000)
    exact[catalogTabularColumns[44]!] += 'x'
    failure([exact], 'catalog_record_too_large')
  })
  it('rejects oversized rows rather than dropping, truncating or relaxing71-column contract', () => {
    const huge = empty()
    for (const key of catalogTabularColumns) huge[key] = 'x'.repeat(20000)
    failure([empty(), huge, empty()], 'catalog_record_too_large')
    failure([{ ...empty(), sku: 'PRIVATE'.repeat(4000) }], 'invalid_catalog_records')
    failure([{ ...empty(), sku: 1 }], 'invalid_catalog_records')
    failure([{ ...empty(), extra: '' }], 'invalid_catalog_records')
    const missing = empty()
    delete (missing as Partial<CatalogTabularRecord>).sku
    failure([missing], 'invalid_catalog_records')
    failure([], 'invalid_catalog_records')
    failure({}, 'invalid_catalog_records')
  })

  it('bounds expanded staged JSON separately from the20MB original-file budget', () => {
    const row = empty()
    for (const key of catalogTabularColumns.slice(0, 40)) row[key] = 'x'.repeat(20000)
    const result = planCatalogImportJob(Array.from({ length: 100 }, () => row))
    expect(result.totalBytes).toBeGreaterThan(20_000_000)
    expect(result.totalBytes).toBeLessThanOrEqual(100_000_000)
    expect(result.pages).toHaveLength(100)
    failure(
      Array.from({ length: 125 }, () => row),
      'catalog_job_too_large'
    )
  })
  it('rejects root/nested descriptors, prototypes, sparse arrays and cycles without invoking getters', () => {
    const getter = vi.fn(() => {
      throw new Error('PRIVATE getter ran')
    })
    failure(Object.defineProperty([empty()], '0', { enumerable: true, get: getter }), 'invalid_catalog_records')
    failure([Object.defineProperty(empty(), 'sku', { enumerable: true, get: getter })], 'invalid_catalog_records')
    failure(new Array(2), 'invalid_catalog_records')
    failure(Object.assign([empty()], { extra: true }), 'invalid_catalog_records')
    failure(Object.setPrototypeOf([empty()], null), 'invalid_catalog_records')
    failure([Object.assign(Object.create({ inherited: 'PRIVATE' }), empty())], 'invalid_catalog_records')
    failure([Object.defineProperty(empty(), 'sku', { enumerable: false, value: '' })], 'invalid_catalog_records')
    failure([JSON.parse(JSON.stringify(empty()).slice(0, -1) + ',"__proto__":{}}')], 'invalid_catalog_records')
    failure(Object.assign([empty()], { [Symbol('private')]: true }), 'invalid_catalog_records')
    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    failure(cyclic, 'invalid_catalog_records')
    expect(getter).not.toHaveBeenCalled()
  })
})
describe('strict catalog job DTO and input boundaries', () => {
  it('accepts canonical jobs with zero counts and ordered canonical instants', () => {
    expect(catalogImportJobSchema.safeParse(job()).success).toBe(true)
    for (const status of ['ready', 'applied', 'reverted'])
      expect(
        catalogImportJobSchema.safeParse({
          ...job(),
          status,
          receivedPages: 3,
          hash: 'a'.repeat(64),
          counts: { products: 1001, variants: 1001, assets: 1001, mappings: 1001 }
        }).success
      ).toBe(true)
    for (const patch of [
      { receivedPages: 4 },
      { recordCount: 25001 },
      { totalPages: 1001 },
      { hash: 'bad' },
      { expiresAt: job().createdAt },
      { createdAt: '2026-02-30T10:00:00Z' },
      { status: 'expired' },
      { counts: { ...job().counts, assets: -1 } },
      { policy: { ...job().policy, publication: 'published' } }
    ])
      expect(catalogImportJobSchema.safeParse({ ...job(), ...patch }).success).toBe(false)
  })

  it('rejects inconsistent job states and missing or null count fields', () => {
    expect(catalogImportJobSchema.safeParse({ ...job(), hash: 'a'.repeat(64) }).success).toBe(false)
    expect(
      catalogImportJobSchema.safeParse({ ...job(), counts: { products: 1, variants: 0, assets: 0, mappings: 0 } })
        .success
    ).toBe(false)
    const ready = {
      ...job(),
      status: 'ready',
      receivedPages: 3,
      hash: 'a'.repeat(64),
      counts: { products: 1, variants: 1, assets: 1, mappings: 1 }
    }
    for (const patch of [
      { receivedPages: 2 },
      { hash: null },
      { counts: { ...ready.counts, assets: 0 } },
      { counts: { ...ready.counts, products: 1002 } }
    ])
      expect(catalogImportJobSchema.safeParse({ ...ready, ...patch }).success).toBe(false)
    for (const key of Object.keys(ready.counts)) {
      const counts = Object.fromEntries(Object.entries(ready.counts).filter(([field]) => field !== key))
      expect(catalogImportJobSchema.safeParse({ ...ready, counts }).success).toBe(false)
      expect(catalogImportJobSchema.safeParse({ ...ready, counts: { ...ready.counts, [key]: null } }).success).toBe(
        false
      )
    }
    expect(catalogImportJobPageInputSchema.safeParse({ index: 0 }).success).toBe(false)
    expect(catalogImportJobCreateInputSchema.safeParse({ totalPages: 1 }).success).toBe(false)
    expect(catalogImportJobCreateInputSchema.safeParse({ recordCount: 1 }).success).toBe(false)
  })
  it('bounds and strictly validates create, page and finalize inputs', () => {
    expect(catalogImportJobCreateInputSchema.parse({ totalPages: 1000, recordCount: 25000 })).toEqual({
      totalPages: 1000,
      recordCount: 25000
    })
    expect(catalogImportJobPageInputSchema.safeParse({ index: 0, records: [empty()] }).success).toBe(true)
    expect(
      catalogImportJobPageInputSchema.safeParse({ index: 999, records: Array.from({ length: 500 }, empty) }).success
    ).toBe(true)
    for (const value of [
      { index: 1000, records: [empty()] },
      { index: -1, records: [empty()] },
      { index: 0, records: [] },
      { index: 0, records: Array.from({ length: 501 }, empty) }
    ])
      expect(catalogImportJobPageInputSchema.safeParse(value).success).toBe(false)
    expect(catalogImportJobFinalizeInputSchema.parse({ reason: '  Importación autorizada  ' })).toEqual({
      reason: 'Importación autorizada'
    })
    for (const reason of ['x', 'x'.repeat(501), 'control\nreason'])
      expect(catalogImportJobFinalizeInputSchema.safeParse({ reason }).success).toBe(false)
  })
  it('rejects extras and unsafe own data at every DTO boundary without running accessors', () => {
    const cases = [
      { schema: catalogImportJobSchema, value: job() },
      { schema: catalogImportJobCreateInputSchema, value: { totalPages: 1, recordCount: 1 } },
      { schema: catalogImportJobPageInputSchema, value: { index: 0, records: [empty()] } },
      { schema: catalogImportJobFinalizeInputSchema, value: { reason: 'Approved' } }
    ]
    const getter = vi.fn(() => 'PRIVATE')
    for (const { schema, value } of cases) {
      expect(schema.safeParse({ ...value, now: '2026-10-04T10:00:00Z' }).success).toBe(false)
      expect(schema.safeParse(Object.assign(Object.create({ inherited: true }), value)).success).toBe(false)
      expect(
        schema.safeParse(Object.defineProperty({ ...value }, 'unexpected', { enumerable: true, get: getter })).success
      ).toBe(false)
      expect(schema.safeParse(JSON.parse(JSON.stringify(value).slice(0, -1) + ',"__proto__":{}}')).success).toBe(false)
    }
    expect(catalogImportJobSchema.safeParse({ ...job(), counts: { ...job().counts, extra: 1 } }).success).toBe(false)
    expect(catalogImportJobSchema.safeParse({ ...job(), policy: { ...job().policy, extra: true } }).success).toBe(false)
    expect(getter).not.toHaveBeenCalled()
  })
})
