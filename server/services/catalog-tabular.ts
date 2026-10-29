import ExcelJS from 'exceljs'
import { PassThrough } from 'node:stream'
import {
  catalogTabularColumns,
  CATALOG_TABULAR_MAX_BYTES,
  assertCatalogTabularFileSize as assertFileSize,
  catalogTabularRecordsFromRows as recordsFromRows,
  assertCatalogTabularExportRecords as assertExportRecords,
  type CatalogTabularRecord
} from '../../shared/catalog-tabular-core'
import { inspectCatalogXlsxArchive } from '../../shared/catalog-xlsx-archive'

// Preserve the original Node service surface; XLSX remains Node-only.
export {
  CATALOG_TABULAR_MAX_BYTES,
  CATALOG_TABULAR_MAX_ROWS,
  CATALOG_TABULAR_MAX_CELL_CHARACTERS,
  catalogTabularColumns,
  parseCatalogCsv,
  exportCatalogCsv,
  validateCatalogRecords,
  type CatalogTabularColumn,
  type CatalogTabularRecord,
  type CatalogTabularIssue,
  type CatalogImportProduct,
  type CatalogImportVariant,
  type CatalogImportAsset,
  type CatalogImportMedia,
  type CatalogImportDataset,
  type CatalogTabularValidation
} from '../../shared/catalog-tabular-core'

function excelCell(value: ExcelJS.CellValue): string {
  if (value == null) return ''
  if (typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) throw new Error('Catalog XLSX formulas are not allowed')
    if (value instanceof Date) return value.toISOString()
    if ('hyperlink' in value || 'text' in value || 'richText' in value) {
      throw new Error('Catalog XLSX hyperlinks and rich text are not allowed')
    }
    throw new Error('Catalog XLSX contains an unsupported rich cell value')
  }
  return String(value)
}

function assertSafeXlsxArchive(bytes: Uint8Array) {
  inspectCatalogXlsxArchive(bytes)
}

export async function parseCatalogXlsx(bytes: Uint8Array): Promise<CatalogTabularRecord[]> {
  assertFileSize(bytes)
  assertSafeXlsxArchive(bytes)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new Uint8Array(bytes).buffer)
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

export async function exportCatalogXlsx(records: CatalogTabularRecord[]): Promise<Uint8Array> {
  assertExportRecords(records)
  // The document writer feeds XML strings through JSZip's independent 16KiB
  // UTF-8 encoding chunks, which can split a surrogate pair irreversibly. The
  // existing Node streaming writer uses Archiver and preserves original text.
  const chunks: Buffer[] = []
  const stream = new PassThrough()
  stream.on('data', (chunk: Buffer) => chunks.push(chunk))
  const timestamp = new Date('2026-08-13T12:00:00.000Z')
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream,
    useSharedStrings: true,
    useStyles: true
  })
  workbook.creator = 'NETECO'
  workbook.created = timestamp
  workbook.modified = timestamp
  const worksheet = workbook.addWorksheet('Catalog', { views: [{ state: 'frozen', ySplit: 1 }] })
  worksheet.addRow([...catalogTabularColumns]).commit()
  for (const record of records) {
    worksheet.addRow(catalogTabularColumns.map((column) => record[column])).commit()
  }
  await workbook.commit()
  const result = new Uint8Array(Buffer.concat(chunks))
  if (result.byteLength > CATALOG_TABULAR_MAX_BYTES) throw new Error('Catalog export exceeds the 20 MB limit')
  return result
}
