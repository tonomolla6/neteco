import { verifySessionCookie, type SessionCookieConfiguration } from './session-cookie'
import { consumeIdentityQuota } from './identity-quota'
import { accountPrivacyInputSchema } from '../../shared/account-privacy'
import {
  AccountPrivacyError,
  readD1AccountPrivacy,
  executeD1AccountPrivacy,
  readD1AccountPrivacyCommand,
  downloadD1AccountPrivacy
} from './account-privacy'
export interface AccountPrivacyHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  now?: () => string
}
export async function handleAccountPrivacyHttp(
  request: Request,
  deps: AccountPrivacyHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url),
    match = /^\/api\/account\/privacy(?:\/(commands)\/([^/]+)|\/([^/]+)\/(download))?$/.exec(url.pathname)
  if (!match) return null
  const headers = {
    'Cache-Control': 'private, no-store',
    Pragma: 'no-cache',
    Vary: 'Cookie',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Referrer-Policy': 'no-referrer'
  }
  const response = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    Response.json(body, { status, headers: { ...headers, ...extra } })
  const error = (code: string, status: number, extra: Record<string, string> = {}) =>
    response({ error: { code } }, status, extra)
  const readOnly = !!(match[1] || match[4])
  if (!(readOnly ? ['GET'] : ['GET', 'POST']).includes(request.method))
    return error('method_not_allowed', 405, { Allow: readOnly ? 'GET' : 'GET, POST' })
  try {
    const configured = new URL(deps.origin)
    if (
      configured.protocol !== 'https:' ||
      configured.origin !== deps.origin ||
      configured.username ||
      configured.password
    )
      return error('unavailable', 503)
    if (url.origin !== configured.origin) return error('forbidden', 403)
    if (url.search) return error('invalid_input', 400)
    const origin = request.headers.get('origin')
    if (
      (origin !== null && origin !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.method === 'POST' && origin !== deps.origin)
    )
      return error('forbidden', 403)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    // Authorize before consuming owner-scoped quotas, including on download/recovery.
    await readD1AccountPrivacy(deps.database, claims, deps)
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: request.method === 'POST' ? 'account-privacy-requests' : 'account-privacy-reads',
      limit: request.method === 'POST' ? 10 : 60,
      windowSeconds: request.method === 'POST' ? 3600 : 60,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now()) / 1000) } : {})
    })
    if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
    if (match[1]) return response(await readD1AccountPrivacyCommand(deps.database, claims, match[2]!, deps))
    if (match[4]) {
      const data = await downloadD1AccountPrivacy(deps.database, claims, match[3]!, deps)
      return response(data, 200, { 'Content-Disposition': `attachment; filename="neteco-datos-${match[3]}.json"` })
    }
    if (request.method === 'GET') return response(await readD1AccountPrivacy(deps.database, claims, deps))
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
      return error('invalid_input', 415)
    const declared = request.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 8192)) return error('invalid_input', 413)
    const reader = request.body?.getReader()
    if (!reader) return error('invalid_input', 400)
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 8192) {
        await reader.cancel()
        return error('invalid_input', 413)
      }
      chunks.push(part.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      return error('invalid_input', 400)
    }
    const parsed = accountPrivacyInputSchema.safeParse(value)
    if (!parsed.success) return error('invalid_input', 400)
    const key = request.headers.get('idempotency-key')
    if (key !== null && key !== parsed.data.idempotencyKey) return error('invalid_input', 400)
    return response(await executeD1AccountPrivacy(deps.database, claims, parsed.data, deps), 202)
  } catch (cause) {
    if (cause instanceof AccountPrivacyError)
      return error(
        cause.code,
        {
          invalid_input: 400,
          unauthenticated: 401,
          email_unverified: 403,
          customer_required: 403,
          not_found: 404,
          conflict: 409,
          unavailable: 503,
          export_too_large: 413
        }[cause.code]
      )
    return error('unavailable', 503)
  }
}
