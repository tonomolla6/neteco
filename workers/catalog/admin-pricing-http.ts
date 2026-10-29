import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { listD1AdminPrices, parseAdminPricingLegacyId, type AdminPricingQuery } from './admin-pricing'
import { authorizeD1Session } from './authorization'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { catalogPriceIdSchema } from '../../shared/catalog-price-commands'
import {
  ADMIN_PRICE_WRITE_PERMISSION,
  AdminPriceCommandError,
  scheduleD1VariantPrice,
  cancelD1ScheduledPrice
} from './admin-price-commands'

export interface AdminPricingHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  /** Configured origin, never authority from Host/forwarded/request headers. */
  origin: string
  /** Internal deterministic test clock, never HTTP input. */
  now?: string
}
function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
      ...headers
    }
  })
}
function error(code: string, status: number, headers: Record<string, string> = {}) {
  return json({ error: { code } }, status, headers)
}
/** Node's q/{items} list is preserved. The additive pagination counts variants;
 * historyPage/historyPerPage apply independently to each variant's full history.
 * List default/max history is 8: at most 5000 item/history/schedule records.
 * A single `variant` read defaults to 50 history versions, with maximum 100. */
export function parseAdminPricingQuery(parameters: URLSearchParams): AdminPricingQuery | null {
  const allowed = new Set(['q', 'variant', 'page', 'perPage', 'historyPage', 'historyPerPage'])
  for (const key of parameters.keys()) if (!allowed.has(key) || parameters.getAll(key).length !== 1) return null
  const q = parameters.get('q') ?? ''
  if (
    q.length > 160 ||
    Array.from(q).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    return null
  const result: AdminPricingQuery = { q: q.trim(), page: 1, perPage: 500, historyPage: 1, historyPerPage: 8 }
  const variant = parameters.get('variant')
  if (variant !== null) {
    const id = parseAdminPricingLegacyId(variant)
    if (id === null) return null
    result.variant = id
    result.historyPerPage = 50
  }
  for (const key of ['page', 'perPage', 'historyPage', 'historyPerPage'] as const) {
    const raw = parameters.get(key)
    if (raw === null) continue
    if (!/^[1-9]\d{0,6}$/.test(raw)) return null
    const value = Number(raw)
    const maximum =
      key === 'perPage' ? 500 : key === 'historyPerPage' ? (result.variant === undefined ? 8 : 100) : 1_000_000
    if (value > maximum) return null
    result[key] = value
  }
  return result
}

export function ownsD1AdminPricingNamespace(pathname: string) {
  let candidate = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    if (/^\/api\/admin\/prices(?:[/\\%]|$)/.test(candidate)) return true
    try {
      const decoded = decodeURIComponent(candidate)
      if (decoded === candidate) return false
      candidate = decoded
    } catch {
      return false
    }
  }
  return false
}
function canonicalPriceId(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment)
    return encodeURIComponent(decoded) === segment &&
      !decoded.includes('/') &&
      !decoded.includes('\\') &&
      catalogPriceIdSchema.safeParse(decoded).success
      ? decoded
      : null
  } catch {
    return null
  }
}
class PricingHttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
async function commandBody(request: Request): Promise<unknown> {
  const maximum = 64 * 1024,
    declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum))
    throw new PricingHttpError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new PricingHttpError('json_required', 415)
  if (!request.body) throw new PricingHttpError('missing_body', 400)
  const reader = request.body.getReader(),
    bytes = new Uint8Array(maximum)
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new PricingHttpError('invalid_json', 400)
      if (next.value.byteLength > maximum - length) {
        await reader.cancel().catch(() => undefined)
        throw new PricingHttpError('body_too_large', 413)
      }
      bytes.set(next.value, length)
      length += next.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  if (!length) throw new PricingHttpError('missing_body', 400)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown
  } catch {
    throw new PricingHttpError('invalid_json', 400)
  }
}
/** Private read and governed financial commands only; never fall through to a
 * legacy writer. The sealed cookie is authentication, not a permission grant. */
export async function handleD1AdminPricingRequest(
  request: Request,
  deps: AdminPricingHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const list = url.pathname === '/api/admin/prices'
  if (!ownsD1AdminPricingNamespace(url.pathname)) return null
  const match = /^\/api\/admin\/prices\/([^/]+)\/cancel$/.exec(url.pathname)
  const priceId = match ? canonicalPriceId(match[1]!) : null
  const allow = list ? 'GET, POST' : match ? 'POST' : null
  if (allow && !(list ? ['GET', 'POST'].includes(request.method) : request.method === 'POST'))
    return error('method_not_allowed', 405, { Allow: allow })
  const write = request.method !== 'GET'
  try {
    const origin = new URL(deps.origin)
    if (origin.protocol !== 'https:' || origin.origin !== deps.origin || deps.origin.length > 2000)
      throw new Error('invalid_admin_pricing_origin')
    if (
      (write
        ? request.headers.get('origin') !== deps.origin
        : request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    if (!list && !match) return error('not_found', 404)
    if (match && priceId === null) return error('invalid_input', 400)
    if (write) {
      if (url.searchParams.size) return error('invalid_input', 400)
      const auth = await authorizeD1Session(deps.database, claims, ADMIN_PRICE_WRITE_PERMISSION, {
        requireMfa: true,
        ...(deps.now === undefined ? {} : { now: new Date(deps.now).toISOString().replace(/\.\d{3}Z$/, 'Z') })
      })
      if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
      const key = request.headers.get('idempotency-key')
      if (!key || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return error('invalid_idempotency_key', 400)
      let quota: Awaited<ReturnType<typeof consumeIdentityQuota>>
      try {
        quota = await consumeIdentityQuota(deps.database, {
          identityId: claims.identityId,
          scope: 'admin-price-commands',
          limit: 60,
          windowSeconds: 3600,
          ...(deps.now === undefined ? {} : { now: Math.floor(Date.parse(deps.now) / 1000) })
        })
      } catch {
        return error('abuse_control_unavailable', 503)
      }
      const headers = { 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': String(quota.remaining) }
      if (!quota.allowed) return error('rate_limited', 429, { ...headers, 'Retry-After': String(quota.retryAfter) })
      const body = await commandBody(request),
        options = { idempotencyKey: key, ...(deps.now === undefined ? {} : { now: deps.now }) }
      const receipt = list
        ? await scheduleD1VariantPrice(deps.database, claims, body, options)
        : await cancelD1ScheduledPrice(deps.database, claims, priceId!, body, options)
      return json(receipt, list ? 201 : 200, headers)
    }
    const query = parseAdminPricingQuery(url.searchParams)
    if (!query) return error('invalid_input', 400)
    const result = await listD1AdminPrices(deps.database, claims, deps.now ?? new Date().toISOString(), query)
    return result.outcome === 'found'
      ? json(result.data)
      : error(result.code, result.code === 'unauthenticated' ? 401 : 403)
  } catch (failure) {
    if (failure instanceof PricingHttpError) return error(failure.code, failure.status)
    if (failure instanceof AdminPriceCommandError) {
      if (failure.code === 'unauthenticated') return error(failure.code, 401)
      if (['email_unverified', 'mfa_required', 'forbidden'].includes(failure.code)) return error(failure.code, 403)
      if (failure.code === 'not_found') return error(failure.code, 404)
      return error(failure.code, failure.code === 'invalid_input' ? 422 : 409)
    }
    return error('service_unavailable', 503)
  }
}
