import { verifySessionCookie } from '../auth/session-cookie'
import {
  analyticsAssertEnabled,
  analyticsAssertCurrentConfiguration,
  analyticsAuthorizeAdmin,
  AnalyticsMeasurementError
} from './authority'
import { analyticsHttpJson, type AnalyticsHttpDependencies } from './http'
import { readCohortsAnalytics } from './cohorts'

export function ownsCohortsAnalyticsNamespace(pathname: string): boolean {
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/admin\/analytics\/cohorts(?:[/\\%]|$)/i.test(pathname)) return true
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
  if (['invalid_input', 'prohibited_data', 'invalid_timestamp'].includes(code)) return 400
  return 503
}

export async function handleCohortsAnalyticsHttp(
  request: Request,
  deps: AnalyticsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsCohortsAnalyticsNamespace(path)) return null

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

    if (request.method !== 'GET') {
      return failure('method_not_allowed', 405, { Allow: 'GET' })
    }

    if (!deps.sessionCookieConfiguration) return failure('service_unavailable')
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return failure('unauthenticated', 401)
    await analyticsAuthorizeAdmin(deps, claims)

    const policy = analyticsAssertEnabled(deps)
    analyticsAssertCurrentConfiguration(deps, policy, expectedOrigin)

    const from = url.searchParams.get('from') ?? undefined
    const to = url.searchParams.get('to') ?? undefined
    const segment = (url.searchParams.get('segment') ?? 'all') as 'all' | 'particular' | 'professional'
    const categoryId = url.searchParams.get('categoryId') ?? 'all'
    const churnDays = url.searchParams.has('churnDays') ? Number(url.searchParams.get('churnDays')) : 90

    const result = await readCohortsAnalytics(deps, claims, {
      from,
      to,
      segment,
      categoryId,
      churnDays
    })

    await analyticsAuthorizeAdmin(deps, claims)
    analyticsAssertCurrentConfiguration(deps, policy, expectedOrigin)

    return analyticsHttpJson(result)
  } catch (error) {
    if (error instanceof AnalyticsMeasurementError) return failure(error.code, errorStatus(error.code))
    return failure('service_unavailable')
  }
}
