import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { ORDER_EXPORT_CONTENT_TYPE, ORDER_EXPORT_FILENAME, ORDER_EXPORT_HEADERS } from '../../shared/order-export'
import { exportD1AdminOrders, OrderExportError } from './order-export'
export interface OrderExportHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  edgeLimiter: RateLimit
  rateLimitPepper: string
  now?: () => string
}
export async function handleOrderExportHttp(
  request: Request,
  deps: OrderExportHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/api/admin/orders/export.csv') return null
  const headers = {
    'Cache-Control': 'private, no-store',
    Pragma: 'no-cache',
    Vary: 'Cookie',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Referrer-Policy': 'no-referrer'
  }
  const error = (code: string, status: number, extra: Record<string, string> = {}) =>
    Response.json({ error: { code } }, { status, headers: { ...headers, ...extra } })
  if (request.method !== 'GET') return error('method_not_allowed', 405, { Allow: 'GET' })
  try {
    const origin = new URL(deps.origin)
    if (origin.protocol !== 'https:' || origin.origin !== deps.origin || deps.origin.length > 2000)
      return error('unavailable', 503)
    if (
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    const limited = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, deps.rateLimitPepper, 'admin-orders')
    if (limited !== 'allowed')
      return error(limited === 'limited' ? 'rate_limited' : 'unavailable', limited === 'limited' ? 429 : 503)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    const result = await exportD1AdminOrders(deps.database, claims, url.searchParams, { now: deps.now })
    return new Response(result.csv, {
      status: 200,
      headers: {
        ...headers,
        'Content-Type': ORDER_EXPORT_CONTENT_TYPE,
        'Content-Disposition': `attachment; filename="${ORDER_EXPORT_FILENAME}"`,
        [ORDER_EXPORT_HEADERS.source]: result.metadata.source,
        [ORDER_EXPORT_HEADERS.rows]: String(result.metadata.rows),
        [ORDER_EXPORT_HEADERS.bytes]: String(result.metadata.bytes)
      }
    })
  } catch (cause) {
    if (cause instanceof OrderExportError)
      return error(
        cause.code,
        cause.code === 'unauthenticated'
          ? 401
          : cause.code === 'invalid_input'
            ? 400
            : cause.code === 'export_too_large'
              ? 409
              : cause.code === 'unavailable'
                ? 503
                : 403
      )
    return error('unavailable', 503)
  }
}
