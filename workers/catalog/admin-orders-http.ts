import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { AdminOrderCursorError, listD1AdminOrdersByCursor } from './admin-order-cursor'
import {
  listD1AdminOrders,
  readD1AdminOrder,
  readD1AdminStats,
  readD1AdminOperations,
  type AdminOrderQuery,
  type AdminReadResult
} from './admin-orders'

export interface AdminOrdersHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  /** Configured authority, never Host/forwarded/request input. */
  origin: string
  now?: string
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
      ...extra
    }
  })
}

const VALUES = {
  bucket: ['todos', 'por_preparar', 'por_cobrar', 'incidencia'],
  sortKey: ['id', 'createdAt', 'name', 'total'],
  sortDir: ['asc', 'desc'],
  paymentStatus: ['pending', 'processing', 'authorized', 'captured', 'failed', 'cancelled', 'stock_exception'],
  orderStatus: ['awaiting_payment', 'cancelled'],
  shippingMethod: ['pickup', 'parcel', 'own_delivery'],
  customerType: ['b2c', 'b2b']
} as const

export function parseAdminOrderQuery(parameters: URLSearchParams): AdminOrderQuery | null {
  const allowed = new Set(['q', 'page', 'perPage', 'from', 'to', ...Object.keys(VALUES)])
  for (const key of parameters.keys()) if (!allowed.has(key) || parameters.getAll(key).length !== 1) return null
  const pageRaw = parameters.get('page') ?? '1'
  const sizeRaw = parameters.get('perPage') ?? '25'
  if (!/^[1-9]\d{0,6}$/.test(pageRaw) || !/^[1-9]\d{0,2}$/.test(sizeRaw)) return null
  const page = Number(pageRaw),
    perPage = Number(sizeRaw)
  if (page > 1000000 || perPage > 100) return null
  const q = (parameters.get('q') ?? '').trim()
  if (q.length > 120 || [...q].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    return null
  const query = { page, perPage, q, bucket: 'todos', sortKey: 'createdAt', sortDir: 'desc' } as AdminOrderQuery
  for (const [key, values] of Object.entries(VALUES)) {
    const value = parameters.get(key)
    if (value === null) continue
    if (!(values as readonly string[]).includes(value)) return null
    Object.assign(query, { [key]: value })
  }
  for (const key of ['from', 'to'] as const) {
    const value = parameters.get(key)
    if (value === null) continue
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value ||
      value > '9999-12-30'
    )
      return null
    query[key] = value
  }
  if (query.from && query.to && query.from > query.to) return null
  return query
}

function response<T>(result: AdminReadResult<T>) {
  if (result.outcome === 'found') return json(result.data)
  if (result.outcome === 'not_found') return json({ error: { code: 'not_found' } }, 404)
  return json({ error: { code: result.code } }, result.code === 'unauthenticated' ? 401 : 403)
}

/** Returns null only for paths owned by another router. Unsupported mutations
 * on these read-only resources never fall through to legacy backends. */
export async function handleD1AdminOrdersRequest(
  request: Request,
  deps: AdminOrdersHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const detail = /^\/api\/admin\/orders\/([^/]+)\/detail$/.exec(url.pathname)
  const supported =
    ['/api/admin/orders', '/api/admin/stats', '/api/admin/operations'].includes(url.pathname) || !!detail
  if (!supported) return null
  if (request.method !== 'GET') return json({ error: { code: 'method_not_allowed' } }, 405, { Allow: 'GET' })
  try {
    const origin = new URL(deps.origin)
    if (origin.protocol !== 'https:' || origin.origin !== deps.origin || deps.origin.length > 2000)
      throw new Error('invalid_admin_orders_origin')
    // Private GET navigation/SSR commonly has no Origin. An explicit Origin
    // must match configured authority exactly; cross-site fetches fail before
    // any sealed-cookie processing or live D1 authorization.
    if (
      (url.searchParams.has('pagination') && url.origin !== deps.origin) ||
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return json({ error: { code: 'csrf_rejected' } }, 403)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return json({ error: { code: 'unauthenticated' } }, 401)
    const now = deps.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    if (detail) return response(await readD1AdminOrder(deps.database, claims, now, detail[1]!))
    if (url.pathname === '/api/admin/stats') return response(await readD1AdminStats(deps.database, claims, now))
    if (url.pathname === '/api/admin/operations')
      return response(await readD1AdminOperations(deps.database, claims, now))
    if (url.searchParams.has('pagination')) {
      if (
        url.searchParams.get('pagination') !== 'cursor' ||
        ['pagination', 'after', 'before'].some((key) => url.searchParams.getAll(key).length > 1) ||
        (url.searchParams.has('after') && url.searchParams.has('before'))
      )
        return json({ error: { code: 'invalid_input' } }, 400)
      const parameters = new URLSearchParams(url.searchParams)
      for (const key of ['pagination', 'after', 'before']) parameters.delete(key)
      const query = parseAdminOrderQuery(parameters)
      if (!query) return json({ error: { code: 'invalid_input' } }, 400)
      return response(
        await listD1AdminOrdersByCursor(deps.database, claims, now, query, {
          password: deps.sessionCookieConfiguration.password,
          ...(url.searchParams.has('after') ? { after: url.searchParams.get('after')! } : {}),
          ...(url.searchParams.has('before') ? { before: url.searchParams.get('before')! } : {})
        })
      )
    }
    const query = parseAdminOrderQuery(url.searchParams)
    if (!query) return json({ error: { code: 'invalid_input' } }, 400)
    return response(await listD1AdminOrders(deps.database, claims, now, query))
  } catch (error) {
    if (error instanceof AdminOrderCursorError && error.code === 'invalid_cursor')
      return json({ error: { code: 'invalid_input' } }, 400)
    // Never leak SQL, credentials, private snapshots or database error details.
    return json({ error: { code: 'service_unavailable' } }, 503)
  }
}
