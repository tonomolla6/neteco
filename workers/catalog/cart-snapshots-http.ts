import {
  verifySessionCookie,
  validateSessionCookieConfiguration,
  type SessionCookieConfiguration
} from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { credentials } from './storefront-cart'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { cartSnapshotInputSchema, cartSnapshotRevokeInputSchema } from '../../shared/cart-snapshots'
import {
  CartSnapshotError,
  saveD1CartSnapshot,
  listD1CartSnapshots,
  readD1CartSnapshotCommand,
  revokeD1CartShare,
  resolveD1SharedCart
} from './cart-snapshots'

export interface CustomerCartSnapshotsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  edgeLimiter: RateLimit
  rateLimitPepper: string
  now?: string
}

export function ownsCartSnapshotsNamespace(path: string): boolean {
  let candidate = path
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/(?:account\/cart-snapshots|cart\/shared)(?:[/\\%]|$)/i.test(candidate)) return true
    try {
      const next = decodeURIComponent(candidate)
      if (next === candidate) return false
      candidate = next
    } catch {
      return false
    }
  }
  return false
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      Vary: 'Cookie',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      ...headers
    }
  })
}
const error = (code: string, status: number, headers: Record<string, string> = {}) =>
  json({ error: { code } }, status, headers)
class BodyError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
async function readBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length'),
    maximum = 8192
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum))
    throw new BodyError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new BodyError('json_required', 415)
  if (!request.body) throw new BodyError('invalid_input', 400)
  const reader = request.body.getReader(),
    bytes = new Uint8Array(maximum)
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (chunk.value.byteLength > maximum - size) {
        await reader.cancel().catch(() => undefined)
        throw new BodyError('body_too_large', 413)
      }
      bytes.set(chunk.value, size)
      size += chunk.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))) as unknown
  } catch {
    throw new BodyError('invalid_input', 400)
  }
}

/** Cookie/session authority is checked again by core before any replay or final read. */
export async function handleCustomerCartSnapshotsHttp(
  request: Request,
  deps: CustomerCartSnapshotsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname
  if (!ownsCartSnapshotsNamespace(path)) return null
  const list = path === '/api/account/cart-snapshots',
    resolve = path === '/api/cart/shared/resolve'
  const command = /^\/api\/account\/cart-snapshots\/commands\/([^/]+)$/.exec(path)
  const revoke = /^\/api\/account\/cart-snapshots\/([^/]+)\/revoke$/.exec(path)
  if (!list && !resolve && !command && !revoke) return error('not_found', 404)
  const id = command?.[1] ?? revoke?.[1]
  if (id && !catalogPolicyUuidSchema.safeParse(id).success) return error('invalid_input', 400)
  const allowed = list ? 'GET, POST' : command ? 'GET' : 'POST'
  if (!allowed.split(', ').includes(request.method)) return error('method_not_allowed', 405, { Allow: allowed })
  try {
    validateSessionCookieConfiguration(deps.sessionCookieConfiguration)
    const configured = new URL(deps.origin)
    if (configured.origin !== deps.origin || configured.protocol !== 'https:') return error('service_unavailable', 503)
    if (
      url.origin !== deps.origin ||
      ((request.method !== 'GET' || request.headers.has('origin')) && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    if (url.search) return error('invalid_input', 400)
    const edge = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, deps.rateLimitPepper, 'storefront-cart')
    if (edge === 'unavailable') return error('service_unavailable', 503)
    if (edge === 'limited') return error('rate_limited', 429, { 'Retry-After': '60' })
    const options = deps.now ? { now: deps.now } : {}
    if (resolve) {
      const raw = await readBody(request)
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Object.keys(raw).some((key) => key !== 'id' && key !== 'token')
      )
        return error('invalid_input', 400)
      // Invalid bearer shapes are uniformly unavailable, never an existence oracle.
      return json(await resolveD1SharedCart(deps.database, raw, options))
    }
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    const cart = credentials(request)
    const expectedCartId = request.headers.get('X-Neteco-Cart-Id')
    if ((list && request.method === 'POST') || (command && expectedCartId !== null)) {
      if (!catalogPolicyUuidSchema.safeParse(expectedCartId).success || !cart || expectedCartId !== cart.cartId)
        return error('unauthenticated', 401)
    }
    if (list && request.method === 'GET') return json(await listD1CartSnapshots(deps.database, claims, options))
    if (command)
      return json(
        await readD1CartSnapshotCommand(
          deps.database,
          {
            claims,
            ...(cart ? { cartId: cart.cartId, cartToken: cart.token } : {})
          },
          id!,
          request.headers.get('X-Neteco-Command-Payload-Hash') ?? '',
          options
        )
      )
    if (list && !cart) return error('unauthenticated', 401)
    // Read-only live owner authorization precedes a security-quota write.
    await listD1CartSnapshots(deps.database, claims, options)
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'cart-snapshots',
      limit: 60,
      windowSeconds: 3600,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now) / 1000) } : {})
    })
    if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
    const raw = await readBody(request),
      key = request.headers.get('idempotency-key') ?? ''
    if (!catalogPolicyUuidSchema.safeParse(key).success) return error('invalid_input', 400)
    if (revoke) {
      const parsed = cartSnapshotRevokeInputSchema.safeParse(raw)
      if (!parsed.success) return error('invalid_input', 400)
      return json(await revokeD1CartShare(deps.database, claims, id!, parsed.data, { ...options, idempotencyKey: key }))
    }
    const parsed = cartSnapshotInputSchema.safeParse(raw)
    if (!parsed.success) return error('invalid_input', 400)
    return json(
      await saveD1CartSnapshot(deps.database, { claims, cartId: cart!.cartId, cartToken: cart!.token }, parsed.data, {
        ...options,
        idempotencyKey: key
      }),
      201
    )
  } catch (failure) {
    if (failure instanceof BodyError) return error(failure.code, failure.status)
    if (failure instanceof CartSnapshotError) {
      const code = failure.code
      if (code === 'unauthenticated') return error(code, 401)
      if (code === 'email_unverified' || code === 'mfa_required') return error(code, 403)
      if (code === 'invalid_input') return error(code, 400)
      if (code === 'not_found') return error(code, 404)
      if (['version_conflict', 'conflict', 'already_exists', 'limit_reached'].includes(code)) return error(code, 409)
      if (code === 'empty_cart' || code === 'variant_not_available') return error(code, 422)
    }
    return error('service_unavailable', 503)
  }
}
