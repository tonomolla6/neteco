import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  MarketingObservabilityError,
  recordD1MarketingAutomationEvent,
  getD1WorkflowMetricsSummary,
  getD1WorkflowMetricsDetail,
  listD1MarketingEvents
} from './marketing-automation-observability'

export interface MarketingObservabilityHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration | null
  origin?: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: string | (() => string)
  claimsResolver?: (request: Request) => Promise<VerifiedSessionClaims | null>
}

export function ownsMarketingObservabilityNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (value === '/api/admin/marketing/observability' || value.startsWith('/api/admin/marketing/observability/')) {
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

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      pragma: 'no-cache',
      vary: 'Cookie',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'referrer-policy': 'no-referrer'
    }
  })
}

function errorResponse(code: string, status = 400) {
  return jsonResponse({ error: { code } }, status)
}

function statusFromCode(code: string): number {
  switch (code) {
    case 'unauthenticated':
      return 401
    case 'email_unverified':
    case 'mfa_required':
    case 'forbidden':
    case 'cross_site_forbidden':
      return 403
    case 'not_found':
      return 404
    case 'conflict':
    case 'idempotency_conflict':
      return 409
    case 'service_unavailable':
      return 503
    case 'invalid_input':
    default:
      return 400
  }
}

async function resolveClaims(
  request: Request,
  deps: MarketingObservabilityHttpDependencies
): Promise<VerifiedSessionClaims | null> {
  if (deps.claimsResolver) {
    return await deps.claimsResolver(request)
  }
  if (!deps.sessionCookieConfiguration) {
    return null
  }
  return await verifySessionCookie(request, deps.sessionCookieConfiguration)
}

function checkOrigin(request: Request, expectedOrigin?: string): boolean {
  const secFetchSite = request.headers.get('sec-fetch-site')
  if (secFetchSite === 'cross-site') {
    return false
  }
  const origin = request.headers.get('origin')
  if (origin && expectedOrigin && origin !== expectedOrigin) {
    return false
  }
  return true
}

export async function handleMarketingObservabilityHttp(
  request: Request,
  deps: MarketingObservabilityHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsMarketingObservabilityNamespace(path)) {
    return null
  }

  const nowFn =
    typeof deps.now === 'function'
      ? deps.now
      : () => (typeof deps.now === 'string' ? deps.now : new Date().toISOString())

  const claims = await resolveClaims(request, deps)
  if (!claims) {
    return errorResponse('unauthenticated', 401)
  }

  // Cross-site defense on mutations
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (!checkOrigin(request, deps.origin)) {
      return errorResponse('cross_site_forbidden', 403)
    }
  }

  try {
    // GET /workflows
    if (request.method === 'GET' && path === '/api/admin/marketing/observability/workflows') {
      const summaries = await getD1WorkflowMetricsSummary(deps.database, claims, { now: nowFn })
      return jsonResponse({ workflows: summaries })
    }

    // POST /events - Ingest telemetry event
    if (request.method === 'POST' && path === '/api/admin/marketing/observability/events') {
      const body = await request.json().catch(() => null)
      if (!body || typeof body !== 'object') {
        return errorResponse('invalid_input', 400)
      }
      const idempotencyKey = request.headers.get('x-idempotency-key') ?? undefined
      const receipt = await recordD1MarketingAutomationEvent(
        deps.database,
        claims,
        body as never,
        { idempotencyKey },
        { now: nowFn }
      )
      return jsonResponse(receipt, 201)
    }

    // GET /events - List audit trail
    if (request.method === 'GET' && path === '/api/admin/marketing/observability/events') {
      const workflowId = url.searchParams.get('workflowId') ?? undefined
      const eventType = url.searchParams.get('eventType') ?? undefined
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const events = await listD1MarketingEvents(
        deps.database,
        claims,
        { workflowId, eventType, limit },
        { now: nowFn }
      )
      return jsonResponse({ events })
    }

    // Match /workflows/:id
    const workflowMatch = /^\/api\/admin\/marketing\/observability\/workflows\/([a-z0-9_-]+)$/.exec(path)
    if (request.method === 'GET' && workflowMatch) {
      const workflowId = workflowMatch[1]!
      const detail = await getD1WorkflowMetricsDetail(deps.database, claims, workflowId, { now: nowFn })
      return jsonResponse({ workflow: detail })
    }

    return errorResponse('not_found', 404)
  } catch (err: unknown) {
    if (err instanceof MarketingObservabilityError) {
      return errorResponse(err.code, statusFromCode(err.code))
    }
    return errorResponse('service_unavailable', 500)
  }
}
