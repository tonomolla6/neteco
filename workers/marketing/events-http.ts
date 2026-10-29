import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import {
  createD1Event,
  updateD1Event,
  publishD1EventRecording,
  getD1EventBySlug,
  listD1Events,
  registerD1EventAttendee,
  dispatchD1EventReminders,
  submitD1EventQuestion,
  answerD1EventQuestion,
  listD1EventQuestions,
  dispatchD1EventFollowup,
  EventError
} from './events'

export interface EventsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration?: SessionCookieConfiguration | null
  origin?: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: string | (() => string)
}

export function ownsEventsNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (
      value === '/api/events' ||
      value.startsWith('/api/events/') ||
      value === '/api/admin/events' ||
      value.startsWith('/api/admin/events/')
    ) {
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

export function isAdminEventsPath(path: string): boolean {
  return path === '/api/admin/events' || path.startsWith('/api/admin/events/')
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

function mapEventError(err: unknown) {
  if (err instanceof EventError) {
    switch (err.code) {
      case 'unauthenticated':
        return errorResponse('unauthenticated', 401)
      case 'forbidden':
        return errorResponse('forbidden', 403)
      case 'not_found':
        return errorResponse('not_found', 404)
      case 'conflict':
        return errorResponse('conflict', 409)
      case 'version_conflict':
        return errorResponse('version_conflict', 409)
      case 'event_full':
        return errorResponse('event_full', 409)
      case 'event_not_open':
        return errorResponse('event_not_open', 400)
      case 'invalid_input':
      default:
        return errorResponse(err.code, 400)
    }
  }
  return errorResponse('internal_error', 500)
}

export async function handleEventsHttp(request: Request, deps: EventsHttpDependencies): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const now = typeof deps.now === 'function' ? deps.now() : deps.now

  let claims = null
  if (deps.sessionCookieConfiguration) {
    claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  }

  try {
    // 1. Admin routes
    if (isAdminEventsPath(path)) {
      if (!claims?.identityId) {
        return errorResponse('unauthenticated', 401)
      }

      if (deps.edgeLimiter && deps.rateLimitPepper) {
        const edgeOk = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, deps.rateLimitPepper, 'admin-cms')
        if (!edgeOk) return errorResponse('rate_limited', 429)
      }

      if (request.method === 'POST' && path === '/api/admin/events') {
        const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
        const event = await createD1Event(deps.database, claims, {
          ...(body as unknown as Parameters<typeof createD1Event>[2]),
          now
        })
        return jsonResponse({ event }, 201)
      }

      const matchId = path.match(/^\/api\/admin\/events\/([0-9a-fA-F-]+)$/)
      if (matchId && (request.method === 'PUT' || request.method === 'PATCH')) {
        const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
        const event = await updateD1Event(deps.database, claims, {
          ...(body as unknown as Parameters<typeof updateD1Event>[2]),
          eventId: matchId[1]!,
          now
        })
        return jsonResponse({ event }, 200)
      }

      const matchRecording = path.match(/^\/api\/admin\/events\/([0-9a-fA-F-]+)\/recording$/)
      if (matchRecording && request.method === 'POST') {
        const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
        const event = await publishD1EventRecording(deps.database, claims, {
          ...(body as unknown as Parameters<typeof publishD1EventRecording>[2]),
          eventId: matchRecording[1]!,
          now
        })
        return jsonResponse({ event }, 200)
      }

      const matchReminders = path.match(/^\/api\/admin\/events\/([0-9a-fA-F-]+)\/reminders$/)
      if (matchReminders && request.method === 'POST') {
        const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
        const reminders = await dispatchD1EventReminders(deps.database, claims, {
          ...(body as unknown as Parameters<typeof dispatchD1EventReminders>[2]),
          eventId: matchReminders[1]!,
          now
        })
        return jsonResponse({ reminders }, 200)
      }

      const matchFollowup = path.match(/^\/api\/admin\/events\/([0-9a-fA-F-]+)\/followup$/)
      if (matchFollowup && request.method === 'POST') {
        const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
        const followups = await dispatchD1EventFollowup(deps.database, claims, {
          ...(body as unknown as Parameters<typeof dispatchD1EventFollowup>[2]),
          eventId: matchFollowup[1]!,
          now
        })
        return jsonResponse({ followups }, 200)
      }

      const matchAnswer = path.match(/^\/api\/admin\/events\/questions\/([0-9a-fA-F-]+)\/answer$/)
      if (matchAnswer && request.method === 'POST') {
        const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
        const question = await answerD1EventQuestion(deps.database, claims, {
          ...(body as unknown as Parameters<typeof answerD1EventQuestion>[2]),
          questionId: matchAnswer[1]!,
          now
        })
        return jsonResponse({ question }, 200)
      }

      return errorResponse('not_found', 404)
    }

    // 2. Public Storefront routes
    if (request.method === 'GET' && path === '/api/events') {
      const sector = url.searchParams.get('sector') || undefined
      const type = url.searchParams.get('type') || undefined
      const status = url.searchParams.get('status') || undefined
      const list = await listD1Events(deps.database, { sector, type, status })
      return jsonResponse(list, 200)
    }

    const matchSlug = path.match(/^\/api\/events\/([a-z0-9_-]+)$/)
    if (matchSlug && request.method === 'GET') {
      const slug = matchSlug[1]!
      const event = await getD1EventBySlug(deps.database, slug)
      if (!event) return errorResponse('not_found', 404)
      return jsonResponse({ event }, 200)
    }

    const matchRegister = path.match(/^\/api\/events\/([a-z0-9_-]+)\/register$/)
    if (matchRegister && request.method === 'POST') {
      const slug = matchRegister[1]!
      const event = await getD1EventBySlug(deps.database, slug)
      if (!event) return errorResponse('not_found', 404)

      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
      const registration = await registerD1EventAttendee(deps.database, {
        commandId: typeof body.commandId === 'string' ? body.commandId : crypto.randomUUID(),
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : `idem-reg-${Date.now()}`,
        eventId: event.id,
        customerId: claims?.identityId,
        attendeeName: typeof body.attendeeName === 'string' ? body.attendeeName : '',
        attendeeEmail: typeof body.attendeeEmail === 'string' ? body.attendeeEmail : '',
        attendeePhone: typeof body.attendeePhone === 'string' ? body.attendeePhone : undefined,
        consentEmailReminder: Boolean(body.consentEmailReminder),
        consentSmsReminder: Boolean(body.consentSmsReminder),
        consentFollowup: Boolean(body.consentFollowup),
        consentTermsVersion: typeof body.consentTermsVersion === 'string' ? body.consentTermsVersion : 'terms-v1',
        now
      })
      return jsonResponse({ registration }, 201)
    }

    const matchQuestions = path.match(/^\/api\/events\/([a-z0-9_-]+)\/questions$/)
    if (matchQuestions) {
      const slug = matchQuestions[1]!
      const event = await getD1EventBySlug(deps.database, slug)
      if (!event) return errorResponse('not_found', 404)

      if (request.method === 'GET') {
        const questions = await listD1EventQuestions(deps.database, event.id)
        return jsonResponse(questions, 200)
      }

      if (request.method === 'POST') {
        const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
        const question = await submitD1EventQuestion(deps.database, {
          commandId: typeof body.commandId === 'string' ? body.commandId : crypto.randomUUID(),
          idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : `idem-q-${Date.now()}`,
          eventId: event.id,
          customerId: claims?.identityId,
          authorName: typeof body.authorName === 'string' ? body.authorName : '',
          questionText: typeof body.questionText === 'string' ? body.questionText : '',
          now
        })
        return jsonResponse({ question }, 201)
      }
    }

    return errorResponse('not_found', 404)
  } catch (err) {
    return mapEventError(err)
  }
}
