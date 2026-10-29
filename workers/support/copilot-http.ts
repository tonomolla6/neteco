import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import {
  generateD1CopilotDraft,
  recordD1CopilotHumanApproval,
  recordD1CopilotAccuracyEvaluation,
  readD1CopilotInteraction,
  listD1CopilotInteractions
} from './copilot'
import { SupportCopilotError } from '../../shared/support-copilot'

export interface SupportCopilotHttpDependencies {
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

export function ownsSupportCopilotNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (/^\/api\/admin\/support\/copilot(?:\/|$)/.test(value)) {
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

async function checkCopilotAuth(
  database: D1Database,
  claims: { identityId: string; sessionId: string; sessionVersion: number },
  now?: string
): Promise<boolean> {
  const auth = await authorizeD1Session(database, claims, 'support.copilot', { now })
  if (auth.allowed) return true
  const fallbackAuth = await authorizeD1Session(database, claims, 'support.manage', { now })
  return fallbackAuth.allowed
}

export async function handleSupportCopilotHttp(
  request: Request,
  deps: SupportCopilotHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsSupportCopilotNamespace(path)) {
    return null
  }

  // 1. Session check
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) {
    return errorResponse('unauthenticated', 401)
  }

  // 2. Authorization
  const authorized = await checkCopilotAuth(deps.database, claims, deps.now?.())
  if (!authorized) {
    return errorResponse('forbidden', 403)
  }

  const recheck = async (): Promise<boolean> => checkCopilotAuth(deps.database, claims, deps.now?.())

  const method = request.method
  const idempotencyKey = request.headers.get('idempotency-key') ?? crypto.randomUUID()

  try {
    // POST /api/admin/support/copilot/draft
    if (method === 'POST' && path === '/api/admin/support/copilot/draft') {
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_input', 400, 'Payload JSON requerido')

      const result = await generateD1CopilotDraft(deps.database, claims, body, {
        idempotencyKey,
        now: deps.now
      })
      if (!(await recheck())) return errorResponse('forbidden', 403)
      return jsonResponse(result, 201)
    }

    // GET /api/admin/support/copilot/tickets/:ticketId
    const ticketMatch = path.match(/^\/api\/admin\/support\/copilot\/tickets\/([^/]+)$/)
    if (method === 'GET' && ticketMatch) {
      const ticketId = ticketMatch[1]!
      const result = await listD1CopilotInteractions(deps.database, { ticketId })
      if (!(await recheck())) return errorResponse('forbidden', 403)
      return jsonResponse(result, 200)
    }

    // Matches /api/admin/support/copilot/:id or /decision or /evaluate
    const match = path.match(/^\/api\/admin\/support\/copilot\/([^/]+)(?:\/(decision|evaluate))?$/)
    if (!match) {
      return errorResponse('not_found', 404)
    }

    const interactionId = match[1]!
    const subAction = match[2]

    // POST /api/admin/support/copilot/:id/decision
    if (method === 'POST' && subAction === 'decision') {
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_input', 400, 'Payload JSON requerido')

      const result = await recordD1CopilotHumanApproval(deps.database, claims, interactionId, body, {
        idempotencyKey,
        now: deps.now
      })
      if (!(await recheck())) return errorResponse('forbidden', 403)
      return jsonResponse(result, 200)
    }

    // POST /api/admin/support/copilot/:id/evaluate
    if (method === 'POST' && subAction === 'evaluate') {
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_input', 400, 'Payload JSON requerido')

      const result = await recordD1CopilotAccuracyEvaluation(deps.database, claims, interactionId, body, {
        idempotencyKey,
        now: deps.now
      })
      if (!(await recheck())) return errorResponse('forbidden', 403)
      return jsonResponse(result, 200)
    }

    // GET /api/admin/support/copilot/:id
    if (method === 'GET' && !subAction) {
      const interaction = await readD1CopilotInteraction(deps.database, interactionId)
      if (!interaction) return errorResponse('not_found', 404, 'Interacción no encontrada')
      if (!(await recheck())) return errorResponse('forbidden', 403)
      return jsonResponse(interaction, 200)
    }

    return errorResponse('method_not_allowed', 405)
  } catch (err) {
    if (err instanceof SupportCopilotError) {
      const statusMap: Record<string, number> = {
        invalid_input: 400,
        not_found: 404,
        ticket_not_found: 404,
        concurrency_conflict: 409,
        idempotency_conflict: 409,
        unauthorized: 403,
        redaction_failure: 422
      }
      return errorResponse(err.code, statusMap[err.code] ?? 500, err.message)
    }
    return errorResponse('internal_server_error', 500, err instanceof Error ? err.message : 'Error interno')
  }
}
