import {
  CATALOG_TABULAR_MAX_BYTES,
  CATALOG_TABULAR_MAX_CELL_CHARACTERS,
  CATALOG_TABULAR_MAX_ROWS,
  catalogTabularColumns,
  assertCatalogTabularFileSize,
  catalogTabularRecordsFromRows,
  parseCatalogCsv,
  validateCatalogRecords,
  type CatalogTabularRecord,
  type CatalogTabularValidation
} from '../../shared/catalog-tabular-core'
import { CatalogXlsxArchiveError, inspectCatalogXlsxArchive } from '../../shared/catalog-xlsx-archive'

const INVALID_FILE_MESSAGE = 'El archivo no coincide con el formato de catálogo compatible.'
const TOO_LARGE_MESSAGE = 'El archivo supera los límites permitidos para la importación de catálogo.'

function failed(
  code: 'invalid_catalog_file' | 'catalog_file_too_large',
  budget?: 'file' | 'expanded'
): CatalogTabularValidation {
  const message =
    budget === 'file'
      ? 'El archivo CSV o XLSX comprimido supera los 20 MB permitidos. 0 filas aceptadas; no se ha importado ninguna parte.'
      : budget === 'expanded'
        ? 'El contenido descomprimido del XLSX supera los 100 MB permitidos, aunque el archivo comprimido ocupe menos de 20 MB. 0 filas aceptadas; no se ha importado ninguna parte.'
        : code === 'catalog_file_too_large'
          ? TOO_LARGE_MESSAGE
          : INVALID_FILE_MESSAGE
  return {
    valid: false,
    issues: [{ code, message }],
    dataset: { products: [], variants: [], assets: [], media: [] },
    summary: { rows: 0, products: 0, variants: 0, assets: 0, documents: 0 }
  }
}

function cellText(value: unknown): string {
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const cellValue = value as Record<string, unknown>
    if ('formula' in cellValue || 'sharedFormula' in cellValue) {
      throw new Error('formula')
    }
    if ('hyperlink' in cellValue || 'text' in cellValue || 'richText' in cellValue) {
      throw new Error('unsupported_cell')
    }
    throw new Error('unsupported_cell')
  }
  return String(value)
}

function isSizeBudgetError(error: unknown): boolean {
  if (error instanceof CatalogXlsxArchiveError) return error.code === 'catalog_file_too_large'
  const message = error instanceof Error ? error.message : ''
  return /20 MB|100 MB|entry limit|25000 row|row limit|cell limit/i.test(message)
}

/** Decode locally through the same guarded parser used by file inspection.
 * Structurally invalid files never expose partial records. Semantic issues stay
 * available alongside the decoded source rows for the governed intake preview. */
export async function decodeCatalogImportFile(
  bytes: Uint8Array,
  format: 'csv' | 'xlsx'
): Promise<{ records: CatalogTabularRecord[]; validation: CatalogTabularValidation }> {
  const failure = (code: 'invalid_catalog_file' | 'catalog_file_too_large', budget?: 'file' | 'expanded') => ({
    records: [],
    validation: failed(code, budget)
  })
  const decoded = (records: CatalogTabularRecord[]) => ({ records, validation: validateCatalogRecords(records) })
  if (!(bytes instanceof Uint8Array)) return failure('invalid_catalog_file')
  if (bytes.byteLength > CATALOG_TABULAR_MAX_BYTES) return failure('catalog_file_too_large', 'file')
  if (!bytes.byteLength) return failure('invalid_catalog_file')

  try {
    if (format === 'csv') return decoded(parseCatalogCsv(bytes))
    if (format !== 'xlsx') return failure('invalid_catalog_file')

    assertCatalogTabularFileSize(bytes)
    inspectCatalogXlsxArchive(bytes)
    const ExcelJS = (await import('exceljs')).default
    const workbook = new ExcelJS.Workbook()
    const archiveBytes = bytes.slice().buffer as ArrayBuffer
    await workbook.xlsx.load(archiveBytes as never)
    if (workbook.worksheets.length !== 1) throw new Error('worksheet_count')

    const worksheet = workbook.worksheets[0]!
    const rowLimit = CATALOG_TABULAR_MAX_ROWS + 1
    if (worksheet.actualColumnCount > catalogTabularColumns.length) {
      throw new Error('catalog_column_limit')
    }
    if (worksheet.rowCount > rowLimit || worksheet.actualRowCount > rowLimit) {
      throw new Error('catalog row limit')
    }

    const rows: string[][] = []
    worksheet.eachRow({ includeEmpty: true }, (row) => {
      if (row.number > rowLimit) throw new Error('catalog row limit')
      if (row.cellCount > catalogTabularColumns.length) throw new Error('catalog_column_limit')
      const values = catalogTabularColumns.map((_, index) => {
        const value = cellText(row.getCell(index + 1).value)
        if (value.length > CATALOG_TABULAR_MAX_CELL_CHARACTERS) throw new Error('catalog cell limit')
        return value
      })
      rows.push(values)
    })
    return decoded(catalogTabularRecordsFromRows(rows))
  } catch (error) {
    if (
      error instanceof CatalogXlsxArchiveError &&
      error.code === 'catalog_file_too_large' &&
      error.message === 'Catalog XLSX expands beyond the 100 MB limit'
    )
      return failure('catalog_file_too_large', 'expanded')
    return failure(isSizeBudgetError(error) ? 'catalog_file_too_large' : 'invalid_catalog_file')
  }
}

/** Inspect an existing legacy catalog file locally; this never sends or applies data. */
export async function inspectCatalogImportFile(
  bytes: Uint8Array,
  format: 'csv' | 'xlsx'
): Promise<CatalogTabularValidation> {
  return (await decodeCatalogImportFile(bytes, format)).validation
}
