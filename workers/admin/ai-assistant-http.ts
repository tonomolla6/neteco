import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  generateD1AdminAiProposal,
  recordD1AdminAiHumanDecision,
  readD1AdminAiInteraction,
  listD1AdminAiInteractions
} from './ai-assistant'
import { AdminAiAssistantError } from '../../shared/admin-ai-assistant'

export interface AdminAiAssistantHttpDependencies {
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

export function ownsAdminAiAssistantNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (/^\/api\/admin\/ai\/assistant(?:\/|$)/.test(value)) {
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

export async function handleAdminAiAssistantHttp(
  request: Request,
  deps: AdminAiAssistantHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsAdminAiAssistantNamespace(url.pathname)) {
    return null
  }

  // Session verification
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) {
    return errorResponse('unauthenticated', 401, 'Sesión no iniciada')
  }

  const path = url.pathname.replace(/^\/api\/admin\/ai\/assistant/, '')

  try {
    // POST /propose
    if (request.method === 'POST' && (path === '/propose' || path === '')) {
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_input', 400, 'Cuerpo de solicitud requerido')
      const idempotencyKey =
        request.headers.get('idempotency-key') || request.headers.get('x-idempotency-key') || crypto.randomUUID()

      const interaction = await generateD1AdminAiProposal(deps.database, claims, body, {
        idempotencyKey,
        now: deps.now
      })
      return jsonResponse({ interaction }, 200)
    }

    // GET /interactions
    if (request.method === 'GET' && (path === '/interactions' || path === '')) {
      const category = url.searchParams.get('category') || undefined
      const status = url.searchParams.get('status') || undefined
      const interactions = await listD1AdminAiInteractions(deps.database, claims, { category, status })
      return jsonResponse({ interactions }, 200)
    }

    // Match /interactions/:id/decision
    const decisionMatch = path.match(/^\/interactions\/([^/]+)\/decision$/)
    if (request.method === 'POST' && decisionMatch) {
      const interactionId = decisionMatch[1]
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_input', 400, 'Cuerpo de decisión requerido')
      const idempotencyKey =
        request.headers.get('idempotency-key') || request.headers.get('x-idempotency-key') || crypto.randomUUID()

      const interaction = await recordD1AdminAiHumanDecision(deps.database, claims, interactionId, body, {
        idempotencyKey,
        now: deps.now
      })
      return jsonResponse({ interaction }, 200)
    }

    // Match /interactions/:id
    const idMatch = path.match(/^\/interactions\/([^/]+)$/)
    if (request.method === 'GET' && idMatch) {
      const interactionId = idMatch[1]
      const interaction = await readD1AdminAiInteraction(deps.database, claims, interactionId)
      return jsonResponse({ interaction }, 200)
    }

    return errorResponse('not_found', 404, 'Ruta no encontrada')
  } catch (err: unknown) {
    if (err instanceof AdminAiAssistantError) {
      const statusMap: Record<string, number> = {
        invalid_input: 400,
        unauthorized: 403,
        not_found: 404,
        concurrency_conflict: 409,
        idempotency_conflict: 409,
        auto_execution_forbidden: 422
      }
      const status = statusMap[err.code] || 500
      return errorResponse(err.code, status, err.message)
    }
    const message = err instanceof Error ? err.message : 'Error interno'
    return errorResponse('internal_error', 500, message)
  }
}
