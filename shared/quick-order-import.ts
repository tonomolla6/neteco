/** SEA-018. Pure, deterministic CSV import (delimiter detection, column mapping, per-row errors)
 * and barcode-scan normalisation for the B2B quick order. No I/O: the server resolves every
 * reference again, under the authenticated company, so nothing here is an authority. */
export const QUICK_ORDER_IMPORT_MAX_BYTES = 65_536
export const QUICK_ORDER_IMPORT_MAX_ROWS = 100
export const QUICK_ORDER_IMPORT_MAX_COLUMNS = 40
export const QUICK_ORDER_MAX_QUANTITY = 999
const MAX_REFERENCE = 160

export interface QuickOrderLine {
  reference: string
  quantity: number
}
export type QuickOrderRowError =
  | 'missing_reference'
  | 'invalid_reference'
  | 'invalid_checksum'
  | 'missing_quantity'
  | 'invalid_quantity'
  | 'duplicate_reference'
export interface QuickOrderImportRow {
  line: number
  reference: string
  quantity: number | null
  error: QuickOrderRowError | null
}
export interface QuickOrderColumnMapping {
  reference: number
  quantity: number
}
export type QuickOrderImportResult =
  | {
      status: 'ready'
      delimiter: ',' | ';' | '\t'
      headers: string[]
      mapping: QuickOrderColumnMapping
      rows: QuickOrderImportRow[]
      validCount: number
      errorCount: number
    }
  | {
      status: 'mapping_required'
      delimiter: ',' | ';' | '\t'
      headers: string[]
      suggestion: { reference: number | null; quantity: number | null }
    }
  | {
      status: 'error'
      code: 'empty' | 'too_large' | 'too_many_rows' | 'malformed_csv' | 'invalid_mapping' | 'too_many_columns'
    }

/** GS1 mod-10 check digit for GTIN-8/12/13/14. */
export function isValidGtin(value: string): boolean {
  if (!/^\d+$/.test(value) || ![8, 12, 13, 14].includes(value.length)) return false
  const digits = Array.from(value, Number)
  const check = digits.pop()!
  let sum = 0
  for (let i = digits.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) sum += digits[i]! * weight
  return (10 - (sum % 10)) % 10 === check
}
const isGtinShaped = (value: string) => /^\d+$/.test(value) && [8, 12, 13, 14].includes(value.length)
const hasControl = (value: string) => /[\p{Cc}\p{Cf}]/u.test(value)

export type ScanResult =
  | { ok: true; kind: 'gtin' | 'reference'; code: string }
  | { ok: false; error: 'empty' | 'too_long' | 'invalid_characters' | 'invalid_checksum' }
/** Scanners append CR/LF/TAB; those are trimmed. A GTIN-shaped code must carry a valid check digit. */
export function normalizeScannedCode(raw: string): ScanResult {
  const code = raw.trim()
  if (!code) return { ok: false, error: 'empty' }
  if (code.length > MAX_REFERENCE) return { ok: false, error: 'too_long' }
  if (hasControl(code) || /\s/u.test(code)) return { ok: false, error: 'invalid_characters' }
  if (isGtinShaped(code))
    return isValidGtin(code) ? { ok: true, kind: 'gtin', code } : { ok: false, error: 'invalid_checksum' }
  return { ok: true, kind: 'reference', code }
}

export function addScannedCode(
  lines: readonly QuickOrderLine[],
  raw: string
):
  | { ok: true; lines: QuickOrderLine[] }
  | { ok: false; error: Exclude<ScanResult, { ok: true }>['error'] | 'row_limit' | 'quantity_limit' } {
  const scan = normalizeScannedCode(raw)
  if (!scan.ok) return scan
  const index = lines.findIndex((line) => line.reference.toLowerCase() === scan.code.toLowerCase())
  if (index >= 0) {
    if (lines[index]!.quantity >= QUICK_ORDER_MAX_QUANTITY) return { ok: false, error: 'quantity_limit' }
    return {
      ok: true,
      lines: lines.map((line, i) => (i === index ? { ...line, quantity: line.quantity + 1 } : { ...line }))
    }
  }
  if (lines.length >= QUICK_ORDER_IMPORT_MAX_ROWS) return { ok: false, error: 'row_limit' }
  return { ok: true, lines: [...lines.map((line) => ({ ...line })), { reference: scan.code, quantity: 1 }] }
}

const REFERENCE_ALIASES = new Set([
  'referencia',
  'ref',
  'sku',
  'ean',
  'gtin',
  'mpn',
  'codigo',
  'codigodebarras',
  'codigobarras',
  'barcode',
  'reference',
  'articulo',
  'item'
])
const QUANTITY_ALIASES = new Set(['cantidad', 'cant', 'qty', 'quantity', 'unidades', 'uds', 'ud', 'units'])
const headerKey = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

function detectDelimiter(text: string): ',' | ';' | '\t' {
  const head = text.split(/\r\n|\n|\r/, 1)[0] ?? ''
  const counts = ([',', ';', '\t'] as const).map((d) => [d, head.split(d).length - 1] as const)
  return counts.sort((a, b) => b[1] - a[1])[0]![1] > 0 ? counts[0]![0] : ','
}

/** Quote-aware record splitter that keeps the physical start line of every record. */
function splitRecords(text: string, delimiter: string): Array<{ line: number; cells: string[] }> | null {
  const records: Array<{ line: number; cells: string[] }> = []
  let cells: string[] = []
  let cell = ''
  let quoted = false
  let closed = false
  let line = 1
  let start = 1
  const endRecord = () => {
    cells.push(cell)
    records.push({ line: start, cells })
    cells = []
    cell = ''
    closed = false
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') {
        quoted = false
        closed = true
      } else {
        if (ch === '\n') line++
        cell += ch
      }
      continue
    }
    if (ch === '"' && cell === '' && !closed) quoted = true
    else if (closed && ch !== delimiter && ch !== '\n' && ch !== '\r') return null
    else if (ch === delimiter) {
      cells.push(cell)
      cell = ''
      closed = false
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRecord()
      line++
      start = line
    } else cell += ch
    if (cells.length > QUICK_ORDER_IMPORT_MAX_COLUMNS) return null
  }
  if (quoted) return null
  if (cell !== '' || cells.length > 0 || closed) endRecord()
  return records
}

export function parseQuickOrderImport(
  input: string,
  options: { mapping?: QuickOrderColumnMapping } = {}
): QuickOrderImportResult {
  if (new TextEncoder().encode(input).byteLength > QUICK_ORDER_IMPORT_MAX_BYTES)
    return { status: 'error', code: 'too_large' }
  const text = input.replace(/^\uFEFF/, '')
  if (!text.trim()) return { status: 'error', code: 'empty' }
  const delimiter = detectDelimiter(text)
  const all = splitRecords(text, delimiter)
  if (!all) return { status: 'error', code: 'malformed_csv' }
  const records = all.filter((record) => record.cells.some((cell) => cell.trim() !== ''))
  const header = records[0]
  if (!header || records.length < 2) return { status: 'error', code: 'empty' }
  const headers = header.cells.map((cell) => cell.trim())
  if (records.length - 1 > QUICK_ORDER_IMPORT_MAX_ROWS) return { status: 'error', code: 'too_many_rows' }

  let mapping = options.mapping
  if (mapping) {
    const ok = [mapping.reference, mapping.quantity].every((i) => Number.isInteger(i) && i >= 0 && i < headers.length)
    if (!ok || mapping.reference === mapping.quantity) return { status: 'error', code: 'invalid_mapping' }
  } else {
    const keys = headers.map(headerKey)
    const references = keys.flatMap((key, i) => (REFERENCE_ALIASES.has(key) ? [i] : []))
    const quantities = keys.flatMap((key, i) => (QUANTITY_ALIASES.has(key) ? [i] : []))
    if (references.length !== 1 || quantities.length !== 1)
      return {
        status: 'mapping_required',
        delimiter,
        headers,
        suggestion: {
          reference: references.length === 1 ? references[0]! : null,
          quantity: quantities.length === 1 ? quantities[0]! : null
        }
      }
    mapping = { reference: references[0]!, quantity: quantities[0]! }
  }

  const seen = new Set<string>()
  const rows: QuickOrderImportRow[] = records.slice(1).map((record) => {
    const reference = (record.cells[mapping.reference] ?? '').trim()
    const rawQuantity = record.cells[mapping.quantity]
    const row = (error: QuickOrderRowError | null, quantity: number | null = null): QuickOrderImportRow => ({
      line: record.line,
      reference,
      quantity,
      error
    })
    if (!reference) return row('missing_reference')
    if (reference.length > MAX_REFERENCE || hasControl(reference) || /^[=+\-@]/.test(reference))
      return row('invalid_reference')
    if (isGtinShaped(reference) && !isValidGtin(reference)) return row('invalid_checksum')
    if (rawQuantity === undefined || rawQuantity.trim() === '') return row('missing_quantity')
    const quantityText = rawQuantity.trim()
    if (!/^[1-9]\d{0,2}$/.test(quantityText)) return row('invalid_quantity')
    const key = reference.toLowerCase()
    if (seen.has(key)) return row('duplicate_reference', Number(quantityText))
    seen.add(key)
    return row(null, Number(quantityText))
  })
  const errorCount = rows.filter((row) => row.error).length
  return { status: 'ready', delimiter, headers, mapping, rows, validCount: rows.length - errorCount, errorCount }
}
