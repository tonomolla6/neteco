import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  generateD1CatalogContent,
  reviewD1CatalogAiGeneration,
  applyD1CatalogAiGeneration,
  readD1CatalogAiGeneration,
  listD1CatalogAiGenerations,
  checkD1CatalogDuplicates
} from './ai-generation'
import { CatalogAiGenerationError } from '../../shared/catalog-ai-generation'

export interface CatalogAiGenerationHttpDependencies {
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

export function ownsCatalogAiGenerationNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (/^\/api\/admin\/catalog\/ai-generate(?:\/|$)/.test(value)) {
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

export async function handleCatalogAiGenerationHttp(
  request: Request,
  deps: CatalogAiGenerationHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCatalogAiGenerationNamespace(url.pathname)) {
    return null
  }

  // Session verification
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) {
    return errorResponse('unauthenticated', 401, 'Sesión no iniciada')
  }

  const path = url.pathname.replace(/^\/api\/admin\/catalog\/ai-generate/, '')

  try {
    // POST /check-duplicates
    if (request.method === 'POST' && path === '/check-duplicates') {
      const body = (await request.json().catch(() => null)) as { text?: string; title?: string } | null
      if (!body?.text) return errorResponse('invalid_input', 400, 'Texto requerido para comprobación de duplicados')
      const duplicateCheck = await checkD1CatalogDuplicates(deps.database, body.text, body.title)
      return jsonResponse({ duplicateCheck }, 200)
    }

    // POST /propose
    if (request.method === 'POST' && (path === '/propose' || path === '')) {
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_input', 400, 'Cuerpo de solicitud requerido')
      const idempotencyKey =
        request.headers.get('idempotency-key') || request.headers.get('x-idempotency-key') || crypto.randomUUID()

      const generation = await generateD1CatalogContent(deps.database, claims, body, {
        idempotencyKey,
        now: deps.now
      })
      return jsonResponse({ generation }, 200)
    }

    // GET /generations
    if (request.method === 'GET' && (path === '/generations' || path === '')) {
      const productId = url.searchParams.get('productId') || undefined
      const status = url.searchParams.get('status') || undefined
      const generations = await listD1CatalogAiGenerations(deps.database, claims, { productId, status })
      return jsonResponse({ generations }, 200)
    }

    // Match /generations/:id/review
    const reviewMatch = path.match(/^\/generations\/([^/]+)\/review$/)
    if (request.method === 'POST' && reviewMatch) {
      const generationId = reviewMatch[1]
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_input', 400, 'Cuerpo de revisión requerido')
      const idempotencyKey =
        request.headers.get('idempotency-key') || request.headers.get('x-idempotency-key') || crypto.randomUUID()

      const generation = await reviewD1CatalogAiGeneration(deps.database, claims, generationId, body, {
        idempotencyKey,
        now: deps.now
      })
      return jsonResponse({ generation }, 200)
    }

    // Match /generations/:id/apply
    const applyMatch = path.match(/^\/generations\/([^/]+)\/apply$/)
    if (request.method === 'POST' && applyMatch) {
      const generationId = applyMatch[1]
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_input', 400, 'Cuerpo de aplicación requerido')
      const idempotencyKey =
        request.headers.get('idempotency-key') || request.headers.get('x-idempotency-key') || crypto.randomUUID()

      const result = await applyD1CatalogAiGeneration(deps.database, claims, generationId, body, {
        idempotencyKey,
        now: deps.now
      })
      return jsonResponse(result, 200)
    }

    // Match /generations/:id
    const idMatch = path.match(/^\/generations\/([^/]+)$/)
    if (request.method === 'GET' && idMatch) {
      const generationId = idMatch[1]
      const generation = await readD1CatalogAiGeneration(deps.database, claims, generationId)
      return jsonResponse({ generation }, 200)
    }

    return errorResponse('not_found', 404, 'Ruta no encontrada')
  } catch (err: unknown) {
    if (err instanceof CatalogAiGenerationError) {
      const statusMap: Record<string, number> = {
        invalid_input: 400,
        unverified_claims: 422,
        unauthorized: 403,
        not_found: 404,
        not_approved: 422,
        concurrency_conflict: 409,
        idempotency_conflict: 409,
        high_duplicate_risk: 409
      }
      const status = statusMap[err.code] || 500
      return errorResponse(err.code, status, err.message)
    }
    const message = err instanceof Error ? err.message : 'Error interno'
    return errorResponse('internal_error', 500, message)
  }
}
