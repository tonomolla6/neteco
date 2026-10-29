import { verifySessionCookie } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { readPaymentFunnelDashboard, paymentFunnelDeviceSchema, paymentFunnelMethodSchema } from './funnel-analytics'

export interface PaymentFunnelHttpEnvironment {
  DB: D1Database
  AUTH_ENABLED?: string
  NUXT_SESSION_PASSWORD?: string
  AUTH_RATE_LIMIT_PEPPER?: string
  ADMIN_EDGE_LIMIT?: KVNamespace
}

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

export function ownsPaymentFunnelNamespace(pathname: string): boolean {
  let path = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    if (/^\/api\/admin\/(?:payments\/funnel|payment-funnel|analytics\/payment-funnel)(?:[/\\%]|$)/i.test(path)) {
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

export async function handlePaymentFunnelHttp(
  request: Request,
  env: PaymentFunnelHttpEnvironment
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsPaymentFunnelNamespace(url.pathname)) return null

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

    if (!env.NUXT_SESSION_PASSWORD) {
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

    if (env.ADMIN_EDGE_LIMIT && env.AUTH_RATE_LIMIT_PEPPER) {
      const edge = await checkAdministrativeEdgeLimit(
        request,
        env.ADMIN_EDGE_LIMIT,
        env.AUTH_RATE_LIMIT_PEPPER,
        'admin-payment-funnel'
      )
      if (edge !== 'allowed') {
        return error(edge === 'limited' ? 'rate_limited' : 'service_unavailable', edge === 'limited' ? 429 : 503)
      }
    }

    // Parse and validate date filters
    const now = new Date()
    const nowIso = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')

    let fromIso = url.searchParams.get('from')
    let toIso = url.searchParams.get('to')

    if (!fromIso) fromIso = thirtyDaysAgo
    if (!toIso) toIso = nowIso

    // Normalize date strings if passed as YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(fromIso)) {
      fromIso = `${fromIso}T00:00:00Z`
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(toIso)) {
      toIso = `${toIso}T23:59:59Z`
    }

    const fromDate = new Date(fromIso)
    const toDate = new Date(toIso)

    if (
      isNaN(fromDate.getTime()) ||
      isNaN(toDate.getTime()) ||
      fromDate > toDate ||
      toDate.getTime() - fromDate.getTime() > 366 * 86400000
    ) {
      return error('invalid_date_range', 400)
    }

    const deviceParam = url.searchParams.get('device') ?? 'all'
    if (deviceParam !== 'all' && !paymentFunnelDeviceSchema.safeParse(deviceParam).success) {
      return error('invalid_filter_device', 400)
    }

    const methodParam = url.searchParams.get('method') ?? 'all'
    if (methodParam !== 'all' && !paymentFunnelMethodSchema.safeParse(methodParam).success) {
      return error('invalid_filter_method', 400)
    }

    const bankParam = url.searchParams.get('bank') ?? 'all'
    if (bankParam.length > 80 || /[*[\]{}]/.test(bankParam)) {
      return error('invalid_filter_bank', 400)
    }

    const dashboard = await readPaymentFunnelDashboard(env.DB, {
      from: fromIso,
      to: toIso,
      device: deviceParam,
      method: methodParam,
      bank: bankParam
    })

    return json(dashboard, 200)
  } catch (err) {
    if (err instanceof Error && err.message.includes('prohibited_data')) {
      return error('prohibited_data_rejected', 400)
    }
    return error('internal_error', 500)
  }
}
