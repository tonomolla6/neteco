import { z } from 'zod'
import { csvCell } from '../server/utils/csv'
import { parseCatalogCsvCells } from './catalog-tabular-core'

export const ORDER_EXPORT_MAX_ROWS = 1000
export const ORDER_EXPORT_MAX_BYTES = 2_000_000
export const ORDER_EXPORT_FILENAME = 'neteco-pedidos.csv'
export const ORDER_EXPORT_CONTENT_TYPE = 'text/csv; charset=utf-8'
export const ORDER_EXPORT_HEADERS = {
  source: 'X-Neteco-Export-Source',
  rows: 'X-Neteco-Export-Rows',
  bytes: 'X-Neteco-Export-Bytes'
} as const
export const ORDER_EXPORT_COLUMNS = [
  'id',
  'status',
  'orderStatus',
  'paymentStatus',
  'inventoryStatus',
  'fulfillmentStatus',
  'invoiceStatus',
  'name',
  'company',
  'email',
  'city',
  'paymentMethod',
  'shippingMethod',
  'totalGrossCents',
  'createdAt',
  'lines'
] as const
export const ORDER_EXPORT_QUERY_KEYS = [
  'q',
  'bucket',
  'sortKey',
  'sortDir',
  'paymentStatus',
  'orderStatus',
  'shippingMethod',
  'customerType',
  'from',
  'to'
] as const
/** Transport-only validation. parseAdminOrderQuery remains the single semantic
 * authority for filter values, dates and order. No page/perPage is accepted. */
export const orderExportQuerySchema = z
  .record(z.string(), z.string().max(120))
  .refine((query) =>
    Object.entries(query).every(
      ([key, value]) =>
        (ORDER_EXPORT_QUERY_KEYS as readonly string[]).includes(key) &&
        [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    )
  )
export const orderExportMetadataSchema = z
  .object({
    source: z.literal('cloudflare'),
    rows: z.number().int().min(0).max(ORDER_EXPORT_MAX_ROWS),
    bytes: z.number().int().min(1).max(ORDER_EXPORT_MAX_BYTES)
  })
  .strict()
export type OrderExportMetadata = z.infer<typeof orderExportMetadataSchema>
export type OrderExportQuery = z.infer<typeof orderExportQuerySchema>
/** Keep the existing CSV quote/escape implementation. The export also guards
 * Unicode-leading whitespace, which spreadsheet importers may trim. */
export function orderExportCsvCell(value: string | number) {
  const text = String(value)
  return csvCell(/^[=+\-@]/u.test(text.trimStart()) ? "'" + text : text)
}
export function verifyOrderExportCsv(bytes: Uint8Array, metadata: OrderExportMetadata): void {
  const parsed = orderExportMetadataSchema.parse(metadata)
  if (
    bytes.byteLength !== parsed.bytes ||
    bytes.byteLength > ORDER_EXPORT_MAX_BYTES ||
    bytes[0] !== 0xef ||
    bytes[1] !== 0xbb ||
    bytes[2] !== 0xbf
  )
    throw new Error('invalid_order_export')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3))
  if (!text.endsWith('\r\n')) throw new Error('invalid_order_export')
  const rows = parseCatalogCsvCells(text, {
    maxRows: ORDER_EXPORT_MAX_ROWS + 1,
    maxColumns: ORDER_EXPORT_COLUMNS.length,
    maxCellCharacters: 4096
  })
  if (rows.length !== parsed.rows + 1 || JSON.stringify(rows[0]) !== JSON.stringify(ORDER_EXPORT_COLUMNS))
    throw new Error('invalid_order_export')
  for (const row of rows.slice(1)) {
    if (
      row.length !== ORDER_EXPORT_COLUMNS.length ||
      row.some((cell) => cell.includes('\u0000') || /^[=+\-@]/u.test(cell.trimStart()))
    )
      throw new Error('invalid_order_export')
  }
}
