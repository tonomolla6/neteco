import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  isSupportChatOperatingHours,
  SUPPORT_CHAT_DISCLAIMER,
  requestLiveChatSession,
  claimLiveChatSession,
  sendLiveChatMessage,
  handoffLiveChatSession,
  escalateLiveChatToTicket,
  closeLiveChatSession,
  readLiveChatSession,
  readLiveChatTranscript,
  listActiveLiveChatQueue
} from './live-chat'

export interface LiveChatHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration | null
  origin: string
  edgeGate?: (request: Request, area: string) => Promise<'allowed' | 'limited' | 'denied'>
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff'
    }
  })
}

function errorResponse(code: string, status = 400) {
  return jsonResponse({ error: { code } }, status)
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'service_unavailable'
}

export function ownsSupportLiveChatNamespace(pathname: string): boolean {
  return pathname.startsWith('/api/support/live-chat') || pathname.startsWith('/api/admin/support/live-chat')
}

export async function handleSupportLiveChatHttp(
  request: Request,
  deps: LiveChatHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsSupportLiveChatNamespace(path)) return null

  if (deps.edgeGate) {
    const gate = await deps.edgeGate(request, path.startsWith('/api/admin/') ? 'admin' : 'support')
    if (gate !== 'allowed') {
      return errorResponse(gate === 'limited' ? 'rate_limited' : 'service_unavailable', gate === 'limited' ? 429 : 503)
    }
  }

  const method = request.method
  const claims = deps.sessionCookieConfiguration
    ? await verifySessionCookie(request, deps.sessionCookieConfiguration)
    : null

  // 1. GET /api/support/live-chat/availability
  if (path === '/api/support/live-chat/availability' && method === 'GET') {
    const queueRow = await deps.database
      .prepare("SELECT COUNT(*) AS cnt FROM support_live_chat_sessions WHERE status = 'waiting_operator'")
      .first<{ cnt: number }>()
    const length = queueRow?.cnt ?? 0
    const opHours = isSupportChatOperatingHours()

    return jsonResponse({
      isOpen: opHours.isOpen,
      schedule: opHours.schedule,
      timezone: opHours.timezone,
      currentUtc: opHours.currentUtc,
      nextOpeningAt: opHours.nextOpeningAt,
      operatingHours: {
        schedule: opHours.schedule,
        timezone: opHours.timezone
      },
      disclaimer: SUPPORT_CHAT_DISCLAIMER,
      queue: {
        length,
        estimatedWaitSeconds: length * 120
      }
    })
  }

  // 2. POST /api/support/live-chat/sessions
  if (path === '/api/support/live-chat/sessions' && method === 'POST') {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('invalid_input', 400)
    }

    try {
      const session = await requestLiveChatSession(deps.database, body, { claims })
      return jsonResponse({ session }, 201)
    } catch (err: unknown) {
      const msg = getErrorMessage(err)
      if (msg === 'outside_business_hours') return errorResponse('outside_business_hours', 403)
      if (msg === 'consent_required') return errorResponse('consent_required', 400)
      if (msg === 'invalid_input') return errorResponse('invalid_input', 400)
      return errorResponse('service_unavailable', 500)
    }
  }

  // 3. GET /api/admin/support/live-chat/queue
  if (path === '/api/admin/support/live-chat/queue' && method === 'GET') {
    if (!claims) return errorResponse('unauthenticated', 401)
    try {
      const queue = await listActiveLiveChatQueue(deps.database, claims)
      return jsonResponse({ queue })
    } catch (err: unknown) {
      const msg = getErrorMessage(err)
      if (msg === 'unauthenticated') return errorResponse('unauthenticated', 401)
      if (msg === 'forbidden') return errorResponse('forbidden', 403)
      return errorResponse('service_unavailable', 500)
    }
  }

  // Session routes
  const sessionClaimMatch = path.match(/^\/api\/admin\/support\/live-chat\/sessions\/([^/]+)\/claim$/)
  if (sessionClaimMatch && method === 'POST') {
    if (!claims) return errorResponse('unauthenticated', 401)
    const sessionId = sessionClaimMatch[1]!
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('invalid_input', 400)
    }

    try {
      const session = await claimLiveChatSession(deps.database, claims, sessionId, body)
      return jsonResponse({ session })
    } catch (err: unknown) {
      const msg = getErrorMessage(err)
      if (msg === 'unauthenticated') return errorResponse('unauthenticated', 401)
      if (msg === 'forbidden') return errorResponse('forbidden', 403)
      if (msg === 'version_conflict') return errorResponse('version_conflict', 409)
      if (msg === 'not_found') return errorResponse('not_found', 404)
      return errorResponse(msg, 400)
    }
  }

  const sessionHandoffMatch = path.match(/^\/api\/admin\/support\/live-chat\/sessions\/([^/]+)\/handoff$/)
  if (sessionHandoffMatch && method === 'POST') {
    if (!claims) return errorResponse('unauthenticated', 401)
    const sessionId = sessionHandoffMatch[1]!
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('invalid_input', 400)
    }

    try {
      const session = await handoffLiveChatSession(deps.database, claims, sessionId, body)
      return jsonResponse({ session })
    } catch (err: unknown) {
      const msg = getErrorMessage(err)
      if (msg === 'unauthenticated') return errorResponse('unauthenticated', 401)
      if (msg === 'forbidden') return errorResponse('forbidden', 403)
      if (msg === 'version_conflict') return errorResponse('version_conflict', 409)
      if (msg === 'not_found') return errorResponse('not_found', 404)
      return errorResponse(msg, 400)
    }
  }

  const sessionEscalateMatch = path.match(/^\/api\/admin\/support\/live-chat\/sessions\/([^/]+)\/escalate$/)
  if (sessionEscalateMatch && method === 'POST') {
    if (!claims) return errorResponse('unauthenticated', 401)
    const sessionId = sessionEscalateMatch[1]!
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('invalid_input', 400)
    }

    try {
      const result = await escalateLiveChatToTicket(deps.database, claims, sessionId, body)
      return jsonResponse(result)
    } catch (err: unknown) {
      const msg = getErrorMessage(err)
      if (msg === 'unauthenticated') return errorResponse('unauthenticated', 401)
      if (msg === 'forbidden') return errorResponse('forbidden', 403)
      if (msg === 'version_conflict') return errorResponse('version_conflict', 409)
      if (msg === 'not_found') return errorResponse('not_found', 404)
      return errorResponse(msg, 400)
    }
  }

  const sessionCloseMatch = path.match(/^\/api\/admin\/support\/live-chat\/sessions\/([^/]+)\/close$/)
  if (sessionCloseMatch && method === 'POST') {
    if (!claims) return errorResponse('unauthenticated', 401)
    const sessionId = sessionCloseMatch[1]!
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('invalid_input', 400)
    }

    try {
      const session = await closeLiveChatSession(deps.database, claims, sessionId, body)
      return jsonResponse({ session })
    } catch (err: unknown) {
      const msg = getErrorMessage(err)
      if (msg === 'unauthenticated') return errorResponse('unauthenticated', 401)
      if (msg === 'forbidden') return errorResponse('forbidden', 403)
      if (msg === 'version_conflict') return errorResponse('version_conflict', 409)
      if (msg === 'not_found') return errorResponse('not_found', 404)
      return errorResponse(msg, 400)
    }
  }

  const sessionMsgMatch = path.match(/^\/api\/support\/live-chat\/sessions\/([^/]+)\/messages$/)
  if (sessionMsgMatch && method === 'POST') {
    const sessionId = sessionMsgMatch[1]!
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return errorResponse('invalid_input', 400)
    }

    const body = (typeof rawBody === 'object' && rawBody !== null ? rawBody : {}) as {
      message?: unknown
      senderName?: unknown
    }
    const messageText = typeof body.message === 'string' ? body.message : ''
    if (!messageText || messageText.trim().length === 0) return errorResponse('invalid_input', 400)

    try {
      const isOperator = Boolean(claims)
      const senderName =
        typeof body.senderName === 'string' ? body.senderName : isOperator ? 'Operador Neteco' : 'Cliente'
      const message = await sendLiveChatMessage(deps.database, sessionId, {
        senderType: isOperator ? 'operator' : 'customer',
        senderId: claims?.identityId ?? null,
        senderName,
        message: messageText
      })
      return jsonResponse({ message }, 201)
    } catch (err: unknown) {
      const msg = getErrorMessage(err)
      if (msg === 'session_closed') return errorResponse('session_closed', 400)
      if (msg === 'not_found') return errorResponse('not_found', 404)
      return errorResponse(msg, 400)
    }
  }

  const sessionTranscriptMatch = path.match(/^\/api\/support\/live-chat\/sessions\/([^/]+)\/transcript$/)
  if (sessionTranscriptMatch && method === 'GET') {
    const sessionId = sessionTranscriptMatch[1]!
    try {
      const transcript = await readLiveChatTranscript(deps.database, sessionId)
      return jsonResponse({ transcript })
    } catch (err: unknown) {
      const msg = getErrorMessage(err)
      if (msg === 'not_found') return errorResponse('not_found', 404)
      return errorResponse('service_unavailable', 500)
    }
  }

  const sessionGetMatch = path.match(/^\/api\/support\/live-chat\/sessions\/([^/]+)$/)
  if (sessionGetMatch && method === 'GET') {
    const sessionId = sessionGetMatch[1]!
    try {
      const session = await readLiveChatSession(deps.database, sessionId)
      return jsonResponse({ session })
    } catch (err: unknown) {
      const msg = getErrorMessage(err)
      if (msg === 'not_found') return errorResponse('not_found', 404)
      return errorResponse('service_unavailable', 500)
    }
  }

  return null
}
