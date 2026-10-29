import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { deriveAdminAuditIpHash } from '../auth/admin-audit-network'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { orderCancellationInputSchema } from '../../shared/order-cancellation'
import {
  cancelD1UnpaidOrder,
  readD1OrderCancellation,
  readD1OrderCancellationCommand,
  OrderCancellationError
} from './order-cancellation'

export interface OrderCancellationHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  edgeLimiter: RateLimit
  rateLimitPepper: string
  now?: () => string
}
export async function handleOrderCancellationHttp(
  request: Request,
  deps: OrderCancellationHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = /^\/api\/(admin\/)?orders\/([^/]+)\/cancellation(?:\/commands\/([^/]+))?$/.exec(url.pathname)
  if (!match) return null
  const response = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    Response.json(body, {
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
  const error = (code: string, status: number, headers?: Record<string, string>) =>
    response({ error: { code } }, status, headers)
  const receipt = match[3] !== undefined
  if (!(receipt ? ['GET'] : ['GET', 'POST']).includes(request.method))
    return error('method_not_allowed', 405, { Allow: receipt ? 'GET' : 'GET, POST' })
  try {
    const origin = new URL(deps.origin)
    if (origin.protocol !== 'https:' || origin.origin !== deps.origin || deps.origin.length > 2000)
      return error('unavailable', 503)
    if (
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.method === 'POST' && request.headers.get('origin') !== deps.origin)
    )
      return error('csrf_rejected', 403)
    if (url.searchParams.size) return error('invalid_input', 400)
    const audience = match[1] ? 'admin' : 'customer'
    const limited = await checkAdministrativeEdgeLimit(
      request,
      deps.edgeLimiter,
      deps.rateLimitPepper,
      audience === 'admin' ? 'admin-orders' : 'customer-returns'
    )
    if (limited !== 'allowed')
      return error(limited === 'limited' ? 'rate_limited' : 'unavailable', limited === 'limited' ? 429 : 503)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    const options = { audience, now: deps.now } as const
    if (receipt)
      return response(await readD1OrderCancellationCommand(deps.database, claims, match[2]!, match[3]!, options))
    if (request.method === 'GET')
      return response(await readD1OrderCancellation(deps.database, claims, match[2]!, options))
    const key = request.headers.get('idempotency-key')
    if (!key || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key))
      return error('invalid_input', 400)
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? ''))
      return error('invalid_input', 400)
    const length = request.headers.get('content-length')
    if (length && (!/^\d+$/.test(length) || Number(length) > 4096)) return error('invalid_input', 413)
    const reader = request.body?.getReader()
    if (!reader) return error('invalid_input', 400)
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > 4096) {
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
    const parsed = orderCancellationInputSchema.safeParse(input)
    if (!parsed.success) return error('invalid_input', 400)
    // Authenticate ownership/grants before the quota write. Eligibility itself
    // is checked again by the command and inside its single financial-free batch.
    await readD1OrderCancellation(deps.database, claims, match[2]!, options)
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: audience === 'admin' ? 'admin-orders' : 'customer-returns',
      limit: 10,
      windowSeconds: 3600,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now()) / 1000) } : {})
    })
    if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
    const ipHash = await deriveAdminAuditIpHash(request, deps.rateLimitPepper)
    return response(
      await cancelD1UnpaidOrder(deps.database, claims, match[2]!, key, parsed.data, { ...options, ipHash })
    )
  } catch (cause) {
    if (cause instanceof OrderCancellationError)
      return error(
        cause.code,
        cause.code === 'unauthenticated'
          ? 401
          : cause.code === 'not_found'
            ? 404
            : cause.code === 'invalid_input'
              ? 400
              : cause.code === 'conflict' || cause.code === 'not_eligible'
                ? 409
                : cause.code === 'unavailable'
                  ? 503
                  : 403
      )
    return error('unavailable', 503)
  }
}
