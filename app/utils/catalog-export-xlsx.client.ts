import { CATALOG_EXPORT_MAX_BYTES, verifyCatalogExportSnapshot } from '~~/shared/catalog-export'

/** In-memory, read-only XLSX. The UI imports this module only on the client.
 * Validate/copy the observed server snapshot before loading the browser codec;
 * original typed record_json and the verified server hash remain unchanged. */
export async function exportCatalogSnapshotXlsx(input: unknown): Promise<Uint8Array> {
  const snapshot = await verifyCatalogExportSnapshot(input).catch(() => {
    throw Error('invalid_catalog_export_snapshot')
  })
  let bytes: Uint8Array | undefined
  try {
    const ExcelJS = (await import('exceljs')).default,
      workbook = new ExcelJS.Workbook()
    workbook.creator = 'NETECO'
    workbook.created = new Date(snapshot.observedAt)
    workbook.modified = workbook.created
    function appendSheet(name: string, columns: readonly string[], rows: readonly (readonly string[])[]) {
      const sheet = workbook.addWorksheet(name)
      sheet.views = [{ state: 'frozen', ySplit: 1 }]
      sheet.addRow([...columns])
      for (const row of rows) sheet.addRow([...row])
      for (let index = 0; index < columns.length; index++) {
        const column = sheet.getColumn(index + 1)
        let width = columns[index]!.length
        for (const row of rows) width = Math.max(width, row[index]!.length)
        column.width = Math.min(64, Math.max(12, width + 2))
        column.numFmt = '@'
        column.alignment = { vertical: 'top', wrapText: true }
      }
      sheet.getRow(1).font = { bold: true }
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: columns.length } }
    }
    for (const sheet of snapshot.sheets) appendSheet(sheet.name, sheet.columns, sheet.rows)
    appendSheet(
      'Manifest',
      ['Field', 'Value'],
      [
        ['source', snapshot.source],
        ['profile', snapshot.profile],
        ['snapshotId', snapshot.snapshotId],
        ['observedAt', snapshot.observedAt],
        ['filters', JSON.stringify(snapshot.filters)],
        ['counts', JSON.stringify(snapshot.counts)],
        ['hash', snapshot.hash],
        ['nulls', 'Blank display cells may be null or empty; record_json preserves the original value.'],
        ['purpose', 'Read-only catalogue snapshot, not an import or live/publication authority.']
      ]
    )
    const buffer = await workbook.xlsx.writeBuffer()
    if (buffer.byteLength <= CATALOG_EXPORT_MAX_BYTES) bytes = new Uint8Array(buffer).slice()
  } catch {
    throw Error('catalog_export_xlsx_unavailable')
  }
  if (!bytes) throw Error('catalog_export_xlsx_too_large')
  return bytes
}
