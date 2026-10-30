import { describe, expect, it } from 'vitest'
import {
  QUICK_ORDER_IMPORT_MAX_BYTES,
  QUICK_ORDER_IMPORT_MAX_ROWS,
  addScannedCode,
  isValidGtin,
  normalizeScannedCode,
  parseQuickOrderImport
} from '../../shared/quick-order-import'

describe('SEA-018 isValidGtin / normalizeScannedCode', () => {
  it('validates GS1 check digits for 8, 12, 13 and 14 digits', () => {
    expect(isValidGtin('8412345678905')).toBe(true) // EAN-13
    expect(isValidGtin('96385074')).toBe(true) // EAN-8
    expect(isValidGtin('036000291452')).toBe(true) // UPC-A
    expect(isValidGtin('10012345678902')).toBe(true) // GTIN-14
    expect(isValidGtin('8412345678904')).toBe(false)
    expect(isValidGtin('841234567890')).toBe(false) // wrong check digit
    expect(isValidGtin('84123456789')).toBe(false) // 11 digits
    expect(isValidGtin('84123456789A5')).toBe(false)
    expect(isValidGtin('')).toBe(false)
  })
  it('trims scanner terminators and classifies the code', () => {
    expect(normalizeScannedCode('8412345678905\r\n')).toEqual({ ok: true, kind: 'gtin', code: '8412345678905' })
    expect(normalizeScannedCode('  sku-abc-1\t')).toEqual({ ok: true, kind: 'reference', code: 'sku-abc-1' })
  })
  it('rejects a numeric code with a wrong checksum instead of guessing', () => {
    expect(normalizeScannedCode('8412345678904')).toEqual({ ok: false, error: 'invalid_checksum' })
  })
  it('rejects empty, oversized and control-character scans', () => {
    expect(normalizeScannedCode('   ')).toEqual({ ok: false, error: 'empty' })
    expect(normalizeScannedCode('A'.repeat(161))).toEqual({ ok: false, error: 'too_long' })
    expect(normalizeScannedCode('AB\u0000CD')).toEqual({ ok: false, error: 'invalid_characters' })
    expect(normalizeScannedCode('AB CD')).toEqual({ ok: false, error: 'invalid_characters' })
  })
})

describe('SEA-018 addScannedCode', () => {
  it('appends a new line with quantity 1 and increments repeated scans', () => {
    let lines = addScannedCode([], '8412345678905')
    expect(lines).toEqual({ ok: true, lines: [{ reference: '8412345678905', quantity: 1 }] })
    lines = addScannedCode((lines as { lines: never[] }).lines, '8412345678905\n')
    expect(lines).toEqual({ ok: true, lines: [{ reference: '8412345678905', quantity: 2 }] })
  })
  it('refuses to exceed 999 units and to exceed the row limit', () => {
    expect(addScannedCode([{ reference: 'SKU-1', quantity: 999 }], 'SKU-1')).toEqual({
      ok: false,
      error: 'quantity_limit'
    })
    const full = Array.from({ length: QUICK_ORDER_IMPORT_MAX_ROWS }, (_, i) => ({ reference: `SKU-${i}`, quantity: 1 }))
    expect(addScannedCode(full, 'NEW-1')).toEqual({ ok: false, error: 'row_limit' })
  })
  it('does not mutate the input array', () => {
    const input = [{ reference: 'SKU-1', quantity: 1 }]
    addScannedCode(input, 'SKU-1')
    expect(input).toEqual([{ reference: 'SKU-1', quantity: 1 }])
  })
  it('propagates scan errors', () => {
    expect(addScannedCode([], '8412345678904')).toEqual({ ok: false, error: 'invalid_checksum' })
  })
})

describe('SEA-018 parseQuickOrderImport', () => {
  it('auto-maps Spanish headers with comma, semicolon or tab delimiters', () => {
    for (const delimiter of [',', ';', '\t']) {
      const result = parseQuickOrderImport(`Referencia${delimiter}Cantidad\nSKU-1${delimiter}2\nSKU-2${delimiter}5`)
      expect(result.status).toBe('ready')
      if (result.status !== 'ready') return
      expect(result.mapping).toEqual({ reference: 0, quantity: 1 })
      expect(result.rows.map((row) => [row.line, row.reference, row.quantity, row.error])).toEqual([
        [2, 'SKU-1', 2, null],
        [3, 'SKU-2', 5, null]
      ])
      expect(result.validCount).toBe(2)
      expect(result.errorCount).toBe(0)
    }
  })
  it('maps aliases (sku/ean/qty/unidades) and extra unrelated columns', () => {
    const result = parseQuickOrderImport('nombre,EAN,uds,notas\nLejía,8412345678905,3,x')
    expect(result.status).toBe('ready')
    if (result.status === 'ready') expect(result.mapping).toEqual({ reference: 1, quantity: 2 })
  })
  it('strips a BOM and accepts CRLF and quoted cells with delimiters', () => {
    const result = parseQuickOrderImport('﻿referencia;cantidad\r\n"SKU;1";4\r\n')
    expect(result.status).toBe('ready')
    if (result.status === 'ready') expect(result.rows[0]).toMatchObject({ reference: 'SKU;1', quantity: 4 })
  })
  it('requires a manual mapping when headers are ambiguous or unknown', () => {
    const result = parseQuickOrderImport('sku,ean,cantidad\nA1,8412345678905,2')
    expect(result.status).toBe('mapping_required')
    if (result.status !== 'mapping_required') return
    expect(result.headers).toEqual(['sku', 'ean', 'cantidad'])
    expect(result.suggestion).toEqual({ reference: null, quantity: 2 })
    const mapped = parseQuickOrderImport('sku,ean,cantidad\nA1,8412345678905,2', {
      mapping: { reference: 1, quantity: 2 }
    })
    expect(mapped.status).toBe('ready')
    if (mapped.status === 'ready') expect(mapped.rows[0]).toMatchObject({ reference: '8412345678905', quantity: 2 })
  })
  it('rejects an invalid explicit mapping', () => {
    const text = 'a,b\nx,1'
    expect(parseQuickOrderImport(text, { mapping: { reference: 0, quantity: 0 } })).toMatchObject({
      status: 'error',
      code: 'invalid_mapping'
    })
    expect(parseQuickOrderImport(text, { mapping: { reference: 0, quantity: 5 } })).toMatchObject({
      status: 'error',
      code: 'invalid_mapping'
    })
    expect(parseQuickOrderImport(text, { mapping: { reference: -1, quantity: 1 } })).toMatchObject({
      status: 'error',
      code: 'invalid_mapping'
    })
  })
  it('reports per-row errors with the 1-based line and keeps valid rows', () => {
    const result = parseQuickOrderImport(
      'referencia,cantidad\nSKU-1,2\n,3\nSKU-3,0\nSKU-4,1.5\nSKU-5,abc\nSKU-6,1000\n8412345678904,1\nSKU-9,7'
    )
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    const errors = result.rows.filter((row) => row.error).map((row) => [row.line, row.error])
    expect(errors).toEqual([
      [3, 'missing_reference'],
      [4, 'invalid_quantity'],
      [5, 'invalid_quantity'],
      [6, 'invalid_quantity'],
      [7, 'invalid_quantity'],
      [8, 'invalid_checksum']
    ])
    expect(result.validCount).toBe(2)
    expect(result.errorCount).toBe(6)
  })
  it('flags duplicated references on the later row without summing quantities', () => {
    const result = parseQuickOrderImport('referencia,cantidad\nSKU-1,2\nsku-1,3\nSKU-2,1')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.rows.map((row) => row.error)).toEqual([null, 'duplicate_reference', null])
  })
  it('flags short rows, rows with too many cells and control characters', () => {
    const result = parseQuickOrderImport('referencia,cantidad\nSKU-1\nSKU-2,1,9\nSKU\u0007-3,1')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.rows.map((row) => row.error)).toEqual(['missing_quantity', null, 'invalid_reference'])
  })
  it('skips fully blank lines without shifting line numbers', () => {
    const result = parseQuickOrderImport('referencia,cantidad\n\nSKU-1,1\n\n\nSKU-2,2')
    expect(result.status).toBe('ready')
    if (result.status === 'ready') expect(result.rows.map((row) => row.line)).toEqual([3, 6])
  })
  it('does not accept spreadsheet formulas as references', () => {
    const result = parseQuickOrderImport('referencia,cantidad\n=HYPERLINK("x"),1\n+34600,1\n@SUM(1),1')
    expect(result.status).toBe('ready')
    if (result.status === 'ready')
      expect(result.rows.map((row) => row.error)).toEqual(Array(3).fill('invalid_reference'))
  })
  it('fails closed on empty, header-only, oversized and over-row-limit files', () => {
    expect(parseQuickOrderImport('')).toMatchObject({ status: 'error', code: 'empty' })
    expect(parseQuickOrderImport('referencia,cantidad')).toMatchObject({ status: 'error', code: 'empty' })
    expect(parseQuickOrderImport('x'.repeat(QUICK_ORDER_IMPORT_MAX_BYTES + 1))).toMatchObject({
      status: 'error',
      code: 'too_large'
    })
    const rows = Array.from({ length: QUICK_ORDER_IMPORT_MAX_ROWS + 1 }, (_, i) => `SKU-${i},1`).join('\n')
    expect(parseQuickOrderImport(`referencia,cantidad\n${rows}`)).toMatchObject({
      status: 'error',
      code: 'too_many_rows'
    })
  })
  it('fails closed on an unterminated quote', () => {
    expect(parseQuickOrderImport('referencia,cantidad\n"SKU-1,2')).toMatchObject({
      status: 'error',
      code: 'malformed_csv'
    })
  })
  it('exposes only plain data: no valid line carries an error', () => {
    const result = parseQuickOrderImport('referencia,cantidad\nSKU-1,2')
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })
})
