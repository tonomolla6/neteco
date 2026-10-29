import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { supportBytes } from '../support/http'
import { SupportError } from '../support/operations'
import {
  listPaymentTokens,
  requestPaymentTokenRemoval,
  paymentTokenRemovalInputSchema,
  PaymentTokenError
} from './token-removal'

export interface PaymentTokenRemovalHttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration
  now?: () => string
}
export async function handlePaymentTokenRemovalHttp(
  request: Request,
  deps: PaymentTokenRemovalHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/api/account/payment-tokens') return null
  const headers = {
    'cache-control': 'private, no-store',
    vary: 'Cookie',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'referrer-policy': 'no-referrer'
  }
  const respond = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    Response.json(body, { status, headers: { ...headers, ...extra } })
  const fail = (code: string, status: number, extra: Record<string, string> = {}) =>
    respond({ error: { code } }, status, extra)
  if (!['GET', 'POST'].includes(request.method)) return fail('method_not_allowed', 405, { allow: 'GET, POST' })
  try {
    const configured = new URL(deps.origin)
    if (
      configured.protocol !== 'https:' ||
      configured.origin !== deps.origin ||
      configured.username ||
      configured.password
    )
      return fail('unavailable', 503)
    if (url.origin !== deps.origin) return fail('forbidden', 403)
    if (url.search) return fail('invalid_input', 400)
    const origin = request.headers.get('origin')
    if (
      (origin !== null && origin !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.method === 'POST' && origin !== deps.origin)
    )
      return fail('forbidden', 403)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return fail('unauthenticated', 401)
    await listPaymentTokens(deps.database, claims, deps)
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: request.method === 'POST' ? 'payment-token-removal' : 'payment-token-reads',
      limit: request.method === 'POST' ? 10 : 60,
      windowSeconds: request.method === 'POST' ? 3600 : 60,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now()) / 1000) } : {})
    })
    if (!quota.allowed) return fail('rate_limited', 429, { 'retry-after': String(quota.retryAfter) })
    if (request.method === 'GET') return respond(await listPaymentTokens(deps.database, claims, deps))
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
      return fail('invalid_input', 415)
    let body: unknown
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await supportBytes(request, 4096)))
    } catch (error) {
      if (error instanceof SupportError && error.code === 'body_too_large') return fail('invalid_input', 413)
      return fail('invalid_input', 400)
    }
    const parsed = paymentTokenRemovalInputSchema.safeParse(body)
    if (!parsed.success) return fail('invalid_input', 400)
    const key = request.headers.get('idempotency-key')
    if (key !== null && key !== parsed.data.commandId) return fail('invalid_input', 400)
    return respond(await requestPaymentTokenRemoval(deps.database, claims, parsed.data, deps), 202)
  } catch (error) {
    if (error instanceof PaymentTokenError)
      return fail(
        error.code,
        { invalid_input: 400, unauthenticated: 401, not_found: 404, conflict: 409, unavailable: 503 }[error.code]
      )
    return fail('unavailable', 503)
  }
}
