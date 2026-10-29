import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  proposeD1MediaAiEnrichment,
  decideD1MediaAiEnrichment,
  applyD1MediaAiEnrichment,
  readD1MediaAiEnrichment,
  listD1MediaAiEnrichments
} from './media-ai-enrichment'
import { MediaAiEnrichmentError } from '../../shared/media-ai-enrichment'

export interface MediaAiEnrichmentHttpDependencies {
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

export function ownsMediaAiEnrichmentNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (/^\/api\/admin\/media\/ai-enrich(?:\/|$)/.test(value)) {
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

export async function handleMediaAiEnrichmentHttp(
  request: Request,
  deps: MediaAiEnrichmentHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsMediaAiEnrichmentNamespace(url.pathname)) {
    return null
  }

  // Session verification
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) {
    return errorResponse('unauthenticated', 401, 'Sesión no iniciada')
  }

  const path = url.pathname.replace(/^\/api\/admin\/media\/ai-enrich/, '')

  try {
    // POST /propose
    if (request.method === 'POST' && (path === '/propose' || path === '')) {
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_input', 400, 'Cuerpo de solicitud requerido')
      const idempotencyKey =
        request.headers.get('idempotency-key') ||
        request.headers.get('x-idempotency-key') ||
        crypto.randomUUID()

      const enrichment = await proposeD1MediaAiEnrichment(deps.database, claims, body, {
        idempotencyKey,
        now: deps.now
      })
      return jsonResponse({ enrichment }, 200)
    }

    // GET /enrichments
    if (request.method === 'GET' && (path === '/enrichments' || path === '')) {
      const assetId = url.searchParams.get('assetId') || undefined
      const status = url.searchParams.get('status') || undefined
      const enrichments = await listD1MediaAiEnrichments(deps.database, claims, { assetId, status })
      return jsonResponse({ enrichments }, 200)
    }

    // Match /enrichments/:id/decision
    const decisionMatch = path.match(/^\/enrichments\/([^/]+)\/decision$/)
    if (request.method === 'POST' && decisionMatch) {
      const enrichmentId = decisionMatch[1]
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_input', 400, 'Cuerpo de decisión requerido')
      const idempotencyKey =
        request.headers.get('idempotency-key') ||
        request.headers.get('x-idempotency-key') ||
        crypto.randomUUID()

      const enrichment = await decideD1MediaAiEnrichment(deps.database, claims, enrichmentId, body, {
        idempotencyKey,
        now: deps.now
      })
      return jsonResponse({ enrichment }, 200)
    }

    // Match /enrichments/:id/apply
    const applyMatch = path.match(/^\/enrichments\/([^/]+)\/apply$/)
    if (request.method === 'POST' && applyMatch) {
      const enrichmentId = applyMatch[1]
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_input', 400, 'Cuerpo de aplicación requerido')
      const idempotencyKey =
        request.headers.get('idempotency-key') ||
        request.headers.get('x-idempotency-key') ||
        crypto.randomUUID()

      const result = await applyD1MediaAiEnrichment(deps.database, claims, enrichmentId, body, {
        idempotencyKey,
        now: deps.now
      })
      return jsonResponse(result, 200)
    }

    // Match /enrichments/:id
    const idMatch = path.match(/^\/enrichments\/([^/]+)$/)
    if (request.method === 'GET' && idMatch) {
      const enrichmentId = idMatch[1]
      const enrichment = await readD1MediaAiEnrichment(deps.database, claims, enrichmentId)
      return jsonResponse({ enrichment }, 200)
    }

    return errorResponse('not_found', 404, 'Ruta no encontrada')
  } catch (err: unknown) {
    if (err instanceof MediaAiEnrichmentError) {
      const statusMap: Record<string, number> = {
        invalid_input: 400,
        prohibited_invention_detected: 422,
        unauthorized: 403,
        not_found: 404,
        not_approved: 422,
        concurrency_conflict: 409,
        idempotency_conflict: 409
      }
      const status = statusMap[err.code] || 500
      return errorResponse(err.code, status, err.message)
    }
    const message = err instanceof Error ? err.message : 'Error interno'
    return errorResponse('internal_error', 500, message)
  }
}
