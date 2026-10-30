import { readJsonBody } from '../release/admin-access'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  getCommercialPipeline,
  getCommercialAccountDetail,
  createCommercialNextAction,
  completeCommercialNextAction,
  evaluateQuoteMargin,
  approveQuoteMarginThreshold,
  CommercialQuotesAccountsError
} from './commercial-quotes-accounts'

export interface CommercialQuotesAccountsHttpDependencies {
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

export function ownsCommercialQuotesAccountsNamespace(pathname: string): boolean {
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/admin\/commercial\/(pipeline|accounts|next-actions|quotes)(?:[/\\%]|$)/i.test(pathname)) {
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

export async function handleCommercialQuotesAccountsHttp(
  request: Request,
  deps: CommercialQuotesAccountsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCommercialQuotesAccountsNamespace(url.pathname)) return null

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

    // Pipeline: GET /api/admin/commercial/pipeline
    if (pathname === '/api/admin/commercial/pipeline' && method === 'GET') {
      const pipeline = await getCommercialPipeline(deps.database, claims, {}, { now })
      return jsonResponse(pipeline, 200)
    }

    // Account detail: GET /api/admin/commercial/accounts/:id
    const accountMatch = /^\/api\/admin\/commercial\/accounts\/([^/]+)$/.exec(pathname)
    if (accountMatch && method === 'GET') {
      const customerId = accountMatch[1]
      const account = await getCommercialAccountDetail(deps.database, claims, customerId)
      return jsonResponse(account, 200)
    }

    // Create next action: POST /api/admin/commercial/next-actions
    if (pathname === '/api/admin/commercial/next-actions' && method === 'POST') {
      const commandId = request.headers.get('X-Command-Id') ?? undefined
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const created = await createCommercialNextAction(deps.database, claims, body, {
        commandId,
        now
      })
      return jsonResponse(created, 201)
    }

    // Complete next action: POST /api/admin/commercial/next-actions/:id/complete
    const completeMatch = /^\/api\/admin\/commercial\/next-actions\/([^/]+)\/complete$/.exec(pathname)
    if (completeMatch && method === 'POST') {
      const actionId = completeMatch[1]
      const commandId = request.headers.get('X-Command-Id') ?? undefined
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const completed = await completeCommercialNextAction(deps.database, claims, actionId, body, {
        commandId,
        now
      })
      return jsonResponse(completed, 200)
    }

    // Quote margin calculation: POST /api/admin/commercial/quotes/margins or /api/admin/commercial/quotes/:id/margin
    const quoteMarginMatch = /^\/api\/admin\/commercial\/quotes\/(?:([^/]+)\/margin|margins)$/.exec(pathname)
    if (quoteMarginMatch && method === 'POST') {
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const quoteId = quoteMarginMatch[1] ?? body.quoteId
      const commandId = request.headers.get('X-Command-Id') ?? undefined
      const marginRecord = await evaluateQuoteMargin(deps.database, claims, quoteId, body, {
        commandId,
        now
      })
      return jsonResponse(marginRecord, 200)
    }

    // Approve margin threshold: POST /api/admin/commercial/quotes/:id/margin/approve
    const approveMatch = /^\/api\/admin\/commercial\/quotes\/([^/]+)\/margin\/approve$/.exec(pathname)
    if (approveMatch && method === 'POST') {
      const quoteId = approveMatch[1]
      const commandId = request.headers.get('X-Command-Id') ?? undefined
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const approved = await approveQuoteMarginThreshold(deps.database, claims, quoteId, body, {
        commandId,
        now
      })
      return jsonResponse(approved, 200)
    }

    return failure('not_found', 404)
  } catch (error: unknown) {
    if (error instanceof CommercialQuotesAccountsError) {
      if (error.code === 'unauthenticated') return failure('unauthenticated', 401)
      if (error.code === 'forbidden') return failure('forbidden', 403)
      if (error.code === 'not_found') return failure('not_found', 404)
      if (error.code === 'version_conflict') return failure('version_conflict', 409)
      return failure(error.code, 400)
    }
    return failure('internal_error', 500)
  }
}
