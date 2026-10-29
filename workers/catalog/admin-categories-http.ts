import { consumeIdentityQuota } from '../auth/identity-quota'
import { categoryHasControls } from '../../shared/catalog-category-commands'
import { verifySessionCookie } from '../auth/session-cookie'
import { authorizeD1Session } from './authorization'
import { parseAdminCatalogLegacyId } from './admin-catalog'
import { CatalogCategoryError, CATEGORY_WRITE_PERMISSION, executeD1CatalogCategoryCommand } from './admin-categories'

export type CatalogCategoryHttpEnvironment = Pick<
  CloudflareEnv,
  'DB' | 'AUTH_ENABLED' | 'AUTH_ORIGIN' | 'NUXT_SESSION_PASSWORD'
>
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
export function ownsCatalogCategoryNamespace(pathname: string) {
  let candidate = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    if (/^\/api\/admin\/categories(?:[/\\%]|$)/.test(candidate)) return true
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
class CategoryHttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
async function body(request: Request): Promise<unknown> {
  const limit = 64 * 1024,
    declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new CategoryHttpError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new CategoryHttpError('json_required', 415)
  if (!request.body) throw new CategoryHttpError('missing_body', 400)
  const reader = request.body.getReader(),
    bytes = new Uint8Array(limit)
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new CategoryHttpError('invalid_json', 400)
      if (next.value.byteLength > limit - length) {
        await reader.cancel().catch(() => undefined)
        throw new CategoryHttpError('body_too_large', 413)
      }
      bytes.set(next.value, length)
      length += next.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  if (!length) throw new CategoryHttpError('missing_body', 400)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown
  } catch {
    throw new CategoryHttpError('invalid_json', 400)
  }
}
/** GET remains the existing catalog.write reader. No writable grant is inferred
 * from a cached role, capabilities or permission to read the private tree. */
export async function handleCatalogCategoryHttp(
  request: Request,
  env: CatalogCategoryHttpEnvironment
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCatalogCategoryNamespace(url.pathname)) return null
  if (url.pathname === '/api/admin/categories' && request.method === 'GET') return null
  const collection = url.pathname === '/api/admin/categories',
    match = /^\/api\/admin\/categories\/([^/]+)$/.exec(url.pathname)
  const allowed = collection ? ['GET', 'POST'] : match ? ['PUT', 'DELETE'] : []
  if (allowed.length && !allowed.includes(request.method))
    return error('method_not_allowed', 405, { Allow: allowed.join(', ') })
  try {
    const origin = new URL(env.AUTH_ORIGIN)
    if (origin.protocol !== 'https:' || origin.origin !== env.AUTH_ORIGIN || env.AUTH_ORIGIN.length > 2000)
      throw new Error('invalid_category_origin')
    if (request.headers.get('origin') !== env.AUTH_ORIGIN || request.headers.get('sec-fetch-site') === 'cross-site')
      return error('csrf_rejected', 403)
    if ((!collection && !match) || url.searchParams.size || (match && parseAdminCatalogLegacyId(match[1]!) === null))
      return error('invalid_input', 400)
    if (env.AUTH_ENABLED !== 'true') return error('service_unavailable', 503)
    const claims = await verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
    if (!claims) return error('unauthenticated', 401)
    const auth = await authorizeD1Session(env.DB, claims, CATEGORY_WRITE_PERMISSION, { requireMfa: true })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
    const key = request.headers.get('idempotency-key')
    if (!key || key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key) || categoryHasControls(key))
      return error('invalid_idempotency_key', 400)
    let quota: Awaited<ReturnType<typeof consumeIdentityQuota>>
    try {
      quota = await consumeIdentityQuota(env.DB, {
        identityId: claims.identityId,
        scope: 'admin-categories',
        limit: 60,
        windowSeconds: 3600
      })
    } catch {
      return error('abuse_control_unavailable', 503)
    }
    const headers = { 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': String(quota.remaining) }
    if (!quota.allowed) return error('rate_limited', 429, { ...headers, 'Retry-After': String(quota.retryAfter) })
    const action = collection ? 'create_category' : request.method === 'DELETE' ? 'delete_category' : 'update_category'
    return json(
      await executeD1CatalogCategoryCommand(
        env.DB,
        claims,
        action,
        collection ? {} : { categoryId: match![1]! },
        await body(request),
        { idempotencyKey: key }
      ),
      collection ? 201 : 200,
      headers
    )
  } catch (failure) {
    if (failure instanceof CategoryHttpError) return error(failure.code, failure.status)
    if (failure instanceof CatalogCategoryError)
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
