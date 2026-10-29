import type { CatalogDraftAuthoringAction } from '../../shared/catalog-draft-authoring'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { verifySessionCookie } from '../auth/session-cookie'
import { authorizeD1Session } from './authorization'
import { parseAdminCatalogLegacyId } from './admin-catalog'
import { CatalogDraftAuthoringError, executeD1CatalogDraftAuthoringCommand } from './admin-catalog-authoring'
import { readD1CatalogDraftAuthoringOptions } from './admin-catalog-references'

export type CatalogDraftAuthoringHttpEnvironment = Pick<
  CloudflareEnv,
  'DB' | 'AUTH_ENABLED' | 'AUTH_ORIGIN' | 'NUXT_SESSION_PASSWORD'
>
type Route =
  | { kind: 'options'; method: 'GET' }
  | { kind: 'create_draft'; method: 'POST' }
  | { kind: 'assign_brand'; method: 'PUT'; productId: string }
  | { kind: 'create_variant'; method: 'POST'; productId: string }
  | { kind: 'update_variant'; method: 'PUT'; productId: string; variantId: string }
  | { kind: 'discontinue_variant'; method: 'POST'; productId: string; variantId: string }
const MAX_BODY_BYTES = 64 * 1024

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, {
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
}
const error = (code: string, status: number, headers: Record<string, string> = {}) =>
  json({ error: { code } }, status, headers)

/** Reserve aliases without accepting them. A private draft command must never
 * fall through to the legacy full-product editor or the Nuxt renderer. */
export function ownsCatalogDraftAuthoringNamespace(pathname: string) {
  let candidate = pathname
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (
      /^\/api\/admin\/products(?:[\\%]|\/$|$)/.test(candidate) ||
      /^\/api\/admin\/products\/authoring-options(?:[/\\%]|$)/.test(candidate) ||
      /^\/api\/admin\/products\/[^/]*\/(?:brand|variants)(?:[/\\%]|$)/.test(candidate)
    )
      return true
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
function routeAt(pathname: string): Route | null {
  if (pathname === '/api/admin/products') return { kind: 'create_draft', method: 'POST' }
  if (pathname === '/api/admin/products/authoring-options') return { kind: 'options', method: 'GET' }
  let match = /^\/api\/admin\/products\/([^/]+)\/brand$/.exec(pathname)
  if (match) return { kind: 'assign_brand', method: 'PUT', productId: match[1]! }
  match = /^\/api\/admin\/products\/([^/]+)\/variants$/.exec(pathname)
  if (match) return { kind: 'create_variant', method: 'POST', productId: match[1]! }
  match = /^\/api\/admin\/products\/([^/]+)\/variants\/([^/]+)$/.exec(pathname)
  if (match) return { kind: 'update_variant', method: 'PUT', productId: match[1]!, variantId: match[2]! }
  match = /^\/api\/admin\/products\/([^/]+)\/variants\/([^/]+)\/discontinue$/.exec(pathname)
  return match ? { kind: 'discontinue_variant', method: 'POST', productId: match[1]!, variantId: match[2]! } : null
}
class AuthoringHttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
async function commandBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES))
    throw new AuthoringHttpError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new AuthoringHttpError('json_required', 415)
  if (!request.body) throw new AuthoringHttpError('missing_body', 400)
  const reader = request.body.getReader(),
    bytes = new Uint8Array(MAX_BODY_BYTES)
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new AuthoringHttpError('invalid_json', 400)
      if (next.value.byteLength > MAX_BODY_BYTES - length) {
        await reader.cancel().catch(() => undefined)
        throw new AuthoringHttpError('body_too_large', 413)
      }
      bytes.set(next.value, length)
      length += next.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  if (!length) throw new AuthoringHttpError('missing_body', 400)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown
  } catch {
    throw new AuthoringHttpError('invalid_json', 400)
  }
}
function domainFailure(failure: CatalogDraftAuthoringError) {
  if (failure.code === 'unauthenticated') return error(failure.code, 401)
  if (['email_unverified', 'mfa_required', 'forbidden'].includes(failure.code)) return error(failure.code, 403)
  if (failure.code === 'not_found') return error(failure.code, 404)
  if (failure.code === 'invalid_input') return error(failure.code, 422)
  return error(failure.code, 409)
}

/** Draft-only mutations with live catalog.write + MFA. No publication, pricing,
 * inventory, identity, warehouse or regulatory approval is implied by HTTP. */
export async function handleCatalogDraftAuthoringHttp(
  request: Request,
  env: CatalogDraftAuthoringHttpEnvironment
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCatalogDraftAuthoringNamespace(url.pathname)) return null
  // Preserve the existing paginated private reader, but never its old POST.
  if (url.pathname === '/api/admin/products' && request.method === 'GET') return null
  const route = routeAt(url.pathname)
  const allow = route?.kind === 'create_draft' ? 'GET, POST' : route?.method
  if (allow && request.method !== route!.method) return error('method_not_allowed', 405, { Allow: allow })
  const write = request.method !== 'GET'
  try {
    const origin = new URL(env.AUTH_ORIGIN)
    if (origin.protocol !== 'https:' || origin.origin !== env.AUTH_ORIGIN || env.AUTH_ORIGIN.length > 2000)
      throw new Error('invalid_catalog_authoring_origin')
    if (
      (write
        ? request.headers.get('origin') !== env.AUTH_ORIGIN
        : request.headers.has('origin') && request.headers.get('origin') !== env.AUTH_ORIGIN) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    if (
      !route ||
      url.searchParams.size ||
      ('productId' in route && parseAdminCatalogLegacyId(route.productId) === null) ||
      ('variantId' in route && parseAdminCatalogLegacyId(route.variantId) === null)
    )
      return error('invalid_input', 400)
    if (env.AUTH_ENABLED !== 'true') return error('service_unavailable', 503)
    const claims = await verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
    if (!claims) return error('unauthenticated', 401)
    const auth = await authorizeD1Session(env.DB, claims, 'catalog.write', { requireMfa: true })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
    if (route.kind === 'options') {
      const result = await readD1CatalogDraftAuthoringOptions(env.DB, claims)
      return result.outcome === 'found'
        ? json(result.data)
        : result.outcome === 'denied'
          ? error(result.code, result.code === 'unauthenticated' ? 401 : 403)
          : error('not_found', 404)
    }
    const key = request.headers.get('idempotency-key')
    if (!key || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return error('invalid_idempotency_key', 400)
    let quota: Awaited<ReturnType<typeof consumeIdentityQuota>>
    try {
      quota = await consumeIdentityQuota(env.DB, {
        identityId: claims.identityId,
        scope: 'admin-catalog-authoring',
        limit: 60,
        windowSeconds: 3600
      })
    } catch {
      return error('abuse_control_unavailable', 503)
    }
    const headers = { 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': String(quota.remaining) }
    if (!quota.allowed) return error('rate_limited', 429, { ...headers, 'Retry-After': String(quota.retryAfter) })
    return json(
      await executeD1CatalogDraftAuthoringCommand(
        env.DB,
        claims,
        route.kind as CatalogDraftAuthoringAction,
        {
          ...('productId' in route ? { productId: route.productId } : {}),
          ...('variantId' in route ? { variantId: route.variantId } : {})
        },
        await commandBody(request),
        { idempotencyKey: key }
      ),
      route.kind === 'create_draft' ? 201 : 200,
      headers
    )
  } catch (failure) {
    if (failure instanceof AuthoringHttpError) return error(failure.code, failure.status)
    if (failure instanceof CatalogDraftAuthoringError) return domainFailure(failure)
    return error('service_unavailable', 503)
  }
}
