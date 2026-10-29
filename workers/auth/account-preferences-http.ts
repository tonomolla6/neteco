import { verifySessionCookie, type SessionCookieConfiguration } from './session-cookie'
import { checkAdministrativeEdgeLimit } from './edge-limit'
import { consumeIdentityQuota } from './identity-quota'
import { accountPreferencesInputSchema } from '../../shared/account-preferences'
import {
  AccountPreferencesError,
  authorizeD1AccountPreferences,
  readD1AccountPreferences,
  updateD1AccountPreferences,
  readD1AccountPreferenceCommand
} from './account-preferences'
export interface AccountPreferencesHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  edgeLimiter: RateLimit
  rateLimitPepper: string
  now?: () => string
}
export async function handleAccountPreferencesHttp(
  request: Request,
  deps: AccountPreferencesHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url),
    match = /^\/api\/account\/preferences(?:\/commands\/([^/]+))?$/.exec(url.pathname)
  if (!match) return null
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    Response.json(body, {
      status,
      headers: {
        'Cache-Control': 'private, no-store',
        Pragma: 'no-cache',
        Vary: 'Cookie',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'Referrer-Policy': 'no-referrer',
        ...extra
      }
    })
  const error = (code: string, status: number, extra?: Record<string, string>) =>
    json({ error: { code } }, status, extra)
  const key = match[1],
    methods = key ? 'GET' : 'GET, PUT'
  if (request.method !== 'GET' && (key || request.method !== 'PUT'))
    return error('method_not_allowed', 405, { Allow: methods })
  try {
    const origin = new URL(deps.origin)
    if (origin.protocol !== 'https:' || origin.origin !== deps.origin || deps.origin.length > 2000)
      return error('unavailable', 503)
    if (
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.method === 'PUT' && request.headers.get('origin') !== deps.origin)
    )
      return error('csrf_rejected', 403)
    if (url.searchParams.size) return error('invalid_input', 400)
    const limited = await checkAdministrativeEdgeLimit(
      request,
      deps.edgeLimiter,
      deps.rateLimitPepper,
      'authentication'
    )
    if (limited !== 'allowed')
      return error(limited === 'limited' ? 'rate_limited' : 'unavailable', limited === 'limited' ? 429 : 503)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    const options = { now: deps.now }
    if (key) return json(await readD1AccountPreferenceCommand(deps.database, claims, key, options))
    if (request.method === 'GET') return json(await readD1AccountPreferences(deps.database, claims, options))
    const commandId = request.headers.get('idempotency-key')
    if (
      !commandId ||
      !accountPreferencesCommandId(commandId) ||
      !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')
    )
      return error('invalid_input', 400)
    const declared = request.headers.get('content-length')
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > 2048)) return error('invalid_input', 413)
    const reader = request.body?.getReader()
    if (!reader) return error('invalid_input', 400)
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 2048) {
        await reader.cancel()
        return error('invalid_input', 413)
      }
      chunks.push(chunk.value)
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
    const parsed = accountPreferencesInputSchema.safeParse(input)
    if (!parsed.success) return error('invalid_input', 400)
    await authorizeD1AccountPreferences(deps.database, claims, options)
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'account-preferences',
      limit: 60,
      windowSeconds: 3600,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now()) / 1000) } : {})
    })
    if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
    return json(await updateD1AccountPreferences(deps.database, claims, commandId, parsed.data, options))
  } catch (cause) {
    if (cause instanceof AccountPreferencesError)
      return error(
        cause.code,
        cause.code === 'unauthenticated'
          ? 401
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
function accountPreferencesCommandId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
