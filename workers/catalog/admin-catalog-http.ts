import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { AdminCatalogMutationError, updateD1DraftProductMetadata } from './admin-catalog-mutations'
import { AdminCatalogStatusError, updateD1ProductStatus, type CatalogPublicationGate } from './admin-catalog-status'
import { readD1CatalogPublicationReadiness } from './catalog-publication-readiness'
import { handleCatalogQualityHttp, ownsCatalogQualityNamespace } from './catalog-quality-http'
import {
  ADMIN_CATALOG_STATUSES,
  ADMIN_CATALOG_PERMISSION,
  listD1AdminCategories,
  listD1AdminProducts,
  parseAdminCatalogLegacyId,
  readD1AdminProduct,
  type AdminCatalogQuery,
  type AdminCatalogReadResult,
  type AdminCatalogStatus
} from './admin-catalog'

export interface AdminCatalogHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  /** Trusted configuration, never Host/forwarded headers or request input. */
  origin: string
  now?: string
  publicationGate?: CatalogPublicationGate
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(data, {
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
}
function error(code: string, status: number, extra: Record<string, string> = {}) {
  return json({ error: { code } }, status, extra)
}
function response<T>(result: AdminCatalogReadResult<T>) {
  if (result.outcome === 'found') return json(result.data)
  if (result.outcome === 'not_found') return error('not_found', 404)
  return error(result.code, result.code === 'unauthenticated' ? 401 : 403)
}

class CatalogHttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}

const MAX_METADATA_BODY_BYTES = 64 * 1024

/** The byte limit applies to streamed UTF-8, not the untrusted declared length
 * or decoded character count. Malformed UTF-8 must not normalize a command. */
async function metadataBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_METADATA_BODY_BYTES))
    throw new CatalogHttpError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new CatalogHttpError('json_required', 415)
  if (!request.body) throw new CatalogHttpError('missing_body', 400)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > MAX_METADATA_BODY_BYTES) {
        await reader.cancel()
        throw new CatalogHttpError('body_too_large', 413)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (!length) throw new CatalogHttpError('missing_body', 400)
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new CatalogHttpError('invalid_json', 400)
  }
}

function mutationStatus(failure: AdminCatalogMutationError): number {
  switch (failure.code) {
    case 'unauthenticated':
      return 401
    case 'forbidden':
    case 'mfa_required':
    case 'email_unverified':
      return 403
    case 'not_found':
      return 404
    case 'invalid_input':
      return 422
    default:
      return 409
  }
}

const PUBLICATION_ISSUE_CODES = new Set([
  'product.name',
  'product.short_description',
  'product.description',
  'category.status',
  'category.cycle',
  'category.mapping',
  'category.depth',
  'brand.status',
  'media.primary',
  'media.alt',
  'media.owner',
  'media.license',
  'media.authorization',
  'media.approval',
  'media.object_integrity',
  'media.object_unavailable',
  'variant.missing',
  'variant.limit',
  'variant.mapping',
  'variant.sku',
  'variant.sku_duplicate',
  'variant.ean',
  'variant.gtin',
  'variant.identifier',
  'variant.price',
  'variant.unit',
  'variant.quantity',
  'variant.maximum',
  'variant.logistics',
  'variant.currency',
  'variant.tax',
  'variant.quantity_integer',
  'variant.maximum_integer',
  'variant.lead_time',
  'variant.stock',
  'inventory.scope',
  'regulatory.shape',
  'regulatory.requires_sds',
  'regulatory.sds',
  'policy.missing',
  'policy.invalid',
  'policy.field',
  'policy.document',
  'policy.identifier_exception',
  'publication.snapshot'
])
const PUBLICATION_ISSUE_PATHS = new Set([
  'name',
  'shortDescription',
  'description',
  'category',
  'brand',
  'image',
  'imageAlt',
  'imageRightsOwner',
  'imageRightsLicense',
  'imageAuthorizedAt',
  'variants',
  'media',
  'documents',
  'documents.sds',
  'regulatory',
  'regulatory.requiresSds',
  'policy',
  'publication'
])

/** The gate is a trusted dependency, but its failures may originate in storage
 * or providers. Return only bounded, known editorial locations and local copy;
 * never forward an exception message, object key, fingerprint or SQL fragment. */
function publicationIssues(candidate: unknown) {
  const fallback = {
    code: 'publication.snapshot',
    path: 'publication',
    message: 'No se han podido validar todos los requisitos de publicación.'
  }
  if (!Array.isArray(candidate) || !candidate.length) return [fallback]
  return candidate.slice(0, 100).map((issue: unknown) => {
    if (issue === null || typeof issue !== 'object' || Array.isArray(issue)) return fallback
    const code: unknown = Object.getOwnPropertyDescriptor(issue, 'code')?.value
    const path: unknown = Object.getOwnPropertyDescriptor(issue, 'path')?.value
    if (
      typeof code !== 'string' ||
      !PUBLICATION_ISSUE_CODES.has(code) ||
      typeof path !== 'string' ||
      [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      (!PUBLICATION_ISSUE_PATHS.has(path) &&
        !/^variants\.(?:0|[1-9]\d{0,5})\.(?:id|sku|ean|gtin|identifierExceptionReason|price|unit|minimumQuantity|maximumQuantity|weightGrams|currency|tax|stock|leadTimeDays)$/.test(
          path
        ))
    )
      return fallback
    return { code, path, message: 'Revisa este requisito antes de publicar el producto.' }
  })
}

function statusFailure(failure: AdminCatalogStatusError) {
  if (failure.code === 'publication_blocked')
    return json({ error: { code: failure.code, issues: publicationIssues(failure.issues) } }, 409)
  switch (failure.code) {
    case 'unauthenticated':
      return error(failure.code, 401)
    case 'forbidden':
    case 'mfa_required':
    case 'email_unverified':
      return error(failure.code, 403)
    case 'not_found':
      return error(failure.code, 404)
    case 'invalid_input':
      return error(failure.code, 422)
    default:
      return error(failure.code, 409)
  }
}

/** Before parsing a transition we cannot know its exact persisted permission.
 * Permit either live editorial grant here; the motor enforces the transition's
 * permission and, on replay, the original command's permission again in SQL. */
async function authorizeStatusRequest(database: D1Database, claims: VerifiedSessionClaims) {
  const writer = await authorizeD1Session(database, claims, ADMIN_CATALOG_PERMISSION, { requireMfa: true })
  if (writer.allowed || writer.code !== 'forbidden') return writer
  return authorizeD1Session(database, claims, 'catalog.publish', { requireMfa: true })
}

/** Existing filters plus optional stable server pagination. The default 500
 * preserves the current editor's client-side pagination and {items} contract. */
export function parseAdminCatalogQuery(parameters: URLSearchParams): AdminCatalogQuery | null {
  const allowed = new Set(['q', 'category', 'active', 'status', 'page', 'perPage'])
  for (const key of parameters.keys()) if (!allowed.has(key) || parameters.getAll(key).length !== 1) return null
  const rawQ = parameters.get('q') ?? ''
  if (
    rawQ.length > 160 ||
    [...rawQ].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    return null
  const pageRaw = parameters.get('page') ?? '1'
  const sizeRaw = parameters.get('perPage') ?? '500'
  if (!/^[1-9]\d{0,6}$/.test(pageRaw) || !/^[1-9]\d{0,2}$/.test(sizeRaw)) return null
  const page = Number(pageRaw),
    perPage = Number(sizeRaw)
  if (page > 1_000_000 || perPage > 500) return null
  const query: AdminCatalogQuery = { q: rawQ.trim(), page, perPage }
  const category = parameters.get('category')
  if (category !== null) {
    const id = parseAdminCatalogLegacyId(category)
    if (id === null) return null
    query.category = id
  }
  const active = parameters.get('active')
  if (active !== null) {
    if (active !== '0' && active !== '1') return null
    query.active = active
  }
  const status = parameters.get('status')
  if (status !== null) {
    if (!(ADMIN_CATALOG_STATUSES as readonly string[]).includes(status)) return null
    query.status = status as AdminCatalogStatus
  }
  return query
}

/** Owns only the catalog namespaces, not /api/admin/media. Numeric-detail PUT
 * edits draft metadata; /status PUT delegates an audited transition. Native
 * administrative edge limiting is applied by the canary ingress before this
 * handler. Identity quotas and live SQL authority also govern accepted writes. */
export async function handleD1AdminCatalogRequest(
  request: Request,
  deps: AdminCatalogHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (ownsCatalogQualityNamespace(url.pathname)) return handleCatalogQualityHttp(request, deps)
  const products = url.pathname === '/api/admin/products'
  const categories = url.pathname === '/api/admin/categories'
  const catalogPath =
    products ||
    categories ||
    url.pathname.startsWith('/api/admin/products/') ||
    url.pathname.startsWith('/api/admin/categories/')
  if (!catalogPath) return null
  const detail = /^\/api\/admin\/products\/([^/]+)$/.exec(url.pathname)
  const readiness = /^\/api\/admin\/products\/([^/]+)\/publication-readiness$/.exec(url.pathname)
  const statusRoute = /^\/api\/admin\/products\/([^/]+)\/status$/.exec(url.pathname)
  const metadataWrite = request.method === 'PUT' && detail !== null
  const statusWrite = request.method === 'PUT' && statusRoute !== null
  const catalogWrite = metadataWrite || statusWrite
  if (statusRoute && !statusWrite) return error('method_not_allowed', 405, { Allow: 'PUT' })
  if (request.method !== 'GET' && !catalogWrite)
    return error('method_not_allowed', 405, {
      Allow: detail && parseAdminCatalogLegacyId(detail[1]!) !== null ? 'GET, PUT' : 'GET'
    })
  try {
    const origin = new URL(deps.origin)
    if (origin.protocol !== 'https:' || origin.origin !== deps.origin || deps.origin.length > 2000)
      throw new Error('invalid_admin_catalog_origin')
    // GET fetches/SSR commonly omit Origin. If present it must match exactly;
    // unlike SEO documents these private API reads reject cross-site metadata.
    if (
      (catalogWrite
        ? request.headers.get('origin') !== deps.origin
        : request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    if (metadataWrite && (url.searchParams.size || parseAdminCatalogLegacyId(detail![1]!) === null))
      return error('invalid_input', 400)
    if (statusWrite && (url.searchParams.size || parseAdminCatalogLegacyId(statusRoute![1]!) === null))
      return error('invalid_input', 400)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    if (statusWrite) {
      // Neither the read-test clock nor request fields reach the write motor.
      const authorization = await authorizeStatusRequest(deps.database, claims)
      if (!authorization.allowed) return error(authorization.code, authorization.code === 'unauthenticated' ? 401 : 403)
      const key = request.headers.get('idempotency-key')
      if (!key || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return error('invalid_idempotency_key', 400)
      let quota: Awaited<ReturnType<typeof consumeIdentityQuota>>
      try {
        quota = await consumeIdentityQuota(deps.database, {
          identityId: claims.identityId,
          scope: 'admin-catalog-status',
          limit: 60,
          windowSeconds: 3600
        })
      } catch {
        return error('abuse_control_unavailable', 503)
      }
      const quotaHeaders = { 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': String(quota.remaining) }
      if (!quota.allowed)
        return error('rate_limited', 429, { ...quotaHeaders, 'Retry-After': String(quota.retryAfter) })
      const receipt = await updateD1ProductStatus(
        deps.database,
        claims,
        statusRoute![1]!,
        await metadataBody(request),
        {
          idempotencyKey: key,
          publicationGate: deps.publicationGate
        }
      )
      return json(receipt, 200, quotaHeaders)
    }
    if (metadataWrite) {
      // Never forward the read-test instant to writes. The mutation SQL uses
      // execution-time D1 authority even after this early authorization check.
      const authorization = await authorizeD1Session(deps.database, claims, ADMIN_CATALOG_PERMISSION, {
        requireMfa: true
      })
      if (!authorization.allowed) return error(authorization.code, authorization.code === 'unauthenticated' ? 401 : 403)
      const key = request.headers.get('idempotency-key')
      if (!key || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return error('invalid_idempotency_key', 400)
      let quota: Awaited<ReturnType<typeof consumeIdentityQuota>>
      try {
        quota = await consumeIdentityQuota(deps.database, {
          identityId: claims.identityId,
          scope: 'admin-catalog-metadata',
          limit: 60,
          windowSeconds: 3600
        })
      } catch {
        return error('abuse_control_unavailable', 503)
      }
      const quotaHeaders = { 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': String(quota.remaining) }
      if (!quota.allowed)
        return error('rate_limited', 429, { ...quotaHeaders, 'Retry-After': String(quota.retryAfter) })
      const receipt = await updateD1DraftProductMetadata(
        deps.database,
        claims,
        detail![1]!,
        await metadataBody(request),
        {
          idempotencyKey: key
        }
      )
      return json(receipt, 200, quotaHeaders)
    }
    const now = deps.now ?? new Date().toISOString()
    if (products) {
      const query = parseAdminCatalogQuery(url.searchParams)
      if (!query) return error('invalid_input', 400)
      return response(await listD1AdminProducts(deps.database, claims, now, query))
    }
    if (url.searchParams.size) return error('invalid_input', 400)
    if (categories) return response(await listD1AdminCategories(deps.database, claims, now))
    if (readiness) {
      if (parseAdminCatalogLegacyId(readiness[1]!) === null) return error('invalid_input', 400)
      // Private advisory only; this is neither a transition nor a publication grant.
      return response(await readD1CatalogPublicationReadiness(deps.database, claims, now, readiness[1]!))
    }
    if (detail) {
      if (parseAdminCatalogLegacyId(detail[1]!) === null) return error('invalid_input', 400)
      return response(await readD1AdminProduct(deps.database, claims, now, detail[1]!))
    }
    return error('not_found', 404)
  } catch (failure) {
    if (failure instanceof CatalogHttpError) return error(failure.code, failure.status)
    if (failure instanceof AdminCatalogMutationError) return error(failure.code, mutationStatus(failure))
    if (failure instanceof AdminCatalogStatusError) return statusFailure(failure)
    // SQL text, attributes, cookie material and provider details never escape.
    return error('service_unavailable', 503)
  }
}
