import { readJsonBody, serverInstant } from '../release/admin-access'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  authorizeCatalog,
  stageAndCompareSupplierFeed,
  reviewSupplierFeedItem,
  applyApprovedFeedItems,
  getSupplierFeedImport,
  listSupplierFeedReviewItems,
  SupplierFeedError
} from './supplier-feed-comparison'

export interface SupplierFeedHttpDependencies {
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

export function ownsSupplierFeedNamespace(pathname: string): boolean {
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/admin\/supplier-feed(?:[/\\%]|$)/i.test(pathname)) {
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

export async function handleSupplierFeedHttp(
  request: Request,
  deps: SupplierFeedHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsSupplierFeedNamespace(url.pathname)) return null

  const claims = deps.sessionCookieConfiguration
    ? await verifySessionCookie(request, deps.sessionCookieConfiguration)
    : null
  if (!claims) {
    return failure('unauthenticated', 401)
  }

  const now = deps.now ? deps.now() : serverInstant()

  try {
    if (request.method === 'POST' && url.pathname === '/api/admin/supplier-feed/stage') {
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const result = await stageAndCompareSupplierFeed(deps.database, claims, body, { now })
      return jsonResponse(result, 201)
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/supplier-feed/review') {
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const result = await reviewSupplierFeedItem(deps.database, claims, body, { now })
      return jsonResponse(result, 200)
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/supplier-feed/apply') {
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const result = await applyApprovedFeedItems(deps.database, claims, body, { now })
      return jsonResponse(result, 200)
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/admin/supplier-feed/import/')) {
      await authorizeCatalog(deps.database, claims, now)
      const importId = url.pathname.slice('/api/admin/supplier-feed/import/'.length)
      const result = await getSupplierFeedImport(deps.database, importId)
      return jsonResponse(result, 200)
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/supplier-feed/items') {
      await authorizeCatalog(deps.database, claims, now)
      const importId = url.searchParams.get('importId')
      if (!importId) {
        return failure('missing_import_id', 400)
      }
      const status = url.searchParams.get('status') || undefined
      const result = await listSupplierFeedReviewItems(deps.database, importId, status)
      return jsonResponse(result, 200)
    }

    return failure('not_found', 404)
  } catch (err: unknown) {
    if (err instanceof SupplierFeedError) {
      const statusMap: Record<string, number> = {
        unauthenticated: 401,
        forbidden: 403,
        not_found: 404,
        version_conflict: 409,
        unreviewed_feed_cannot_publish: 422
      }
      return failure(err.code, statusMap[err.code] || 400)
    }
    if (err instanceof Error && err.name === 'ZodError') {
      return failure('invalid_input', 400)
    }
    return failure('internal_error', 500)
  }
}
