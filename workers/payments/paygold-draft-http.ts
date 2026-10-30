import { z } from 'zod'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { activeOrderCustomerId } from '../catalog/customer-orders'
import { credentials } from '../catalog/storefront-cart'
import { deriveOrderToken } from '../catalog/checkout'
import { PaymentError } from '../catalog/payments'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { supportBytes } from '../support/http'
import { SupportError } from '../support/operations'
import { draftLinkInputSchema } from './paygold-draft-links'
import { PayGoldError } from './paygold-links'

export const PAYGOLD_DRAFT_PATH = '/api/account/paygold-links/draft'
const uuid = z.string().uuid()
const outputSchema = z
  .object({
    draftId: uuid,
    orderId: uuid,
    paymentIntentId: uuid,
    amountCents: z.number().int().safe().positive(),
    expiresAt: catalogPolicyInstantSchema,
    url: z.string().url().max(2048)
  })
  .strict()

export interface PayGoldDraftHttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration
  now?: () => string
  issue: (
    claims: VerifiedSessionClaims,
    input: z.infer<typeof draftLinkInputSchema> & { orderToken: string }
  ) => Promise<unknown>
}

function orderCookie(request: Request) {
  const entries = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('neteco-order-access-v2='))
  if (entries.length !== 1) return null
  const match = /^neteco-order-access-v2=v1\.([0-9a-f-]{36})\.([0-9a-f]{64})$/i.exec(entries[0]!)
  return match && uuid.safeParse(match[1]).success ? { id: match[1]!, token: match[2]! } : null
}

export async function handlePayGoldDraftHttp(
  request: Request,
  deps: PayGoldDraftHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== PAYGOLD_DRAFT_PATH) return null
  const headers = {
    'cache-control': 'private, no-store',
    vary: 'Cookie',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'referrer-policy': 'no-referrer'
  }
  const respond = (body: unknown, status: number, extra: Record<string, string> = {}) =>
    Response.json(body, { status, headers: { ...headers, ...extra } })
  const fail = (code: string, status: number, extra: Record<string, string> = {}) =>
    respond({ error: { code } }, status, extra)
  if (request.method !== 'POST') return fail('method_not_allowed', 405, { allow: 'POST' })
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
      url.search ||
      request.headers.get('origin') !== deps.origin ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return fail('forbidden', 403)
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
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
      return fail('invalid_input', 415)
    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await supportBytes(request, 4096)))
    } catch (error) {
      return fail('invalid_input', error instanceof SupportError && error.code === 'body_too_large' ? 413 : 400)
    }
    const parsed = draftLinkInputSchema.safeParse(raw)
    if (!parsed.success || request.headers.get('idempotency-key') !== parsed.data.commandId)
      return fail('invalid_input', 400)
    const credential = orderCookie(request)
    if (
      !credential &&
      (request.headers.get('cookie') ?? '').split(';').some((p) => p.trim().startsWith('neteco-order-access-v2='))
    )
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
      result.data.draftId !== parsed.data.draftId ||
      result.data.expiresAt !== parsed.data.expiresAt
    )
      return fail('unavailable', 503)
    if ((await activeOrderCustomerId(deps.database, claims, deps.now?.() ?? now)) !== customerId)
      return fail('unauthenticated', 401)
    return respond(result.data, 201)
  } catch (error) {
    if (error instanceof PayGoldError)
      return fail(
        error.code,
        { invalid_input: 400, unauthenticated: 401, not_payable: 409, conflict: 409, unavailable: 503 }[error.code]
      )
    if (error instanceof PaymentError)
      return fail(error.code, error.code === 'unauthorized' ? 401 : error.code === 'infrastructure' ? 503 : 409)
    return fail('unavailable', 503)
  }
}
