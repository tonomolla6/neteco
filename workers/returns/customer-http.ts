import { returnOrderIdSchema, returnRequestInputSchema, returnIdempotencyKeySchema } from '../../shared/order-returns'
import { verifySessionCookie } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { activeOrderCustomerId } from '../catalog/customer-orders'
import { requestD1CustomerReturn, readD1CustomerReturns, ReturnsError } from './operations'
import {
  returnsJson,
  returnsHttpError,
  returnsStatus,
  ReturnsHttpError,
  checkReturnsOrigin,
  readReturnsBody,
  returnsPagination,
  type ReturnsHttpEnvironment
} from './admin-http'

export function ownsCustomerReturnsNamespace(pathname: string) {
  let path = pathname
  for (let i = 0; i < 4; i++) {
    if (/^\/api\/orders[/\\][^/\\]+[/\\]returns(?:[/\\%]|$)/.test(path)) return true
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
/** Existing verified customer ownership only. No guest token/email exchange,
 * retroactive owner claim, new permission grant or automatic eligibility. */
export async function handleCustomerReturnsHttp(
  request: Request,
  env: ReturnsHttpEnvironment
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCustomerReturnsNamespace(url.pathname)) return null
  try {
    checkReturnsOrigin(request, env)
    const match = /^\/api\/orders\/([^/]+)\/returns$/.exec(url.pathname),
      orderId = match?.[1]
    if (!orderId || !returnOrderIdSchema.safeParse(orderId).success) return returnsHttpError('invalid_input', 400)
    if (!['GET', 'POST'].includes(request.method))
      return returnsHttpError('method_not_allowed', 405, { Allow: 'GET, POST' })
    const read = request.method === 'GET'
    if (!read && url.searchParams.size) return returnsHttpError('invalid_input', 400)
    const page = read ? returnsPagination(url) : null
    if (env.AUTH_ENABLED !== 'true') return returnsHttpError('service_unavailable', 503)
    const claims = await verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
    if (!claims)
      return returnsHttpError(
        /(?:^|;)\s*neteco-order-access-v2=/.test(request.headers.get('cookie') ?? '')
          ? 'guest_verification_required'
          : 'unauthenticated',
        /(?:^|;)\s*neteco-order-access-v2=/.test(request.headers.get('cookie') ?? '') ? 403 : 401
      )
    const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      owner = await activeOrderCustomerId(env.DB, claims, now())
    if (!owner) return returnsHttpError('unauthenticated', 401)
    if (read) return returnsJson(await readD1CustomerReturns(env.DB, claims, orderId, page!))
    const key = returnIdempotencyKeySchema.safeParse(request.headers.get('idempotency-key'))
    if (!key.success) return returnsHttpError('invalid_idempotency_key', 400)
    const quota = await consumeIdentityQuota(env.DB, {
        identityId: claims.identityId,
        scope: 'customer-returns',
        limit: 10,
        windowSeconds: 3600
      }),
      headers = { 'X-RateLimit-Limit': '10', 'X-RateLimit-Remaining': String(quota.remaining) }
    if (!quota.allowed)
      return returnsHttpError('rate_limited', 429, { ...headers, 'Retry-After': String(quota.retryAfter) })
    const cmd = returnRequestInputSchema.safeParse(await readReturnsBody(request))
    if (!cmd.success) return returnsHttpError('invalid_input', 422)
    if ((await activeOrderCustomerId(env.DB, claims, now())) !== owner) return returnsHttpError('unauthenticated', 401)
    const receipt = await requestD1CustomerReturn(env.DB, claims, orderId, cmd.data, { idempotencyKey: key.data })
    if ((await activeOrderCustomerId(env.DB, claims, now())) !== owner) return returnsHttpError('unauthenticated', 401)
    return returnsJson(receipt, 201, headers)
  } catch (failure) {
    if (failure instanceof ReturnsHttpError) return returnsHttpError(failure.code, failure.status)
    if (failure instanceof ReturnsError) return returnsHttpError(failure.code, returnsStatus(failure.code))
    return returnsHttpError('service_unavailable', 503)
  }
}
