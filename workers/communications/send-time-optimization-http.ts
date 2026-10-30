import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  SendTimeOptimizationError,
  readD1SendTimePolicy,
  updateD1SendTimePolicy,
  evaluateD1SendTimeMessage,
  listD1SendTimeDecisions
} from './send-time-optimization'

export interface SendTimeOptimizationHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: () => string
  claimsResolver?: (request: Request) => Promise<VerifiedSessionClaims | null>
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

export function ownsSendTimeOptimizationNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (/^\/api\/admin\/marketing\/send-time(?:\/|$)/.test(value)) {
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

function mapSendTimeError(error: unknown): Response {
  if (error instanceof SendTimeOptimizationError) {
    switch (error.code) {
      case 'invalid_input':
        return errorResponse(error.code, 400)
      case 'unauthenticated':
        return errorResponse(error.code, 401)
      case 'forbidden':
      case 'email_unverified':
      case 'mfa_required':
        return errorResponse(error.code, 403)
      case 'not_found':
        return errorResponse(error.code, 404)
      case 'version_conflict':
      case 'idempotency_conflict':
        return errorResponse(error.code, 409)
      case 'service_unavailable':
        return errorResponse(error.code, 503)
      default:
        return errorResponse('internal_error', 500)
    }
  }
  return errorResponse('internal_error', 500)
}

export async function handleSendTimeOptimizationHttp(
  request: Request,
  deps: SendTimeOptimizationHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsSendTimeOptimizationNamespace(path)) {
    return null
  }

  // 1. Session check
  const claims = deps.claimsResolver
    ? await deps.claimsResolver(request)
    : await verifySessionCookie(request, deps.sessionCookieConfiguration)

  if (!claims) {
    return errorResponse('unauthenticated', 401)
  }

  // 2. Cross-origin check on mutations
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('origin')
    if (origin !== null && origin !== deps.origin) {
      return errorResponse('origin_forbidden', 403)
    }
  }

  // 3. Live authorization check
  const nowIso = deps.now ? deps.now() : undefined
  const auth = await authorizeD1Session(deps.database, claims, 'administration.manage', {
    now: nowIso,
    requireMfa: true
  })
  if (!auth.allowed) {
    const status = auth.code === 'unauthenticated' ? 401 : 403
    return errorResponse(auth.code, status)
  }

  const options = nowIso ? { now: () => nowIso } : undefined
  const sub = path.replace(/^\/api\/admin\/marketing\/send-time\/?/, '').replace(/\/$/, '')

  try {
    // GET /api/admin/marketing/send-time/policy
    if (request.method === 'GET' && sub === 'policy') {
      const policy = await readD1SendTimePolicy(deps.database, claims, options)
      return jsonResponse({ policy })
    }

    // PUT or POST /api/admin/marketing/send-time/policy
    if ((request.method === 'PUT' || request.method === 'POST') && sub === 'policy') {
      let body: Record<string, unknown>
      try {
        body = (await request.json()) as Record<string, unknown>
      } catch {
        return errorResponse('invalid_input', 400)
      }
      const commandId = String(body.commandId ?? crypto.randomUUID())
      const idempotencyKey = String(body.idempotencyKey ?? commandId)
      const { commandId: _c, idempotencyKey: _k, ...inputData } = body

      const policy = await updateD1SendTimePolicy(deps.database, claims, commandId, idempotencyKey, inputData, options)
      return jsonResponse({ policy })
    }

    // POST /api/admin/marketing/send-time/evaluate
    if (request.method === 'POST' && sub === 'evaluate') {
      let body: Record<string, unknown>
      try {
        body = (await request.json()) as Record<string, unknown>
      } catch {
        return errorResponse('invalid_input', 400)
      }
      const decisionId = String(body.decisionId ?? crypto.randomUUID())
      const commandId = String(body.commandId ?? crypto.randomUUID())
      const idempotencyKey = String(body.idempotencyKey ?? commandId)
      const { decisionId: _d, commandId: _c, idempotencyKey: _k, ...inputData } = body

      const decision = await evaluateD1SendTimeMessage(
        deps.database,
        claims,
        decisionId,
        commandId,
        idempotencyKey,
        inputData,
        options
      )
      return jsonResponse({ decision })
    }

    // GET /api/admin/marketing/send-time/decisions
    if (request.method === 'GET' && sub === 'decisions') {
      const customerId = url.searchParams.get('customerId') || undefined
      const status = url.searchParams.get('status') || undefined
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined

      const result = await listD1SendTimeDecisions(deps.database, claims, {
        customerId,
        status,
        limit
      })
      return jsonResponse(result)
    }

    return errorResponse('not_found', 404)
  } catch (error) {
    return mapSendTimeError(error)
  }
}
