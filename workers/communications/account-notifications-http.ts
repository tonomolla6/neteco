import { z } from 'zod'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  listAccountNotifications,
  markAccountNotificationsRead,
  getAccountNotificationSummary,
  resolveCustomerId,
  AccountNotificationError
} from './account-notifications'
import {
  readCustomerChannelPreferences,
  updateCustomerChannelPreferences,
  MultichannelError
} from './multichannel-orchestrator'

export interface AccountNotificationsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: () => string
}

export function ownsAccountNotificationsNamespace(pathname: string): boolean {
  return (
    pathname === '/api/account/notifications' ||
    pathname === '/api/account/notifications/mark-read' ||
    pathname === '/api/account/notifications/summary' ||
    pathname === '/api/account/multichannel-preferences'
  )
}

function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
      ...extra
    }
  })
}

function errorResponse(code: string, status: number, extra?: Record<string, string>): Response {
  return jsonResponse({ error: { code } }, status, extra)
}

export async function handleAccountNotificationsHttp(
  request: Request,
  deps: AccountNotificationsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsAccountNotificationsNamespace(url.pathname)) return null

  // Origin verification
  if (
    url.origin !== deps.origin ||
    (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (['POST', 'PUT', 'DELETE'].includes(request.method) && request.headers.get('origin') !== deps.origin)
  ) {
    return errorResponse('csrf_rejected', 403)
  }

  // Session verification
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) return errorResponse('unauthenticated', 401)

  try {
    const customerId = await resolveCustomerId(deps.database, claims.identityId)

    // GET /api/account/notifications
    if (url.pathname === '/api/account/notifications' && request.method === 'GET') {
      const query = {
        category: url.searchParams.get('category') ?? 'all',
        status: url.searchParams.get('status') ?? 'all',
        limit: url.searchParams.get('limit') ?? 20,
        offset: url.searchParams.get('offset') ?? 0
      }
      const result = await listAccountNotifications(deps.database, claims, query)
      return jsonResponse(result)
    }

    // GET /api/account/notifications/summary
    if (url.pathname === '/api/account/notifications/summary' && request.method === 'GET') {
      const result = await getAccountNotificationSummary(deps.database, claims)
      return jsonResponse(result)
    }

    // POST /api/account/notifications/mark-read
    if (url.pathname === '/api/account/notifications/mark-read' && request.method === 'POST') {
      const idempotencyKey =
        request.headers.get('Idempotency-Key') ?? request.headers.get('idempotency-key') ?? crypto.randomUUID()

      if (!z.string().uuid().safeParse(idempotencyKey).success) {
        return errorResponse('invalid_input', 400)
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return errorResponse('invalid_input', 400)
      }

      const result = await markAccountNotificationsRead(deps.database, claims, idempotencyKey, body, { now: deps.now })
      return jsonResponse(result)
    }

    // GET /api/account/multichannel-preferences
    if (url.pathname === '/api/account/multichannel-preferences' && request.method === 'GET') {
      const prefs = await readCustomerChannelPreferences(deps.database, customerId)
      return jsonResponse(prefs)
    }

    // PUT /api/account/multichannel-preferences
    if (url.pathname === '/api/account/multichannel-preferences' && request.method === 'PUT') {
      const idempotencyKey =
        request.headers.get('Idempotency-Key') ?? request.headers.get('idempotency-key') ?? crypto.randomUUID()

      if (!z.string().uuid().safeParse(idempotencyKey).success) {
        return errorResponse('invalid_input', 400)
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return errorResponse('invalid_input', 400)
      }

      const result = await updateCustomerChannelPreferences(deps.database, claims, customerId, idempotencyKey, body, {
        now: deps.now
      })
      return jsonResponse(result)
    }

    return errorResponse('method_not_allowed', 405)
  } catch (err) {
    if (err instanceof AccountNotificationError || err instanceof MultichannelError) {
      if (err.code === 'unauthenticated') return errorResponse('unauthenticated', 401)
      if (err.code === 'forbidden') return errorResponse('forbidden', 403)
      if (err.code === 'not_found') return errorResponse('not_found', 404)
      if (err.code === 'conflict') return errorResponse('conflict', 409)
      if (err.code === 'invalid_input') return errorResponse('invalid_input', 400)
    }
    return errorResponse('service_unavailable', 503)
  }
}
