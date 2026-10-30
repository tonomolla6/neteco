import { readJsonBody } from '../release/admin-access'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  createEditorialBriefing,
  updateEditorialBriefing,
  reviewEditorialBriefing,
  publishOrScheduleEditorialBriefing,
  readEditorialBriefing,
  listEditorialBriefings,
  readUnifiedEditorialCalendar,
  EditorialBriefingError
} from './editorial-seo-briefing'

export interface EditorialBriefingHttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration | null
  now?: () => string
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
      ...headers
    }
  })
}

function failure(code: string, status = 500): Response {
  return jsonResponse({ error: { code } }, status)
}

export function ownsEditorialBriefingNamespace(pathname: string): boolean {
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/admin\/cms\/(briefings|editorial-calendar-briefings)(?:[/\\%]|$)/i.test(pathname)) {
      return true
    }
    try {
      const next = decodeURIComponent(pathname)
      if (next === pathname) break
      pathname = next
    } catch {
      break
    }
  }
  return false
}

export async function handleEditorialBriefingHttp(
  request: Request,
  deps: EditorialBriefingHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsEditorialBriefingNamespace(url.pathname)) return null

  const now = deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  // CSRF validation
  const origin = request.headers.get('origin')
  if (origin && origin !== deps.origin) {
    return failure('csrf_rejected', 403)
  }

  // Session verification
  if (!deps.sessionCookieConfiguration) {
    return failure('service_unavailable', 503)
  }

  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) {
    return failure('unauthenticated', 401)
  }

  try {
    const method = request.method
    const pathname = url.pathname

    // Calendar endpoint
    if (pathname === '/api/admin/cms/editorial-calendar-briefings' && method === 'GET') {
      const month = url.searchParams.get('month') ?? now.slice(0, 7)
      const calendar = await readUnifiedEditorialCalendar(deps.database, claims, { month }, { now })
      return jsonResponse(calendar, 200)
    }

    // List briefings: GET /api/admin/cms/briefings
    if (pathname === '/api/admin/cms/briefings' && method === 'GET') {
      const searchIntent = url.searchParams.get('searchIntent') ?? undefined
      const reviewStatus = url.searchParams.get('reviewStatus') ?? undefined
      const month = url.searchParams.get('month') ?? undefined
      const items = await listEditorialBriefings(deps.database, claims, { searchIntent, reviewStatus, month }, now)
      return jsonResponse({ briefings: items }, 200)
    }

    // Create briefing: POST /api/admin/cms/briefings
    if (pathname === '/api/admin/cms/briefings' && method === 'POST') {
      const commandId = request.headers.get('X-Command-Id') ?? undefined
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const created = await createEditorialBriefing(deps.database, claims, body, {
        commandId,
        now
      })
      return jsonResponse(created, 201)
    }

    // Review briefing: POST /api/admin/cms/briefings/:id/review
    const reviewMatch = /^\/api\/admin\/cms\/briefings\/([^/]+)\/review$/.exec(pathname)
    if (reviewMatch && method === 'POST') {
      const briefingId = reviewMatch[1]
      const commandId = request.headers.get('X-Command-Id') ?? undefined
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const reviewed = await reviewEditorialBriefing(deps.database, claims, briefingId, body, {
        commandId,
        now
      })
      return jsonResponse(reviewed, 200)
    }

    // Publish/schedule: POST /api/admin/cms/briefings/:id/publish
    const publishMatch = /^\/api\/admin\/cms\/briefings\/([^/]+)\/publish$/.exec(pathname)
    if (publishMatch && method === 'POST') {
      const briefingId = publishMatch[1]
      const commandId = request.headers.get('X-Command-Id') ?? undefined
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const published = await publishOrScheduleEditorialBriefing(deps.database, claims, briefingId, body, {
        commandId,
        now
      })
      return jsonResponse(published, 200)
    }

    // Update briefing: PUT /api/admin/cms/briefings/:id
    const itemMatch = /^\/api\/admin\/cms\/briefings\/([^/]+)$/.exec(pathname)
    if (itemMatch && method === 'PUT') {
      const briefingId = itemMatch[1]
      const commandId = request.headers.get('X-Command-Id') ?? undefined
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const updated = await updateEditorialBriefing(deps.database, claims, briefingId, body, {
        commandId,
        now
      })
      return jsonResponse(updated, 200)
    }

    // Get briefing: GET /api/admin/cms/briefings/:id
    if (itemMatch && method === 'GET') {
      const briefingId = itemMatch[1]
      const item = await readEditorialBriefing(deps.database, claims, briefingId, now)
      return jsonResponse(item, 200)
    }

    return failure('not_found', 404)
  } catch (error: unknown) {
    if (error instanceof EditorialBriefingError) {
      if (error.code === 'unauthenticated') return failure('unauthenticated', 401)
      if (error.code === 'forbidden') return failure('forbidden', 403)
      if (error.code === 'not_found') return failure('not_found', 404)
      if (error.code === 'version_conflict') return failure('version_conflict', 409)
      return failure(error.code, 400)
    }
    return failure('internal_error', 500)
  }
}
