import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from './authorization'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { parseAdminCatalogLegacyId } from './admin-catalog'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { catalogRelationsInputSchema, catalogRelationSlugsSchema } from '../../shared/catalog-relations'
import {
  CatalogRelationsError,
  readD1AdminCatalogRelations,
  updateD1CatalogRelations,
  readD1CatalogRelationsCommand,
  readD1ProductRelations
} from './catalog-relations'

export interface CatalogRelationsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  edgeLimiter: RateLimit
  rateLimitPepper: string
  now?: string
}
export function ownsCatalogRelationsNamespace(path: string): boolean {
  let candidate = path
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/(?:product-relations(?:[/\\%]|$)|admin\/products\/[^/\\]+\/relations(?:[/\\%]|$))/i.test(candidate))
      return true
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
class BoundaryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
async function readBody(request: Request): Promise<unknown> {
  const maximum = 32768,
    declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum))
    throw new BoundaryError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new BoundaryError('json_required', 415)
  if (!request.body) throw new BoundaryError('invalid_input', 400)
  const reader = request.body.getReader(),
    bytes = new Uint8Array(maximum),
    deadline = Date.now() + 8000
  let size = 0
  try {
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new BoundaryError('body_timeout', 408)
      let timer: ReturnType<typeof setTimeout> | undefined
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new BoundaryError('body_timeout', 408)), remaining)
        })
      ]).finally(() => clearTimeout(timer))
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new BoundaryError('invalid_input', 400)
      if (next.value.byteLength > maximum - size) throw new BoundaryError('body_too_large', 413)
      bytes.set(next.value, size)
      size += next.value.byteLength
    }
  } catch (failure) {
    void reader.cancel().catch(() => undefined)
    if (failure instanceof BoundaryError) throw failure
    throw new BoundaryError('invalid_input', 400)
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))) as unknown
  } catch {
    throw new BoundaryError('invalid_input', 400)
  }
}
export async function handleCatalogRelationsHttp(
  request: Request,
  deps: CatalogRelationsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname
  if (!ownsCatalogRelationsNamespace(path)) return null
  const publicRead = path === '/api/product-relations'
  const match = /^\/api\/admin\/products\/([^/]+)\/relations(?:\/(commands)(?:\/([^/]+))?)?$/.exec(path)
  if (!publicRead && !match) return error('not_found', 404)
  const productId = match ? parseAdminCatalogLegacyId(match[1]!) : null
  if (match && productId === null) return error('invalid_input', 400)
  const write = Boolean(match?.[2] && !match[3]),
    commandId = match?.[3]
  if (commandId && !catalogPolicyUuidSchema.safeParse(commandId).success) return error('invalid_input', 400)
  const allowed = write ? 'POST' : 'GET'
  if (request.method !== allowed) return error('method_not_allowed', 405, { Allow: allowed })
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
    if (!publicRead && url.search) return error('invalid_input', 400)
    const edge = await checkAdministrativeEdgeLimit(
      request,
      deps.edgeLimiter,
      deps.rateLimitPepper,
      publicRead ? 'storefront-cart' : 'admin-catalog'
    )
    if (edge === 'unavailable') return error('service_unavailable', 503)
    if (edge === 'limited') return error('rate_limited', 429, { 'Retry-After': '60' })
    const options = deps.now ? { now: deps.now } : {}
    if (publicRead) {
      if (url.searchParams.getAll('slugs').length !== 1 || [...url.searchParams.keys()].some((key) => key !== 'slugs'))
        return error('invalid_input', 400)
      const slugs = catalogRelationSlugsSchema.safeParse(url.searchParams.get('slugs')!.split(','))
      if (!slugs.success) return error('invalid_input', 400)
      return json(await readD1ProductRelations(deps.database, slugs.data, options))
    }
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    const authority = await authorizeD1Session(deps.database, claims, 'catalog.write', { ...options, requireMfa: true })
    if (!authority.allowed) return error(authority.code, authority.code === 'unauthenticated' ? 401 : 403)
    if (commandId) {
      const hash = request.headers.get('X-Neteco-Command-Payload-Hash') ?? ''
      if (!/^[0-9a-f]{64}$/.test(hash)) return error('invalid_input', 400)
      return json(await readD1CatalogRelationsCommand(deps.database, claims, productId!, commandId, hash, options))
    }
    if (!write) return json(await readD1AdminCatalogRelations(deps.database, claims, productId!, options))
    const key = catalogPolicyUuidSchema.safeParse(request.headers.get('idempotency-key'))
    if (!key.success) return error('invalid_input', 400)
    const parsed = catalogRelationsInputSchema.safeParse(await readBody(request))
    if (!parsed.success || parsed.data.relations.some((item) => item.targetProductId === productId))
      return error('invalid_input', 400)
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'admin-catalog-relations',
      limit: 60,
      windowSeconds: 3600,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now) / 1000) } : {})
    })
    if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
    // The core performs final atomic live authorization. No further DB await may follow.
    return json(
      await updateD1CatalogRelations(deps.database, claims, productId!, parsed.data, {
        ...options,
        idempotencyKey: key.data
      }),
      201
    )
  } catch (failure) {
    if (failure instanceof BoundaryError) return error(failure.code, failure.status)
    if (failure instanceof CatalogRelationsError) {
      const code = failure.code
      if (code === 'unauthenticated') return error(code, 401)
      if (['email_unverified', 'mfa_required', 'forbidden'].includes(code)) return error(code, 403)
      if (code === 'invalid_input') return error(code, 400)
      if (code === 'not_found') return error(code, 404)
      if (code === 'version_conflict' || code === 'idempotency_conflict') return error(code, 409)
    }
    return error('service_unavailable', 503)
  }
}
