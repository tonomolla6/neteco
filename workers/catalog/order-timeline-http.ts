import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { OrderTimelineError, readD1OrderTimeline } from './order-timeline'
export interface OrderTimelineHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  edgeLimiter: RateLimit
  rateLimitPepper: string
  appEnvironment: 'local' | 'preview' | 'production'
  now?: () => string
}
export async function handleOrderTimelineHttp(
  request: Request,
  deps: OrderTimelineHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url),
    match = /^\/api\/(admin\/)?orders\/([^/]+)\/timeline$/.exec(url.pathname)
  if (!match) return null
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
  const error = (code: string, status: number, extra?: Record<string, string>) =>
    json({ error: { code } }, status, extra)
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
    const audience = match[1] ? 'admin' : 'customer',
      limited = await checkAdministrativeEdgeLimit(
        request,
        deps.edgeLimiter,
        deps.rateLimitPepper,
        audience === 'admin' ? 'admin-orders' : 'customer-refunds'
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
    return json(
      await readD1OrderTimeline(deps.database, claims, match[2]!, {
        audience,
        appEnvironment: deps.appEnvironment,
        limit: rawLimit === null ? 10 : Number(rawLimit),
        ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}),
        now: deps.now
      })
    )
  } catch (cause) {
    if (cause instanceof OrderTimelineError)
      return error(
        cause.code === 'read_unconfirmed' ? 'unavailable' : cause.code,
        cause.code === 'unauthenticated'
          ? 401
          : cause.code === 'invalid_input'
            ? 400
            : cause.code === 'not_found'
              ? 404
              : cause.code === 'read_unconfirmed'
                ? 503
                : 403
      )
    return error('unavailable', 503)
  }
}
