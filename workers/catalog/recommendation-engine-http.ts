import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from './authorization'
import {
  readD1RecommendationPolicy,
  updateD1RecommendationPolicy,
  generateD1Recommendations,
  recordD1RecommendationEvent,
  getD1RecommendationMetrics,
  RecommendationEngineError
} from './recommendation-engine'

import type { Sector } from '../../shared/recommendation-engine'

export interface RecommendationEngineHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin?: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: () => string
}

const SECURITY_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  pragma: 'no-cache',
  vary: 'Cookie',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive'
}

export function ownsRecommendationEngineNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (
      /^\/api\/catalog\/recommendations(?:\/|$)/.test(value) ||
      /^\/api\/admin\/recommendations(?:\/|$)/.test(value)
    ) {
      return true
    }
    try {
      const decoded = decodeURIComponent(value)
      if (decoded === value) break
      value = decoded
    } catch {
      break
    }
  }
  return false
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: SECURITY_HEADERS
  })
}

function errorResponse(code: string, status: number, message?: string): Response {
  return jsonResponse({ error: { code, message: message ?? code } }, status)
}

function adaptCookieConfig(
  config: SessionCookieConfiguration | { secretKey?: string; password?: string; maxAgeSeconds?: number }
): SessionCookieConfiguration {
  const cfg = config as { password?: string; secretKey?: string; maxAgeSeconds?: number }
  return {
    password: cfg?.password ?? cfg?.secretKey ?? 'synthetic-long-secret-key-at-least-32-chars!',
    maxAgeSeconds: cfg?.maxAgeSeconds ?? 86400
  }
}

async function checkAdminAuth(
  database: D1Database,
  claims: { identityId: string; sessionId: string; sessionVersion: number },
  now?: string
): Promise<boolean> {
  const auth = await authorizeD1Session(database, claims, 'administration.manage', { now })
  if (auth.allowed) return true
  const catAuth = await authorizeD1Session(database, claims, 'catalog.write', { now })
  return catAuth.allowed
}

export async function handleRecommendationEngineHttp(
  request: Request,
  deps: RecommendationEngineHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsRecommendationEngineNamespace(path)) {
    return null
  }

  const cookieConfig = adaptCookieConfig(deps.sessionCookieConfiguration)
  const method = request.method
  const now = deps.now ? deps.now() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  try {
    // 1. Admin endpoints
    if (/^\/api\/admin\/recommendations(?:\/|$)/.test(path)) {
      const claims = await verifySessionCookie(request, cookieConfig)
      if (!claims) {
        return errorResponse('unauthenticated', 401)
      }

      const authorized = await checkAdminAuth(deps.database, claims, now)
      if (!authorized) {
        return errorResponse('forbidden', 403)
      }

      if (path === '/api/admin/recommendations/policy') {
        if (method === 'GET') {
          const policy = await readD1RecommendationPolicy(deps.database)
          return jsonResponse({ policy })
        }
        if (method === 'PUT') {
          const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
          if (!body || typeof body !== 'object') return errorResponse('invalid_input', 400)
          const updated = await updateD1RecommendationPolicy(deps.database, claims.identityId, body as never, now)
          return jsonResponse({ policy: updated })
        }
        return errorResponse('method_not_allowed', 405)
      }

      if (path === '/api/admin/recommendations/metrics') {
        if (method === 'GET') {
          const period = Number(url.searchParams.get('periodDays') ?? 30)
          const metrics = await getD1RecommendationMetrics(deps.database, period, now)
          return jsonResponse({ metrics })
        }
        return errorResponse('method_not_allowed', 405)
      }

      return errorResponse('not_found', 404)
    }

    // 2. Public / Storefront Catalog recommendations endpoints
    if (path === '/api/catalog/recommendations') {
      if (method === 'GET') {
        const targetProductId = url.searchParams.get('targetProductId') ?? undefined
        const sector = (url.searchParams.get('sector') as Sector | null) ?? undefined
        const limit = Number(url.searchParams.get('limit') ?? 4)
        const cartProductIds = url.searchParams.getAll('cartProductIds')
        const recs = await generateD1Recommendations(
          deps.database,
          { targetProductId, sector, limit, cartProductIds },
          now
        )
        return jsonResponse(recs)
      }

      if (method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
        const recs = await generateD1Recommendations(deps.database, body as never, now)
        return jsonResponse(recs)
      }

      return errorResponse('method_not_allowed', 405)
    }

    if (path === '/api/catalog/recommendations/events' && method === 'POST') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body !== 'object') {
        return errorResponse('invalid_input', 400)
      }
      const recorded = await recordD1RecommendationEvent(deps.database, body as never, now)
      return jsonResponse({ event: recorded }, 201)
    }

    return errorResponse('not_found', 404)
  } catch (err) {
    if (err instanceof RecommendationEngineError) {
      const statusMap: Record<string, number> = {
        invalid_input: 400,
        unauthenticated: 401,
        forbidden: 403,
        not_found: 404,
        version_conflict: 409,
        service_unavailable: 503
      }
      const status = statusMap[err.code] ?? 400
      return errorResponse(err.code, status)
    }
    return errorResponse('service_unavailable', 500)
  }
}
