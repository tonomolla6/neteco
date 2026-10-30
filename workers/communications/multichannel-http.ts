import { z } from 'zod'
import { denyUnlessAdmin, serverInstant } from '../release/admin-access'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  orchestrateMultichannelDelivery,
  readCustomerChannelPreferences,
  updateCustomerChannelPreferences,
  MultichannelError,
  type MultichannelTransportAdapters
} from './multichannel-orchestrator'

export interface MultichannelHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: () => string
  transports?: MultichannelTransportAdapters
}

export function ownsMultichannelNamespace(pathname: string): boolean {
  return (
    pathname === '/api/admin/communications/multichannel/dispatch' ||
    pathname === '/api/admin/communications/multichannel/logs' ||
    pathname.startsWith('/api/admin/communications/multichannel/preferences/')
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

export async function handleMultichannelHttp(
  request: Request,
  deps: MultichannelHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsMultichannelNamespace(url.pathname)) return null

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

  // Admin API: dispatch, logs and any customer's preferences need live administrative authority
  // (role, MFA and session state re-read from D1); a signed-in buyer is not enough.
  const denied = await denyUnlessAdmin(
    deps.database,
    claims,
    ['administration.manage'],
    deps.now?.() ?? serverInstant()
  )
  if (denied) return errorResponse(denied.code, denied.status)

  try {
    // POST /api/admin/communications/multichannel/dispatch
    if (url.pathname === '/api/admin/communications/multichannel/dispatch' && request.method === 'POST') {
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

      const result = await orchestrateMultichannelDelivery(deps.database, idempotencyKey, body, {
        now: deps.now,
        transports: deps.transports
      })
      return jsonResponse(result)
    }

    // GET /api/admin/communications/multichannel/logs
    if (url.pathname === '/api/admin/communications/multichannel/logs' && request.method === 'GET') {
      const customerId = url.searchParams.get('customerId')
      const category = url.searchParams.get('category')
      const status = url.searchParams.get('status')
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10), 1), 100)
      const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10), 0)

      let countSql = 'SELECT COUNT(*) as count FROM multichannel_orchestration_commands WHERE 1=1'
      let selectSql = 'SELECT * FROM multichannel_orchestration_commands WHERE 1=1'
      const params: unknown[] = []

      if (customerId && z.string().uuid().safeParse(customerId).success) {
        countSql += ' AND customer_id = ?'
        selectSql += ' AND customer_id = ?'
        params.push(customerId)
      }
      if (category) {
        countSql += ' AND category = ?'
        selectSql += ' AND category = ?'
        params.push(category)
      }
      if (status) {
        countSql += ' AND status = ?'
        selectSql += ' AND status = ?'
        params.push(status)
      }

      selectSql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'

      const countRow = await deps.database
        .prepare(countSql)
        .bind(...params)
        .first<{ count: number }>()
      const total = countRow?.count ?? 0

      const rows = await deps.database
        .prepare(selectSql)
        .bind(...params, limit, offset)
        .all<{
          command_id: string
          customer_id: string
          dedup_key: string
          category: string
          event_type: string
          selected_channel: string | null
          priority_order: string
          status: string
          cause: string
          results: string
          mandatory: number
          created_at: string
        }>()

      const items = (rows.results ?? []).map((r) => ({
        commandId: r.command_id,
        customerId: r.customer_id,
        dedupKey: r.dedup_key,
        category: r.category,
        eventType: r.event_type,
        selectedChannel: r.selected_channel,
        priorityOrder: JSON.parse(r.priority_order),
        status: r.status,
        cause: r.cause,
        results: JSON.parse(r.results),
        mandatory: r.mandatory === 1,
        createdAt: r.created_at
      }))

      return jsonResponse({ total, items })
    }

    // GET /api/admin/communications/multichannel/preferences/:customerId
    const prefMatch = /^\/api\/admin\/communications\/multichannel\/preferences\/([^/]+)$/.exec(url.pathname)
    if (prefMatch) {
      const customerId = prefMatch[1]
      if (!z.string().uuid().safeParse(customerId).success) return errorResponse('invalid_input', 400)

      if (request.method === 'GET') {
        const prefs = await readCustomerChannelPreferences(deps.database, customerId)
        return jsonResponse(prefs)
      }

      if (request.method === 'PUT') {
        const idempotencyKey =
          request.headers.get('Idempotency-Key') ?? request.headers.get('idempotency-key') ?? crypto.randomUUID()

        let body: unknown
        try {
          body = await request.json()
        } catch {
          return errorResponse('invalid_input', 400)
        }

        const prefs = await updateCustomerChannelPreferences(deps.database, claims, customerId, idempotencyKey, body, {
          now: deps.now
        })
        return jsonResponse(prefs)
      }
    }

    return errorResponse('method_not_allowed', 405)
  } catch (err) {
    if (err instanceof MultichannelError) {
      if (err.code === 'unauthenticated') return errorResponse('unauthenticated', 401)
      if (err.code === 'forbidden') return errorResponse('forbidden', 403)
      if (err.code === 'not_found') return errorResponse('not_found', 404)
      if (err.code === 'conflict') return errorResponse('conflict', 409)
      if (err.code === 'invalid_input') return errorResponse('invalid_input', 400)
    }
    return errorResponse('service_unavailable', 503)
  }
}
