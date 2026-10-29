import { orderTrackingSchema } from '../../shared/order-tracking'
import { fulfillmentOrderIdSchema } from '../../shared/order-fulfillment'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { GUEST_ORDER_COOKIE } from '../catalog/guest-order-access'
import { readD1OrderTracking, OrderTrackingError, type OrderTrackingAccess } from './tracking'

export interface OrderTrackingHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  /** Ingress owns the mandatory edge check BEFORE auth/cookie/D1:
   * admin-fulfillment for admin, customer-refunds for customer/guest. */
  edgeLimiter: RateLimit
  rateLimitPepper: string
  appEnvironment?: 'local' | 'preview' | 'production'
  now?: () => string
}
export function ownsOrderTrackingNamespace(pathname: string) {
  let path = pathname
  for (let pass = 0; pass < 4; pass++) {
    if (/^\/api\/(?:admin\/)?orders[/\\][^/\\]+[/\\]tracking(?:[/\\%]|$)/i.test(path)) return true
    try {
      const decoded = decodeURIComponent(path)
      if (decoded === path) return false
      path = decoded
    } catch {
      return false
    }
  }
  return false
}
export function ownsAdminOrderTrackingNamespace(pathname: string) {
  let path = pathname
  for (let pass = 0; pass < 4; pass++) {
    if (/^\/api\/admin\/orders[/\\][^/\\]+[/\\]tracking(?:[/\\%]|$)/i.test(path)) return true
    try {
      const decoded = decodeURIComponent(path)
      if (decoded === path) return false
      path = decoded
    } catch {
      return false
    }
  }
  return false
}
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
const error = (code: string, status: number, extra?: Record<string, string>) => json({ error: { code } }, status, extra)
export async function handleOrderTrackingHttp(
  request: Request,
  deps: OrderTrackingHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsOrderTrackingNamespace(url.pathname)) return null
  const match = /^\/api\/(admin\/)?orders\/([a-f0-9-]+)\/tracking$/.exec(url.pathname)
  if (!match || !fulfillmentOrderIdSchema.safeParse(match[2]).success) return error('invalid_input', 400)
  if (request.method !== 'GET') return error('method_not_allowed', 405, { Allow: 'GET' })
  try {
    const configured = new URL(deps.origin)
    if (configured.protocol !== 'https:' || configured.origin !== deps.origin || deps.origin.length > 2000)
      return error('service_unavailable', 503)
    if (
      url.origin !== deps.origin ||
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    if (url.searchParams.size) return error('invalid_input', 400)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    let access: OrderTrackingAccess
    if (claims) access = { kind: match[1] ? 'admin' : 'customer', claims }
    else {
      const cookie = request.headers.get('cookie')
      if (
        match[1] ||
        !cookie ||
        cookie.length > 16384 ||
        !cookie.split(';').some((part) => part.trim().startsWith(GUEST_ORDER_COOKIE + '='))
      )
        return error('unauthenticated', 401)
      access = { kind: 'guest', request, configuration: deps.sessionCookieConfiguration }
    }
    const parsed = orderTrackingSchema.safeParse(
      await readD1OrderTracking(deps.database, access, match[2]!, deps.now ? { now: deps.now() } : {})
    )
    if (!parsed.success || parsed.data.orderId !== match[2] || parsed.data.audience !== access.kind)
      return error('service_unavailable', 503)
    return json(parsed.data)
  } catch (cause) {
    if (!(cause instanceof OrderTrackingError)) return error('service_unavailable', 503)
    return error(
      cause.code,
      cause.code === 'unauthenticated'
        ? 401
        : ['email_unverified', 'mfa_required', 'forbidden'].includes(cause.code)
          ? 403
          : cause.code === 'not_found'
            ? 404
            : cause.code === 'invalid_input'
              ? 422
              : 503
    )
  }
}
