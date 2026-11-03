import { readJsonBody, serverInstant } from '../release/admin-access'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  authorizeOrders,
  createDraftOrder,
  submitDraftOrderForApproval,
  reviewDraftOrder,
  convertDraftOrderToConfirmed,
  sweepExpiredDraftOrders,
  getDraftOrder,
  listDraftOrders,
  DraftOrderError
} from './draft-orders'

export interface DraftOrdersHttpDependencies {
  database: D1Database
  origin?: string
  sessionCookieConfiguration: SessionCookieConfiguration | null
  now?: () => string
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer'
    }
  })
}

function failure(code: string, status = 500): Response {
  return jsonResponse({ error: { code } }, status)
}

export function ownsDraftOrdersNamespace(pathname: string): boolean {
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/admin\/draft-orders(?:[/\\%]|$)/i.test(pathname)) {
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

export async function handleDraftOrdersHttp(
  request: Request,
  deps: DraftOrdersHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsDraftOrdersNamespace(url.pathname)) return null

  const claims = deps.sessionCookieConfiguration
    ? await verifySessionCookie(request, deps.sessionCookieConfiguration)
    : null
  if (!claims) {
    return failure('unauthenticated', 401)
  }

  const now = deps.now ? deps.now() : serverInstant()

  try {
    if (request.method === 'POST' && url.pathname === '/api/admin/draft-orders/create') {
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      await authorizeOrders(deps.database, claims, now)
      if (!body || typeof body.commandId !== 'string' || !body.commandId.trim() || body.commandId.length > 128) {
        return failure('invalid_input', 400)
      }
      const result = await createDraftOrder(deps.database, claims, body, { now })
      return jsonResponse(result, 201)
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/draft-orders/submit') {
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const result = await submitDraftOrderForApproval(deps.database, claims, body, { now })
      return jsonResponse(result, 200)
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/draft-orders/review') {
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const result = await reviewDraftOrder(deps.database, claims, body, { now })
      return jsonResponse(result, 200)
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/draft-orders/convert') {
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const result = await convertDraftOrderToConfirmed(deps.database, claims, body, { now })
      return jsonResponse(result, 200)
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/draft-orders/sweep') {
      await authorizeOrders(deps.database, claims, now)
      const result = await sweepExpiredDraftOrders(deps.database, now)
      return jsonResponse(result, 200)
    }

    if (
      request.method === 'GET' &&
      url.pathname.startsWith('/api/admin/draft-orders/') &&
      url.pathname !== '/api/admin/draft-orders/list'
    ) {
      await authorizeOrders(deps.database, claims, now)
      const id = url.pathname.slice('/api/admin/draft-orders/'.length)
      const result = await getDraftOrder(deps.database, id)
      if (!result) return failure('not_found', 404)
      return jsonResponse(result, 200)
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/draft-orders/list') {
      await authorizeOrders(deps.database, claims, now)
      const customerId = url.searchParams.get('customerId') || undefined
      const status = url.searchParams.get('status') || undefined
      const result = await listDraftOrders(deps.database, { customerId, status })
      return jsonResponse(result, 200)
    }

    return failure('not_found', 404)
  } catch (err: unknown) {
    if (err instanceof DraftOrderError) {
      const statusMap: Record<string, number> = {
        unauthenticated: 401,
        forbidden: 403,
        not_found: 404,
        version_conflict: 409,
        idempotency_conflict: 409,
        draft_order_expired: 410,
        not_approved: 422
      }
      return failure(err.code, statusMap[err.code] || 400)
    }
    if (err instanceof Error && err.name === 'ZodError') {
      return failure('invalid_input', 400)
    }
    return failure('internal_error', 500)
  }
}
