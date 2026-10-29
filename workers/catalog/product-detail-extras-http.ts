import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { parseDetailExtrasQuery } from '../../shared/product-detail-extras'
import { ProductDetailExtrasError, readD1ProductDetailExtras } from './product-detail-extras'

export interface ProductDetailExtrasHttpDependencies {
  database: D1Database
  origin: string
  edgeLimiter: RateLimit
  rateLimitPepper: string
  now?: string
}
/** Decodes up to four rounds so encoded spellings cannot bypass ownership. */
export function ownsProductDetailExtrasNamespace(path: string): boolean {
  let candidate = path
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/product-detail-extras(?:[/\\%]|$)/i.test(candidate)) return true
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
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...extra
    }
  })
}
const error = (code: string, status: number, extra: Record<string, string> = {}) =>
  json({ error: { code } }, status, extra)

export async function handleProductDetailExtrasHttp(
  request: Request,
  deps: ProductDetailExtrasHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsProductDetailExtrasNamespace(url.pathname)) return null
  if (url.pathname !== '/api/product-detail-extras') return error('not_found', 404)
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return error('method_not_allowed', 405, { Allow: 'GET, HEAD' })
  try {
    const configured = new URL(deps.origin)
    if (configured.origin !== deps.origin || configured.protocol !== 'https:') return error('service_unavailable', 503)
    if (
      url.origin !== deps.origin ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin)
    )
      return error('csrf_rejected', 403)
    const edge = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, deps.rateLimitPepper, 'storefront-cart')
    if (edge === 'unavailable') return error('service_unavailable', 503)
    if (edge === 'limited') return error('rate_limited', 429, { 'Retry-After': '60' })
    const query = parseDetailExtrasQuery(url.searchParams)
    if (!query) return error('invalid_input', 400)
    return json(await readD1ProductDetailExtras(deps.database, query, deps.now ? { now: deps.now } : {}))
  } catch (failure) {
    if (failure instanceof ProductDetailExtrasError)
      return failure.code === 'not_found'
        ? error('not_found', 404)
        : failure.code === 'invalid_input'
          ? error('invalid_input', 400)
          : error('service_unavailable', 503)
    return error('service_unavailable', 503)
  }
}
