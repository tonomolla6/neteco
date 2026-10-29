import {
  fulfillmentIdempotencyKeySchema,
  fulfillmentOrderIdSchema,
  fulfillmentTransitionInputSchema
} from '../../shared/order-fulfillment'
import { verifySessionCookie } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { authorizeD1Session } from '../catalog/authorization'
import {
  FulfillmentError,
  executeD1AdminFulfillmentCommand,
  readD1AdminFulfillment,
  type FulfillmentErrorCode
} from './admin'

export type AdminFulfillmentHttpEnvironment = Pick<
  CloudflareEnv,
  'DB' | 'AUTH_ENABLED' | 'AUTH_ORIGIN' | 'NUXT_SESSION_PASSWORD'
>
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
function status(code: FulfillmentErrorCode) {
  if (code === 'unauthenticated') return 401
  if (['email_unverified', 'mfa_required', 'forbidden'].includes(code)) return 403
  if (code === 'not_found') return 404
  if (code === 'invalid_input') return 422
  return 409
}
/** Own aliases as well, but never accept them as canonical routes. They must
 * not fall through to an older backend or a public order/token handler. */
export function ownsAdminFulfillmentNamespace(pathname: string): boolean {
  let path = pathname
  for (let attempts = 0; attempts < 4; attempts++) {
    if (/^\/api\/admin\/orders[/\\][^/\\]+[/\\]fulfillment(?:[/\\%]|$)/.test(path)) return true
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
type Route = { orderId: string; write: boolean }
function routeAt(path: string): Route | null {
  const match = /^\/api\/admin\/orders\/([^/]+)\/fulfillment(\/transitions)?$/.exec(path)
  if (!match || !fulfillmentOrderIdSchema.safeParse(match[1]).success) return null
  return { orderId: match[1]!, write: !!match[2] }
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
  const declared = request.headers.get('content-length'),
    limit = 8 * 1024
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
function pagination(url: URL) {
  if (
    [...url.searchParams.keys()].some(
      (key) => !['page', 'perPage'].includes(key) || url.searchParams.getAll(key).length !== 1
    )
  )
    throw new HttpError('invalid_input', 400)
  const page = url.searchParams.get('page') ?? '1',
    perPage = url.searchParams.get('perPage') ?? '25'
  if (
    !/^[1-9][0-9]{0,6}$/.test(page) ||
    !/^[1-9][0-9]?$/.test(perPage) ||
    Number(page) > 1_000_000 ||
    Number(perPage) > 50
  )
    throw new HttpError('invalid_input', 400)
  return { page: Number(page), perPage: Number(perPage) }
}
/** D1 itself serializes each guarded atomic command. No carrier, external
 * payment, stock coordinator or historical PostgreSQL mutation is involved. */
export async function handleAdminFulfillmentHttp(
  request: Request,
  env: AdminFulfillmentHttpEnvironment
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsAdminFulfillmentNamespace(url.pathname)) return null
  try {
    const configured = new URL(env.AUTH_ORIGIN)
    if (configured.protocol !== 'https:' || configured.origin !== env.AUTH_ORIGIN || env.AUTH_ORIGIN.length > 2000)
      throw new Error('invalid_fulfillment_origin')
    const route = routeAt(url.pathname),
      write = request.method !== 'GET'
    if (
      (write
        ? request.headers.get('origin') !== env.AUTH_ORIGIN
        : request.headers.has('origin') && request.headers.get('origin') !== env.AUTH_ORIGIN) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    if (!route) return error('invalid_input', 400)
    const method = route.write ? 'POST' : 'GET'
    if (request.method !== method) return error('method_not_allowed', 405, { Allow: method })
    if (route.write && url.searchParams.size) return error('invalid_input', 400)
    const page = route.write ? null : pagination(url)
    if (env.AUTH_ENABLED !== 'true') return error('service_unavailable', 503)
    const claims = await verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
    if (!claims) return error('unauthenticated', 401)
    const auth = await authorizeD1Session(env.DB, claims, 'administration.manage', { requireMfa: true })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
    if (!route.write) return json(await readD1AdminFulfillment(env.DB, claims, route.orderId, page!))
    const key = fulfillmentIdempotencyKeySchema.safeParse(request.headers.get('idempotency-key'))
    if (!key.success) return error('invalid_idempotency_key', 400)
    const quota = await consumeIdentityQuota(env.DB, {
      identityId: claims.identityId,
      scope: 'admin-fulfillment',
      limit: 60,
      windowSeconds: 3600
    })
    const headers = { 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': String(quota.remaining) }
    if (!quota.allowed) return error('rate_limited', 429, { ...headers, 'Retry-After': String(quota.retryAfter) })
    const input = fulfillmentTransitionInputSchema.safeParse(await body(request))
    if (!input.success) return error('invalid_input', 422)
    const fresh = await authorizeD1Session(env.DB, claims, 'administration.manage', { requireMfa: true })
    if (!fresh.allowed) return error(fresh.code, fresh.code === 'unauthenticated' ? 401 : 403)
    const receipt = await executeD1AdminFulfillmentCommand(env.DB, claims, route.orderId, input.data, {
      idempotencyKey: key.data
    })
    const authorizedReturn = await authorizeD1Session(env.DB, claims, 'administration.manage', { requireMfa: true })
    if (!authorizedReturn.allowed)
      return error(authorizedReturn.code, authorizedReturn.code === 'unauthenticated' ? 401 : 403)
    return json(receipt, 200, headers)
  } catch (failure) {
    if (failure instanceof HttpError) return error(failure.code, failure.status)
    if (failure instanceof FulfillmentError) return error(failure.code, status(failure.code))
    return error('service_unavailable', 503)
  }
}
