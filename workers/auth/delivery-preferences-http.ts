import type { AccountPreferencesHttpDependencies } from './account-preferences-http'
import { verifySessionCookie } from './session-cookie'
import { checkAdministrativeEdgeLimit } from './edge-limit'
import { consumeIdentityQuota } from './identity-quota'
import { authorizeD1AccountPreferences } from './account-preferences'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { deliveryPreferencesInputSchema } from '../../shared/delivery-preferences'
import {
  DeliveryPreferencesError,
  readD1DeliveryPreferences,
  updateD1DeliveryPreferences,
  readD1DeliveryPreferenceCommand
} from './delivery-preferences'
export type DeliveryPreferencesHttpDependencies = AccountPreferencesHttpDependencies
export function ownsDeliveryPreferencesNamespace(pathname: string) {
  let path = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    if (/^\/api\/account\/delivery-preferences(?:[/\\%]|$)/i.test(path)) return true
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
export async function handleDeliveryPreferencesRequest(
  request: Request,
  deps: DeliveryPreferencesHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsDeliveryPreferencesNamespace(url.pathname)) return null
  const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
    Response.json(value, {
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
    json({ error: { code } }, status, headers)
  const match = /^\/api\/account\/delivery-preferences(?:\/commands\/([^/]+))?$/.exec(url.pathname)
  if (!match) {
    const canonicalUnknown =
      /^\/api\/account\/delivery-preferences\/[a-z0-9/-]+$/.test(url.pathname) &&
      !url.pathname.startsWith('/api/account/delivery-preferences/commands')
    return error(canonicalUnknown ? 'not_found' : 'invalid_input', canonicalUnknown ? 404 : 400)
  }
  if (match[1] && !catalogPolicyUuidSchema.safeParse(match[1]).success) return error('invalid_input', 400)
  const key = match[1],
    methods = key ? 'GET' : 'GET, PUT'
  if (request.method !== 'GET' && (key || request.method !== 'PUT'))
    return error('method_not_allowed', 405, { Allow: methods })
  try {
    const origin = new URL(deps.origin)
    if (origin.protocol !== 'https:' || origin.origin !== deps.origin || deps.origin.length > 2000)
      return error('unavailable', 503)
    if (
      url.origin !== deps.origin ||
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
    const options = deps.now ? { now: deps.now } : {}
    if (key) {
      const hash = request.headers.get('X-Neteco-Command-Payload-Hash') ?? ''
      if (!/^[a-f0-9]{64}$/.test(hash)) return error('invalid_input', 400)
      return json(await readD1DeliveryPreferenceCommand(deps.database, claims, key, hash, options))
    }
    if (request.method === 'GET') return json(await readD1DeliveryPreferences(deps.database, claims, options))
    await authorizeD1AccountPreferences(deps.database, claims, options)
    const commandId = request.headers.get('idempotency-key')
    if (
      !catalogPolicyUuidSchema.safeParse(commandId).success ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')
    )
      return error('invalid_input', 400)
    const declared = request.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 2048)) return error('invalid_input', 413)
    const reader = request.body?.getReader()
    if (!reader) return error('invalid_input', 400)
    const bytes = new Uint8Array(2048)
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (chunk.value.byteLength > 2048 - size) {
          await reader.cancel().catch(() => undefined)
          return error('invalid_input', 413)
        }
        bytes.set(chunk.value, size)
        size += chunk.value.byteLength
      }
    } finally {
      reader.releaseLock()
    }
    let input: unknown
    try {
      input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)))
    } catch {
      return error('invalid_input', 400)
    }
    const parsed = deliveryPreferencesInputSchema.safeParse(input)
    if (!parsed.success) return error('invalid_input', 400)
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'account-preferences',
      limit: 60,
      windowSeconds: 3600,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now()) / 1000) } : {})
    })
    if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
    return json(await updateD1DeliveryPreferences(deps.database, claims, commandId!, parsed.data, options))
  } catch (cause) {
    const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : 'unavailable'
    if (
      cause instanceof DeliveryPreferencesError ||
      ['unauthenticated', 'email_unverified', 'mfa_required'].includes(code)
    )
      return error(
        code,
        code === 'unauthenticated'
          ? 401
          : code === 'invalid_input'
            ? 400
            : ['conflict', 'version_conflict'].includes(code)
              ? 409
              : code === 'unavailable'
                ? 503
                : 403
      )
    return error('unavailable', 503)
  }
}
