import { verifySessionCookie } from '../auth/session-cookie'
import { authorizeD1Session } from './authorization'
import { readPersonalizedUpliftReport, recordRerankImpression, recordRerankInteraction } from './personalized-rerank'

export type PersonalizedRerankHttpEnvironment = Pick<
  CloudflareEnv,
  'DB' | 'AUTH_ENABLED' | 'AUTH_ORIGIN' | 'NUXT_SESSION_PASSWORD'
>

const BASE_PUBLIC = '/api/search/rerank/events'
const BASE_ADMIN_EXPERIMENTS = '/api/admin/search-personalization/experiments'
const BASE_ADMIN_UPLIFT = '/api/admin/search-personalization/uplift'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, {
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

const error = (code: string, status: number, headers: Record<string, string> = {}) =>
  json({ error: { code } }, status, headers)

export function ownsPersonalizedRerankNamespace(pathname: string): boolean {
  let candidate = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    if (candidate === BASE_PUBLIC || candidate.startsWith(BASE_PUBLIC + '/')) return true
    if (/^\/api\/admin\/search-personalization(?:[/\\%]|$)/.test(candidate)) return true
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

export async function handlePersonalizedRerankHttp(
  request: Request,
  env: PersonalizedRerankHttpEnvironment
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsPersonalizedRerankNamespace(url.pathname)) return null

  // 1. Storefront tracking endpoint: POST /api/search/rerank/events
  if (url.pathname === BASE_PUBLIC) {
    if (request.method !== 'POST') {
      return error('method_not_allowed', 405, { Allow: 'POST' })
    }
    try {
      const body = (await request.json()) as Record<string, unknown>
      if (body.type === 'impression') {
        await recordRerankImpression(env.DB, {
          eventId: String(body.eventId ?? ''),
          experimentId: String(body.experimentId ?? 'rerank_affinity_v1'),
          sessionHash: String(body.sessionHash ?? ''),
          variant: (body.variant as 'control' | 'personalized') ?? 'control',
          userSegment: (body.userSegment as 'anonymous' | 'customer' | 'professional') ?? 'anonymous',
          queryNormalized: String(body.queryNormalized ?? ''),
          hasExplicitSort: Boolean(body.hasExplicitSort),
          hasExplicitFilters: Boolean(body.hasExplicitFilters),
          productsShown: Array.isArray(body.productsShown) ? (body.productsShown as string[]) : []
        })
        return json({ success: true }, 201)
      } else if (body.type === 'interaction') {
        const res = await recordRerankInteraction(env.DB, {
          eventId: String(body.eventId ?? ''),
          clickedProductId: body.clickedProductId ? String(body.clickedProductId) : undefined,
          clickedRank: typeof body.clickedRank === 'number' ? body.clickedRank : undefined,
          converted: Boolean(body.converted),
          conversionCents: typeof body.conversionCents === 'number' ? body.conversionCents : 0
        })
        return json({ success: true, interactionId: res.interactionId }, 201)
      }
      return error('invalid_event_type', 400)
    } catch {
      return error('invalid_input', 400)
    }
  }

  // 2. Administrative endpoints: experiments & uplift reports
  try {
    const origin = new URL(env.AUTH_ORIGIN)
    if (origin.protocol !== 'https:' || origin.origin !== env.AUTH_ORIGIN) {
      throw new Error('invalid_auth_origin')
    }

    if (
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.method !== 'GET'
        ? request.headers.get('origin') !== env.AUTH_ORIGIN
        : request.headers.has('origin') && request.headers.get('origin') !== env.AUTH_ORIGIN)
    ) {
      return error('csrf_rejected', 403)
    }

    if (env.AUTH_ENABLED !== 'true') {
      return error('service_unavailable', 503)
    }

    const claims = await verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
    if (!claims) return error('unauthenticated', 401)

    const auth = await authorizeD1Session(env.DB, claims, 'catalog.write', { requireMfa: true })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)

    if (url.pathname === BASE_ADMIN_EXPERIMENTS) {
      if (request.method !== 'GET') {
        return error('method_not_allowed', 405, { Allow: 'GET' })
      }
      const rows = await env.DB.prepare(`SELECT * FROM search_rerank_experiments ORDER BY created_at DESC`).all()
      return json({ items: rows.results })
    }

    if (url.pathname === BASE_ADMIN_UPLIFT) {
      if (request.method !== 'GET') {
        return error('method_not_allowed', 405, { Allow: 'GET' })
      }
      const experimentId = url.searchParams.get('experimentId') ?? 'rerank_affinity_v1'
      const report = await readPersonalizedUpliftReport(env.DB, experimentId)
      return json(report)
    }

    return error('not_found', 404)
  } catch {
    return error('service_unavailable', 503)
  }
}
