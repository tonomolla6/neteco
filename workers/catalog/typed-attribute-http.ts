import { consumeIdentityQuota } from '../auth/identity-quota'
import { verifySessionCookie } from '../auth/session-cookie'
import { authorizeD1Session } from './authorization'
import { parseAdminCatalogLegacyId } from './admin-catalog'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import {
  catalogTypedAttributeDefinitionsViewSchema,
  catalogTypedAttributeDefinitionHttpUpdateSchema
} from '../../shared/catalog-typed-attribute-views'
import {
  CatalogTypedAttributeDefinitionError,
  executeD1CatalogTypedAttributeDefinitionCommand,
  readD1CatalogTypedAttributeDefinitions
} from './typed-attribute-definitions'
import { AdminCatalogMutationError } from './admin-catalog-mutations'
import { readD1CatalogTypedAttributeProduct, updateD1CatalogTypedAttributeValues } from './typed-attribute-values'

export type CatalogTypedAttributesHttpEnvironment = Pick<
  CloudflareEnv,
  'DB' | 'AUTH_ENABLED' | 'AUTH_ORIGIN' | 'NUXT_SESSION_PASSWORD'
>

const BASE = '/api/admin/catalog-attributes'
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
export function ownsCatalogTypedAttributesNamespace(pathname: string): boolean {
  let candidate = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    if (/^\/api\/admin\/catalog-attributes(?:[/\\%]|$)/.test(candidate)) return true
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
class TypedHttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
async function readBody(request: Request): Promise<unknown> {
  const maximum = 64 * 1024,
    declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum))
    throw new TypedHttpError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new TypedHttpError('json_required', 415)
  if (!request.body) throw new TypedHttpError('missing_body', 400)
  const reader = request.body.getReader(),
    bytes = new Uint8Array(maximum)
  let length = 0
  const deadline = Date.now() + 8000
  try {
    while (true) {
      if (Date.now() >= deadline) throw new TypedHttpError('body_timeout', 408)
      let timer: ReturnType<typeof setTimeout> | undefined
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new TypedHttpError('body_timeout', 408)), Math.max(1, deadline - Date.now()))
        })
      ]).finally(() => clearTimeout(timer))
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new TypedHttpError('invalid_json', 400)
      if (next.value.byteLength > maximum - length) {
        throw new TypedHttpError('body_too_large', 413)
      }
      bytes.set(next.value, length)
      length += next.value.byteLength
    }
  } catch (failure) {
    // A hostile underlying cancel hook may never settle. Cancellation must not
    // extend the bounded response deadline or keep the reader lock held.
    void reader.cancel().catch(() => undefined)
    if (failure instanceof TypedHttpError) throw failure
    throw new TypedHttpError('invalid_json', 400)
  } finally {
    reader.releaseLock()
  }
  if (!length) throw new TypedHttpError('missing_body', 400)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown
  } catch {
    throw new TypedHttpError('invalid_json', 400)
  }
}

/** Independent private namespace: never falls through to legacy metadata PUT.
 * Capability flags are computed from fresh grants, not role names or UI state. */
export async function handleCatalogTypedAttributesHttp(
  request: Request,
  env: CatalogTypedAttributesHttpEnvironment
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCatalogTypedAttributesNamespace(url.pathname)) return null
  const collection = url.pathname === BASE + '/definitions'
  const item = new RegExp('^' + BASE + '/definitions/([^/]+)$').exec(url.pathname)
  const product = new RegExp('^' + BASE + '/products/([^/]+)$').exec(url.pathname)
  if (item && !catalogPolicyUuidSchema.safeParse(item[1]).success) return error('invalid_input', 400)
  if (product) {
    const id = parseAdminCatalogLegacyId(product[1]!)
    if (id === null || String(id) !== product[1]) return error('invalid_input', 400)
  }
  const allowed = collection ? ['GET', 'POST'] : item ? ['PUT'] : product ? ['GET', 'PUT'] : []
  if (allowed.length && !allowed.includes(request.method))
    return error('method_not_allowed', 405, { Allow: allowed.join(', ') })
  try {
    if (!collection && !item && !product) return error('invalid_input', 400)
    let categoryId: number | null = null
    if (collection && request.method === 'GET') {
      const raw = url.searchParams.get('categoryId')
      categoryId = raw === null ? null : parseAdminCatalogLegacyId(raw)
      if (url.searchParams.size !== 1 || categoryId === null || String(categoryId) !== raw)
        return error('invalid_input', 400)
    } else if (url.searchParams.size) return error('invalid_input', 400)
    const origin = new URL(env.AUTH_ORIGIN)
    if (origin.protocol !== 'https:' || origin.origin !== env.AUTH_ORIGIN || env.AUTH_ORIGIN.length > 2000)
      throw new Error('invalid_typed_origin')
    if (
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.method !== 'GET' && request.headers.get('origin') !== env.AUTH_ORIGIN) ||
      (request.method === 'GET' && request.headers.has('origin') && request.headers.get('origin') !== env.AUTH_ORIGIN)
    )
      return error('csrf_rejected', 403)
    if (env.AUTH_ENABLED !== 'true') return error('service_unavailable', 503)
    const claims = await verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
    if (!claims) return error('unauthenticated', 401)
    const readAuth = await authorizeD1Session(env.DB, claims, 'catalog.write', { requireMfa: true })
    if (!readAuth.allowed) return error(readAuth.code, readAuth.code === 'unauthenticated' ? 401 : 403)
    if (product && request.method === 'GET')
      return json(await readD1CatalogTypedAttributeProduct(env.DB, claims, product[1]!))
    if (request.method === 'GET') {
      const category = await env.DB.prepare('SELECT id FROM categories WHERE legacy_id=?1')
        .bind(categoryId)
        .first<{ id: string }>()
      if (!category) return error('not_found', 404)
      const definitions = await readD1CatalogTypedAttributeDefinitions(env.DB, categoryId!, { includeRetired: true })
      const writeAuth = await authorizeD1Session(env.DB, claims, 'administration.manage', { requireMfa: true })
      if (!writeAuth.allowed && writeAuth.code !== 'forbidden')
        return error(writeAuth.code, writeAuth.code === 'unauthenticated' ? 401 : 403)
      const finalRead = await authorizeD1Session(env.DB, claims, 'catalog.write', { requireMfa: true })
      if (!finalRead.allowed) return error(finalRead.code, finalRead.code === 'unauthenticated' ? 401 : 403)
      return json(
        catalogTypedAttributeDefinitionsViewSchema.parse({
          source: 'cloudflare',
          categoryId,
          categoryUuid: category.id,
          definitions,
          capabilities: { read: true, create: writeAuth.allowed, update: writeAuth.allowed, retire: writeAuth.allowed }
        })
      )
    }
    if (!product) {
      const writeAuth = await authorizeD1Session(env.DB, claims, 'administration.manage', { requireMfa: true })
      if (!writeAuth.allowed) return error(writeAuth.code, writeAuth.code === 'unauthenticated' ? 401 : 403)
    }
    const key = request.headers.get('idempotency-key')
    if (!key || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return error('invalid_idempotency_key', 400)
    let quota: Awaited<ReturnType<typeof consumeIdentityQuota>>
    try {
      quota = await consumeIdentityQuota(env.DB, {
        identityId: claims.identityId,
        scope: 'admin-typed-attributes',
        limit: 60,
        windowSeconds: 3600
      })
    } catch {
      return error('abuse_control_unavailable', 503)
    }
    const headers = { 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': String(quota.remaining) }
    if (!quota.allowed) return error('rate_limited', 429, { ...headers, 'Retry-After': String(quota.retryAfter) })
    const input = await readBody(request)
    if (product)
      return json(
        await updateD1CatalogTypedAttributeValues(env.DB, claims, product[1]!, input, { idempotencyKey: key }),
        200,
        headers
      )
    if (collection)
      return json(
        await executeD1CatalogTypedAttributeDefinitionCommand(env.DB, claims, 'create', {}, input, {
          idempotencyKey: key
        }),
        201,
        headers
      )
    const parsed = catalogTypedAttributeDefinitionHttpUpdateSchema.safeParse(input)
    if (!parsed.success) return error('invalid_input', 422, headers)
    const { action, ...body } = parsed.data
    return json(
      await executeD1CatalogTypedAttributeDefinitionCommand(env.DB, claims, action, { definitionId: item![1]! }, body, {
        idempotencyKey: key
      }),
      200,
      headers
    )
  } catch (failure) {
    if (failure instanceof TypedHttpError) return error(failure.code, failure.status)
    if (failure instanceof AdminCatalogMutationError)
      return error(
        failure.code,
        failure.code === 'unauthenticated'
          ? 401
          : ['email_unverified', 'mfa_required', 'forbidden'].includes(failure.code)
            ? 403
            : failure.code === 'not_found'
              ? 404
              : ['invalid_input', 'invalid_typed_values'].includes(failure.code)
                ? 422
                : 409
      )
    if (failure instanceof CatalogTypedAttributeDefinitionError)
      return error(
        failure.code,
        failure.code === 'unauthenticated'
          ? 401
          : ['email_unverified', 'mfa_required', 'forbidden'].includes(failure.code)
            ? 403
            : failure.code === 'not_found'
              ? 404
              : failure.code === 'invalid_input'
                ? 422
                : 409
      )
    return error('service_unavailable', 503)
  }
}
