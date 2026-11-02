import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import {
  EDITORIAL_CSV_COLUMNS,
  MAX_BYTES,
  MAX_PRODUCTS,
  EditorialCsvError,
  parseEditorialCsv,
  exportEditorialCsv,
  type EditorialCsvRow
} from '../../shared/catalog-editorial-csv'
import { parseCatalogCsvCells } from '../../shared/catalog-tabular-core'
import { draftProductMetadataSchema } from '../../workers/catalog/admin-catalog-mutations'
import { csvCell } from '../../server/utils/csv'

function row(index = 1): EditorialCsvRow {
  return {
    productId: `a1100000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    legacyId: index,
    expectedVersion: 5,
    metadata: {
      name: 'Producto editorial',
      shortDesc: 'Descripción editorial breve',
      description: 'Descripción completa editorial.',
      usage: null,
      series: null,
      featured: false
    }
  }
}
const bytes = (text: string) => new TextEncoder().encode(text)
const cell = (text: string) => `"${text.replaceAll('"', '""')}"`
const columns = (value: EditorialCsvRow) => [
  value.productId,
  String(value.legacyId),
  String(value.expectedVersion),
  value.metadata.name,
  value.metadata.shortDesc,
  value.metadata.description,
  value.metadata.usage ?? '',
  value.metadata.series ?? '',
  String(value.metadata.featured)
]
const raw = (values: string[][], header: readonly string[] = EDITORIAL_CSV_COLUMNS) =>
  bytes([header.map(cell).join(','), ...values.map((fields) => fields.map(cell).join(','))].join('\r\n') + '\r\n')
const decode = (data: Uint8Array) => new TextDecoder().decode(data)
const unsafeExport = (value: unknown) => Reflect.apply(exportEditorialCsv, undefined, [value])
function csvError(action: () => unknown) {
  try {
    action()
  } catch (failure) {
    expect(failure).toBeInstanceOf(EditorialCsvError)
    if (failure instanceof EditorialCsvError) return failure
    throw failure
  }
  throw new Error('expected_editorial_csv_error')
}

describe('editorial-only CSV profile v1, separate from the legacy full catalogue', () => {
  it('has exact nine headers and independent 1 MB / 100-product limits', () => {
    expect(EDITORIAL_CSV_COLUMNS).toEqual([
      'product_id',
      'product_legacy_id',
      'catalog_version',
      'product_name',
      'short_description',
      'description',
      'product_usage',
      'product_series',
      'product_featured'
    ])
    expect(MAX_BYTES).toBe(1_000_000)
    expect(MAX_PRODUCTS).toBe(100)
    expect(decode(exportEditorialCsv([row()])).split('\r\n')[0]).toBe(
      EDITORIAL_CSV_COLUMNS.map((column) => csvCell(column)).join(',')
    )
  })
  it('round trips canonical UTF-8, quoted commas, doubled quotes, tabs and CRLF multiline text without Node globals', () => {
    const value = row()
    value.metadata.name = 'Detergente, "editorial"'
    value.metadata.description = 'Primera línea, con "comillas".\r\nSegunda línea con café y 🧽.'
    value.metadata.usage = 'Primera acción\tcon detalle.\nSegunda acción.'
    value.metadata.series = 'Colección editorial'
    value.metadata.featured = true
    let actual: EditorialCsvRow[]
    try {
      vi.stubGlobal('Buffer', undefined)
      vi.stubGlobal('process', undefined)
      actual = parseEditorialCsv(exportEditorialCsv([value]))
    } finally {
      vi.unstubAllGlobals()
    }
    expect(actual).toEqual([value])
  })
  it('preserves incomplete export templates and unedited spaces, but parsing requires completed metadata', () => {
    const blank = row()
    blank.metadata = { name: '', shortDesc: '', description: '', usage: '', series: '', featured: false }
    const output = exportEditorialCsv([blank])
    expect(parseCatalogCsvCells(decode(output))[1]).toEqual(columns(blank))
    expect(() => parseEditorialCsv(output)).toThrow()
    const existing = row()
    existing.metadata.name = '  Producto editorial  '
    existing.metadata.shortDesc = '  Texto existente  '
    existing.metadata.description = '\n  Descripción existente  \n'
    existing.metadata.usage = '\nUso existente\n'
    existing.metadata.series = '  Serie existente  '
    expect(parseCatalogCsvCells(decode(exportEditorialCsv([existing])))[1]).toEqual(columns(existing))
    const parsed = parseEditorialCsv(exportEditorialCsv([existing]))[0]!
    const authority = draftProductMetadataSchema.parse({
      expectedVersion: existing.expectedVersion,
      reason: 'Aplicar edición',
      ...existing.metadata
    })
    expect(parsed.metadata).toEqual({
      name: authority.name,
      shortDesc: authority.shortDesc,
      description: authority.description,
      usage: authority.usage,
      series: authority.series,
      featured: authority.featured
    })
  })
  it('exports a header-only empty template, which is not a valid import', () => {
    const output = exportEditorialCsv([])
    expect(parseCatalogCsvCells(decode(output))).toHaveLength(1)
    expect(() => parseEditorialCsv(output)).toThrow('editorial_csv_products_required')
  })
  it('accepts a single initial UTF-8 BOM, normalizes empty/whitespace nullable cells and applies backend trims', () => {
    const values = columns(row())
    values[3] = '   Producto editorial   '
    values[6] = '\t \r\n '
    values[7] = '   '
    const actual = parseEditorialCsv(bytes('\uFEFF' + decode(raw([values]))))[0]!
    expect(actual.metadata).toEqual(row().metadata)
  })
  it.each([
    ['duplicate BOM', '\uFEFF\uFEFF'],
    ['embedded BOM', '']
  ])('rejects %s rather than silently stripping invisible data', (_name, prefix) => {
    const values = columns(row())
    if (!prefix) values[5] += '\uFEFF'
    expect(() => parseEditorialCsv(bytes(prefix + decode(raw([values]))))).toThrow('editorial_csv_bom_invalid')
  })
  it.each([
    new Uint8Array([0xff]),
    new Uint8Array([0xc0, 0x80]),
    new Uint8Array([0xe2, 0x82]),
    new Uint8Array([0xff, 0xfe, 0x61, 0])
  ])('rejects malformed/foreign encoding %j', (input) => {
    expect(() => parseEditorialCsv(input)).toThrow()
  })
  it('does not read byteLength, constructor or iterator getters from a branded byte array', () => {
    const input = raw([columns(row())])
    const effect = vi.fn(() => {
      throw new Error('getter_must_not_run')
    })
    Object.defineProperties(input, {
      byteLength: { get: effect },
      constructor: { get: effect },
      [Symbol.iterator]: { get: effect }
    })
    expect(parseEditorialCsv(input)).toEqual([row()])
    expect(effect).not.toHaveBeenCalled()
  })
  it.each([
    ['empty', ''],
    ['header only', EDITORIAL_CSV_COLUMNS.join(',')],
    ['unterminated', EDITORIAL_CSV_COLUMNS.join(',') + '\n"unfinished'],
    ['after closing quote', EDITORIAL_CSV_COLUMNS.join(',') + '\n"one"oops'],
    ['quote within cell', EDITORIAL_CSV_COLUMNS.join(',') + '\none"oops'],
    ['missing field', decode(raw([columns(row()).slice(0, -1)]))],
    ['extra field', decode(raw([[...columns(row()), 'extra']]))],
    ['blank extra row', decode(raw([columns(row())])) + '\n']
  ])('rejects hostile CSV structure: %s', (_name, input) => {
    expect(() => parseEditorialCsv(bytes(input))).toThrow()
  })
  it.each([
    [...EDITORIAL_CSV_COLUMNS].reverse(),
    EDITORIAL_CSV_COLUMNS.slice(1),
    [...EDITORIAL_CSV_COLUMNS, 'price_gross_cents'],
    ['product_id', 'product_id', ...EDITORIAL_CSV_COLUMNS.slice(2)],
    [' product_id', ...EDITORIAL_CSV_COLUMNS.slice(1)]
  ])('rejects nonexact headers %j', (header) => {
    expect(() => parseEditorialCsv(raw([columns(row())], header))).toThrow()
  })
  it.each(['=SUM(1,2)', '+CMD(1)', '-1+1', '@SUM(1)', ' \t\n=FORMULA', '\u00a0=FORMULA', '\u2003@FORMULA'])(
    'rejects formula prefix %j on import and export, never rewriting it as an edit',
    (formula) => {
      for (const index of [3, 4, 5, 6, 7]) {
        const values = columns(row())
        values[index] = formula
        expect(() => parseEditorialCsv(raw([values]))).toThrow()
      }
      for (const field of ['name', 'shortDesc', 'description', 'usage', 'series'] as const) {
        const value = row()
        value.metadata[field] = formula
        expect(() => exportEditorialCsv([value])).toThrow()
      }
    }
  )
  it('keeps explicit literal apostrophes without silently antiformula-changing identity or metadata', () => {
    const value = row()
    value.metadata.description = "'=SUM(1,2) is quoted literal documentation."
    expect(parseEditorialCsv(exportEditorialCsv([value]))).toEqual([value])
  })
  it.each(['\0', '\x01', '\x1f', '\x7f'])('rejects control %j in every text field', (control) => {
    for (const field of ['name', 'shortDesc', 'description', 'usage', 'series'] as const) {
      const value = row()
      value.metadata[field] = 'Texto válido' + control
      expect(() => exportEditorialCsv([value])).toThrow()
      expect(() => parseEditorialCsv(raw([columns(value)]))).toThrow()
    }
  })
  it.each(['name', 'shortDesc', 'series'] as const)('rejects newline/tab in single-line %s', (field) => {
    for (const control of ['\n', '\r', '\t']) {
      const value = row()
      value.metadata[field] = 'Texto válido' + control + 'Otro texto'
      expect(() => exportEditorialCsv([value])).toThrow()
      expect(() => parseEditorialCsv(raw([columns(value)]))).toThrow()
    }
  })
  it.each([
    ['name', 3, 160],
    ['shortDesc', 5, 500],
    ['description', 5, 10_000],
    ['usage', 0, 2_000],
    ['series', 0, 160]
  ] as const)(
    'matches backend metadata bounds for %s, excluding only explicit CSV safety rules',
    (field, minimum, maximum) => {
      for (const length of [Math.max(0, minimum - 1), minimum, maximum, maximum + 1]) {
        const value = row()
        value.metadata[field] = 'x'.repeat(length)
        const authority = draftProductMetadataSchema.safeParse({
          expectedVersion: value.expectedVersion,
          reason: 'Aplicar edición',
          ...value.metadata
        })
        if (authority.success) expect(() => parseEditorialCsv(raw([columns(value)]))).not.toThrow()
        else expect(() => parseEditorialCsv(raw([columns(value)]))).toThrow()
      }
    }
  )
  it.each(['0', '-1', '+1', '01', '1.0', '1e1', ' 1', '9007199254740992', '=1'])(
    'rejects noncanonical/unsafe positive numeric cell %s',
    (numeric) => {
      for (const index of [1, 2]) {
        const values = columns(row())
        values[index] = numeric
        expect(() => parseEditorialCsv(raw([values]))).toThrow()
      }
    }
  )
  it('accepts MAXSAFE legacy id but caps version at MAXSAFE-2 for apply and revert increments', () => {
    const value = row()
    value.legacyId = Number.MAX_SAFE_INTEGER
    value.expectedVersion = Number.MAX_SAFE_INTEGER - 2
    expect(parseEditorialCsv(exportEditorialCsv([value]))).toEqual([value])
    value.expectedVersion++
    expect(() => exportEditorialCsv([value])).toThrow()
    expect(() => parseEditorialCsv(raw([columns(value)]))).toThrow()
  })
  it.each(['TRUE', 'False', '1', '0', 'yes', '', ' true '])('rejects coercive featured flag %j', (featured) => {
    const values = columns(row())
    values[8] = featured
    expect(() => parseEditorialCsv(raw([values]))).toThrow('editorial_csv_boolean_invalid')
  })
  it('rejects duplicate UUID or legacy id independently even if versions/metadata differ', () => {
    for (const field of ['productId', 'legacyId'] as const) {
      const first = row(),
        second = row(2)
      if (field === 'productId') second.productId = first.productId
      else second.legacyId = first.legacyId
      expect(() => exportEditorialCsv([first, second])).toThrow('editorial_csv_duplicate_product')
      expect(() => parseEditorialCsv(raw([columns(first), columns(second)]))).toThrow('editorial_csv_duplicate_product')
    }
  })
  it('rejects forged UUIDs and extra authority fields rather than expanding scope', () => {
    const values = columns(row())
    values[0] = 'not-a-uuid'
    expect(() => parseEditorialCsv(raw([values]))).toThrow()
    expect(() => unsafeExport([{ ...row(), priceGrossCents: 100 }])).toThrow()
    expect(() => unsafeExport([{ ...row(), metadata: { ...row().metadata, categoryId: 7 } }])).toThrow()
  })
  it('rejects getters, coercions, inherited rows and symbols without executing them', () => {
    const effect = vi.fn(() => {
      throw new Error('untrusted_effect')
    })
    const getter = row()
    Object.defineProperty(getter.metadata, 'name', { get: effect, enumerable: true })
    const coercion = row()
    Object.defineProperty(coercion.metadata, 'toJSON', { value: effect, enumerable: true })
    const inherited = Object.create(row())
    const symbol = row()
    Object.defineProperty(symbol, Symbol.toPrimitive, { value: effect, enumerable: true })
    for (const value of [getter, coercion, inherited, symbol]) expect(() => unsafeExport([value])).toThrow()
    expect(effect).not.toHaveBeenCalled()
  })
  it('rejects sparse/inherited arrays, undefined, function values and nonenumerable rows', () => {
    const sparse: EditorialCsvRow[] = new Array(1)
    const inherited = [row()]
    Object.setPrototypeOf(inherited, Object.create(Array.prototype))
    const nonenumerable = [row()]
    Object.defineProperty(nonenumerable, '0', { enumerable: false })
    for (const value of [
      sparse,
      inherited,
      nonenumerable,
      undefined,
      [() => row()],
      [{ ...row(), metadata: { ...row().metadata, featured: undefined } }]
    ])
      expect(() => unsafeExport(value)).toThrow()
  })
  it('accepts ordinary null-prototype JSON records, with no coercion hooks', () => {
    const value = row()
    const nullRow = Object.assign(Object.create(null), value, {
      metadata: Object.assign(Object.create(null), value.metadata)
    })
    expect(parseEditorialCsv(unsafeExport([nullRow]))).toEqual([value])
  })
  it('enforces 100 products in both directions without truncating the 101st row', () => {
    const values = Array.from({ length: MAX_PRODUCTS }, (_, index) => row(index + 1))
    expect(parseEditorialCsv(exportEditorialCsv(values))).toHaveLength(100)
    values.push(row(101))
    expect(() => exportEditorialCsv(values)).toThrow()
    expect(() => parseEditorialCsv(raw(values.map(columns)))).toThrow('CSV exceeds its row limit')
  })
  it('accepts exactly 1 MB of valid rows, rejects the next byte and uses actual UTF-8 byte size', () => {
    const values = Array.from({ length: MAX_PRODUCTS }, (_, index) => row(index + 1))
    let remaining = MAX_BYTES - exportEditorialCsv(values).byteLength
    for (const value of values) {
      const addition = Math.min(remaining, 10_000 - value.metadata.description.length)
      value.metadata.description += 'x'.repeat(addition)
      remaining -= addition
    }
    expect(remaining).toBe(0)
    const exact = exportEditorialCsv(values)
    expect(exact.byteLength).toBe(MAX_BYTES)
    expect(parseEditorialCsv(exact)).toHaveLength(100)
    values.at(-1)!.metadata.description += 'x'
    expect(() => exportEditorialCsv(values)).toThrow('editorial_csv_bytes_invalid')
    expect(() => parseEditorialCsv(new Uint8Array(MAX_BYTES + 1))).toThrow('editorial_csv_bytes_invalid')
    const unicode = Array.from({ length: 40 }, (_, index) => {
      const value = row(index + 1)
      value.metadata.description = '🧽'.repeat(5_000)
      return value
    })
    expect(() => exportEditorialCsv(unicode)).not.toThrow()
    unicode.push(
      ...Array.from({ length: 15 }, (_, index) => {
        const value = row(index + 41)
        value.metadata.description = '🧽'.repeat(5_000)
        return value
      })
    )
    expect(() => exportEditorialCsv(unicode)).toThrow('editorial_csv_bytes_invalid')
  })
  it('bounded reused parser stops hostile columns/rows/cells before completing unbounded structures', () => {
    expect(parseCatalogCsvCells('a,b\r\nx,y', { maxRows: 2, maxColumns: 2, maxCellCharacters: 1 })).toEqual([
      ['a', 'b'],
      ['x', 'y']
    ])
    expect(() => parseCatalogCsvCells('a,b,c', { maxRows: 2, maxColumns: 2, maxCellCharacters: 1 })).toThrow(
      'CSV exceeds its column limit'
    )
    expect(() => parseCatalogCsvCells('a\nb\nc', { maxRows: 2, maxColumns: 2, maxCellCharacters: 1 })).toThrow(
      'CSV exceeds its row limit'
    )
    expect(() =>
      parseCatalogCsvCells('"' + 'x'.repeat(10_001), { maxRows: 101, maxColumns: 9, maxCellCharacters: 10_000 })
    ).toThrow('CSV exceeds its cell limit')
    expect(() => parseCatalogCsvCells('a', { maxRows: 0, maxColumns: 9, maxCellCharacters: 10_000 })).toThrow()
  })
  it('reports the first invalid logical row and known metadata header without exposing its value', () => {
    const first = row()
    first.metadata.description = 'Valid multiline description\nStill the first CSV record.'
    const second = columns(row(2)),
      third = columns(row(3))
    second[4] = 'x'
    third[3] = '=FORMULA("third-row@example.invalid")'
    const failure = csvError(() => parseEditorialCsv(raw([columns(first), second, third])))
    expect(failure).toMatchObject({ code: 'metadata_field_invalid', row: 3, field: 'short_description' })
    expect(failure.message).toBe('metadata_field_invalid')
    expect(failure.message).not.toContain('third-row@example.invalid')
    expect(failure.message).not.toContain('FORMULA')
  })
  it('maps known identity, legacy id, version and boolean validation failures to their exact wire headers', () => {
    const cases = [
      {
        index: 0,
        value: 'private-customer@example.invalid',
        code: 'editorial_csv_product_id_invalid',
        field: 'product_id'
      },
      { index: 1, value: '+01', code: 'editorial_csv_integer_invalid', field: 'product_legacy_id' },
      {
        index: 2,
        value: String(Number.MAX_SAFE_INTEGER - 1),
        code: 'editorial_csv_integer_invalid',
        field: 'catalog_version'
      },
      { index: 8, value: 'TRUE', code: 'editorial_csv_boolean_invalid', field: 'product_featured' }
    ]
    for (const test of cases) {
      const second = columns(row(2))
      second[test.index] = test.value
      const failure = csvError(() => parseEditorialCsv(raw([columns(row()), second])))
      expect(failure).toMatchObject({ code: test.code, row: 3, field: test.field })
      expect(failure.message).toBe(test.code)
      expect(failure.message).not.toContain(test.value)
    }
  })
  it('formula and control failures in every metadata cell use one safe code and a known header', () => {
    for (const index of [3, 4, 5, 6, 7, 8]) {
      for (const value of ['=LOOKUP("private-customer@example.invalid")', 'private-customer@example.invalid\x01']) {
        const second = columns(row(2))
        second[index] = value
        const failure = csvError(() => parseEditorialCsv(raw([columns(row()), second])))
        expect(failure).toMatchObject({ code: 'metadata_field_invalid', row: 3, field: EDITORIAL_CSV_COLUMNS[index] })
        expect(failure.message).toBe('metadata_field_invalid')
        expect(failure.message).not.toContain('private-customer@example.invalid')
        expect(JSON.stringify(failure)).not.toContain(value)
      }
    }
  })
  it('unknown headers and malformed UTF-8 have file-level feedback without invented row/field or input values', () => {
    const header = [...EDITORIAL_CSV_COLUMNS]
    header.splice(4, 1)
    const unknown = raw([columns(row())], [...header, 'private-customer@example.invalid']),
      encoded = bytes('private-customer@example.invalid'),
      invalid = new Uint8Array(encoded.length + 1),
      effect = vi.fn(() => {
        throw new Error('private-customer@example.invalid')
      })
    invalid.set(encoded)
    invalid[encoded.length] = 0xff
    Object.defineProperties(invalid, {
      byteLength: { get: effect },
      constructor: { get: effect },
      [Symbol.iterator]: { get: effect }
    })
    const failures = [csvError(() => parseEditorialCsv(unknown)), csvError(() => parseEditorialCsv(invalid))]
    expect(failures.map((failure) => failure.code)).toEqual([
      'editorial_csv_header_invalid',
      'editorial_csv_encoding_invalid'
    ])
    for (const failure of failures) {
      expect(failure.row).toBeUndefined()
      expect(failure.field).toBeUndefined()
      expect(failure.message).toBe(failure.code)
      expect(failure.message).not.toContain('private-customer@example.invalid')
    }
    expect(effect).not.toHaveBeenCalled()
  })
  it('unsafe export DTO getters never execute or acquire invented CSV row/field hints', () => {
    const effect = vi.fn(() => {
        throw new Error('private-customer@example.invalid')
      }),
      value = row()
    Object.defineProperty(value.metadata, 'name', { get: effect, enumerable: true })
    const failure = csvError(() => unsafeExport([value]))
    expect(failure.code).toBe('editorial_csv_own_data_required')
    expect(failure.row).toBeUndefined()
    expect(failure.field).toBeUndefined()
    expect(failure.message).not.toContain('private-customer@example.invalid')
    expect(effect).not.toHaveBeenCalled()
  })
  it('the full local runtime dependency graph remains free of Node, ExcelJS and PostgreSQL imports/globals', () => {
    const graph = [
      {
        path: '../../shared/catalog-editorial-csv.ts',
        imports: ['zod', './catalog-publication-policy', './catalog-tabular-core', '../server/utils/csv']
      },
      { path: '../../shared/catalog-publication-policy.ts', imports: ['zod'] },
      {
        path: '../../shared/catalog-tabular-core.ts',
        imports: ['zod', '../server/domain/catalog-publication', '../server/utils/csv', './catalog-typed-attributes']
      },
      { path: '../../shared/catalog-typed-attributes.ts', imports: ['zod', './catalog-publication-policy'] },
      { path: '../../server/domain/catalog-publication.ts', imports: [] },
      { path: '../../server/utils/csv.ts', imports: [] }
    ]
    for (const file of graph) {
      const ast = ts.createSourceFile(
        file.path,
        readFileSync(new URL(file.path, import.meta.url), 'utf8'),
        ts.ScriptTarget.Latest,
        true
      )
      expect(
        ast.statements
          .filter(ts.isImportDeclaration)
          .map((statement) => (ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : ''))
      ).toEqual(file.imports)
      const globals: string[] = []
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node) && ['Buffer', 'process', 'require'].includes(node.text)) globals.push(node.text)
        ts.forEachChild(node, visit)
      }
      visit(ast)
      expect(globals).toEqual([])
    }
  })
})
