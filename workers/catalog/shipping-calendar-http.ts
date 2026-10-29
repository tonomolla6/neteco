import type { SessionCookieConfiguration } from '../auth/session-cookie'
import { verifySessionCookie } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { authorizeD1Session } from './authorization'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { shippingCalendarInputSchema } from '../../shared/shipping-calendar'
import {
  ShippingCalendarError,
  readD1ShippingCalendars,
  updateD1ShippingCalendars,
  readD1ShippingCalendarCommand
} from './shipping-calendar'
export interface ShippingCalendarsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  edgeLimiter: RateLimit
  rateLimitPepper: string
  now?: string
}
export function ownsShippingCalendarsNamespace(path: string) {
  let candidate = path
  for (let attempt = 0; attempt < 4; attempt++) {
    if (/^\/api\/admin\/shipping\/calendars(?:[/\\%]|$)/i.test(candidate)) return true
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
function json(value: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      Vary: 'Cookie',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      ...extra
    }
  })
}
const error = (code: string, status: number, extra: Record<string, string> = {}) =>
  json({ error: { code } }, status, extra)
class BodyError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
async function readBody(request: Request) {
  const max = 65536,
    declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max))
    throw new BodyError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new BodyError('json_required', 415)
  if (!request.body) throw new BodyError('invalid_input', 400)
  const reader = request.body.getReader(),
    bytes = new Uint8Array(max),
    deadline = Date.now() + 8000
  let size = 0
  try {
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new BodyError('body_timeout', 408)
      let timer: ReturnType<typeof setTimeout> | undefined
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new BodyError('body_timeout', 408)), remaining)
        })
      ]).finally(() => clearTimeout(timer))
      if (next.done) break
      if (next.value.byteLength > max - size) throw new BodyError('body_too_large', 413)
      bytes.set(next.value, size)
      size += next.value.byteLength
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))) as unknown
    } catch {
      throw new BodyError('invalid_input', 400)
    }
  } catch (cause) {
    void reader.cancel().catch(() => undefined)
    throw cause
  } finally {
    reader.releaseLock()
  }
}
export async function handleShippingCalendarsHttp(
  request: Request,
  deps: ShippingCalendarsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsShippingCalendarsNamespace(url.pathname)) return null
  const match = /^\/api\/admin\/shipping\/calendars(?:\/(commands)(?:\/([^/]+))?)?$/.exec(url.pathname)
  if (!match) return error('not_found', 404)
  const key = match[2],
    write = Boolean(match[1] && !key),
    method = write ? 'POST' : 'GET'
  if (request.method !== method) return error('method_not_allowed', 405, { Allow: method })
  if (key && !catalogPolicyUuidSchema.safeParse(key).success) return error('invalid_input', 400)
  try {
    const configured = new URL(deps.origin)
    if (configured.origin !== deps.origin || configured.protocol !== 'https:') return error('service_unavailable', 503)
    if (
      url.origin !== deps.origin ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (write
        ? request.headers.get('origin') !== deps.origin
        : request.headers.has('origin') && request.headers.get('origin') !== deps.origin)
    )
      return error('csrf_rejected', 403)
    if (url.search) return error('invalid_input', 400)
    const limited = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, deps.rateLimitPepper, 'admin-catalog')
    if (limited !== 'allowed')
      return error(limited === 'limited' ? 'rate_limited' : 'service_unavailable', limited === 'limited' ? 429 : 503)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    const options = deps.now ? { now: deps.now } : {}
    const allowed = await authorizeD1Session(deps.database, claims, 'administration.manage', {
      ...options,
      requireMfa: true
    })
    if (!allowed.allowed) return error(allowed.code, allowed.code === 'unauthenticated' ? 401 : 403)
    if (key) {
      const hash = request.headers.get('X-Neteco-Command-Payload-Hash') ?? ''
      if (!/^[a-f0-9]{64}$/.test(hash)) return error('invalid_input', 400)
      return json(await readD1ShippingCalendarCommand(deps.database, claims, key, hash, options))
    }
    if (!write) return json(await readD1ShippingCalendars(deps.database, claims, options))
    const commandId = catalogPolicyUuidSchema.safeParse(request.headers.get('idempotency-key'))
    if (!commandId.success) return error('invalid_input', 400)
    const input = shippingCalendarInputSchema.safeParse(await readBody(request))
    if (!input.success) return error('invalid_input', 400)
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'admin-shipping-calendars',
      limit: 60,
      windowSeconds: 3600,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now) / 1000) } : {})
    })
    if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
    return json(
      await updateD1ShippingCalendars(deps.database, claims, input.data, {
        ...options,
        idempotencyKey: commandId.data
      }),
      201
    )
  } catch (cause) {
    if (cause instanceof BodyError) return error(cause.code, cause.status)
    if (cause instanceof ShippingCalendarError) {
      const status =
        cause.code === 'invalid_input'
          ? 400
          : cause.code === 'unauthenticated'
            ? 401
            : ['forbidden', 'mfa_required', 'email_unverified'].includes(cause.code)
              ? 403
              : ['version_conflict', 'idempotency_conflict'].includes(cause.code)
                ? 409
                : 503
      return error(cause.code, status)
    }
    return error('service_unavailable', 503)
  }
}
