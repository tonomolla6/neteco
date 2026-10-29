import { verifySessionCookie } from '../auth/session-cookie'
import {
  analyticsAssertEnabled,
  analyticsAssertCurrentConfiguration,
  analyticsAuthorizeAdmin,
  AnalyticsMeasurementError
} from './authority'
import { analyticsHttpJson, type AnalyticsHttpDependencies } from './http'
import {
  readFunnelAnalyticsDashboard,
  recordFunnelEvent,
  funnelDeviceSchema,
  funnelSourceSchema,
  funnelSegmentSchema,
  type FunnelDevice,
  type FunnelSource,
  type FunnelSegment
} from './funnel'
import { analyticsConsent } from '../../server/utils/analytics'

export function ownsFunnelAnalyticsNamespace(pathname: string): boolean {
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/admin\/analytics\/funnel(?:[/\\%]|$)/i.test(pathname)) return true
    if (/^\/api\/analytics\/funnel(?:[/\\%]|$)/i.test(pathname)) return true
    try {
      const next = decodeURIComponent(pathname)
      if (next === pathname) break
      pathname = next
    } catch {
      break
    }
  }
  return false
}

function failure(code: string, status = 503, extra: Record<string, string> = {}) {
  return analyticsHttpJson({ error: { code } }, status, extra)
}

function errorStatus(code: string) {
  if (code === 'unauthenticated') return 401
  if (['email_unverified', 'mfa_required', 'forbidden', 'consent_required'].includes(code)) return 403
  if (['invalid_input', 'prohibited_data', 'invalid_timestamp', 'idempotency_conflict'].includes(code))
    return code === 'idempotency_conflict' ? 409 : 400
  return 503
}

function getCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return undefined
}

function cookieInstruction(instruction: { name: string; value: string; maxAgeSeconds: number }) {
  return `${instruction.name}=${encodeURIComponent(instruction.value)}; Path=/; Max-Age=${instruction.maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`
}

export async function handleFunnelAnalyticsHttp(
  request: Request,
  deps: AnalyticsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  const isAdmin = /^\/api\/admin\/analytics\/funnel(?:[/\\%]|$)/i.test(path)
  const isEvents = /^\/api\/analytics\/funnel(?:[/\\%]|$)/i.test(path)

  if (!isAdmin && !isEvents) return null

  if (deps.enabled !== true) return failure('service_unavailable')

  try {
    const expectedOrigin = deps.origin
    if (
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.method === 'GET'
        ? request.headers.has('origin') && request.headers.get('origin') !== expectedOrigin
        : request.headers.get('origin') !== expectedOrigin)
    ) {
      return failure('csrf_rejected', 403)
    }

    const policy = analyticsAssertEnabled(deps)
    analyticsAssertCurrentConfiguration(deps, policy, expectedOrigin)

    // Handle Admin Analytics Funnel Dashboard
    if (isAdmin) {
      if (request.method !== 'GET') {
        return failure('method_not_allowed', 405, { Allow: 'GET' })
      }

      if (!deps.sessionCookieConfiguration) return failure('service_unavailable')
      const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
      if (!claims) return failure('unauthenticated', 401)
      await analyticsAuthorizeAdmin(deps, claims)

      const from = url.searchParams.get('from') ?? new Date(Date.now() - 30 * 86400000).toISOString()
      const to = url.searchParams.get('to') ?? new Date().toISOString()
      const rawDevice = url.searchParams.get('device') ?? 'all'
      const rawSource = url.searchParams.get('source') ?? 'all'
      const rawSegment = url.searchParams.get('segment') ?? 'all'

      const device: 'all' | FunnelDevice = rawDevice === 'all' ? 'all' : funnelDeviceSchema.parse(rawDevice)
      const source: 'all' | FunnelSource = rawSource === 'all' ? 'all' : funnelSourceSchema.parse(rawSource)
      const segment: 'all' | FunnelSegment = rawSegment === 'all' ? 'all' : funnelSegmentSchema.parse(rawSegment)

      const result = await readFunnelAnalyticsDashboard(deps, claims, { from, to, device, source, segment })
      await analyticsAuthorizeAdmin(deps, claims)
      analyticsAssertCurrentConfiguration(deps, policy, expectedOrigin)
      return analyticsHttpJson(result)
    }

    // Handle Client Funnel Event Ingestion
    if (isEvents) {
      if (request.method !== 'POST') {
        return failure('method_not_allowed', 405, { Allow: 'POST' })
      }

      const consentCookie = getCookie(request, 'neteco-consent-v1')
      const anonymousCookie = getCookie(request, 'neteco-analytics-id')

      if (!analyticsConsent(consentCookie)) {
        return failure('consent_required', 403)
      }

      const body = (await request.json().catch(() => null)) as unknown
      if (!body) return failure('missing_body', 400)

      const result = await recordFunnelEvent(deps, {
        event: body,
        consentCookie,
        anonymousCookie,
        userAgent: request.headers.get('user-agent') ?? undefined,
        referrer: request.headers.get('referer') ?? undefined
      })

      if (result.reason === 'consent_required') return failure('consent_required', 403)
      if (result.reason === 'disabled') return failure('service_unavailable')

      return analyticsHttpJson(
        { accepted: result.accepted },
        202,
        result.cookie === null ? {} : { 'Set-Cookie': cookieInstruction(result.cookie) }
      )
    }

    return null
  } catch (error) {
    if (error instanceof AnalyticsMeasurementError) return failure(error.code, errorStatus(error.code))
    return failure('service_unavailable')
  }
}
