import { verifySessionCookie } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import type { AdminFulfillmentHttpEnvironment } from './admin-http'
import { computeCarrierScorecard } from './carrier-scorecard'

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

export function ownsCarrierScorecardNamespace(pathname: string): boolean {
  let path = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    if (/^\/api\/admin\/(?:carriers\/scorecard|carrier-scorecard)(?:[/\\%]|$)/i.test(path)) {
      return true
    }
    try {
      const decoded = decodeURIComponent(path)
      if (decoded === path) break
      path = decoded
    } catch {
      break
    }
  }
  return false
}

export async function handleCarrierScorecardHttp(
  request: Request,
  env: AdminFulfillmentHttpEnvironment
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCarrierScorecardNamespace(url.pathname)) return null

  try {
    if (request.method !== 'GET') {
      return error('method_not_allowed', 405, { Allow: 'GET' })
    }

    if (request.headers.get('sec-fetch-site') === 'cross-site') {
      return error('csrf_rejected', 403)
    }

    if (env.AUTH_ENABLED !== 'true') {
      return error('service_unavailable', 503)
    }

    const claims = await verifySessionCookie(request, {
      password: env.NUXT_SESSION_PASSWORD,
      maxAgeSeconds: 3600
    })

    if (!claims) {
      return error('unauthenticated', 401)
    }

    const auth = await authorizeD1Session(env.DB, claims, 'administration.manage', {
      requireMfa: true
    })

    if (!auth.allowed) {
      return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
    }

    // Parse date filters
    const now = new Date()
    const nowIso = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')

    const periodParam = url.searchParams.get('period')
    let fromIso = url.searchParams.get('from')
    let toIso = url.searchParams.get('to')

    if (periodParam) {
      const days = periodParam === '7d' ? 7 : periodParam === '90d' ? 90 : periodParam === 'year' ? 365 : 30
      fromIso = new Date(now.getTime() - days * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
      toIso = nowIso
    }

    if (!fromIso) fromIso = thirtyDaysAgo
    if (!toIso) toIso = nowIso

    // Normalize date strings if passed as YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(fromIso)) {
      fromIso = `${fromIso}T00:00:00Z`
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(toIso)) {
      toIso = `${toIso}T23:59:59Z`
    }

    const carrierParam = url.searchParams.get('carrier') ?? undefined

    const scorecard = await computeCarrierScorecard(env.DB, {
      from: fromIso,
      to: toIso,
      carrier: carrierParam,
      now: nowIso
    })

    const freshAuth = await authorizeD1Session(env.DB, claims, 'administration.manage', {
      requireMfa: true
    })

    if (!freshAuth.allowed) {
      return error(freshAuth.code, freshAuth.code === 'unauthenticated' ? 401 : 403)
    }

    return json(scorecard, 200)
  } catch {
    return error('service_unavailable', 503)
  }
}
