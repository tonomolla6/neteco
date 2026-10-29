import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { describe, expect, it, vi } from 'vitest'
import { exportCatalogCsv, exportCatalogXlsx, validateCatalogRecords } from '../../server/services/catalog-tabular'
import { catalogTabularColumns } from '../../shared/catalog-tabular-core'
import { inspectCatalogXlsxArchive } from '../../shared/catalog-xlsx-archive'
import { decodeCatalogImportFile, inspectCatalogImportFile } from '../../app/utils/catalog-import-file.client'
import { catalogFixtureIds, catalogRecord } from '../support/catalog-tabular-fixture'

function zip(entries: Array<{ name: string; flags?: number; expandedSize?: number }>, zip64 = false) {
  const encodedNames = entries.map(({ name }) => new TextEncoder().encode(name))
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let localOffset = 0
  let centralSize = 0

  entries.forEach((entry, index) => {
    const name = encodedNames[index]!
    const flags = entry.flags ?? 0
    const expandedSize = entry.expandedSize ?? 0
    const local = new Uint8Array(30 + name.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, flags, true)
    localView.setUint16(8, 0, true)
    localView.setUint32(18, 0, true)
    localView.setUint32(22, expandedSize, true)
    localView.setUint16(26, name.length, true)
    local.set(name, 30)
    localParts.push(local)

    const central = new Uint8Array(46 + name.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, flags, true)
    centralView.setUint16(10, 0, true)
    centralView.setUint32(24, expandedSize, true)
    centralView.setUint16(28, name.length, true)
    centralView.setUint32(42, localOffset, true)
    central.set(name, 46)
    centralParts.push(central)
    localOffset += local.length
    centralSize += central.length
  })

  const directoryOffset = localOffset
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, zip64 ? 0xffff : entries.length, true)
  endView.setUint16(10, zip64 ? 0xffff : entries.length, true)
  endView.setUint32(12, zip64 ? 0xffffffff : centralSize, true)
  endView.setUint32(16, zip64 ? 0xffffffff : directoryOffset, true)
  const output = new Uint8Array(localOffset + centralSize + end.length)
  let cursor = 0
  for (const part of [...localParts, ...centralParts, end]) {
    output.set(part, cursor)
    cursor += part.length
  }
  return output
}

function misadvertiseDeflatedEntrySize(bytes: Uint8Array): Uint8Array {
  const result = bytes.slice()
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength)
  let end = -1
  for (let offset = result.byteLength - 22; offset >= Math.max(0, result.byteLength - 65_557); offset -= 1) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === result.byteLength
    ) {
      end = offset
      break
    }
  }
  if (end < 0) throw new Error('test_fixture_missing_eocd')
  const entryCount = view.getUint16(end + 10, true)
  let offset = view.getUint32(end + 16, true)
  for (let index = 0; index < entryCount; index += 1) {
    const method = view.getUint16(offset + 10, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    if (method === 8) {
      const advertisedSize = view.getUint32(offset + 24, true)
      const localOffset = view.getUint32(offset + 42, true)
      view.setUint32(offset + 24, advertisedSize + 1, true)
      view.setUint32(localOffset + 22, advertisedSize + 1, true)
      if (view.getUint16(localOffset + 6, true) & 0x0008) {
        const descriptor =
          localOffset +
          30 +
          view.getUint16(localOffset + 26, true) +
          view.getUint16(localOffset + 28, true) +
          view.getUint32(offset + 20, true)
        const signatureBytes = view.getUint32(descriptor, true) === 0x08074b50 ? 4 : 0
        // Keep all advertised metadata consistent, including streamed ZIPs;
        // the actual deflate payload remains unchanged and must still fail.
        view.setUint32(descriptor + signatureBytes + 8, advertisedSize + 1, true)
      }
      return result
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  throw new Error('test_fixture_missing_deflated_entry')
}

function invalidCode(result: Awaited<ReturnType<typeof inspectCatalogImportFile>>, code: string) {
  expect(result.valid).toBe(false)
  expect(result.issues).toEqual([expect.objectContaining({ code })])
  expect(result.issues[0]?.message).not.toMatch(/attacker|https?:|formula|secret/i)
}

describe('local legacy catalog file inspection', () => {
  it.each([13_809, 13_810, 13_811])(
    'preserves supplementary Unicode around the Node XLSX exporter boundary, padding %s',
    async (padding) => {
      const record = { ...catalogRecord(), description: 'p'.repeat(padding) + '🧼' }
      const bytes = await exportCatalogXlsx([record])
      const archive = await JSZip.loadAsync(bytes)
      const xmlBytes = await archive.file('xl/sharedStrings.xml')!.async('uint8array')
      const xml = new TextDecoder('utf-8', { fatal: true }).decode(xmlBytes)
      // Inspect the original ZIP bytes before the reader: no decoder can recover
      // an emoji already replaced irreversibly by the writer.
      expect(xml.includes(record.description)).toBe(true)
      expect(xml).not.toContain('\uFFFD')
      expect((await decodeCatalogImportFile(bytes, 'xlsx')).records).toEqual([record])
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(bytes as never)
      expect(workbook.creator).toBe('NETECO')
      expect(workbook.created.toISOString()).toBe('2026-08-13T12:00:00.000Z')
      expect(workbook.modified.toISOString()).toBe('2026-08-13T12:00:00.000Z')
      expect(workbook.worksheets).toHaveLength(1)
      const worksheet = workbook.worksheets[0]!
      expect(worksheet.name).toBe('Catalog')
      expect(worksheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
      expect(worksheet.getRow(1).values).toEqual([undefined, ...catalogTabularColumns])
      for (let column = 1; column <= catalogTabularColumns.length; column++)
        expect(worksheet.getCell(2, column).type).toBe(ExcelJS.ValueType.String)
    }
  )

  it('decodes intact UTF-8 XML with supplementary Unicode across the same boundary', async () => {
    const record = { ...catalogRecord(), description: 'p'.repeat(13_810) + '🧼' }
    const placeholder = { ...record, description: 'UNICODE_BOUNDARY_PLACEHOLDER' }
    const archive = await JSZip.loadAsync(await exportCatalogXlsx([placeholder]))
    const xml = await archive.file('xl/sharedStrings.xml')!.async('string')
    const placeholderOffset = xml.indexOf('UNICODE_BOUNDARY_PLACEHOLDER')
    expect(placeholderOffset).toBeGreaterThan(0)
    record.description = 'p'.repeat(16_383 - placeholderOffset) + '🧼'
    const intactXml = xml.replace('UNICODE_BOUNDARY_PLACEHOLDER', record.description)
    expect(intactXml.indexOf('🧼')).toBe(16_383)
    // ZIP source is complete UTF-8 bytes, not independently encoded string
    // chunks. This is a real valid workbook, not a mocked parser response.
    archive.file('xl/sharedStrings.xml', new TextEncoder().encode(intactXml))
    const bytes = await archive.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    inspectCatalogXlsxArchive(bytes)
    expect((await decodeCatalogImportFile(bytes, 'xlsx')).records).toEqual([record])
  })

  it('exposes all decoded source records and retains the inspection API for both formats', async () => {
    const records = [{ ...catalogRecord(), product_name: 'Catálogo, con comillas "y" saltos\nde línea' }]
    for (const [format, bytes] of [
      ['csv', exportCatalogCsv(records)],
      ['xlsx', await exportCatalogXlsx(records)]
    ] as const) {
      const decoded = await decodeCatalogImportFile(bytes, format)
      expect(decoded.records).toEqual(records)
      expect(decoded.validation).toEqual(await inspectCatalogImportFile(bytes, format))
    }
  })

  it('retains structurally decoded rows with semantic issues, never partial structural failures', async () => {
    const records = [{ ...catalogRecord(), sku: '' }]
    const decoded = await decodeCatalogImportFile(exportCatalogCsv(records), 'csv')
    expect(decoded.records).toEqual(records)
    expect(decoded.validation.valid).toBe(false)
    const failures = [
      new Uint8Array([0xff, 0xfe]),
      new TextEncoder().encode('product_id,product_name\na,b\n'),
      new Uint8Array(20_000_001)
    ]
    for (const bytes of failures) {
      const failure = await decodeCatalogImportFile(bytes, 'csv')
      expect(failure.records).toEqual([])
      expect(failure.validation).toEqual(await inspectCatalogImportFile(bytes, 'csv'))
    }
  })

  it('guards hostile XLSX archive metadata before invoking workbook expansion', async () => {
    const load = vi.spyOn(Object.getPrototypeOf(new ExcelJS.Workbook().xlsx), 'load')
    try {
      const result = await decodeCatalogImportFile(zip([{ name: '../outside.xml' }]), 'xlsx')
      expect(result.records).toEqual([])
      invalidCode(result.validation, 'invalid_catalog_file')
      expect(load).not.toHaveBeenCalled()
    } finally {
      load.mockRestore()
    }
  })

  it('preserves all 71 legacy fields and typed validation for existing CSV and XLSX files', async () => {
    expect(catalogTabularColumns).toHaveLength(71)
    const records = [catalogRecord()]
    const expected = validateCatalogRecords(records)
    expect(expected.valid).toBe(true)

    const csv = await inspectCatalogImportFile(exportCatalogCsv(records), 'csv')
    const xlsx = await inspectCatalogImportFile(await exportCatalogXlsx(records), 'xlsx')
    expect(csv).toEqual(expected)
    expect(xlsx).toEqual(expected)
    expect(csv.dataset.products[0]?.sourceId).toBe(catalogFixtureIds.source)
    expect(csv.dataset.variants[0]?.inventory[0]?.physicalQuantity).toBe(40)
    expect(csv.dataset.assets[0]?.license).toBe('Fotografía propia autorizada para ecommerce')
  })

  it('keeps CSV inspection independent of Node globals and sanitizes malformed or wrong-profile input', async () => {
    const bytes = exportCatalogCsv([catalogRecord()])
    const xlsx = await exportCatalogXlsx([catalogRecord()])
    try {
      vi.stubGlobal('Buffer', undefined)
      vi.stubGlobal('process', undefined)
      expect(await inspectCatalogImportFile(bytes, 'csv')).toEqual(validateCatalogRecords([catalogRecord()]))
    } finally {
      vi.unstubAllGlobals()
    }
    expect(await inspectCatalogImportFile(xlsx, 'xlsx')).toEqual(validateCatalogRecords([catalogRecord()]))

    invalidCode(await inspectCatalogImportFile(new Uint8Array([0xff, 0xfe]), 'csv'), 'invalid_catalog_file')
    invalidCode(
      await inspectCatalogImportFile(new TextEncoder().encode('product_id,product_name\na,b\n'), 'csv'),
      'invalid_catalog_file'
    )
  })

  it('uses stable size errors and rejects structural limits before parsing', async () => {
    invalidCode(await inspectCatalogImportFile(new Uint8Array(20_000_001), 'csv'), 'catalog_file_too_large')
    invalidCode(await inspectCatalogImportFile(new Uint8Array(0), 'xlsx'), 'invalid_catalog_file')
    invalidCode(
      await inspectCatalogImportFile(zip([{ name: 'xl/a.xml', expandedSize: 100_000_001 }]), 'xlsx'),
      'catalog_file_too_large'
    )
    invalidCode(
      await inspectCatalogImportFile(
        zip(Array.from({ length: 1_001 }, (_, index) => ({ name: `xl/${index}.xml` }))),
        'xlsx'
      ),
      'catalog_file_too_large'
    )
  })

  it('distinguishes the file byte budget from expanded XLSX bytes without accepting partial rows', async () => {
    const csv = await decodeCatalogImportFile(new Uint8Array(20_000_001), 'csv')
    const xlsxFile = await decodeCatalogImportFile(new Uint8Array(20_000_001), 'xlsx')
    const xlsxExpanded = await decodeCatalogImportFile(zip([{ name: 'xl/a.xml', expandedSize: 100_000_001 }]), 'xlsx')
    for (const decoded of [csv, xlsxFile, xlsxExpanded]) {
      invalidCode(decoded.validation, 'catalog_file_too_large')
      expect(decoded.records).toEqual([])
      expect(decoded.validation.summary.rows).toBe(0)
      expect(decoded.validation.issues[0]?.message).toContain('0 filas aceptadas')
    }
    expect(csv.validation.issues[0]?.message).toContain('20 MB')
    expect(xlsxFile.validation.issues[0]?.message).toContain('comprimido')
    expect(xlsxExpanded.validation.issues[0]?.message).toContain('descomprimido')
    expect(xlsxExpanded.validation.issues[0]?.message).toContain('100 MB')
    expect(xlsxExpanded.validation.issues[0]?.message).not.toBe(xlsxFile.validation.issues[0]?.message)
  })

  it('rejects hostile or impossible archive structures before handing bytes to ExcelJS', async () => {
    const hostile = [
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      zip([{ name: '../outside.xml' }]),
      zip([{ name: 'xl/item.xml' }, { name: 'xl/item.xml' }]),
      zip([{ name: 'xl/item.xml', flags: 1 }]),
      zip([{ name: 'xl/item.xml', flags: 8 }]),
      zip([{ name: 'xl/item.xml' }], true)
    ]
    for (const bytes of hostile) invalidCode(await inspectCatalogImportFile(bytes, 'xlsx'), 'invalid_catalog_file')

    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Catalog').addRow([...catalogTabularColumns])
    const truncated = new Uint8Array(await workbook.xlsx.writeBuffer()).slice(0, -12)
    invalidCode(await inspectCatalogImportFile(truncated, 'xlsx'), 'invalid_catalog_file')
  })

  it('lets ExcelJS/JSZip reject actual deflate length that disagrees with the advertised ZIP metadata', async () => {
    const mismatched = misadvertiseDeflatedEntrySize(await exportCatalogXlsx([catalogRecord()]))
    expect(() => inspectCatalogXlsxArchive(mismatched)).not.toThrow()
    invalidCode(await inspectCatalogImportFile(mismatched, 'xlsx'), 'invalid_catalog_file')
  })

  it('rejects formulas, hyperlinks, multiple sheets, excessive columns and oversized cells', async () => {
    const makeWorkbook = async (setValue: (worksheet: ExcelJS.Worksheet) => void) => {
      const workbook = new ExcelJS.Workbook()
      const worksheet = workbook.addWorksheet('Catalog')
      worksheet.addRow([...catalogTabularColumns])
      worksheet.addRow(catalogTabularColumns.map((column) => catalogRecord()[column]))
      setValue(worksheet)
      return new Uint8Array(await workbook.xlsx.writeBuffer())
    }
    const formula = await makeWorkbook((worksheet) => {
      worksheet.getCell('C2').value = { formula: 'HYPERLINK("https://attacker.invalid")', result: 'click' }
    })
    const hyperlink = await makeWorkbook((worksheet) => {
      worksheet.getCell('C2').value = { text: 'open', hyperlink: 'https://attacker.invalid' }
    })
    const richText = await makeWorkbook((worksheet) => {
      worksheet.getCell('C2').value = { richText: [{ text: 'split ' }, { text: 'value' }] }
    })
    const sharedFormula = await makeWorkbook((worksheet) => {
      worksheet.fillFormula('C2:C3', 'A1+1', [2, 3])
    })
    invalidCode(await inspectCatalogImportFile(formula, 'xlsx'), 'invalid_catalog_file')
    invalidCode(await inspectCatalogImportFile(hyperlink, 'xlsx'), 'invalid_catalog_file')
    invalidCode(await inspectCatalogImportFile(richText, 'xlsx'), 'invalid_catalog_file')
    invalidCode(await inspectCatalogImportFile(sharedFormula, 'xlsx'), 'invalid_catalog_file')

    const multiple = new ExcelJS.Workbook()
    multiple.addWorksheet('Catalog').addRow([...catalogTabularColumns])
    multiple.addWorksheet('Other').addRow([...catalogTabularColumns])
    invalidCode(
      await inspectCatalogImportFile(new Uint8Array(await multiple.xlsx.writeBuffer()), 'xlsx'),
      'invalid_catalog_file'
    )

    const tooWide = await makeWorkbook((worksheet) => {
      worksheet.getCell(2, 72).value = 'unexpected'
    })
    invalidCode(await inspectCatalogImportFile(tooWide, 'xlsx'), 'invalid_catalog_file')

    const tooLong = await makeWorkbook((worksheet) => {
      worksheet.getCell('C2').value = 'x'.repeat(20_001)
    })
    invalidCode(await inspectCatalogImportFile(tooLong, 'xlsx'), 'catalog_file_too_large')

    const sparseTooManyRows = new ExcelJS.Workbook()
    const sparseWorksheet = sparseTooManyRows.addWorksheet('Catalog')
    sparseWorksheet.addRow([...catalogTabularColumns])
    sparseWorksheet.getCell(25_002, 1).value = 'outside row budget'
    invalidCode(
      await inspectCatalogImportFile(new Uint8Array(await sparseTooManyRows.xlsx.writeBuffer()), 'xlsx'),
      'catalog_file_too_large'
    )
  })
})
