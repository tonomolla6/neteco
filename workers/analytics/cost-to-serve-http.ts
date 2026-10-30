import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import {
  calculateOrderCostToServe,
  getOrderCostToServe,
  listOrderCostToServe,
  readCostToServeSummary
} from './cost-to-serve'
import { CostToServeError, type ProfitabilityTier } from '../../shared/cost-to-serve'

export interface CostToServeHttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration | null
  now?: () => string
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
      ...headers
    }
  })
}

function failure(code: string, status = 500): Response {
  return jsonResponse({ error: { code } }, status)
}

export function ownsCostToServeNamespace(pathname: string): boolean {
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/admin\/analytics\/cost-to-serve(?:[/\\%]|$)/i.test(pathname)) return true
    try {
      const next = decodeURIComponent(pathname)
      if (next === pathname) break
      pathname = next
    } catch {
      break
    }
  }
  return false
}

export async function handleCostToServeHttp(
  request: Request,
  deps: CostToServeHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCostToServeNamespace(url.pathname)) return null

  const now = deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  // CSRF validation
  const origin = request.headers.get('origin')
  if (origin && origin !== deps.origin) {
    return failure('csrf_rejected', 403)
  }

  // Session verification
  if (!deps.sessionCookieConfiguration) {
    return failure('service_unavailable', 503)
  }

  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) {
    return failure('unauthenticated', 401)
  }

  // Authorization check
  const auth = await authorizeD1Session(deps.database, claims, 'administration.manage', {
    now,
    requireMfa: true
  })
  if (!auth.allowed) {
    if (auth.code === 'unauthenticated') return failure('unauthenticated', 401)
    return failure('forbidden', 403)
  }

  try {
    // 1. POST /api/admin/analytics/cost-to-serve/calculate
    if (url.pathname === '/api/admin/analytics/cost-to-serve/calculate' && request.method === 'POST') {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return failure('invalid_input', 400)
      }

      const commandId = request.headers.get('idempotency-key') ?? request.headers.get('x-command-id') ?? undefined

      const result = await calculateOrderCostToServe(
        deps.database,
        claims,
        typeof body === 'object' && body !== null && commandId ? { ...body, commandId } : body,
        { now: () => now }
      )
      return jsonResponse(result, 200)
    }

    // 2. GET /api/admin/analytics/cost-to-serve/orders
    if (url.pathname === '/api/admin/analytics/cost-to-serve/orders' && request.method === 'GET') {
      const from = url.searchParams.get('from') || undefined
      const to = url.searchParams.get('to') || undefined
      const profitabilityTier = url.searchParams.get('profitabilityTier') || undefined
      const orderId = url.searchParams.get('orderId') || undefined
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
      const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined

      const result = await listOrderCostToServe(
        deps.database,
        claims,
        { from, to, profitabilityTier: profitabilityTier as ProfitabilityTier | undefined, orderId, limit, offset },
        { now: () => now }
      )
      return jsonResponse(result, 200)
    }

    // 3. GET /api/admin/analytics/cost-to-serve/orders/:id
    const orderMatch = url.pathname.match(/^\/api\/admin\/analytics\/cost-to-serve\/orders\/([^/]+)$/)
    if (orderMatch && request.method === 'GET') {
      const orderId = decodeURIComponent(orderMatch[1]!)
      const record = await getOrderCostToServe(deps.database, claims, orderId, { now: () => now })
      if (!record) return failure('not_found', 404)
      return jsonResponse(record, 200)
    }

    // 4. GET /api/admin/analytics/cost-to-serve
    if (url.pathname === '/api/admin/analytics/cost-to-serve' && request.method === 'GET') {
      const from = url.searchParams.get('from') || undefined
      const to = url.searchParams.get('to') || undefined
      const profitabilityTier = url.searchParams.get('profitabilityTier') || undefined
      const orderId = url.searchParams.get('orderId') || undefined

      const summary = await readCostToServeSummary(
        deps.database,
        claims,
        { from, to, profitabilityTier: profitabilityTier as ProfitabilityTier | undefined, orderId },
        { now: () => now }
      )
      return jsonResponse(summary, 200)
    }

    return failure('method_not_allowed', 405)
  } catch (err: unknown) {
    if (err instanceof CostToServeError) {
      if (err.code === 'invalid_input') return failure('invalid_input', 400)
      if (err.code === 'unauthenticated') return failure('unauthenticated', 401)
      if (err.code === 'forbidden') return failure('forbidden', 403)
      if (err.code === 'not_found') return failure('not_found', 404)
      if (err.code === 'conflict') return failure('conflict', 409)
    }
    return failure('service_unavailable', 503)
  }
}
