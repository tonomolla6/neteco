import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import { createD1SupportRca, updateD1SupportRca, verifyD1SupportRca, readD1SupportRca, listD1SupportRcas } from './rca'
import { SupportRcaError } from '../../shared/support-rca'

export interface SupportRcaHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
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

export function ownsSupportRcaNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (/^\/api\/admin\/support\/rca(?:\/|$)/.test(value)) {
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

async function checkRcaAuth(
  database: D1Database,
  claims: { identityId: string; sessionId: string; sessionVersion: number },
  now?: string
): Promise<boolean> {
  const auth = await authorizeD1Session(database, claims, 'support.rca', { now })
  if (auth.allowed) return true
  const fallbackAuth = await authorizeD1Session(database, claims, 'support.manage', { now })
  return fallbackAuth.allowed
}

export async function handleSupportRcaHttp(
  request: Request,
  deps: SupportRcaHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsSupportRcaNamespace(path)) {
    return null
  }

  // 1. Session verification
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) {
    return errorResponse('unauthenticated', 401)
  }

  // 2. Authorization before operation
  const authorized = await checkRcaAuth(deps.database, claims, deps.now?.())
  if (!authorized) {
    return errorResponse('forbidden', 403)
  }

  const recheck = async (): Promise<boolean> => checkRcaAuth(deps.database, claims, deps.now?.())

  const method = request.method
  const idempotencyKey = request.headers.get('idempotency-key') ?? crypto.randomUUID()

  try {
    // GET /api/admin/support/rca
    if (method === 'GET' && path === '/api/admin/support/rca') {
      const category = url.searchParams.get('category') ?? undefined
      const status = url.searchParams.get('status') ?? undefined
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
      const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined

      const result = await listD1SupportRcas(deps.database, { category, status, limit, offset })
      if (!(await recheck())) return errorResponse('forbidden', 403)
      return jsonResponse(result, 200)
    }

    // POST /api/admin/support/rca
    if (method === 'POST' && path === '/api/admin/support/rca') {
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_input', 400, 'Payload JSON requerido')

      const result = await createD1SupportRca(deps.database, claims, body, {
        idempotencyKey,
        now: deps.now
      })
      if (!(await recheck())) return errorResponse('forbidden', 403)
      return jsonResponse(result, 201)
    }

    // Matches /api/admin/support/rca/:id or /api/admin/support/rca/:id/verify
    const match = path.match(/^\/api\/admin\/support\/rca\/([^/]+)(?:\/(verify))?$/)
    if (!match) {
      return errorResponse('not_found', 404)
    }

    const rcaId = match[1]!
    const isVerify = match[2] === 'verify'

    // POST /api/admin/support/rca/:id/verify
    if (method === 'POST' && isVerify) {
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_input', 400, 'Payload JSON requerido')

      const result = await verifyD1SupportRca(deps.database, claims, rcaId, body, {
        idempotencyKey,
        now: deps.now
      })
      if (!(await recheck())) return errorResponse('forbidden', 403)
      return jsonResponse(result, 200)
    }

    // GET /api/admin/support/rca/:id
    if (method === 'GET' && !isVerify) {
      const rca = await readD1SupportRca(deps.database, rcaId)
      if (!rca) return errorResponse('not_found', 404, 'RCA no encontrado')
      if (!(await recheck())) return errorResponse('forbidden', 403)
      return jsonResponse(rca, 200)
    }

    // PUT /api/admin/support/rca/:id
    if (method === 'PUT' && !isVerify) {
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_input', 400, 'Payload JSON requerido')

      const result = await updateD1SupportRca(deps.database, claims, rcaId, body, {
        idempotencyKey,
        now: deps.now
      })
      if (!(await recheck())) return errorResponse('forbidden', 403)
      return jsonResponse(result, 200)
    }

    return errorResponse('method_not_allowed', 405)
  } catch (err) {
    if (err instanceof SupportRcaError) {
      const statusMap: Record<string, number> = {
        invalid_input: 400,
        not_found: 404,
        concurrency_conflict: 409,
        idempotency_conflict: 409,
        unauthorized: 403
      }
      return errorResponse(err.code, statusMap[err.code] ?? 500, err.message)
    }
    return errorResponse('internal_server_error', 500, err instanceof Error ? err.message : 'Error interno')
  }
}
