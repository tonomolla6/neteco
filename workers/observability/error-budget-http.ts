import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  evaluateD1ReleaseDecision,
  emergencyOverrideD1ReleaseDecision,
  recordD1SliMeasurement,
  readD1ErrorBudgetOverview,
  listD1ReleaseDecisions
} from './error-budget'
import { ErrorBudgetReleaseError } from '../../shared/error-budget-releases'

export interface ErrorBudgetHttpDependencies {
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

export function ownsErrorBudgetNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (/^\/api\/admin\/observability\/error-budget(?:\/|$)/.test(value)) {
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

export async function handleErrorBudgetHttp(
  request: Request,
  deps: ErrorBudgetHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsErrorBudgetNamespace(path)) {
    return null
  }

  // 1. Session verification
  const claims = deps.claimsResolver
    ? await deps.claimsResolver(request)
    : await verifySessionCookie(request, deps.sessionCookieConfiguration)

  if (!claims) {
    return errorResponse('unauthenticated', 401)
  }

  // 2. Authorization verification
  const nowIso = deps.now ? deps.now() : undefined
  const auth = await authorizeD1Session(deps.database, claims, 'administration.manage', {
    now: nowIso
  })
  if (!auth.allowed) {
    return errorResponse(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
  }

  const send = async (data: unknown, status = 200): Promise<Response> => {
    const after = await authorizeD1Session(deps.database, claims, 'administration.manage', {
      now: deps.now ? deps.now() : undefined
    })
    if (!after.allowed) {
      return errorResponse(after.code, after.code === 'unauthenticated' ? 401 : 403)
    }
    return jsonResponse(data, status)
  }

  const subPath = path.replace(/^\/api\/admin\/observability\/error-budget\/?/, '')

  try {
    if (request.method === 'GET') {
      if (subPath === 'overview' || subPath === '') {
        const overview = await readD1ErrorBudgetOverview(deps.database, { now: nowIso })
        return await send(overview)
      }
      if (subPath === 'decisions') {
        const decisions = await listD1ReleaseDecisions(deps.database)
        return await send({ decisions })
      }
      return errorResponse('not_found', 404)
    }

    if (request.method === 'POST') {
      if (subPath === 'evaluate') {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return errorResponse('invalid_request', 400, 'Invalid JSON body')
        }
        const decision = await evaluateD1ReleaseDecision(deps.database, claims, body as never, { now: nowIso })
        return await send({ decision })
      }

      if (subPath === 'measurements') {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return errorResponse('invalid_request', 400, 'Invalid JSON body')
        }
        const measurement = await recordD1SliMeasurement(deps.database, claims, body as never, { now: nowIso })
        return await send({ measurement })
      }

      if (subPath === 'override') {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return errorResponse('invalid_request', 400, 'Invalid JSON body')
        }
        const decision = await emergencyOverrideD1ReleaseDecision(deps.database, claims, body as never, { now: nowIso })
        return await send({ decision })
      }

      return errorResponse('not_found', 404)
    }

    return errorResponse('method_not_allowed', 405)
  } catch (error) {
    if (error instanceof ErrorBudgetReleaseError) {
      return errorResponse(error.code, error.statusCode, error.message)
    }
    return errorResponse('internal_error', 500, error instanceof Error ? error.message : 'Unknown error')
  }
}
