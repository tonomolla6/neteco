import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { authorizeD1Session } from './authorization'
import { evaluatePromotion, promotionRuleHash } from './promotions'
import { adminPromotionPreviewInputSchema, adminPromotionQuerySchema } from '../../shared/admin-promotions'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { promotionBasketPreviewInputSchema } from '../../shared/promotion-basket-preview'
import { previewD1PromotionBasket, PromotionBasketPreviewError } from './promotion-basket-preview'
import {
  AdminPromotionError,
  executeD1AdminPromotion,
  listD1AdminPromotions,
  readD1AdminPromotion,
  readD1AdminPromotionCommand
} from './admin-promotions'

export interface AdminPromotionsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  /** Server/test clock only, never HTTP input. Edge belongs to the outer admin-pricing gate. */
  now?: string
  freeShippingThresholdCents?: number | null
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
const error = (code: string, status: number, headers: Record<string, string> = {}) =>
  json({ error: { code } }, status, headers)
export function ownsAdminPromotionsNamespace(path: string) {
  let candidate = path
  for (let attempt = 0; attempt < 4; attempt++) {
    if (/^\/api\/admin\/promotions(?:[/\\%]|$)/i.test(candidate)) return true
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
class BoundaryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
async function body(request: Request) {
  const max = 65536,
    declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max))
    throw new BoundaryError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new BoundaryError('json_required', 415)
  if (!request.body) throw new BoundaryError('invalid_input', 400)
  const reader = request.body.getReader(),
    buffer = new Uint8Array(max)
  let length = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      if (next.value.byteLength > max - length) {
        await reader.cancel().catch(() => undefined)
        throw new BoundaryError('body_too_large', 413)
      }
      buffer.set(next.value, length)
      length += next.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))) as unknown
  } catch {
    throw new BoundaryError('invalid_input', 400)
  }
}
function positive(value: string | null, defaultValue: number) {
  if (value === null) return defaultValue
  if (!/^[1-9]\d{0,6}$/.test(value)) throw new BoundaryError('invalid_input', 400)
  return Number(value)
}
function query(request: URL, allowed: string[]) {
  for (const key of request.searchParams.keys())
    if (!allowed.includes(key) || request.searchParams.getAll(key).length !== 1)
      throw new BoundaryError('invalid_input', 400)
}
export async function handleAdminPromotionsHttp(
  request: Request,
  deps: AdminPromotionsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsAdminPromotionsNamespace(url.pathname)) return null
  const list = url.pathname === '/api/admin/promotions',
    preview = url.pathname === '/api/admin/promotions/preview',
    basketPreview = url.pathname === '/api/admin/promotions/basket-preview'
  const detail = /^\/api\/admin\/promotions\/([0-9a-f-]{36})$/.exec(url.pathname)
  const receipt = /^\/api\/admin\/promotions\/commands\/([0-9a-f-]{36})$/.exec(url.pathname)
  const id = detail?.[1] ?? receipt?.[1]
  if (
    (!list && !preview && !basketPreview && !detail && !receipt) ||
    (id && !catalogPolicyUuidSchema.safeParse(id).success)
  )
    return error('not_found', 404)
  const allow = list ? 'GET, POST' : preview || basketPreview ? 'POST' : receipt ? 'GET' : 'GET, PUT'
  if (!allow.split(', ').includes(request.method)) return error('method_not_allowed', 405, { Allow: allow })
  try {
    if (new URL(deps.origin).origin !== deps.origin || new URL(deps.origin).protocol !== 'https:')
      return error('service_unavailable', 503)
    const write = request.method !== 'GET'
    if (
      url.origin !== deps.origin ||
      (write
        ? request.headers.get('origin') !== deps.origin
        : request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    const auth = await authorizeD1Session(deps.database, claims, 'administration.manage', {
      requireMfa: true,
      ...(deps.now ? { now: deps.now } : {})
    })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
    const options = deps.now ? { now: deps.now } : {}
    if (basketPreview) {
      const catalog = await authorizeD1Session(deps.database, claims, 'catalog.write', {
        requireMfa: true,
        ...options
      })
      if (!catalog.allowed) return error(catalog.code, catalog.code === 'unauthenticated' ? 401 : 403)
    }
    if (request.method === 'GET') {
      if (receipt) {
        query(url, [])
        return json(
          await readD1AdminPromotionCommand(
            deps.database,
            claims,
            id!,
            request.headers.get('X-Neteco-Command-Payload-Hash') ?? '',
            options
          )
        )
      }
      if (detail) {
        query(url, ['historyPage'])
        return json(
          await readD1AdminPromotion(
            deps.database,
            claims,
            id!,
            { historyPage: positive(url.searchParams.get('historyPage'), 1) },
            options
          )
        )
      }
      query(url, ['q', 'status', 'page', 'perPage'])
      const parsed = adminPromotionQuerySchema.safeParse({
        q: url.searchParams.get('q') ?? '',
        status: url.searchParams.get('status') ?? 'all',
        page: positive(url.searchParams.get('page'), 1),
        perPage: positive(url.searchParams.get('perPage'), 25)
      })
      if (!parsed.success) return error('invalid_input', 400)
      return json(await listD1AdminPromotions(deps.database, claims, parsed.data, options))
    }
    query(url, [])
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'admin-price-commands',
      limit: 60,
      windowSeconds: 3600,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now) / 1000) } : {})
    })
    if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
    const raw = await body(request)
    if (basketPreview) {
      const parsed = promotionBasketPreviewInputSchema.safeParse(raw)
      if (!parsed.success) return error('invalid_input', 400)
      const result = await previewD1PromotionBasket(deps.database, claims, parsed.data, {
        ...options,
        ...(deps.freeShippingThresholdCents === undefined
          ? {}
          : { freeShippingThresholdCents: deps.freeShippingThresholdCents })
      })
      // Core's final database await checks both grants atomically after hashing.
      // A further individual check would split that intersection again.
      return json(result)
    }
    if (preview) {
      const parsed = adminPromotionPreviewInputSchema.safeParse(raw)
      if (!parsed.success) return error('invalid_input', 400)
      const result = evaluatePromotion(parsed.data.rule, parsed.data.context),
        ruleHash = await promotionRuleHash(parsed.data.rule)
      const final = await authorizeD1Session(deps.database, claims, 'administration.manage', {
        requireMfa: true,
        ...options
      })
      if (!final.allowed) return error(final.code, final.code === 'unauthenticated' ? 401 : 403)
      return json({
        source: 'cloudflare',
        simulation: true,
        ruleHash,
        eligible: result.eligible,
        reason: result.reason,
        totals: result.totals
      })
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return error('invalid_input', 400)
    const input = raw as { expectedVersion?: unknown; rule?: { id?: unknown } }
    if (
      (list && input.expectedVersion !== 0) ||
      (detail && (input.rule?.id !== id || typeof input.expectedVersion !== 'number' || input.expectedVersion < 1))
    )
      return error('invalid_input', 400)
    return json(
      await executeD1AdminPromotion(deps.database, claims, raw, {
        ...options,
        idempotencyKey: request.headers.get('idempotency-key') ?? ''
      }),
      201
    )
  } catch (failure) {
    if (failure instanceof BoundaryError) return error(failure.code, failure.status)
    if (failure instanceof PromotionBasketPreviewError) {
      const code = failure.code
      if (code === 'unauthenticated') return error(code, 401)
      if (['email_unverified', 'mfa_required', 'forbidden'].includes(code)) return error(code, 403)
      if (code === 'invalid_input') return error(code, 400)
      if (code === 'variant_not_available' || code === 'customer_not_available') return error(code, 422)
      return error('service_unavailable', 503)
    }
    if (failure instanceof AdminPromotionError) {
      const code = failure.code
      if (code === 'unauthenticated') return error(code, 401)
      if (['email_unverified', 'mfa_required', 'forbidden'].includes(code)) return error(code, 403)
      if (code === 'invalid_input') return error(code, 400)
      if (code === 'not_found') return error(code, 404)
      if (
        ['version_conflict', 'idempotency_conflict', 'code_immutable', 'code_conflict', 'scope_not_found'].includes(
          code
        )
      )
        return error(code, 409)
    }
    return error('service_unavailable', 503)
  }
}
