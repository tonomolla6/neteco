import { AdminActivityError, readD1AdminActivity } from './admin-activity'
import { verifySessionCookie, type SessionCookieConfiguration } from './session-cookie'
import { checkAdministrativeEdgeLimit } from './edge-limit'

export interface AdminActivityHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  edgeLimiter: RateLimit
  rateLimitPepper: string
  now?: () => string
}
export async function handleAdminActivityHttp(
  request: Request,
  deps: AdminActivityHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/api/admin/activity') return null
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
      [...url.searchParams.keys()].some((key) => !['limit', 'cursor'].includes(key)) ||
      ['limit', 'cursor'].some((key) => url.searchParams.getAll(key).length > 1)
    )
      return error('invalid_input', 400)
    const rawLimit = url.searchParams.get('limit')
    if (rawLimit !== null && !/^[1-9]\d?$/.test(rawLimit)) return error('invalid_input', 400)
    const result = await readD1AdminActivity(deps.database, claims, {
      limit: rawLimit === null ? 10 : Number(rawLimit),
      ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}),
      now: deps.now
    })
    return json(result)
  } catch (cause) {
    if (cause instanceof AdminActivityError)
      return error(cause.code, cause.code === 'unauthenticated' ? 401 : cause.code === 'invalid_input' ? 400 : 403)
    return error('unavailable', 503)
  }
}
