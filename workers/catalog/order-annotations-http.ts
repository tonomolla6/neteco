import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { orderAnnotationsInputSchema } from '../../shared/order-annotations'
import {
  OrderAnnotationsError,
  readD1OrderAnnotations,
  executeD1OrderAnnotations,
  readD1OrderAnnotationCommand
} from './order-annotations'
export interface OrderAnnotationsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  edgeLimiter: RateLimit
  rateLimitPepper: string
  now?: () => string
}
export async function handleOrderAnnotationsHttp(
  request: Request,
  deps: OrderAnnotationsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url),
    match = /^\/api\/admin\/orders\/([^/]+)\/annotations(?:\/commands\/([^/]+))?$/.exec(url.pathname)
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
  const receipt = match[2] !== undefined
  if (!(receipt ? ['GET'] : ['GET', 'POST']).includes(request.method))
    return error('method_not_allowed', 405, { Allow: receipt ? 'GET' : 'GET, POST' })
  try {
    const configured = new URL(deps.origin)
    if (configured.protocol !== 'https:' || configured.origin !== deps.origin || deps.origin.length > 2000)
      return error('unavailable', 503)
    if (
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.method === 'POST' && request.headers.get('origin') !== deps.origin)
    )
      return error('csrf_rejected', 403)
    if (
      [...url.searchParams.keys()].some((key) => !['limit', 'before'].includes(key)) ||
      [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1) ||
      ((request.method === 'POST' || receipt) && url.searchParams.size)
    )
      return error('invalid_input', 400)
    const limited = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, deps.rateLimitPepper, 'admin-orders')
    if (limited !== 'allowed')
      return error(limited === 'limited' ? 'rate_limited' : 'unavailable', limited === 'limited' ? 429 : 503)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    const options = { now: deps.now }
    if (receipt)
      return response(await readD1OrderAnnotationCommand(deps.database, claims, match[1]!, match[2]!, options))
    const query = {
      ...(url.searchParams.has('limit')
        ? { limit: /^[1-9]\d?$/.test(url.searchParams.get('limit')!) ? Number(url.searchParams.get('limit')) : NaN }
        : {}),
      ...(url.searchParams.has('before') ? { before: url.searchParams.get('before')! } : {})
    }
    if (request.method === 'GET')
      return response(await readD1OrderAnnotations(deps.database, claims, match[1]!, query, options))
    const key = request.headers.get('idempotency-key')
    if (
      !key ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key) ||
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
    const parsed = orderAnnotationsInputSchema.safeParse(input)
    if (!parsed.success) return error('invalid_input', 400)
    await readD1OrderAnnotations(deps.database, claims, match[1]!, {}, options)
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'admin-order-annotations',
      limit: 60,
      windowSeconds: 3600,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now()) / 1000) } : {})
    })
    if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
    return response(await executeD1OrderAnnotations(deps.database, claims, match[1]!, key, parsed.data, options))
  } catch (cause) {
    if (cause instanceof OrderAnnotationsError)
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
