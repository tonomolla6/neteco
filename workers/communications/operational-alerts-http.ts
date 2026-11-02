import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  OperationalAlertsError,
  createD1OperationalAlert,
  acknowledgeD1OperationalAlert,
  escalateD1OperationalAlert,
  resolveD1OperationalAlert,
  getD1OperationalAlert,
  listD1OperationalAlerts
} from './operational-alerts'

export interface OperationalAlertsHttpDependencies {
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

export function ownsOperationalAlertsNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (/^\/api\/admin\/operations\/alerts(?:\/|$)/.test(value)) {
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

function mapOperationalAlertsError(error: unknown): Response {
  if (error instanceof OperationalAlertsError) {
    switch (error.code) {
      case 'invalid_input':
      case 'unapproved_channel':
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

export async function handleOperationalAlertsHttp(
  request: Request,
  deps: OperationalAlertsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsOperationalAlertsNamespace(path)) {
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

  // 3. Authorization check
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
  const sub = path.replace(/^\/api\/admin\/operations\/alerts\/?/, '').replace(/\/$/, '')

  try {
    // GET /api/admin/operations/alerts
    if (request.method === 'GET' && sub === '') {
      const page = Number(url.searchParams.get('page') ?? '1')
      const perPage = Number(url.searchParams.get('perPage') ?? '20')
      const status = url.searchParams.get('status') || undefined
      const severity = url.searchParams.get('severity') || undefined
      const area = url.searchParams.get('area') || undefined

      const result = await listD1OperationalAlerts(deps.database, claims, {
        page,
        perPage,
        status,
        severity,
        area
      })
      return jsonResponse(result)
    }

    // GET /api/admin/operations/alerts/:id
    if (request.method === 'GET' && sub !== '' && !sub.includes('/')) {
      const alert = await getD1OperationalAlert(deps.database, claims, sub)
      return jsonResponse({ alert })
    }

    // POST /api/admin/operations/alerts
    if (request.method === 'POST' && sub === '') {
      let body: Record<string, unknown>
      try {
        body = (await request.json()) as Record<string, unknown>
      } catch {
        return errorResponse('invalid_input', 400)
      }
      const alertId = String(body.alertId ?? '')
      const commandId = String(body.commandId ?? '')
      const { alertId: _a, commandId: _c, ...inputData } = body
      const alert = await createD1OperationalAlert(deps.database, claims, alertId, commandId, inputData, options)
      return jsonResponse({ alert }, 201)
    }

    // Sub-actions on an alert: :id/ack, :id/escalate, :id/resolve
    const match = sub.match(/^([^/]+)\/(ack|escalate|resolve)$/)
    if (request.method === 'POST' && match) {
      const alertId = match[1]!
      const action = match[2]!
      let body: Record<string, unknown>
      try {
        body = (await request.json()) as Record<string, unknown>
      } catch {
        return errorResponse('invalid_input', 400)
      }
      const commandId = String(body.commandId ?? '')
      const { commandId: _cmd, ...inputData } = body

      switch (action) {
        case 'ack': {
          const alert = await acknowledgeD1OperationalAlert(
            deps.database,
            claims,
            alertId,
            commandId,
            inputData,
            options
          )
          return jsonResponse({ alert })
        }
        case 'escalate': {
          const alert = await escalateD1OperationalAlert(deps.database, claims, alertId, commandId, inputData, options)
          return jsonResponse({ alert })
        }
        case 'resolve': {
          const alert = await resolveD1OperationalAlert(deps.database, claims, alertId, commandId, inputData, options)
          return jsonResponse({ alert })
        }
      }
    }

    return errorResponse('not_found', 404)
  } catch (error) {
    return mapOperationalAlertsError(error)
  }
}
