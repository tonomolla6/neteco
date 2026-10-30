import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  WarehouseTelemetryError,
  recordD1TelemetryEvent,
  recordD1DeviceHeartbeat,
  computeD1TelemetryAggregates,
  getD1TelemetryAggregates,
  listD1WarehouseDevices
} from './warehouse-route-telemetry'

export interface WarehouseRouteTelemetryHttpDependencies {
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

export function ownsWarehouseRouteTelemetryNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (/^\/api\/admin\/observability\/telemetry(?:\/|$)/.test(value)) {
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

function mapTelemetryError(error: unknown): Response {
  if (error instanceof WarehouseTelemetryError) {
    switch (error.code) {
      case 'invalid_input':
        return errorResponse(error.code, 400)
      case 'unauthenticated':
        return errorResponse(error.code, 401)
      case 'forbidden':
      case 'email_unverified':
      case 'mfa_required':
      case 'labor_privacy_violation':
        return errorResponse(error.code, 403)
      case 'not_found':
        return errorResponse(error.code, 404)
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

export async function handleWarehouseRouteTelemetryHttp(
  request: Request,
  deps: WarehouseRouteTelemetryHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsWarehouseRouteTelemetryNamespace(path)) {
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

  // 3. Live authorization check
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
  const sub = path.replace(/^\/api\/admin\/observability\/telemetry\/?/, '').replace(/\/$/, '')

  try {
    // POST /api/admin/observability/telemetry/events
    if (request.method === 'POST' && sub === 'events') {
      let body: Record<string, unknown>
      try {
        body = (await request.json()) as Record<string, unknown>
      } catch {
        return errorResponse('invalid_input', 400)
      }
      const eventId = String(body.eventId ?? crypto.randomUUID())
      const commandId = String(body.commandId ?? crypto.randomUUID())
      const idempotencyKey = String(body.idempotencyKey ?? commandId)
      const { eventId: _e, commandId: _c, idempotencyKey: _k, ...inputData } = body

      const event = await recordD1TelemetryEvent(
        deps.database,
        claims,
        eventId,
        commandId,
        idempotencyKey,
        inputData,
        options
      )
      return jsonResponse({ event }, 201)
    }

    // POST /api/admin/observability/telemetry/devices/heartbeat
    if (request.method === 'POST' && sub === 'devices/heartbeat') {
      let body: Record<string, unknown>
      try {
        body = (await request.json()) as Record<string, unknown>
      } catch {
        return errorResponse('invalid_input', 400)
      }
      const commandId = String(body.commandId ?? crypto.randomUUID())
      const idempotencyKey = String(body.idempotencyKey ?? commandId)
      const { commandId: _c, idempotencyKey: _k, ...inputData } = body

      const device = await recordD1DeviceHeartbeat(deps.database, claims, commandId, idempotencyKey, inputData, options)
      return jsonResponse({ device })
    }

    // GET /api/admin/observability/telemetry/devices
    if (request.method === 'GET' && sub === 'devices') {
      const devices = await listD1WarehouseDevices(deps.database, claims)
      return jsonResponse({ devices })
    }

    // POST /api/admin/observability/telemetry/compute
    if (request.method === 'POST' && sub === 'compute') {
      let body: Record<string, unknown>
      try {
        body = (await request.json()) as Record<string, unknown>
      } catch {
        return errorResponse('invalid_input', 400)
      }
      const aggregateId = String(body.aggregateId ?? crypto.randomUUID())
      const commandId = String(body.commandId ?? crypto.randomUUID())
      const idempotencyKey = String(body.idempotencyKey ?? commandId)
      const { aggregateId: _a, commandId: _c, idempotencyKey: _k, ...inputData } = body

      const aggregate = await computeD1TelemetryAggregates(
        deps.database,
        claims,
        aggregateId,
        commandId,
        idempotencyKey,
        inputData,
        options
      )
      return jsonResponse({ aggregate })
    }

    // GET /api/admin/observability/telemetry/aggregates
    if (request.method === 'GET' && sub === 'aggregates') {
      const periodDate = url.searchParams.get('periodDate') ?? ''
      const shiftCode = url.searchParams.get('shiftCode') ?? ''
      const zoneCode = url.searchParams.get('zoneCode') ?? ''

      const aggregate = await getD1TelemetryAggregates(deps.database, claims, periodDate, shiftCode, zoneCode)
      return jsonResponse({ aggregate })
    }

    return errorResponse('not_found', 404)
  } catch (error) {
    return mapTelemetryError(error)
  }
}
