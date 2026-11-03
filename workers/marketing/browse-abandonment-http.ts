import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import {
  readD1BrowsePolicy,
  updateD1BrowsePolicy,
  readD1BrowsePreferences,
  updateD1BrowsePreferences,
  recordD1BrowseEvent,
  evaluateD1BrowseAbandonment,
  getD1BrowseIncrementalityMetrics,
  BrowseAbandonmentError
} from './browse-abandonment'

export interface BrowseAbandonmentHttpDependencies {
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

export function ownsBrowseAbandonmentNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (
      /^\/api\/account\/browse-preferences(?:\/|$)/.test(value) ||
      /^\/api\/admin\/browse-recovery(?:\/|$)/.test(value) ||
      /^\/api\/marketing\/browse-abandonment(?:\/|$)/.test(value)
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

async function checkAdminAuth(
  database: D1Database,
  claims: { identityId: string; sessionId: string; sessionVersion: number },
  now?: string
): Promise<boolean> {
  const auth = await authorizeD1Session(database, claims, 'administration.manage', { now })
  return auth.allowed
}

function adaptCookieConfig(
  config: SessionCookieConfiguration | { secretKey?: string; password?: string; maxAgeSeconds?: number }
): SessionCookieConfiguration | null {
  const cfg = config as { password?: string; secretKey?: string; maxAgeSeconds?: number }
  // Fail closed: never fall back to a built-in session password.
  const password = cfg?.password ?? cfg?.secretKey
  if (typeof password !== 'string' || !password) return null
  return { password, maxAgeSeconds: cfg?.maxAgeSeconds ?? 86400 }
}

/** Same-origin mutation policy for storefront browse commands (Origin is mandatory). */
function crossOriginRejected(request: Request, origin: string | undefined): boolean {
  return !origin || request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site'
}

/** The customer always comes from the verified D1 session, never from the request body. */
async function sessionCustomerId(
  database: D1Database,
  claims: { identityId: string; sessionId: string; sessionVersion: number },
  now: string
): Promise<string | null> {
  const row = await database
    .prepare(
      `SELECT i.customer_id FROM auth_sessions s JOIN identities i ON i.id = s.identity_id
       WHERE s.id = ?1 AND s.identity_id = ?2 AND s.session_version = ?3
         AND s.session_version = i.session_version AND s.revoked_at IS NULL
         AND s.created_at <= ?4 AND s.expires_at > ?4 AND i.status IN ('pending', 'active')`
    )
    .bind(claims.sessionId, claims.identityId, claims.sessionVersion, now)
    .first<{ customer_id: string | null }>()
  return row?.customer_id ?? null
}

export async function handleBrowseAbandonmentHttp(
  request: Request,
  deps: BrowseAbandonmentHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsBrowseAbandonmentNamespace(path)) {
    return null
  }

  const cookieConfig = adaptCookieConfig(deps.sessionCookieConfiguration)
  if (!cookieConfig) return errorResponse('service_unavailable', 503)
  const method = request.method
  const now = deps.now ? deps.now() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  try {
    // 1. Admin endpoints
    if (/^\/api\/admin\/browse-recovery(?:\/|$)/.test(path)) {
      const claims = await verifySessionCookie(request, cookieConfig)
      if (!claims) {
        return errorResponse('unauthenticated', 401)
      }

      const authorized = await checkAdminAuth(deps.database, claims, now)
      if (!authorized) {
        return errorResponse('forbidden', 403)
      }

      if (path === '/api/admin/browse-recovery/policy') {
        if (method === 'GET') {
          const policy = await readD1BrowsePolicy(deps.database)
          return jsonResponse({ policy })
        }
        if (method === 'PUT') {
          const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
          if (!body || typeof body !== 'object') return errorResponse('invalid_input', 400)
          const updated = await updateD1BrowsePolicy(deps.database, claims.identityId, body as never, now)
          return jsonResponse({ policy: updated })
        }
        return errorResponse('method_not_allowed', 405)
      }

      if (path === '/api/admin/browse-recovery/metrics') {
        if (method === 'GET') {
          const metrics = await getD1BrowseIncrementalityMetrics(deps.database, now)
          return jsonResponse({ metrics })
        }
        return errorResponse('method_not_allowed', 405)
      }

      return errorResponse('not_found', 404)
    }

    // 2. Account Preferences endpoints
    if (/^\/api\/account\/browse-preferences(?:\/|$)/.test(path)) {
      const claims = await verifySessionCookie(request, cookieConfig)
      if (!claims) {
        return errorResponse('unauthenticated', 401)
      }

      const identity = await deps.database
        .prepare('SELECT customer_id FROM identities WHERE id = ?1')
        .bind(claims.identityId)
        .first<{ customer_id: string }>()

      if (!identity || !identity.customer_id) {
        return errorResponse('forbidden', 403)
      }

      const customerId = identity.customer_id

      if (method === 'GET') {
        const preferences = await readD1BrowsePreferences(deps.database, customerId)
        return jsonResponse({ preferences })
      }

      if (method === 'PUT') {
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
        if (!body || typeof body !== 'object') return errorResponse('invalid_input', 400)
        const updated = await updateD1BrowsePreferences(deps.database, customerId, body as never, now)
        return jsonResponse({ preferences: updated })
      }

      return errorResponse('method_not_allowed', 405)
    }

    // 3. Marketing Storefront / Internal endpoints
    if (
      (path === '/api/marketing/browse-abandonment/events' || path === '/api/marketing/browse-abandonment/evaluate') &&
      method === 'POST'
    ) {
      if (crossOriginRejected(request, deps.origin)) return errorResponse('csrf_rejected', 403)
      const claims = await verifySessionCookie(request, cookieConfig)
      if (!claims) return errorResponse('unauthenticated', 401)
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('invalid_input', 400)

      if (path === '/api/marketing/browse-abandonment/events') {
        // Events are always attributed to the session customer; a body customerId is ignored.
        const customerId = await sessionCustomerId(deps.database, claims, now)
        if (!customerId) return errorResponse('forbidden', 403)
        const event = await recordD1BrowseEvent(deps.database, customerId, body as never, now)
        return jsonResponse({ event }, 201)
      }

      // Evaluation targets any customer and may create dispatches: internal/admin trigger only.
      const auth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
      if (!auth.allowed) {
        return errorResponse(
          auth.code === 'unauthenticated' ? 'unauthenticated' : 'forbidden',
          auth.code === 'unauthenticated' ? 401 : 403
        )
      }
      if (typeof body.customerId !== 'string' || typeof body.productId !== 'string') {
        return errorResponse('invalid_input', 400)
      }
      const evaluation = await evaluateD1BrowseAbandonment(deps.database, body.customerId, body.productId, now)
      return jsonResponse({ evaluation })
    }

    return errorResponse('not_found', 404)
  } catch (err) {
    if (err instanceof BrowseAbandonmentError) {
      const statusMap: Record<string, number> = {
        invalid_input: 400,
        unauthenticated: 401,
        forbidden: 403,
        not_found: 404,
        version_conflict: 409
      }
      const status = statusMap[err.code] ?? 400
      return errorResponse(err.code, status)
    }
    return errorResponse('service_unavailable', 500)
  }
}
