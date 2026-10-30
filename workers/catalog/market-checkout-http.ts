import { z } from 'zod'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { consumeIdentityQuota } from '../auth/identity-quota'
import {
  CheckoutMarketError,
  configureCheckoutMarket,
  readCheckoutMarket,
  loadCheckoutMarketProfile,
  assertCheckoutMarketAuthority
} from './market-checkout-policy'

export interface CheckoutMarketHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  edgeLimiter: RateLimit
  rateLimitPepper: string
  now?: () => string
}
const bodySchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    expectedVersion: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    exchangeNumerator: z.number().int().min(1).max(1000000),
    exchangeDenominator: z.number().int().min(1).max(1000000),
    goodsTaxBps: z.number().int().min(0).max(10000),
    shippingNetMinor: z.number().int().min(0).max(100000000),
    shippingTaxBps: z.number().int().min(0).max(10000),
    termsVersion: z.string().regex(/^[a-zA-Z0-9_-]{3,100}$/),
    paymentMethods: z
      .array(z.enum(['card', 'bank_transfer', 'credit']))
      .min(1)
      .max(3)
      .refine((v) => new Set(v).size === v.length)
  })
  .strict()
export async function handleCheckoutMarketHttp(
  request: Request,
  deps: CheckoutMarketHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url),
    match = /^\/api\/admin\/checkout-markets\/([A-Z]{2})$/.exec(url.pathname)
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
  if (!['GET', 'POST'].includes(request.method)) return error('method_not_allowed', 405, { Allow: 'GET, POST' })
  try {
    const configured = new URL(deps.origin)
    if (configured.protocol !== 'https:' || configured.origin !== deps.origin || deps.origin.length > 2000)
      return error('unavailable', 503)
    if (
      url.origin !== deps.origin ||
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.method === 'POST' && request.headers.get('origin') !== deps.origin)
    )
      return error('csrf_rejected', 403)
    if (url.searchParams.size) return error('invalid_input', 400)
    const limited = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, deps.rateLimitPepper, 'admin-pricing')
    if (limited !== 'allowed')
      return error(limited === 'limited' ? 'rate_limited' : 'unavailable', limited === 'limited' ? 429 : 503)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    const options = { now: deps.now }
    if (request.method === 'GET') return json(await readCheckoutMarket(deps.database, claims, match[1]!, options))
    const key = request.headers.get('idempotency-key')
    if (
      !key ||
      !z.string().uuid().safeParse(key).success ||
      !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')
    )
      return error('invalid_input', 400)
    const length = request.headers.get('content-length')
    if (length && (!/^\d+$/.test(length) || Number(length) > 8192)) return error('invalid_input', 413)
    const reader = request.body?.getReader()
    if (!reader) return error('invalid_input', 400)
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > 8192) {
        await reader.cancel()
        return error('invalid_input', 413)
      }
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    let input: unknown
    try {
      input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      return error('invalid_input', 400)
    }
    const parsed = bodySchema.safeParse(input)
    if (!parsed.success) return error('invalid_input', 400)
    await assertCheckoutMarketAuthority(deps.database, claims, options)
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'admin-checkout-market',
      limit: 60,
      windowSeconds: 3600,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now()) / 1000) } : {})
    })
    if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
    return json(
      await configureCheckoutMarket(deps.database, claims, key, { ...parsed.data, market: match[1] }, options)
    )
  } catch (cause) {
    if (cause instanceof CheckoutMarketError)
      return error(
        cause.code,
        cause.code === 'unauthenticated'
          ? 401
          : cause.code === 'not_found'
            ? 404
            : cause.code === 'invalid_input'
              ? 400
              : cause.code === 'conflict'
                ? 409
                : cause.code === 'unavailable'
                  ? 503
                  : 403
      )
    return error('unavailable', 503)
  }
}

export interface PublicCheckoutMarketDependencies {
  database: D1Database
  edgeLimiter: RateLimit
  rateLimitPepper: string
}
/** Buyer-facing read of the latest profile (tax, shipping, terms, methods) of a market the catalog has active. */
export async function handlePublicCheckoutMarketHttp(
  request: Request,
  deps: PublicCheckoutMarketDependencies
): Promise<Response | null> {
  const url = new URL(request.url),
    match = /^\/api\/checkout-markets\/([A-Z]{2})$/.exec(url.pathname)
  if (!match) return null
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    Response.json(body, {
      status,
      headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra }
    })
  if (request.method !== 'GET') return json({ error: { code: 'method_not_allowed' } }, 405, { Allow: 'GET' })
  if (url.searchParams.size) return json({ error: { code: 'invalid_input' } }, 400)
  const limited = await checkAdministrativeEdgeLimit(
    request,
    deps.edgeLimiter,
    deps.rateLimitPepper,
    'storefront-checkout'
  )
  if (limited !== 'allowed')
    return json(
      { error: { code: limited === 'limited' ? 'rate_limited' : 'unavailable' } },
      limited === 'limited' ? 429 : 503
    )
  try {
    const active = await deps.database
      .prepare('SELECT 1 AS active FROM catalog_markets WHERE code = ?1 AND is_active = 1')
      .bind(match[1])
      .first()
    const profile = active ? await loadCheckoutMarketProfile(deps.database, match[1]!) : null
    if (!profile) return json({ error: { code: 'not_found' } }, 404)
    return json({
      market: profile.market,
      currency: profile.currency,
      version: profile.version,
      exchangeNumerator: profile.exchangeNumerator,
      exchangeDenominator: profile.exchangeDenominator,
      goodsTaxBps: profile.goodsTaxBps,
      shippingNetMinor: profile.shippingNetMinor,
      shippingTaxBps: profile.shippingTaxBps,
      termsVersion: profile.termsVersion,
      paymentMethods: profile.paymentMethods
    })
  } catch {
    return json({ error: { code: 'unavailable' } }, 503)
  }
}
