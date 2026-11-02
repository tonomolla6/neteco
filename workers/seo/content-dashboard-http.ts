import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import { readSeoContentDashboard, recordSeoContentCost, syncSeoContentMetrics } from './content-dashboard'
import { SeoContentDashboardError } from '../../shared/seo-content-dashboard'

export interface SeoContentDashboardHttpDependencies {
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

export function ownsSeoContentDashboardNamespace(pathname: string): boolean {
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/admin\/seo\/dashboard(?:[/\\%]|$)/i.test(pathname)) return true
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

export async function handleSeoContentDashboardHttp(
  request: Request,
  deps: SeoContentDashboardHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsSeoContentDashboardNamespace(url.pathname)) return null

  const now = deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  // CSRF validation
  // Reads may omit Origin (same-origin navigations); mutations must prove it.
  const origin = request.headers.get('origin')
  if (request.method === 'GET' ? origin !== null && origin !== deps.origin : origin !== deps.origin) {
    return failure('csrf_rejected', 403)
  }
  if (request.headers.get('sec-fetch-site') === 'cross-site') {
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
    // 1. GET /api/admin/seo/dashboard
    if (url.pathname === '/api/admin/seo/dashboard' && request.method === 'GET') {
      const from = url.searchParams.get('from') ?? undefined
      const to = url.searchParams.get('to') ?? undefined
      const device = url.searchParams.get('device') ?? undefined
      const landingPath = url.searchParams.get('landingPath') ?? undefined
      const query = url.searchParams.get('query') ?? undefined

      const dashboard = await readSeoContentDashboard(
        deps.database,
        claims,
        { from, to, device, landingPath, query },
        { now: () => now }
      )
      return jsonResponse(dashboard, 200)
    }

    // 2. POST /api/admin/seo/dashboard/sync
    if (url.pathname === '/api/admin/seo/dashboard/sync' && request.method === 'POST') {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return failure('invalid_input', 400)
      }

      const commandId = request.headers.get('idempotency-key') ?? request.headers.get('x-command-id') ?? undefined

      const result = await syncSeoContentMetrics(deps.database, claims, body, {
        commandId,
        now: () => now
      })
      return jsonResponse(result, 200)
    }

    // 3. POST /api/admin/seo/dashboard/costs
    if (url.pathname === '/api/admin/seo/dashboard/costs' && request.method === 'POST') {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return failure('invalid_input', 400)
      }

      const commandId = request.headers.get('idempotency-key') ?? request.headers.get('x-command-id') ?? undefined

      const result = await recordSeoContentCost(deps.database, claims, body, {
        commandId,
        now: () => now
      })
      return jsonResponse(result, 200)
    }

    return failure('method_not_allowed', 405)
  } catch (err: unknown) {
    if (err instanceof SeoContentDashboardError) {
      if (err.code === 'invalid_input') return failure('invalid_input', 400)
      if (err.code === 'unauthenticated') return failure('unauthenticated', 401)
      if (err.code === 'forbidden') return failure('forbidden', 403)
      if (err.code === 'not_found') return failure('not_found', 404)
      if (err.code === 'conflict') return failure('conflict', 409)
    }
    return failure('service_unavailable', 503)
  }
}
