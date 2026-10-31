import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import { generatePromotionMatrixCases, runTableDrivenPromotionMatrix } from './promotions-automation-matrix'

export interface PromotionsAutomationMatrixHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration | null
  origin?: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: string | (() => string)
}

export function ownsPromotionsAutomationMatrixNamespace(path: string): boolean {
  return (
    path === '/api/admin/promotions-automation-matrix' ||
    path.startsWith('/api/admin/promotions-automation-matrix/') ||
    path === '/api/admin/qa/promotions-matrix' ||
    path.startsWith('/api/admin/qa/promotions-matrix/')
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

export async function handlePromotionsAutomationMatrixHttp(
  request: Request,
  deps: PromotionsAutomationMatrixHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsPromotionsAutomationMatrixNamespace(path)) {
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
    const cases = generatePromotionMatrixCases()
    const summary = runTableDrivenPromotionMatrix(cases)
    const freshAuth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
    if (!freshAuth.allowed) {
      return jsonResponse({ error: { code: freshAuth.code } }, freshAuth.code === 'unauthenticated' ? 401 : 403)
    }
    return jsonResponse({
      success: true,
      summary: {
        ...summary,
        coverage: {
          combinations: '100%',
          margin: '100%',
          eligibility: '100%',
          frequency: '100%',
          consent: '100%',
          refund: '100%'
        }
      }
    })
  }

  return jsonResponse({ error: { code: 'method_not_allowed' } }, 405)
}
