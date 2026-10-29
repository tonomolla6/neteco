import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import {
  createD1Bundle,
  getD1BundleBySlug,
  listD1Bundles,
  updateD1Bundle,
  archiveD1Bundle,
  calculateD1BundleSelection,
  BundleError
} from './bundles'

export interface BundlesHttpDependencies {
  database: D1Database
  sessionCookieConfiguration?: SessionCookieConfiguration | null
  origin?: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: string | (() => string)
}

export function ownsBundlesNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (
      value === '/api/bundles' ||
      value.startsWith('/api/bundles/') ||
      value === '/api/admin/bundles' ||
      value.startsWith('/api/admin/bundles/')
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

export function isAdminBundlesPath(path: string): boolean {
  return path === '/api/admin/bundles' || path.startsWith('/api/admin/bundles/')
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

function mapBundleError(err: unknown) {
  if (err instanceof BundleError) {
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
      case 'invalid_input':
      default:
        return errorResponse(err.code, 400)
    }
  }
  return errorResponse('internal_error', 500)
}

export async function handleBundlesHttp(request: Request, deps: BundlesHttpDependencies): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const now = typeof deps.now === 'function' ? deps.now() : deps.now

  let claims = null
  if (deps.sessionCookieConfiguration) {
    claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  }

  try {
    // 1. Administrative routes
    if (isAdminBundlesPath(path)) {
      if (!claims?.identityId) {
        return errorResponse('unauthenticated', 401)
      }

      if (deps.edgeLimiter && deps.rateLimitPepper) {
        const edgeOk = await checkAdministrativeEdgeLimit({
          limiter: deps.edgeLimiter,
          pepper: deps.rateLimitPepper,
          request,
          identityId: claims.identityId
        })
        if (!edgeOk) return errorResponse('rate_limited', 429)
      }

      if (request.method === 'POST' && path === '/api/admin/bundles') {
        const body = await request.json()
        const result = await createD1Bundle(deps.database, claims, { ...body, now })
        return jsonResponse({ bundle: result }, 201)
      }

      const matchId = path.match(/^\/api\/admin\/bundles\/([0-9a-fA-F-]+)$/)
      if (matchId) {
        const bundleId = matchId[1]
        if (request.method === 'PATCH' || request.method === 'PUT') {
          const body = await request.json()
          const result = await updateD1Bundle(deps.database, claims, {
            ...body,
            bundleId,
            now
          })
          return jsonResponse({ bundle: result }, 200)
        }
        if (request.method === 'DELETE') {
          const body = await request.json().catch(() => ({}))
          const result = await archiveD1Bundle(deps.database, claims, {
            commandId: body.commandId ?? crypto.randomUUID(),
            idempotencyKey: body.idempotencyKey ?? `idem-del-${Date.now()}`,
            bundleId,
            expectedVersion: body.expectedVersion ?? 1,
            now
          })
          return jsonResponse({ bundle: result }, 200)
        }
      }

      return errorResponse('not_found', 404)
    }

    // 2. Public Storefront routes
    if (request.method === 'GET' && path === '/api/bundles') {
      const sector = url.searchParams.get('sector') || undefined
      const task = url.searchParams.get('task') || undefined
      const list = await listD1Bundles(deps.database, { sector, task }, now)
      return jsonResponse(list, 200)
    }

    if (request.method === 'POST' && path === '/api/bundles/calculate') {
      const body = await request.json()
      const selection = await calculateD1BundleSelection(deps.database, body)
      return jsonResponse({ selection }, 200)
    }

    const matchSlug = path.match(/^\/api\/bundles\/([a-z0-9_-]+)$/)
    if (request.method === 'GET' && matchSlug) {
      const slug = matchSlug[1]
      const bundle = await getD1BundleBySlug(deps.database, slug, now)
      if (!bundle || bundle.status === 'archived') {
        return errorResponse('not_found', 404)
      }
      return jsonResponse({ bundle }, 200)
    }

    return errorResponse('not_found', 404)
  } catch (err) {
    return mapBundleError(err)
  }
}
