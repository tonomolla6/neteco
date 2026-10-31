import { ZodError } from 'zod'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  type AnomalyDimension,
  type AnomalyStatus,
  ANOMALY_RUNBOOKS,
  anomalyPolicyInputSchema,
  anomalySignalInputSchema,
  anomalyReviewInputSchema
} from '../../shared/anomaly-detection'
import {
  AnomalyDetectionError,
  listD1AnomalyPolicies,
  updateD1AnomalyPolicy,
  evaluateD1AnomalySignal,
  listD1AnomalyAlerts,
  getD1AnomalyAlertDetail,
  reviewD1AnomalyAlert
} from './anomaly-detection'

export interface AnomalyDetectionHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration | null
  origin?: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: string | (() => string)
  claimsResolver?: (request: Request) => Promise<VerifiedSessionClaims | null>
}

export function ownsAnomalyDetectionNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (value === '/api/admin/observability/anomalies' || value.startsWith('/api/admin/observability/anomalies/')) {
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
  deps: AnomalyDetectionHttpDependencies
): Promise<VerifiedSessionClaims | null> {
  if (deps.claimsResolver) {
    return deps.claimsResolver(request)
  }
  if (!deps.sessionCookieConfiguration) return null

  const session = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!session) return null

  return session
}

export async function handleAnomalyDetectionHttp(
  request: Request,
  deps: AnomalyDetectionHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const pathname = url.pathname

  if (!ownsAnomalyDetectionNamespace(pathname)) return null

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

  const authAdmin = await authorizeD1Session(deps.database, claims, 'administration.manage', {
    requireMfa: true,
    now: nowInstant
  })
  if (!authAdmin.allowed) {
    const authOps = await authorizeD1Session(deps.database, claims, 'operations.manage', {
      requireMfa: true,
      now: nowInstant
    })
    if (!authOps.allowed) {
      const code =
        authAdmin.code === 'mfa_required' || authOps.code === 'mfa_required'
          ? 'mfa_required'
          : authAdmin.code === 'unauthenticated' || authOps.code === 'unauthenticated'
            ? 'unauthenticated'
            : 'forbidden'
      return errorResponse(code, statusFromCode(code))
    }
  }

  try {
    // GET /api/admin/observability/anomalies/runbooks
    if (request.method === 'GET' && pathname === '/api/admin/observability/anomalies/runbooks') {
      const runbooks = Object.values(ANOMALY_RUNBOOKS)
      return jsonResponse({ runbooks })
    }

    // GET /api/admin/observability/anomalies/policies
    if (request.method === 'GET' && pathname === '/api/admin/observability/anomalies/policies') {
      const policies = await listD1AnomalyPolicies(deps.database)
      return jsonResponse({ policies })
    }

    // PUT /api/admin/observability/anomalies/policies/:dimension
    const policyMatch = /^\/api\/admin\/observability\/anomalies\/policies\/([^/]+)$/.exec(pathname)
    if (request.method === 'PUT' && policyMatch) {
      const dimension = decodeURIComponent(policyMatch[1]!) as AnomalyDimension
      const raw = await request.json().catch(() => null)
      const body = anomalyPolicyInputSchema.parse(raw)
      const idempotencyKey =
        request.headers.get('x-idempotency-key') ||
        (raw && typeof raw === 'object' && 'idempotencyKey' in raw && typeof raw.idempotencyKey === 'string'
          ? raw.idempotencyKey
          : crypto.randomUUID())
      const receipt = await updateD1AnomalyPolicy(deps.database, claims, dimension, body, idempotencyKey, {
        now: nowOpt
      })
      return jsonResponse(receipt)
    }

    // GET /api/admin/observability/anomalies/alerts
    if (request.method === 'GET' && pathname === '/api/admin/observability/anomalies/alerts') {
      const query = {
        dimension: (url.searchParams.get('dimension') as AnomalyDimension) || undefined,
        severity: (url.searchParams.get('severity') as 'info' | 'warning' | 'critical') || undefined,
        status: (url.searchParams.get('status') as AnomalyStatus | null) || undefined,
        limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50,
        offset: url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : 0
      }
      const result = await listD1AnomalyAlerts(deps.database, query)
      return jsonResponse(result)
    }

    // GET /api/admin/observability/anomalies/alerts/:id
    const alertDetailMatch = /^\/api\/admin\/observability\/anomalies\/alerts\/([^/]+)$/.exec(pathname)
    if (request.method === 'GET' && alertDetailMatch) {
      const alertId = decodeURIComponent(alertDetailMatch[1]!)
      const detail = await getD1AnomalyAlertDetail(deps.database, alertId)
      return jsonResponse(detail)
    }

    // POST /api/admin/observability/anomalies/evaluate
    if (request.method === 'POST' && pathname === '/api/admin/observability/anomalies/evaluate') {
      const raw = await request.json().catch(() => null)
      const body = anomalySignalInputSchema.parse(raw)
      const res = await evaluateD1AnomalySignal(deps.database, claims, body, { now: nowOpt })
      return jsonResponse(res)
    }

    // POST /api/admin/observability/anomalies/alerts/:id/review
    const reviewMatch = /^\/api\/admin\/observability\/anomalies\/alerts\/([^/]+)\/review$/.exec(pathname)
    if (request.method === 'POST' && reviewMatch) {
      const alertId = decodeURIComponent(reviewMatch[1]!)
      const raw = await request.json().catch(() => null)
      const body = anomalyReviewInputSchema.parse(raw)
      const receipt = await reviewD1AnomalyAlert(deps.database, claims, alertId, body, { now: nowOpt })
      return jsonResponse(receipt)
    }

    return errorResponse('not_found', 404)
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      return errorResponse('invalid_input', 400)
    }
    if (err instanceof AnomalyDetectionError) {
      return errorResponse(err.code, statusFromCode(err.code))
    }
    return errorResponse('unexpected_error', 500)
  }
}
