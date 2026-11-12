import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { parseProductRecommendationsQuery } from '../../shared/product-recommendations'
import type { EffectivePricingOptions } from './pricing'
import { readProductRecommendations } from './product-recommendations'

export interface ProductRecommendationsHttpDependencies {
  database: D1Database
  origin: string
  edgeLimiter: RateLimit
  rateLimitPepper: string
  /** Precio del cliente con tarifa de empresa, resuelto por la sesión del catálogo. */
  pricing?: EffectivePricingOptions
  now?: Date
}

const PATH = '/api/product-recommendations'

/** Decodes up to four rounds so encoded spellings cannot bypass ownership. */
export function ownsProductRecommendationsNamespace(path: string): boolean {
  let candidate = path
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/product-recommendations(?:[/\\%]|$)/i.test(candidate)) return true
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
      // Depende del precio del cliente: nunca en una caché compartida.
      'Cache-Control': status === 200 ? 'private, max-age=120' : 'no-store',
      'CDN-Cache-Control': 'no-store',
      Vary: 'Cookie',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...extra
    }
  })
}
const error = (code: string, status: number, extra: Record<string, string> = {}) =>
  json({ error: { code } }, status, extra)

export async function handleProductRecommendationsHttp(
  request: Request,
  deps: ProductRecommendationsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsProductRecommendationsNamespace(url.pathname)) return null
  if (url.pathname !== PATH) return error('not_found', 404)
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
    const query = parseProductRecommendationsQuery(url.searchParams)
    if (!query) return error('invalid_input', 400)
    return json(await readProductRecommendations(deps.database, query, { now: deps.now, pricing: deps.pricing }))
  } catch {
    return error('service_unavailable', 503)
  }
}
