import type { AccountPreferencesHttpDependencies } from '../auth/account-preferences-http'
import { verifySessionCookie } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { authorizeD1AccountPreferences, AccountPreferencesError } from '../auth/account-preferences'
import {
  productWatchCreateInputSchema,
  productWatchConfirmInputSchema,
  productWatchCancelInputSchema
} from '../../shared/product-watch'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import {
  ProductWatchError,
  readD1ProductWatches,
  readD1ProductWatch,
  createD1ProductWatch,
  confirmD1ProductWatch,
  cancelD1ProductWatch,
  readD1ProductWatchCommand
} from './product-watch'

export interface ProductWatchHttpDependencies extends AccountPreferencesHttpDependencies {
  /** Server-only secret bytes, domain-separated from other uses by the core. */
  hmacKey: Uint8Array
}
export function ownsProductWatchNamespace(pathname: string) {
  let path = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    if (/^\/api\/account\/product-watches(?:[/\\%]|$)/i.test(path)) return true
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
export async function handleProductWatchRequest(
  request: Request,
  deps: ProductWatchHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsProductWatchNamespace(url.pathname)) return null
  const json = (value: unknown, status = 200, extra: Record<string, string> = {}) =>
    Response.json(value, {
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
  const error = (code: string, status: number, extra: Record<string, string> = {}) =>
    json({ error: { code } }, status, extra)
  const match = /^\/api\/account\/product-watches(?:\/(?:commands\/([^/]+)|([^/]+)(?:\/(confirm|cancel))?))?$/.exec(
    url.pathname
  )
  if (!match) return error('invalid_input', 400)
  const commandId = match[1],
    watchId = match[2],
    action = match[3],
    methods = commandId || (watchId && !action) ? 'GET' : watchId ? 'POST' : 'GET, POST'
  if (!methods.split(', ').includes(request.method)) return error('method_not_allowed', 405, { Allow: methods })
  if (
    (commandId && !catalogPolicyUuidSchema.safeParse(commandId).success) ||
    (watchId && !catalogPolicyUuidSchema.safeParse(watchId).success)
  )
    return error('invalid_input', 400)
  try {
    const configured = new URL(deps.origin)
    if (
      configured.protocol !== 'https:' ||
      configured.origin !== deps.origin ||
      !(deps.hmacKey instanceof Uint8Array) ||
      deps.hmacKey.length < 32 ||
      deps.hmacKey.length > 128
    )
      return error('configuration_unavailable', 503)
    if (
      url.origin !== deps.origin ||
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.method === 'POST' && request.headers.get('origin') !== deps.origin)
    )
      return error('csrf_rejected', 403)
    const limited = await checkAdministrativeEdgeLimit(
      request,
      deps.edgeLimiter,
      deps.rateLimitPepper,
      'authentication'
    )
    if (limited !== 'allowed')
      return error(limited === 'limited' ? 'rate_limited' : 'service_unavailable', limited === 'limited' ? 429 : 503)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    const options = { ...(deps.now ? { now: deps.now } : {}), hmacKey: deps.hmacKey }
    if (commandId) {
      if (url.searchParams.size) return error('invalid_input', 400)
      const hash = request.headers.get('X-Neteco-Command-Payload-Hash') ?? ''
      if (!/^[a-f0-9]{64}$/.test(hash)) return error('invalid_input', 400)
      return json(await readD1ProductWatchCommand(deps.database, claims, commandId, hash, options))
    }
    if (request.method === 'GET') {
      if (watchId) {
        if (url.searchParams.size) return error('invalid_input', 400)
        return json(await readD1ProductWatch(deps.database, claims, watchId, options))
      }
      if (
        [...url.searchParams.keys()].some((key) => !['page', 'perPage'].includes(key)) ||
        ['page', 'perPage'].some((key) => url.searchParams.getAll(key).length > 1)
      )
        return error('invalid_input', 400)
      const query: { page?: number; perPage?: number } = {}
      for (const name of ['page', 'perPage'] as const) {
        const value = url.searchParams.get(name)
        if (value !== null) {
          if (!/^[1-9]\d{0,5}$/.test(value)) return error('invalid_input', 400)
          query[name] = Number(value)
        }
      }
      return json(await readD1ProductWatches(deps.database, claims, query, options))
    }
    if (url.searchParams.size) return error('invalid_input', 400)
    await authorizeD1AccountPreferences(deps.database, claims, options)
    const key = request.headers.get('Idempotency-Key')
    if (
      !catalogPolicyUuidSchema.safeParse(key).success ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')
    )
      return error('invalid_input', 400)
    const declared = request.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 2048)) return error('invalid_input', 413)
    const reader = request.body?.getReader()
    if (!reader) return error('invalid_input', 400)
    const bytes = new Uint8Array(2048)
    let length = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        if (part.value.length > 2048 - length) {
          await reader.cancel().catch(() => undefined)
          return error('invalid_input', 413)
        }
        bytes.set(part.value, length)
        length += part.value.length
      }
    } finally {
      reader.releaseLock()
    }
    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
    } catch {
      return error('invalid_input', 400)
    }
    const schema =
      action === 'confirm'
        ? productWatchConfirmInputSchema
        : action === 'cancel'
          ? productWatchCancelInputSchema
          : productWatchCreateInputSchema
    const parsed = schema.safeParse(raw)
    if (!parsed.success) return error('invalid_input', 400)
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'account-preferences',
      limit: 60,
      windowSeconds: 3600,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now()) / 1000) } : {})
    })
    if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
    const receipt =
      action === 'confirm'
        ? await confirmD1ProductWatch(deps.database, claims, watchId!, parsed.data, key!, options)
        : action === 'cancel'
          ? await cancelD1ProductWatch(deps.database, claims, watchId!, parsed.data, key!, options)
          : await createD1ProductWatch(deps.database, claims, parsed.data, key!, options)
    return json(receipt, 201)
  } catch (cause) {
    if (cause instanceof ProductWatchError || cause instanceof AccountPreferencesError) {
      const code = cause.code
      const status =
        code === 'unauthenticated'
          ? 401
          : code === 'email_unverified' || code === 'mfa_required'
            ? 403
            : code === 'invalid_input'
              ? 400
              : code === 'not_found'
                ? 404
                : [
                      'conflict',
                      'version_conflict',
                      'already_subscribed',
                      'variant_unavailable',
                      'confirmation_unavailable'
                    ].includes(code)
                  ? 409
                  : 503
      return error(status === 503 ? 'service_unavailable' : code, status)
    }
    return error('service_unavailable', 503)
  }
}
