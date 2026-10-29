import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import {
  createD1AudienceSegment,
  updateD1AudienceSegmentRules,
  estimateD1AudienceSegment,
  previewD1AudienceUsers,
  readD1AudienceSegment,
  listD1AudienceSegments,
  listD1AudienceSegmentVersions
} from './audiences'
import { AdminAudiencesError } from '../../shared/admin-audiences'

export interface AudiencesHttpDependencies {
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

export function ownsAudiencesNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (/^\/api\/admin\/audiences(?:\/|$)/.test(value)) {
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

async function checkAudiencesAuth(
  database: D1Database,
  claims: { identityId: string; sessionId: string; sessionVersion: number },
  now?: string
): Promise<boolean> {
  const auth = await authorizeD1Session(database, claims, 'audiences.manage', { now })
  if (auth.allowed) return true
  const fallbackAuth = await authorizeD1Session(database, claims, 'administration.manage', { now })
  return fallbackAuth.allowed
}

export async function handleAudiencesHttp(request: Request, deps: AudiencesHttpDependencies): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsAudiencesNamespace(path)) {
    return null
  }

  // 1. Session check
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) {
    return errorResponse('unauthenticated', 401)
  }

  // 2. Authorization
  const authorized = await checkAudiencesAuth(deps.database, claims, deps.now?.())
  if (!authorized) {
    return errorResponse('forbidden', 403)
  }

  const recheck = async (): Promise<boolean> => checkAudiencesAuth(deps.database, claims, deps.now?.())

  const method = request.method
  const idempotencyKey = request.headers.get('idempotency-key') ?? crypto.randomUUID()

  try {
    // GET /api/admin/audiences
    if (method === 'GET' && path === '/api/admin/audiences') {
      const status = url.searchParams.get('status') ?? undefined
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
      const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined

      const result = await listD1AudienceSegments(deps.database, { status, limit, offset })
      if (!(await recheck())) return errorResponse('forbidden', 403)
      return jsonResponse(result, 200)
    }

    // POST /api/admin/audiences
    if (method === 'POST' && path === '/api/admin/audiences') {
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_input', 400, 'Payload JSON requerido')

      const result = await createD1AudienceSegment(deps.database, claims, body, {
        idempotencyKey,
        now: deps.now
      })
      if (!(await recheck())) return errorResponse('forbidden', 403)
      return jsonResponse(result, 201)
    }

    // Matches /api/admin/audiences/:id or /estimate or /preview or /versions or /rules
    const match = path.match(/^\/api\/admin\/audiences\/([^/]+)(?:\/(rules|estimate|preview|versions))?$/)
    if (!match) {
      return errorResponse('not_found', 404)
    }

    const segmentId = match[1]!
    const action = match[2]

    // PUT /api/admin/audiences/:id/rules
    if (method === 'PUT' && action === 'rules') {
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_input', 400, 'Payload JSON requerido')

      const result = await updateD1AudienceSegmentRules(deps.database, claims, segmentId, body, {
        idempotencyKey,
        now: deps.now
      })
      if (!(await recheck())) return errorResponse('forbidden', 403)
      return jsonResponse(result, 200)
    }

    // POST /api/admin/audiences/:id/estimate
    if (method === 'POST' && action === 'estimate') {
      const result = await estimateD1AudienceSegment(deps.database, segmentId, { now: deps.now })
      if (!(await recheck())) return errorResponse('forbidden', 403)
      return jsonResponse(result, 200)
    }

    // GET /api/admin/audiences/:id/preview
    if (method === 'GET' && action === 'preview') {
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
      const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined
      const result = await previewD1AudienceUsers(deps.database, segmentId, { limit, offset })
      if (!(await recheck())) return errorResponse('forbidden', 403)
      return jsonResponse(result, 200)
    }

    // GET /api/admin/audiences/:id/versions
    if (method === 'GET' && action === 'versions') {
      const result = await listD1AudienceSegmentVersions(deps.database, segmentId)
      if (!(await recheck())) return errorResponse('forbidden', 403)
      return jsonResponse(result, 200)
    }

    // GET /api/admin/audiences/:id
    if (method === 'GET' && !action) {
      const segment = await readD1AudienceSegment(deps.database, segmentId)
      if (!segment) return errorResponse('not_found', 404, 'Segmento no encontrado')
      if (!(await recheck())) return errorResponse('forbidden', 403)
      return jsonResponse(segment, 200)
    }

    return errorResponse('method_not_allowed', 405)
  } catch (err) {
    if (err instanceof AdminAudiencesError) {
      const statusMap: Record<string, number> = {
        invalid_input: 400,
        not_found: 404,
        slug_taken: 409,
        concurrency_conflict: 409,
        idempotency_conflict: 409,
        unauthorized: 403
      }
      return errorResponse(err.code, statusMap[err.code] ?? 500, err.message)
    }
    return errorResponse('internal_server_error', 500, err instanceof Error ? err.message : 'Error interno')
  }
}
