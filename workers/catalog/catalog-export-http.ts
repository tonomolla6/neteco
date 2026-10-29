import { catalogExportFiltersSchema } from '../../shared/catalog-export'
import { verifySessionCookie } from '../auth/session-cookie'
import { CatalogExportError, readCatalogSnapshot } from './catalog-export'

type Environment = Pick<CloudflareEnv, 'DB' | 'AUTH_ENABLED' | 'AUTH_ORIGIN' | 'NUXT_SESSION_PASSWORD'>
const prefix = '/api/admin/catalog/export'
const headers = {
  'Cache-Control': 'private, no-store',
  Pragma: 'no-cache',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer'
}
const error = (code: string, status: number, extra: Record<string, string> = {}) =>
  Response.json({ error: { code } }, { status, headers: { ...headers, ...extra } })
export function ownsCatalogExportNamespace(path: string) {
  for (let index = 0; index < 4; index++) {
    if (path.toLowerCase().startsWith(prefix)) return true
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
/** Only snapshot filters. No pagination, clock pin, client IDs or format that
 * changes the server snapshot; every download asks for a new authorized read. */
export async function handleCatalogExportHttp(request: Request, env: Environment): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCatalogExportNamespace(url.pathname)) return null
  if (url.pathname !== prefix + '/snapshot') return error('invalid_input', 400)
  if (request.method !== 'GET') return error('method_not_allowed', 405, { Allow: 'GET' })
  try {
    const origin = new URL(env.AUTH_ORIGIN)
    if (origin.protocol !== 'https:' || origin.origin !== env.AUTH_ORIGIN) throw Error('invalid_export_origin')
    if (
      (request.headers.has('origin') && request.headers.get('origin') !== env.AUTH_ORIGIN) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    const filters: Record<string, unknown> = {}
    for (const [key, value] of url.searchParams) {
      if (!['q', 'category', 'status'].includes(key) || Object.hasOwn(filters, key)) return error('invalid_input', 400)
      if (key === 'category' && !/^[1-9]\d{0,15}$/.test(value)) return error('invalid_input', 400)
      filters[key] = key === 'category' ? Number(value) : value
    }
    const parsed = catalogExportFiltersSchema.safeParse(filters)
    if (!parsed.success) return error('invalid_input', 400)
    if (env.AUTH_ENABLED !== 'true') return error('service_unavailable', 503)
    const claims = await verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
    if (!claims) return error('unauthenticated', 401)
    return Response.json(await readCatalogSnapshot(env.DB, claims, parsed.data), { headers })
  } catch (failure) {
    if (failure instanceof CatalogExportError)
      return error(
        failure.code,
        failure.code === 'unauthenticated'
          ? 401
          : ['email_unverified', 'mfa_required', 'forbidden'].includes(failure.code)
            ? 403
            : failure.code === 'too_large'
              ? 413
              : 422
      )
    return error('service_unavailable', 503)
  }
}
