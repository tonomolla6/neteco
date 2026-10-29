import type { SessionCookieConfiguration } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { GuestOrderAccessError, exchangeD1GuestOrderAccess } from './guest-order-access'
export interface GuestOrderAccessHttpDependencies {
  database: D1Database
  origin: string
  edgeLimiter: RateLimit
  rateLimitPepper: string
  sessionCookieConfiguration: SessionCookieConfiguration
  now?: () => string
}

export async function handleGuestOrderAccessHttp(
  request: Request,
  dependencies: GuestOrderAccessHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url),
    landing = /^\/pedido\/([^/]+)$/.exec(url.pathname),
    exchange = /^\/api\/orders\/([^/]+)\/access$/.exec(url.pathname)
  if (!exchange && !(landing && url.searchParams.has('token'))) return null
  const headers = {
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    Vary: 'Cookie',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow, noarchive'
  }
  const error = (code: string, status: number, extra: Record<string, string> = {}) =>
    Response.json({ error: { code } }, { status, headers: { ...headers, ...extra } })
  if (request.method !== (landing ? 'GET' : 'POST'))
    return error('method_not_allowed', 405, { Allow: landing ? 'GET' : 'POST' })
  try {
    let configured: URL
    try {
      configured = new URL(dependencies.origin)
    } catch {
      return error('unavailable', 503)
    }
    if (
      configured.protocol !== 'https:' ||
      configured.origin !== dependencies.origin ||
      configured.username ||
      configured.password
    )
      return error('unavailable', 503)
    const suppliedOrigin = request.headers.get('origin')
    if (
      url.origin !== dependencies.origin ||
      (suppliedOrigin !== null && suppliedOrigin !== dependencies.origin) ||
      (exchange && (suppliedOrigin !== dependencies.origin || request.headers.get('sec-fetch-site') === 'cross-site'))
    )
      return error('forbidden', 403)
    if (
      landing
        ? Array.from(url.searchParams.keys()).some((key) => key !== 'token') ||
          url.searchParams.getAll('token').length !== 1
        : !!url.search
    )
      return error('invalid_input', 400)
    const limit = await checkAdministrativeEdgeLimit(
      request,
      dependencies.edgeLimiter,
      dependencies.rateLimitPepper,
      'storefront-payment'
    )
    if (limit !== 'allowed')
      return error(limit === 'limited' ? 'rate_limited' : 'unavailable', limit === 'limited' ? 429 : 503)
    let token: string
    if (landing) token = url.searchParams.get('token')!
    else {
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
        return error('invalid_input', 415)
      const length = request.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 512)) return error('invalid_input', 413)
      const reader = request.body?.getReader()
      if (!reader) return error('invalid_input', 400)
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 512) {
          await reader.cancel()
          return error('invalid_input', 413)
        }
        chunks.push(part.value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      let body: unknown
      try {
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      } catch {
        return error('invalid_input', 400)
      }
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !('token' in body) ||
        typeof body.token !== 'string'
      )
        return error('invalid_input', 400)
      token = body.token
    }
    const orderId = (landing ?? exchange)![1]!,
      cookie = await exchangeD1GuestOrderAccess(
        dependencies.database,
        request,
        orderId,
        token,
        dependencies.sessionCookieConfiguration,
        dependencies
      )
    return new Response(null, {
      status: landing ? 303 : 204,
      headers: {
        ...headers,
        ...(landing ? { Location: `/pedido/${orderId}` } : {}),
        ...(cookie ? { 'Set-Cookie': cookie } : {})
      }
    })
  } catch (cause) {
    if (cause instanceof GuestOrderAccessError)
      return error(cause.code === 'not_found' ? 'not_found' : 'unavailable', cause.code === 'not_found' ? 404 : 503)
    return error('internal', 500)
  }
}
