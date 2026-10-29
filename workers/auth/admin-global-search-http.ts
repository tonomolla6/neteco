import type { AdminActivityHttpDependencies } from './admin-activity-http'
import { AdminGlobalSearchError, readD1AdminGlobalSearch } from './admin-global-search'
import { verifySessionCookie } from './session-cookie'
import { checkAdministrativeEdgeLimit } from './edge-limit'
export type AdminGlobalSearchHttpDependencies = AdminActivityHttpDependencies
export async function handleAdminGlobalSearchHttp(
  request: Request,
  deps: AdminGlobalSearchHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/api/admin/global-search') return null
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    Response.json(body, {
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
  const error = (code: string, status: number, headers?: Record<string, string>) =>
    json({ error: { code } }, status, headers)
  if (request.method !== 'GET') return error('method_not_allowed', 405, { Allow: 'GET' })
  try {
    const origin = new URL(deps.origin)
    if (origin.protocol !== 'https:' || origin.origin !== deps.origin || deps.origin.length > 2000)
      return error('unavailable', 503)
    if (
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    const limited = await checkAdministrativeEdgeLimit(
      request,
      deps.edgeLimiter,
      deps.rateLimitPepper,
      'admin-capabilities'
    )
    if (limited !== 'allowed')
      return error(limited === 'limited' ? 'rate_limited' : 'unavailable', limited === 'limited' ? 429 : 503)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    if (
      [...url.searchParams.keys()].some((key) => !['q', 'limit'].includes(key)) ||
      ['q', 'limit'].some((key) => url.searchParams.getAll(key).length > 1)
    )
      return error('invalid_input', 400)
    const rawLimit = url.searchParams.get('limit')
    if (rawLimit !== null && !/^[1-9]\d?$/.test(rawLimit)) return error('invalid_input', 400)
    return json(
      await readD1AdminGlobalSearch(deps.database, claims, {
        query: url.searchParams.get('q') ?? '',
        limit: rawLimit === null ? 10 : Number(rawLimit),
        now: deps.now
      })
    )
  } catch (cause) {
    if (cause instanceof AdminGlobalSearchError)
      return error(cause.code, cause.code === 'unauthenticated' ? 401 : cause.code === 'invalid_input' ? 400 : 403)
    return error('unavailable', 503)
  }
}
