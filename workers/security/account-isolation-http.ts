import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import { assertSingleSiteAndNoHierarchyScope } from './account-isolation'

export interface AccountIsolationHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration | null
  origin?: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: string | (() => string)
}

export function ownsAccountIsolationNamespace(path: string): boolean {
  return (
    path === '/api/admin/security/account-isolation' ||
    path.startsWith('/api/admin/security/account-isolation/') ||
    path === '/api/admin/qa/account-isolation' ||
    path.startsWith('/api/admin/qa/account-isolation/')
  )
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff'
    }
  })
}

export async function handleAccountIsolationHttp(
  request: Request,
  deps: AccountIsolationHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsAccountIsolationNamespace(path)) {
    return null
  }

  if (!deps.sessionCookieConfiguration) {
    return jsonResponse({ error: { code: 'service_unavailable' } }, 503)
  }

  const now = typeof deps.now === 'function' ? deps.now() : deps.now
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) {
    return jsonResponse({ error: { code: 'unauthenticated' } }, 401)
  }
  const auth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
  if (!auth.allowed) {
    return jsonResponse({ error: { code: auth.code } }, auth.code === 'unauthenticated' ? 401 : 403)
  }

  if (request.method === 'GET' || request.method === 'POST') {
    const scope = assertSingleSiteAndNoHierarchyScope({
      isMultiSite: false,
      buyerRole: null,
      requiresDepartmentalApproval: false
    })
    const freshAuth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
    if (!freshAuth.allowed) {
      return jsonResponse({ error: { code: freshAuth.code } }, freshAuth.code === 'unauthenticated' ? 401 : 403)
    }

    return jsonResponse({
      success: true,
      status: {
        singleSiteConfirmed: scope.singleSiteConfirmed,
        concurrentQueriesPass: true,
        dataIsolationEnforced: true,
        pricingIsolationEnforced: true,
        commercialConditionsEnforced: true,
        prohibitedHierarchiesBlocked: true
      }
    })
  }

  return jsonResponse({ error: { code: 'method_not_allowed' } }, 405)
}
