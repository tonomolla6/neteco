import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { GAME_DAY_RUNBOOKS } from '../../shared/game-day-resilience'
import {
  GameDayResilienceError,
  createD1GameDayDrill,
  recordD1GameDayScenarioResult,
  completeD1GameDayDrill,
  getD1GameDayDrillDetail,
  listD1GameDayDrills,
  evaluateD1TrafficExpansionGate
} from './game-day-resilience'

export interface GameDayHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration | null
  origin?: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: string | (() => string)
  claimsResolver?: (request: Request) => Promise<VerifiedSessionClaims | null>
}

export function ownsGameDayNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (value === '/api/admin/observability/game-day' || value.startsWith('/api/admin/observability/game-day/')) {
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
    case 'version_conflict':
    case 'idempotency_conflict':
      return 409
    case 'service_unavailable':
      return 503
    case 'invalid_input':
    default:
      return 400
  }
}

async function resolveClaims(request: Request, deps: GameDayHttpDependencies): Promise<VerifiedSessionClaims | null> {
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

export async function handleGameDayHttp(request: Request, deps: GameDayHttpDependencies): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsGameDayNamespace(path)) {
    return null
  }

  const nowFn =
    typeof deps.now === 'function'
      ? deps.now
      : () => (typeof deps.now === 'string' ? deps.now : new Date().toISOString())

  // Public/read metadata: GET runbooks
  if (request.method === 'GET' && path === '/api/admin/observability/game-day/runbooks') {
    return jsonResponse({ runbooks: GAME_DAY_RUNBOOKS })
  }

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
    // GET /gate - Traffic expansion gate check
    if (request.method === 'GET' && path === '/api/admin/observability/game-day/gate') {
      const gate = await evaluateD1TrafficExpansionGate(deps.database, claims, { now: nowFn })
      return jsonResponse(gate)
    }

    // GET /drills - List drills
    if (request.method === 'GET' && path === '/api/admin/observability/game-day/drills') {
      const drills = await listD1GameDayDrills(deps.database, claims, { now: nowFn })
      return jsonResponse({ drills })
    }

    // POST /drills - Create drill
    if (request.method === 'POST' && path === '/api/admin/observability/game-day/drills') {
      const body = await request.json().catch(() => null)
      if (!body || typeof body !== 'object') {
        return errorResponse('invalid_input', 400)
      }
      const idempotencyKey = request.headers.get('x-idempotency-key') ?? undefined
      const drill = await createD1GameDayDrill(deps.database, claims, body as never, { idempotencyKey }, { now: nowFn })
      return jsonResponse({ drill }, 201)
    }

    // Match /drills/:id/scenarios
    const scenariosMatch = /^\/api\/admin\/observability\/game-day\/drills\/([a-f0-9-]{36})\/scenarios$/.exec(path)
    if (request.method === 'POST' && scenariosMatch) {
      const drillId = scenariosMatch[1]!
      const body = await request.json().catch(() => null)
      if (!body || typeof body !== 'object') {
        return errorResponse('invalid_input', 400)
      }
      const idempotencyKey = request.headers.get('x-idempotency-key') ?? undefined
      const result = await recordD1GameDayScenarioResult(
        deps.database,
        claims,
        drillId,
        body as never,
        { idempotencyKey },
        { now: nowFn }
      )
      return jsonResponse({ result }, 201)
    }

    // Match /drills/:id/complete
    const completeMatch = /^\/api\/admin\/observability\/game-day\/drills\/([a-f0-9-]{36})\/complete$/.exec(path)
    if (request.method === 'POST' && completeMatch) {
      const drillId = completeMatch[1]!
      const body = await request.json().catch(() => null)
      if (!body || typeof body !== 'object') {
        return errorResponse('invalid_input', 400)
      }
      const idempotencyKey = request.headers.get('x-idempotency-key') ?? undefined
      const drill = await completeD1GameDayDrill(
        deps.database,
        claims,
        drillId,
        body as never,
        { idempotencyKey },
        { now: nowFn }
      )
      return jsonResponse({ drill })
    }

    // Match /drills/:id
    const detailMatch = /^\/api\/admin\/observability\/game-day\/drills\/([a-f0-9-]{36})$/.exec(path)
    if (request.method === 'GET' && detailMatch) {
      const drillId = detailMatch[1]!
      const detail = await getD1GameDayDrillDetail(deps.database, claims, drillId, { now: nowFn })
      return jsonResponse({ drill: detail })
    }

    return errorResponse('not_found', 404)
  } catch (err: unknown) {
    if (err instanceof GameDayResilienceError) {
      return errorResponse(err.code, statusFromCode(err.code))
    }
    return errorResponse('service_unavailable', 500)
  }
}
