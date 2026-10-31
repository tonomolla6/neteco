import { ZodError } from 'zod'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  crmHoldoutPolicyInputSchema,
  crmHoldoutEvaluationInputSchema,
  crmAutomationEventInputSchema
} from '../../shared/crm-automation-metrics'
import {
  CrmAutomationMetricsError,
  readD1HoldoutPolicy,
  updateD1HoldoutPolicy,
  evaluateD1HoldoutAllocation,
  recordD1AutomationEvent,
  getD1FlowMetricsSummary,
  listD1FlowMetricsOverview
} from './crm-automation-metrics'

export interface CrmAutomationMetricsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration | null
  origin?: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: string | (() => string)
  claimsResolver?: (request: Request) => Promise<VerifiedSessionClaims | null>
}

export function ownsCrmAutomationMetricsNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (value === '/api/admin/crm/metrics' || value.startsWith('/api/admin/crm/metrics/')) {
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
  if (code === 'unauthenticated') return 401
  if (['mfa_required', 'forbidden', 'email_unverified', 'csrf_rejected'].includes(code)) return 403
  if (code === 'not_found') return 404
  if (code === 'rate_limited') return 429
  if (code === 'version_conflict') return 409
  if (code === 'idempotency_conflict') return 409
  if (code === 'service_unavailable') return 503
  return 400
}

async function resolveSessionClaims(
  request: Request,
  deps: CrmAutomationMetricsHttpDependencies
): Promise<VerifiedSessionClaims | null> {
  if (deps.claimsResolver) {
    return deps.claimsResolver(request)
  }
  if (!deps.sessionCookieConfiguration) return null

  const session = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!session) return null

  return session
}

export async function handleCrmAutomationMetricsHttp(
  request: Request,
  deps: CrmAutomationMetricsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const pathname = url.pathname

  if (!ownsCrmAutomationMetricsNamespace(pathname)) return null

  if (!deps.sessionCookieConfiguration && !deps.claimsResolver) {
    return errorResponse('service_unavailable', 503)
  }

  // CSRF validation on mutating methods
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method) && deps.origin) {
    const requestOrigin = request.headers.get('origin')
    if ((requestOrigin && requestOrigin !== deps.origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
      return errorResponse('csrf_rejected', 403)
    }
  }

  const claims = await resolveSessionClaims(request, deps)
  if (!claims) {
    return errorResponse('unauthenticated', 401)
  }

  const nowOpt = typeof deps.now === 'function' ? deps.now : deps.now ? () => deps.now as string : undefined
  const nowInstant = nowOpt ? (typeof nowOpt === 'function' ? nowOpt() : nowOpt) : undefined

  const auth = await authorizeD1Session(deps.database, claims, 'administration.manage', {
    requireMfa: true,
    now: nowInstant
  })
  if (!auth.allowed) {
    const code =
      auth.code === 'mfa_required' ? 'mfa_required' : auth.code === 'unauthenticated' ? 'unauthenticated' : 'forbidden'
    return errorResponse(code, statusFromCode(code))
  }

  try {
    // GET /api/admin/crm/metrics/flows
    if (request.method === 'GET' && pathname === '/api/admin/crm/metrics/flows') {
      const flows = await listD1FlowMetricsOverview(deps.database, { now: nowOpt })
      return jsonResponse({ flows })
    }

    // GET /api/admin/crm/metrics/flows/:flowId
    const flowDetailMatch = /^\/api\/admin\/crm\/metrics\/flows\/([^/]+)$/.exec(pathname)
    if (request.method === 'GET' && flowDetailMatch) {
      const flowId = decodeURIComponent(flowDetailMatch[1]!)
      const summary = await getD1FlowMetricsSummary(deps.database, flowId, { now: nowOpt })
      return jsonResponse(summary)
    }

    // GET /api/admin/crm/metrics/holdout/policy
    if (request.method === 'GET' && pathname === '/api/admin/crm/metrics/holdout/policy') {
      const flowId = url.searchParams.get('flowId') || 'welcome_series'
      const policy = await readD1HoldoutPolicy(deps.database, flowId)
      return jsonResponse(policy)
    }

    // PUT /api/admin/crm/metrics/holdout/policy
    if (request.method === 'PUT' && pathname === '/api/admin/crm/metrics/holdout/policy') {
      const raw = await request.json().catch(() => null)
      const body = crmHoldoutPolicyInputSchema.parse(raw)
      const idempotencyKey =
        request.headers.get('x-idempotency-key') ||
        (raw && typeof raw === 'object' && 'idempotencyKey' in raw && typeof raw.idempotencyKey === 'string'
          ? raw.idempotencyKey
          : crypto.randomUUID())
      const receipt = await updateD1HoldoutPolicy(deps.database, claims, body, idempotencyKey, { now: nowOpt })
      return jsonResponse(receipt)
    }

    // POST /api/admin/crm/metrics/holdout/evaluate
    if (request.method === 'POST' && pathname === '/api/admin/crm/metrics/holdout/evaluate') {
      const raw = await request.json().catch(() => null)
      const body = crmHoldoutEvaluationInputSchema.parse(raw)
      const receipt = await evaluateD1HoldoutAllocation(deps.database, claims, body, { now: nowOpt })
      return jsonResponse(receipt)
    }

    // POST /api/admin/crm/metrics/events
    if (request.method === 'POST' && pathname === '/api/admin/crm/metrics/events') {
      const raw = await request.json().catch(() => null)
      const body = crmAutomationEventInputSchema.parse(raw)
      const receipt = await recordD1AutomationEvent(deps.database, claims, body, { now: nowOpt })
      return jsonResponse(receipt)
    }

    return errorResponse('not_found', 404)
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      return errorResponse('invalid_input', 400)
    }
    if (err instanceof CrmAutomationMetricsError) {
      return errorResponse(err.code, statusFromCode(err.code))
    }
    return errorResponse('unexpected_error', 500)
  }
}
