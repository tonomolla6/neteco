import { z } from 'zod'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { activeOrderCustomerId } from '../catalog/customer-orders'
import { credentials } from '../catalog/storefront-cart'
import { deriveOrderToken } from '../catalog/checkout'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { supportBytes } from '../support/http'
import { SupportError } from '../support/operations'
import { PayGoldError } from './paygold-links'
import { PaymentError } from '../catalog/payments'
import { SalesQuoteError } from '../catalog/sales-quotes'
const uuid = z.string().uuid()
const inputSchema = z
  .object({
    quoteId: uuid,
    expectedVersion: z.number().int().safe().positive(),
    orderId: uuid,
    commandId: uuid,
    expiresAt: catalogPolicyInstantSchema
  })
  .strict()
const outputSchema = z
  .object({
    quoteId: uuid,
    orderId: uuid,
    paymentIntentId: uuid,
    amountCents: z.number().int().safe().positive(),
    expiresAt: catalogPolicyInstantSchema,
    url: z.string().url().max(2048)
  })
  .strict()
type Input = z.infer<typeof inputSchema> & { orderToken: string }
export interface PayGoldHttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration
  now?: () => string
  issue: (claims: VerifiedSessionClaims, input: Input) => Promise<unknown>
  recover: (
    claims: VerifiedSessionClaims,
    input: { quoteId: string; orderId: string; orderToken: string }
  ) => Promise<unknown>
}
function orderCookie(request: Request) {
  const entries = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('neteco-order-access-v2='))
  if (entries.length !== 1) return null
  const match = /^neteco-order-access-v2=v1\.([0-9a-f-]{36})\.([0-9a-f]{64})$/i.exec(entries[0]!)
  if (!match || !uuid.safeParse(match[1]).success) return null
  return { id: match[1]!, token: match[2]! }
}
export async function handlePayGoldLinksHttp(
  request: Request,
  deps: PayGoldHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const recovery = url.pathname === '/api/account/paygold-links/recover'
  if (url.pathname !== '/api/account/paygold-links' && !recovery) return null
  const headers = {
    'cache-control': 'private, no-store',
    vary: 'Cookie',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'referrer-policy': 'no-referrer'
  }
  const response = (value: unknown, status: number, extra: Record<string, string> = {}) =>
    Response.json(value, { status, headers: { ...headers, ...extra } })
  const fail = (code: string, status: number, extra: Record<string, string> = {}) =>
    response({ error: { code } }, status, extra)
  if (request.method !== (recovery ? 'GET' : 'POST'))
    return fail('method_not_allowed', 405, { allow: recovery ? 'GET' : 'POST' })
  try {
    const configured = new URL(deps.origin)
    if (
      configured.protocol !== 'https:' ||
      configured.origin !== deps.origin ||
      configured.username ||
      configured.password
    )
      return fail('unavailable', 503)
    if (
      url.origin !== deps.origin ||
      (!recovery && request.headers.get('origin') !== deps.origin) ||
      (recovery && request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return fail('forbidden', 403)
    if (!recovery && url.search) return fail('invalid_input', 400)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return fail('unauthenticated', 401)
    const now = deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    if (!catalogPolicyInstantSchema.safeParse(now).success) return fail('unavailable', 503)
    const customerId = await activeOrderCustomerId(deps.database, claims, now)
    if (!customerId) return fail('unauthenticated', 401)
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'paygold-link-requests',
      limit: 20,
      windowSeconds: 3600,
      now: Math.floor(Date.parse(now) / 1000)
    })
    if (!quota.allowed) return fail('rate_limited', 429, { 'retry-after': String(quota.retryAfter) })
    if (recovery) {
      const keys = [...url.searchParams.keys()]
      const orderId = url.searchParams.get('orderId'),
        quoteId = url.searchParams.get('quoteId')
      if (
        keys.length !== 2 ||
        !keys.includes('orderId') ||
        !keys.includes('quoteId') ||
        !uuid.safeParse(orderId).success ||
        !uuid.safeParse(quoteId).success
      )
        return fail('invalid_input', 400)
      const credential = orderCookie(request)
      const cookieHeader = request.headers.get('cookie') ?? ''
      if (!credential && cookieHeader.split(';').some((part) => part.trim().startsWith('neteco-order-access-v2=')))
        return fail('unauthenticated', 401)
      const cart = credentials(request)
      const orderToken =
        credential?.id === orderId ? credential.token : cart ? await deriveOrderToken(cart.token, orderId!) : null
      if (!orderToken) return fail('unauthenticated', 401)
      const raw = await deps.recover(claims, { quoteId: quoteId!, orderId: orderId!, orderToken })
      const result = inputSchema.nullable().safeParse(raw)
      if (!result.success || (result.data && (result.data.quoteId !== quoteId || result.data.orderId !== orderId)))
        return fail('unavailable', 503)
      if ((await activeOrderCustomerId(deps.database, claims, deps.now?.() ?? now)) !== customerId)
        return fail('unauthenticated', 401)
      return response({ attempt: result.data }, 200)
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
      return fail('invalid_input', 415)
    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await supportBytes(request, 4096)))
    } catch (error) {
      return error instanceof SupportError && error.code === 'body_too_large'
        ? fail('invalid_input', 413)
        : fail('invalid_input', 400)
    }
    const parsed = inputSchema.safeParse(raw)
    if (!parsed.success || request.headers.get('idempotency-key') !== parsed.data.commandId)
      return fail('invalid_input', 400)
    const credential = orderCookie(request)
    const cookieHeader = request.headers.get('cookie') ?? ''
    if (!credential && cookieHeader.split(';').some((part) => part.trim().startsWith('neteco-order-access-v2=')))
      return fail('unauthenticated', 401)
    const cart = credentials(request)
    const orderToken =
      credential?.id === parsed.data.orderId
        ? credential.token
        : cart
          ? await deriveOrderToken(cart.token, parsed.data.orderId)
          : null
    if (!orderToken) return fail('unauthenticated', 401)
    const result = outputSchema.safeParse(await deps.issue(claims, { ...parsed.data, orderToken }))
    if (
      !result.success ||
      result.data.orderId !== parsed.data.orderId ||
      result.data.quoteId !== parsed.data.quoteId ||
      result.data.expiresAt !== parsed.data.expiresAt
    )
      return fail('unavailable', 503)
    if ((await activeOrderCustomerId(deps.database, claims, deps.now?.() ?? now)) !== customerId)
      return fail('unauthenticated', 401)
    return response(result.data, 201)
  } catch (error) {
    if (error instanceof PayGoldError)
      return fail(
        error.code,
        { invalid_input: 400, unauthenticated: 401, not_payable: 409, conflict: 409, unavailable: 503 }[error.code]
      )
    if (error instanceof PaymentError)
      return fail(error.code, error.code === 'unauthorized' ? 401 : error.code === 'infrastructure' ? 503 : 409)
    if (error instanceof SalesQuoteError)
      return fail(error.code, error.code === 'unauthenticated' ? 401 : error.code === 'not_found' ? 404 : 409)
    return fail('unavailable', 503)
  }
}
