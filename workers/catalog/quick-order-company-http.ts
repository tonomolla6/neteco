import { consumeIdentityQuota } from '../auth/identity-quota'
import type { VerifiedSessionClaims } from './authorization'
import { QuickOrderCompanyError, resolveCompanyQuickOrder } from './quick-order-company'

/** SEA-018. POST /api/account/quick-order/company resolves CSV / scanned lines under the
 * authenticated company. The session is the only source of identity; body and clock are
 * never trusted for it. */
export interface QuickOrderCompanyHttpDependencies {
  database: D1Database
  origin: string
  session: (request: Request) => Promise<VerifiedSessionClaims | null>
  now?: () => string
}
const BASE = '/api/account/quick-order/company'
const MAX_BODY = 32 * 1024
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
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
const error = (code: string, status: number, headers: Record<string, string> = {}) =>
  json({ error: { code } }, status, headers)

export function ownsQuickOrderCompanyNamespace(pathname: string) {
  let candidate = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    if (/^\/api\/account\/quick-order(?:[/\\%]|$)/i.test(candidate)) return true
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

class BodyError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
async function readBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY))
    throw new BodyError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new BodyError('json_required', 415)
  if (!request.body) throw new BodyError('missing_body', 400)
  const reader = request.body.getReader()
  const bytes = new Uint8Array(MAX_BODY)
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new BodyError('invalid_json', 400)
      if (next.value.byteLength > MAX_BODY - length) throw new BodyError('body_too_large', 413)
      bytes.set(next.value, length)
      length += next.value.byteLength
    }
  } catch (failure) {
    void reader.cancel().catch(() => undefined)
    throw failure
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown
  } catch {
    throw new BodyError('invalid_json', 400)
  }
}

export async function handleQuickOrderCompanyHttp(
  request: Request,
  deps: QuickOrderCompanyHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsQuickOrderCompanyNamespace(url.pathname)) return null
  if (url.pathname !== BASE && url.pathname !== BASE + '/') return error('not_found', 404)
  if (request.method !== 'POST') return error('method_not_allowed', 405, { Allow: 'POST' })
  if (url.search) return error('invalid_input', 400)
  try {
    const configured = new URL(deps.origin)
    if (configured.protocol !== 'https:' || configured.origin !== deps.origin) return error('service_unavailable', 503)
    if (request.headers.get('sec-fetch-site') === 'cross-site' || request.headers.get('origin') !== deps.origin)
      return error('csrf_rejected', 403)
    const claims = await deps.session(request)
    if (!claims) return error('unauthenticated', 401)
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'quick-order-company',
      limit: 120,
      windowSeconds: 3600,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now()) / 1000) } : {})
    })
    if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
    const payload = await readBody(request)
    return json(await resolveCompanyQuickOrder(deps.database, claims, payload, { now: deps.now }))
  } catch (failure) {
    if (failure instanceof BodyError) return error(failure.code, failure.status)
    if (failure instanceof QuickOrderCompanyError) {
      const status =
        failure.code === 'unauthenticated'
          ? 401
          : failure.code === 'invalid_input'
            ? 422
            : failure.code === 'unavailable'
              ? 503
              : 403
      return error(failure.code, status)
    }
    return error('service_unavailable', 503)
  }
}
