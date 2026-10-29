import { verifySessionCookie } from '../auth/session-cookie'
import {
  analyticsAssertEnabled,
  analyticsAssertCurrentConfiguration,
  analyticsAuthorizeAdmin,
  AnalyticsMeasurementError
} from './authority'
import { analyticsHttpJson, type AnalyticsHttpDependencies } from './http'
import {
  recordSearchEvent,
  readSearchAnalyticsDashboard,
  searchDeviceSchema,
  searchSegmentSchema,
  type SearchAnalyticsDashboardQuery,
  type SearchDevice,
  type SearchSegment
} from './search-analytics'
import { analyticsConsent } from '../../server/utils/analytics'

export function ownsSearchAnalyticsNamespace(pathname: string): boolean {
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/admin\/(?:analytics\/search|search-analytics)(?:[/\\%]|$)/i.test(pathname)) return true
    if (/^\/api\/analytics\/search(?:[/\\%]|$)/i.test(pathname)) return true
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

export async function handleSearchAnalyticsHttp(
  request: Request,
  deps: AnalyticsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  const isAdmin = /^\/api\/admin\/(?:analytics\/search|search-analytics)(?:[/\\%]|$)/i.test(path)
  const isSearchEvents = /^\/api\/analytics\/search(?:[/\\%]|$)/i.test(path)
  const isGenericEvents = path === '/api/analytics/events'

  if (!isAdmin && !isSearchEvents && !isGenericEvents) return null

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

    // Handle Admin Analytics Dashboard
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
      const rawSegment = url.searchParams.get('segment') ?? 'all'

      const device: 'all' | SearchDevice = rawDevice === 'all' ? 'all' : searchDeviceSchema.parse(rawDevice)
      const segment: 'all' | SearchSegment = rawSegment === 'all' ? 'all' : searchSegmentSchema.parse(rawSegment)
      const page = Number(url.searchParams.get('page') ?? '1')
      const perPage = Number(url.searchParams.get('perPage') ?? '20')

      const query: SearchAnalyticsDashboardQuery = {
        from,
        to,
        device,
        segment,
        page,
        perPage
      }

      const result = await readSearchAnalyticsDashboard(deps, claims, query)
      await analyticsAuthorizeAdmin(deps, claims)
      analyticsAssertCurrentConfiguration(deps, policy, expectedOrigin)

      return analyticsHttpJson(result)
    }

    // Handle Event Ingestion (search events)
    if (isSearchEvents || isGenericEvents) {
      if (request.method !== 'POST') {
        return failure('method_not_allowed', 405, { Allow: 'POST' })
      }

      const consentCookie = getCookie(request, 'neteco-consent-v1')
      if (!analyticsConsent(consentCookie)) return failure('consent_required', 403)

      let bodyJson: unknown
      try {
        bodyJson = await request.json()
      } catch {
        return failure('invalid_input', 400)
      }

      const anonymousCookie = getCookie(request, 'neteco-analytics-id')
      const userAgent = request.headers.get('user-agent') ?? undefined

      const result = await recordSearchEvent(deps, {
        event: bodyJson,
        consentCookie,
        anonymousCookie,
        userAgent
      })

      if (result.reason === 'consent_required') return failure('consent_required', 403)
      if (result.reason === 'disabled') return failure('service_unavailable')
      if (result.reason === 'bot_excluded' || result.reason === 'event_excluded') {
        return analyticsHttpJson({ accepted: false }, 202)
      }

      return analyticsHttpJson(
        { accepted: result.accepted },
        202,
        result.cookie === null ? {} : { 'Set-Cookie': cookieInstruction(result.cookie) }
      )
    }

    return failure('invalid_input', 400)
  } catch (error) {
    if (error instanceof AnalyticsMeasurementError) {
      const status =
        error.code === 'unauthenticated'
          ? 401
          : ['email_unverified', 'mfa_required', 'forbidden', 'consent_required'].includes(error.code)
            ? 403
            : error.code === 'idempotency_conflict'
              ? 409
              : ['invalid_input', 'invalid_timestamp'].includes(error.code)
                ? 400
                : 503
      return failure(error.code, status)
    }
    return failure('service_unavailable')
  }
}
