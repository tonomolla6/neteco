import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { buildD1AdminOrderReadQuery } from './admin-orders'
import { parseAdminOrderQuery } from './admin-orders-http'
import {
  ORDER_EXPORT_COLUMNS,
  ORDER_EXPORT_MAX_BYTES,
  ORDER_EXPORT_MAX_ROWS,
  orderExportCsvCell,
  orderExportQuerySchema,
  verifyOrderExportCsv,
  type OrderExportMetadata
} from '../../shared/order-export'
export class OrderExportError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'export_too_large'
      | 'unavailable'
  ) {
    super(code)
  }
}
export interface OrderExportResult {
  csv: string
  metadata: OrderExportMetadata
}
const header = '\uFEFF' + ORDER_EXPORT_COLUMNS.map(orderExportCsvCell).join(',') + '\r\n'
const headerBytes = new TextEncoder().encode(header).byteLength
const fields = ORDER_EXPORT_COLUMNS.map((column) => (column === 'totalGrossCents' ? 'total' : column))
// ECMAScript trimStart whitespace, matching the CSV formula protection.
const whitespace =
  'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)'
function cellBytes(field: string) {
  const text = `COALESCE(CAST(${field} AS TEXT),'')`
  return `(length(CAST(${text} AS BLOB)) + length(${text}) - length(replace(${text},'"','')) + 2 + CASE WHEN substr(ltrim(${text},${whitespace}),1,1) IN ('=','+','-','@') THEN 1 ELSE 0 END)`
}
async function finalAuthority(database: D1Database, claims: VerifiedSessionClaims, now: string | null) {
  const row = await database
    .prepare(
      `WITH clock AS (SELECT COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AS instant)
    SELECT i.id, s.mfa_verified,
      (i.email_verified_at IS NOT NULL AND i.email_verified_at<=clock.instant) AS email_verified,
      EXISTS(SELECT 1 FROM identity_roles assigned JOIN role_permissions granted ON granted.role_code=assigned.role_code
        WHERE assigned.identity_id=i.id AND granted.permission_code='administration.manage'
          AND assigned.granted_at<=clock.instant AND (assigned.expires_at IS NULL OR assigned.expires_at>clock.instant)) AS permitted
    FROM auth_sessions s JOIN identities i ON i.id=s.identity_id CROSS JOIN clock
    WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND s.session_version=i.session_version
      AND s.revoked_at IS NULL AND s.created_at<=clock.instant AND s.expires_at>clock.instant AND i.status IN ('pending','active')`
    )
    .bind(now, claims.sessionId, claims.identityId, claims.sessionVersion)
    .first<{ id: string; mfa_verified: number; email_verified: number; permitted: number }>()
  if (!row) throw new OrderExportError('unauthenticated')
  if (!row.email_verified) throw new OrderExportError('email_unverified')
  if (!row.mfa_verified) throw new OrderExportError('mfa_required')
  if (!row.permitted) throw new OrderExportError('forbidden')
}
export async function exportD1AdminOrders(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  parameters: URLSearchParams,
  options: { now?: () => string } = {}
): Promise<OrderExportResult> {
  try {
    if (!claims) throw new OrderExportError('unauthenticated')
    const instant = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    const authority = await authorizeD1Session(database, claims, 'administration.manage', { now: instant })
    if (!authority.allowed) throw new OrderExportError(authority.code)
    if (!orderExportQuerySchema.safeParse(Object.fromEntries(parameters)).success)
      throw new OrderExportError('invalid_input')
    const query = parseAdminOrderQuery(parameters)
    if (!query) throw new OrderExportError('invalid_input')
    const read = buildD1AdminOrderReadQuery(instant, query)
    const bytesSql = fields.map((field) => cellBytes(field)).join(' + ')
    const result = await database
      .prepare(
        `WITH export_candidates AS MATERIALIZED (
      SELECT summary.*, row_number() OVER (ORDER BY ${read.projectedOrderSql}) AS exportOrdinal
      FROM (${read.rowsSql}) summary LIMIT ${ORDER_EXPORT_MAX_ROWS + 1}
    ), export_measure AS MATERIALIZED (
      SELECT count(*) AS rowCount, ${headerBytes} + COALESCE(SUM(${bytesSql} + 17),0) AS totalBytes FROM export_candidates
    ) SELECT measure.rowCount, measure.totalBytes, candidate.exportOrdinal,
      ${fields.map((field, index) => `candidate.${field} AS ${ORDER_EXPORT_COLUMNS[index]}`).join(',')}
      FROM export_measure measure LEFT JOIN export_candidates candidate
        ON measure.rowCount<=${ORDER_EXPORT_MAX_ROWS} AND measure.totalBytes<=${ORDER_EXPORT_MAX_BYTES}
      ORDER BY candidate.exportOrdinal`
      )
      .bind(...read.parameters)
      .all<Record<string, unknown>>()
    if (!result.success || !result.results?.length) throw new OrderExportError('unavailable')
    const first = result.results[0]!
    const rows = first.rowCount,
      bytes = first.totalBytes
    if (
      !Number.isSafeInteger(rows) ||
      !Number.isSafeInteger(bytes) ||
      (rows as number) < 0 ||
      (bytes as number) < headerBytes
    )
      throw new OrderExportError('unavailable')
    if ((rows as number) > ORDER_EXPORT_MAX_ROWS || (bytes as number) > ORDER_EXPORT_MAX_BYTES)
      throw new OrderExportError('export_too_large')
    const actual = rows === 0 ? [] : result.results
    if (actual.length !== rows || result.results.some((row) => row.rowCount !== rows || row.totalBytes !== bytes))
      throw new OrderExportError('unavailable')
    let csv = header
    for (const [index, row] of actual.entries()) {
      if (row.exportOrdinal !== index + 1) throw new OrderExportError('unavailable')
      const values = ORDER_EXPORT_COLUMNS.map((column) => {
        const value = row[column]
        if (column === 'totalGrossCents' || column === 'lines') {
          if (!Number.isSafeInteger(value) || (value as number) < 0) throw new OrderExportError('unavailable')
          return value as number
        }
        if (value === null && ['company', 'city', 'fulfillmentStatus'].includes(column)) return ''
        if (typeof value !== 'string' || value.length > 4096 || value.includes('\u0000'))
          throw new OrderExportError('unavailable')
        return value
      })
      csv += values.map(orderExportCsvCell).join(',') + '\r\n'
    }
    const metadata: OrderExportMetadata = { source: 'cloudflare', rows: rows as number, bytes: bytes as number }
    verifyOrderExportCsv(new TextEncoder().encode(csv), metadata)
    await finalAuthority(database, claims, options.now?.() ?? null)
    return { csv, metadata }
  } catch (error) {
    if (error instanceof OrderExportError) throw error
    throw new OrderExportError('unavailable')
  }
}
