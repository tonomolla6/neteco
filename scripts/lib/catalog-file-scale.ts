import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { decodeCatalogImportFile } from '../../app/utils/catalog-import-file.client'
import { exportCatalogXlsx } from '../../server/services/catalog-tabular'
import { csvCell } from '../../server/utils/csv'
import { catalogRecord } from '../../tests/support/catalog-tabular-fixture'
import {
  CATALOG_TABULAR_MAX_BYTES,
  CATALOG_TABULAR_MAX_ROWS,
  catalogTabularColumns,
  exportCatalogCsv,
  type CatalogTabularRecord
} from '../../shared/catalog-tabular-core'
import { CatalogXlsxArchiveError, inspectCatalogXlsxArchive } from '../../shared/catalog-xlsx-archive'
import {
  CATALOG_TYPED_ATTRIBUTE_KINDS,
  catalogTypedAttributeDefinitionSchema
} from '../../shared/catalog-typed-attributes'
import { catalogImportScaleTypedValues } from './catalog-import-scale-typed-fixture'

// Codec-only closed definitions: these UUIDs have no asserted D1 existence,
// grant or public reference eligibility. No definitions are imported/created.
const typedDefinitions = [
  ['text', { maxLength: 500 }],
  ['number', { precision: 2 }],
  ['unit', { precision: 2, units: ['l'] }],
  ['boolean', {}],
  ['list', { options: [{ code: 'blue', label: 'Azul', status: 'active' }] }],
  ['reference', {}]
].map(([kind, config], index) =>
  catalogTypedAttributeDefinitionSchema.parse({
    id: `a4000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    categoryId: 1,
    categoryUuid: catalogRecord().category_id,
    code: `codec_${kind}`,
    label: `Codec sintético ${kind}`,
    revision: 1,
    status: 'active',
    kind,
    config
  })
)
const syntheticReferenceId = 'a5000000-0000-4000-8000-000000000001'

export function catalogFileScaleRecords(count: number): CatalogTabularRecord[] {
  assert(Number.isSafeInteger(count) && count > 0 && count <= CATALOG_TABULAR_MAX_ROWS, 'Invalid scale row count')
  const base = catalogRecord()
  return Array.from({ length: count }, (_, index) => {
    const suffix = (index + 1).toString(16).padStart(12, '0'),
      product = `a1000000-0000-4000-8000-${suffix}`,
      variant = `a2000000-0000-4000-8000-${suffix}`,
      asset = `a3000000-0000-4000-8000-${suffix}`
    return {
      ...base,
      product_id: product,
      variant_id: variant,
      asset_id: asset,
      product_legacy_id: String(1_000_001 + index),
      variant_legacy_id: String(2_000_001 + index),
      product_name: `Escala ${index} · jabón Ñ 🧼`,
      product_slug: `escala-${index}`,
      short_description: 'Prueba sintética, con coma y\nnueva línea segura.',
      description: 'Evidencia sintética de catálogo completo, nunca datos reales de producción.',
      product_usage: '',
      product_series: '',
      sku: `SCALE-${index}`,
      ean: '',
      gtin: '',
      mpn: `SCALE-${index}`,
      identifier_exception_reason: 'Synthetic MPN only',
      asset_storage_key: `clean/${asset}.png`,
      asset_source_url: `/media/${asset}`,
      asset_checksum_sha256: createHash('sha256').update(asset).digest('hex'),
      product_attributes_json: JSON.stringify({
        ...JSON.parse(base.product_attributes_json),
        image: `/media/${asset}`,
        etiqueta: `Ñ 🧼 "fila ${index}"`,
        attrs: [{ k: 'Nota legacy', v: 'Conservar Ñ 🧼' }],
        typed: catalogImportScaleTypedValues(typedDefinitions, syntheticReferenceId, index)
      }),
      asset_metadata_json: JSON.stringify({ language: 'es', provenance: 'synthetic', etiqueta: `fila ${index} · café` })
    }
  })
}

/** Exact existing exporter envelope, measured without materialising an oversized CSV. */
export function catalogFileScaleCsvBytes(records: CatalogTabularRecord[]): number {
  const encoder = new TextEncoder()
  let bytes = encoder.encode(`\uFEFF${catalogTabularColumns.map(csvCell).join(',')}\r\n`).byteLength
  for (const record of records)
    bytes += encoder.encode(
      `${catalogTabularColumns.map((column) => csvCell(record[column])).join(',')}\r\n`
    ).byteLength
  return bytes
}

type Phase = (name: string, metrics?: Record<string, number>) => void
export interface CatalogFileScaleFormatEvidence {
  outcome: 'passed' | 'rejected-size' | 'rejected'
  bytes: number
  rows: number
  issueCodes: string[]
  archiveFailure?: { code: string; message: string }
  samples?: number[]
}
export async function auditCatalogFileScale(count: number, phase: Phase = () => undefined) {
  const started = performance.now(),
    timings: Record<string, number> = {}
  async function timed<T>(name: string, operation: () => Promise<T>): Promise<T> {
    phase(name)
    const start = performance.now()
    try {
      return await operation()
    } finally {
      timings[name] = Math.round(performance.now() - start)
      phase(`${name}_finished`, { elapsedMs: timings[name] })
    }
  }
  const records = await timed('generate_records', async () => catalogFileScaleRecords(count))
  assert.equal(catalogTabularColumns.length, 71)
  const samples = [...new Set([0, Math.floor((count - 1) / 2), count - 1])]
  async function decode(bytes: Uint8Array, format: 'csv' | 'xlsx'): Promise<CatalogFileScaleFormatEvidence> {
    let archiveFailure: CatalogFileScaleFormatEvidence['archiveFailure']
    if (format === 'xlsx') {
      try {
        inspectCatalogXlsxArchive(bytes)
      } catch (error) {
        if (!(error instanceof CatalogXlsxArchiveError)) throw error
        archiveFailure = { code: error.code, message: error.message }
      }
    }
    const result = await timed(`decode_${format}`, () => decodeCatalogImportFile(bytes, format))
    const issueCodes = [...new Set(result.validation.issues.map((issue) => issue.code))]
    if (!result.validation.valid)
      return {
        outcome: issueCodes.includes('catalog_file_too_large') ? 'rejected-size' : 'rejected',
        bytes: bytes.byteLength,
        rows: result.records.length,
        issueCodes,
        ...(archiveFailure ? { archiveFailure } : {})
      }
    assert.equal(archiveFailure, undefined, 'Decoder must not bypass archive preflight')
    assert(bytes.byteLength <= CATALOG_TABULAR_MAX_BYTES)
    assert.equal(result.records.length, count)
    assert.deepEqual(result.validation.summary, {
      rows: count,
      products: count,
      variants: count,
      assets: count,
      documents: 0
    })
    for (const [index, record] of result.records.entries()) {
      assert.deepEqual(Object.keys(record), [...catalogTabularColumns], `Column mismatch at source row ${index}`)
      assert.deepEqual(record, records[index], `Roundtrip mismatch at source row ${index}`)
    }
    for (const index of samples) {
      assert.deepEqual(
        JSON.parse(result.records[index]!.product_attributes_json),
        JSON.parse(records[index]!.product_attributes_json)
      )
      assert.deepEqual(
        JSON.parse(result.records[index]!.asset_metadata_json),
        JSON.parse(records[index]!.asset_metadata_json)
      )
    }
    return { outcome: 'passed', bytes: bytes.byteLength, rows: count, issueCodes, samples }
  }
  const csvBytes = await timed('measure_csv', async () => catalogFileScaleCsvBytes(records))
  phase('csv_measured', { bytes: csvBytes })
  const csv = await timed('export_csv', async (): Promise<CatalogFileScaleFormatEvidence> => {
    if (csvBytes > CATALOG_TABULAR_MAX_BYTES) {
      assert.throws(() => exportCatalogCsv(records), /^Error: Catalog export exceeds the 20 MB limit$/)
      return { outcome: 'rejected-size', bytes: csvBytes, rows: 0, issueCodes: ['catalog_file_too_large'] }
    }
    const bytes = exportCatalogCsv(records)
    assert.equal(bytes.byteLength, csvBytes)
    return decode(bytes, 'csv')
  })
  const xlsx = await timed('export_xlsx', async () => exportCatalogXlsx(records))
  phase('xlsx_exported', { bytes: xlsx.byteLength })
  const xlsxEvidence = await decode(xlsx, 'xlsx')
  return {
    source: 'local-file-decoder',
    rowCount: count,
    columns: 71,
    typed: {
      kinds: [...CATALOG_TYPED_ATTRIBUTE_KINDS],
      valuesPerRow: 6,
      totalValues: count * 6,
      referenceAuthorityAccepted: false
    },
    csv,
    xlsx: xlsxEvidence,
    fullFilePassed: xlsxEvidence.outcome === 'passed',
    timings,
    elapsedMs: Math.round(performance.now() - started),
    peakRssKiB: process.resourceUsage().maxRSS,
    scope:
      'Synthetic real CSV/XLSX export and guarded local decoding; no D1, HTTP, browser, publication or production acceptance.'
  }
}
