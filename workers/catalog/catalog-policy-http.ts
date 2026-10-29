import {
  catalogPolicyCodeSchema,
  catalogPolicyUuidSchema,
  type CatalogPolicyAction
} from '../../shared/catalog-publication-policy'
import { verifySessionCookie } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { authorizeD1Session } from './authorization'
import { parseAdminCatalogLegacyId } from './admin-catalog'
import {
  CatalogPolicyError,
  executeD1CatalogPolicyCommand,
  readD1CatalogPolicies,
  readD1ProductPublicationPolicy
} from './catalog-policy'

/** Use the generated binding surface; no duplicated platform interface or
 * request-supplied execution clock. The ingress owns native edge limiting. */
export type CatalogPolicyHttpEnvironment = Pick<
  CloudflareEnv,
  'DB' | 'AUTH_ENABLED' | 'AUTH_ORIGIN' | 'NUXT_SESSION_PASSWORD'
>

type Route =
  | { kind: 'policies' }
  | { kind: 'policy_withdraw'; resourceId: string }
  | { kind: 'product_policy'; productId: string }
  | { kind: 'exception_create'; productId: string }
  | { kind: 'exception_withdraw'; productId: string; resourceId: string }

const MAX_BODY_BYTES = 64 * 1024
const QUOTA_SCOPE = 'admin-catalog-policy'

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, {
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
function error(code: string, status: number, headers: Record<string, string> = {}) {
  return json({ error: { code } }, status, headers)
}

/** Reserve malformed/encoded aliases too; an owned private namespace must not
 * fall through to the older product handler or a renderer. Parsing below still
 * accepts only the original canonical pathname, never a decoded alias. */
export function ownsCatalogPolicyNamespace(pathname: string) {
  let candidate = pathname
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (
      /^\/api\/admin\/catalog\/policies(?:[/\\%]|$)/.test(candidate) ||
      /^\/api\/admin\/products\/[^/]*\/(?:publication-policy|identifier-exceptions)(?:[/\\%]|$)/.test(candidate)
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
  if (pathname === '/api/admin/catalog/policies') return { kind: 'policies' }
  let match = /^\/api\/admin\/catalog\/policies\/([^/]+)\/withdraw$/.exec(pathname)
  if (match) return { kind: 'policy_withdraw', resourceId: match[1]! }
  match = /^\/api\/admin\/products\/([^/]+)\/publication-policy$/.exec(pathname)
  if (match) return { kind: 'product_policy', productId: match[1]! }
  match = /^\/api\/admin\/products\/([^/]+)\/identifier-exceptions$/.exec(pathname)
  if (match) return { kind: 'exception_create', productId: match[1]! }
  match = /^\/api\/admin\/products\/([^/]+)\/identifier-exceptions\/([^/]+)\/withdraw$/.exec(pathname)
  return match ? { kind: 'exception_withdraw', productId: match[1]!, resourceId: match[2]! } : null
}
function methodsFor(route: Route) {
  return route.kind === 'policies' ? 'GET, POST' : route.kind === 'product_policy' ? 'GET, PUT' : 'POST'
}
function validTarget(route: Route) {
  return (
    (!('productId' in route) || parseAdminCatalogLegacyId(route.productId) !== null) &&
    (!('resourceId' in route) || catalogPolicyUuidSchema.safeParse(route.resourceId).success)
  )
}
function listQuery(parameters: URLSearchParams) {
  for (const key of parameters.keys())
    if (!['page', 'perPage', 'code'].includes(key) || parameters.getAll(key).length !== 1) return null
  const rawPage = parameters.get('page') ?? '1',
    rawSize = parameters.get('perPage') ?? '25'
  if (!/^[1-9]\d{0,6}$/.test(rawPage) || !/^[1-9]\d{0,1}$/.test(rawSize)) return null
  const page = Number(rawPage),
    perPage = Number(rawSize)
  if (page > 1_000_000 || perPage > 50 || String(page) !== rawPage || String(perPage) !== rawSize) return null
  const code = parameters.get('code')
  if (code !== null && !catalogPolicyCodeSchema.safeParse(code).success) return null
  return code === null ? { page, perPage } : { page, perPage, code }
}

class PolicyHttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}

/** A single bounded allocation; neither Content-Length nor character count is
 * authority. Fatal UTF-8 decoding prevents normalization of an invalid command. */
async function commandBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES))
    throw new PolicyHttpError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new PolicyHttpError('json_required', 415)
  if (!request.body) throw new PolicyHttpError('missing_body', 400)
  const reader = request.body.getReader(),
    bytes = new Uint8Array(MAX_BODY_BYTES)
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new PolicyHttpError('invalid_json', 400)
      if (next.value.byteLength > MAX_BODY_BYTES - length) {
        await reader.cancel().catch(() => undefined)
        throw new PolicyHttpError('body_too_large', 413)
      }
      bytes.set(next.value, length)
      length += next.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  if (!length) throw new PolicyHttpError('missing_body', 400)
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
    return value
  } catch {
    throw new PolicyHttpError('invalid_json', 400)
  }
}

function domainFailure(failure: CatalogPolicyError) {
  switch (failure.code) {
    case 'invalid_input':
      return error(failure.code, 400)
    case 'unauthenticated':
      return error(failure.code, 401)
    case 'email_unverified':
    case 'mfa_required':
    case 'forbidden':
      return error(failure.code, 403)
    case 'not_found':
      return error(failure.code, 404)
    case 'version_conflict':
    case 'idempotency_conflict':
    case 'invalid_state':
    case 'policy_in_use':
    case 'policy_unavailable':
    case 'conflict':
      return error(failure.code, 409)
    default:
      return error('service_unavailable', 503)
  }
}

/** Private publisher governance only. No catalog.write alias, no policy/AV/legal
 * approval inferred from HTTP, and no mutation/read execution clock accepted. */
export async function handleCatalogPolicyHttp(
  request: Request,
  env: CatalogPolicyHttpEnvironment
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCatalogPolicyNamespace(url.pathname)) return null
  const route = routeAt(url.pathname)
  const allow = route ? methodsFor(route) : null
  if (allow && !allow.split(', ').includes(request.method)) return error('method_not_allowed', 405, { Allow: allow })
  const write = request.method !== 'GET'
  try {
    const origin = new URL(env.AUTH_ORIGIN)
    if (origin.protocol !== 'https:' || origin.origin !== env.AUTH_ORIGIN || env.AUTH_ORIGIN.length > 2000)
      throw new Error('invalid_catalog_policy_origin')
    if (
      (write
        ? request.headers.get('origin') !== env.AUTH_ORIGIN
        : request.headers.has('origin') && request.headers.get('origin') !== env.AUTH_ORIGIN) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    if (!route || !validTarget(route)) return error('invalid_input', 400)
    const query = !write && route.kind === 'policies' ? listQuery(url.searchParams) : null
    if (
      (!write && route.kind === 'policies' && !query) ||
      ((write || route.kind !== 'policies') && url.searchParams.size)
    )
      return error('invalid_input', 400)
    if (env.AUTH_ENABLED !== 'true') return error('service_unavailable', 503)
    const claims = await verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
    if (!claims) return error('unauthenticated', 401)
    const authorization = await authorizeD1Session(env.DB, claims, 'catalog.publish', { requireMfa: true })
    if (!authorization.allowed) return error(authorization.code, authorization.code === 'unauthenticated' ? 401 : 403)
    if (!write)
      return json(
        route.kind === 'policies'
          ? await readD1CatalogPolicies(env.DB, claims, query!)
          : await readD1ProductPublicationPolicy(env.DB, claims, 'productId' in route ? route.productId : '')
      )
    const key = request.headers.get('idempotency-key')
    if (!key || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return error('invalid_idempotency_key', 400)
    let quota: Awaited<ReturnType<typeof consumeIdentityQuota>>
    try {
      quota = await consumeIdentityQuota(env.DB, {
        identityId: claims.identityId,
        scope: QUOTA_SCOPE,
        limit: 60,
        windowSeconds: 3600
      })
    } catch {
      return error('abuse_control_unavailable', 503)
    }
    const headers = { 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': String(quota.remaining) }
    if (!quota.allowed) return error('rate_limited', 429, { ...headers, 'Retry-After': String(quota.retryAfter) })
    const action: CatalogPolicyAction =
      route.kind === 'policies' ? 'policy_create' : route.kind === 'product_policy' ? 'policy_assign' : route.kind
    const target = {
      ...('productId' in route ? { productId: route.productId } : {}),
      ...('resourceId' in route ? { resourceId: route.resourceId } : {})
    }
    return json(
      await executeD1CatalogPolicyCommand(env.DB, claims, action, target, await commandBody(request), {
        idempotencyKey: key
      }),
      200,
      headers
    )
  } catch (failure) {
    if (failure instanceof PolicyHttpError) return error(failure.code, failure.status)
    if (failure instanceof CatalogPolicyError) return domainFailure(failure)
    return error('service_unavailable', 503)
  }
}
