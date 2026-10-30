import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { supportBytes } from '../support/http'
import { SupportError } from '../support/operations'
import {
  ONE_CLICK_CONSENT_VERSION,
  payWithSavedToken,
  startTokenizedPayment,
  TokenizationError,
  type TokenizationDependencies
} from './tokenization'

const BASE = '/api/account/saved-cards'
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
const STATUS: Record<TokenizationError['code'], number> = {
  invalid_input: 400,
  unauthenticated: 401,
  not_found: 404,
  conflict: 409,
  not_payable: 422,
  unavailable: 503
}

export const ownsSavedCardsNamespace = (pathname: string) => pathname === BASE || pathname.startsWith(`${BASE}/`)

export interface TokenizationHttpDependencies {
  /** null while the PAY-022 gate (bank support, PCI review, self-service removal) is closed. */
  tokenization: TokenizationDependencies | null
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration
}

export async function handleTokenizationHttp(
  request: Request,
  deps: TokenizationHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsSavedCardsNamespace(url.pathname)) return null
  const route = url.pathname.slice(BASE.length)
  const post = route === '/consent-payments' || route === '/one-click'
  if (!post && route !== '/availability') return fail('not_found', 404)
  const method = post ? 'POST' : 'GET'
  if (request.method !== method) return fail('method_not_allowed', 405, { allow: method })
  try {
    const configured = new URL(deps.origin)
    if (
      configured.protocol !== 'https:' ||
      configured.origin !== deps.origin ||
      configured.username ||
      configured.password
    )
      return fail('unavailable', 503)
    if (url.origin !== deps.origin || url.search) return fail('forbidden', 403)
    const origin = request.headers.get('origin')
    if (
      (origin !== null && origin !== deps.origin) ||
      (post && origin !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return fail('forbidden', 403)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return fail('unauthenticated', 401)
    if (route === '/availability')
      return respond({ available: deps.tokenization !== null, consentVersion: ONE_CLICK_CONSENT_VERSION })
    if (!deps.tokenization) return fail('unavailable', 503)
    const now = deps.tokenization.now()
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: route === '/one-click' ? 'saved-card-one-click' : 'saved-card-consent-payment',
      limit: 20,
      windowSeconds: 3600,
      now: Math.floor(Date.parse(now) / 1000)
    })
    if (!quota.allowed) return fail('rate_limited', 429, { 'retry-after': String(quota.retryAfter) })
    const orderToken = request.headers.get('authorization')?.match(/^Order ([A-Za-z0-9_-]{43,86})$/)?.[1]
    if (!orderToken) return fail('unauthenticated', 401)
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
      return fail('invalid_input', 415)
    let body: unknown
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await supportBytes(request, 2048)))
    } catch (error) {
      return fail('invalid_input', error instanceof SupportError && error.code === 'body_too_large' ? 413 : 400)
    }
    const key = request.headers.get('idempotency-key')
    if (key !== null && key !== (body as { commandId?: unknown } | null)?.commandId) return fail('invalid_input', 400)
    return route === '/one-click'
      ? respond(await payWithSavedToken(claims, orderToken, body, deps.tokenization))
      : respond(await startTokenizedPayment(claims, orderToken, body, deps.tokenization), 201)
  } catch (error) {
    if (error instanceof TokenizationError) return fail(error.code, STATUS[error.code])
    return fail('unavailable', 503)
  }
}
