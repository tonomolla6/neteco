import {
  adminOrderPackingSchema,
  orderPackingInputSchema,
  orderPackingReceiptSchema,
  orderPackingCommandResponseSchema,
  orderPackingIntentHash
} from '../../shared/order-packing'
import { fulfillmentOrderIdSchema } from '../../shared/order-fulfillment'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { verifySessionCookie } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { authorizeD1Session } from '../catalog/authorization'
import type { AdminFulfillmentHttpEnvironment } from './admin-http'
import { PackingError, readD1AdminPacking, executeD1AdminPackingCommand, readD1AdminPackingCommand } from './packing'

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, {
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

/** Own encoded aliases, but only the literal canonical route can execute. */
export function ownsAdminPackingNamespace(pathname: string) {
  let path = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    if (/^\/api\/admin\/orders[/\\][^/\\]+[/\\]packing(?:[/\\%]|$)/.test(path)) return true
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
class HttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
async function body(request: Request): Promise<unknown> {
  const limit = 64 * 1024,
    declared = request.headers.get('content-length')
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > limit))
    throw new HttpError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new HttpError('json_required', 415)
  if (!request.body) throw new HttpError('missing_body', 400)
  const reader = request.body.getReader(),
    bytes = new Uint8Array(limit)
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new HttpError('invalid_json', 400)
      if (next.value.byteLength > limit - length) {
        await reader.cancel().catch(() => undefined)
        throw new HttpError('body_too_large', 413)
      }
      bytes.set(next.value, length)
      length += next.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  if (!length) throw new HttpError('missing_body', 400)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown
  } catch {
    throw new HttpError('invalid_json', 400)
  }
}
function failure(cause: unknown) {
  if (cause instanceof HttpError) return error(cause.code, cause.status)
  if (!(cause instanceof PackingError)) return error('service_unavailable', 503)
  const code = cause.code
  return error(
    code,
    code === 'unauthenticated'
      ? 401
      : ['email_unverified', 'mfa_required', 'forbidden'].includes(code)
        ? 403
        : code === 'not_found'
          ? 404
          : code === 'invalid_input'
            ? 422
            : [
                  'version_conflict',
                  'fulfillment_version_conflict',
                  'idempotency_conflict',
                  'invalid_transition',
                  'packing_incomplete',
                  'packing_locked',
                  'shipping_mode_mismatch',
                  'order_cancelled',
                  'payment_unconfirmed',
                  'inventory_unconfirmed',
                  'warehouse_unavailable',
                  'shipping_mode_unavailable'
                ].includes(code)
              ? 409
              : 503
  )
}

/** Root ingress owns the mandatory admin-fulfillment edge limit, before this
 * handler. Same live permission and 60/hour identity quota as fulfillment. */
export async function handleAdminPackingHttp(
  request: Request,
  env: AdminFulfillmentHttpEnvironment
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsAdminPackingNamespace(url.pathname)) return null
  try {
    const match = /^\/api\/admin\/orders\/([^/]+)\/packing(?:\/(commands)(?:\/([^/]+))?)?$/.exec(url.pathname)
    if (
      !match ||
      !fulfillmentOrderIdSchema.safeParse(match[1]).success ||
      (match[3] && !catalogPolicyUuidSchema.safeParse(match[3]).success)
    )
      return error('invalid_input', 400)
    const write = !!match[2] && !match[3],
      receipt = !!match[3],
      method = write ? 'POST' : 'GET'
    if (request.method !== method) return error('method_not_allowed', 405, { Allow: method })
    if (env.AUTH_ENABLED !== 'true') return error('service_unavailable', 503)
    const configured = new URL(env.AUTH_ORIGIN)
    if (configured.protocol !== 'https:' || configured.origin !== env.AUTH_ORIGIN || env.AUTH_ORIGIN.length > 2000)
      return error('service_unavailable', 503)
    if (
      (request.headers.has('origin') && request.headers.get('origin') !== env.AUTH_ORIGIN) ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (write && request.headers.get('origin') !== env.AUTH_ORIGIN)
    )
      return error('csrf_rejected', 403)
    if (url.searchParams.size) return error('invalid_input', 400)
    const claims = await verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
    if (!claims) return error('unauthenticated', 401)
    const authorize = async () => {
      const result = await authorizeD1Session(env.DB, claims, 'administration.manage', { requireMfa: true })
      return result.allowed ? null : error(result.code, result.code === 'unauthenticated' ? 401 : 403)
    }
    const initial = await authorize()
    if (initial) return initial
    const orderId = match[1]!
    if (receipt) {
      const key = match[3]!,
        hash = request.headers.get('X-Neteco-Command-Payload-Hash') ?? ''
      if (!/^[a-f0-9]{64}$/.test(hash)) return error('invalid_input', 422)
      const parsed = orderPackingCommandResponseSchema.safeParse(
        await readD1AdminPackingCommand(env.DB, claims, orderId, key, hash)
      )
      if (!parsed.success) return error('service_unavailable', 503)
      if (
        parsed.data.outcome === 'applied' &&
        (parsed.data.receipt.commandId !== key ||
          parsed.data.receipt.orderId !== orderId ||
          parsed.data.receipt.payloadHash !== hash)
      )
        return error('service_unavailable', 503)
      return (await authorize()) ?? json(parsed.data)
    }
    if (!write) {
      const parsed = adminOrderPackingSchema.safeParse(await readD1AdminPacking(env.DB, claims, orderId))
      if (!parsed.success || parsed.data.orderId !== orderId) return error('service_unavailable', 503)
      return (await authorize()) ?? json(parsed.data)
    }
    const key = catalogPolicyUuidSchema.safeParse(request.headers.get('idempotency-key'))
    if (!key.success) return error('invalid_idempotency_key', 400)
    const quota = await consumeIdentityQuota(env.DB, {
      identityId: claims.identityId,
      scope: 'admin-fulfillment',
      limit: 60,
      windowSeconds: 3600
    })
    const headers = { 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': String(quota.remaining) }
    if (!quota.allowed) return error('rate_limited', 429, { ...headers, 'Retry-After': String(quota.retryAfter) })
    const input = orderPackingInputSchema.safeParse(await body(request))
    if (!input.success) return error('invalid_input', 422)
    const payloadHash = await orderPackingIntentHash(orderId, input.data)
    const fresh = await authorize()
    if (fresh) return fresh
    const parsed = orderPackingReceiptSchema.safeParse(
      await executeD1AdminPackingCommand(env.DB, claims, orderId, input.data, { idempotencyKey: key.data })
    )
    if (!parsed.success) return error('service_unavailable', 503)
    const result = parsed.data
    if (
      result.commandId !== key.data ||
      result.orderId !== orderId ||
      result.action !== input.data.action ||
      result.payloadHash !== payloadHash ||
      result.version !== input.data.expectedVersion + 1 ||
      result.fulfillmentVersion !== input.data.expectedFulfillmentVersion
    )
      return error('service_unavailable', 503)
    return (await authorize()) ?? json(result, 201, headers)
  } catch (cause) {
    return failure(cause)
  }
}
