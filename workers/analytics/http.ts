import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  analyticsAssertEnabled,
  analyticsAssertCurrentConfiguration,
  analyticsAuthorizeAdmin,
  AnalyticsMeasurementError,
  type AnalyticsMeasurementDependencies
} from './authority'
import { collectClientAnalytics, withdrawAnalyticsSession } from './collector'
import { readAnalyticsSnapshot } from './read-model'
import { readAnalyticsReconciliation } from './reconciliation'
import {
  readSearchAnalyticsDashboard,
  recordSearchEvent,
  searchDeviceSchema,
  searchSegmentSchema,
  type SearchDevice,
  type SearchSegment
} from './search-analytics'
import { analyticsConsent } from '../../server/utils/analytics'

export interface AnalyticsHttpDependencies extends AnalyticsMeasurementDependencies {
  sessionCookieConfiguration: SessionCookieConfiguration | null
  /** Dedicated server-owned ingress control; a consent cookie is not identity. */
  edgeGate?: (
    request: Request,
    area: 'admin' | 'events' | 'withdrawal'
  ) => Promise<'allowed' | 'limited' | 'unavailable'>
}
export interface AnalyticsHttpRange {
  from: string
  to: string
  page: number
  perPage: number
}
function ownedArea(pathname: string): 'admin' | 'events' | null {
  let path = pathname
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/admin\/(?:analytics|search-analytics)(?:[/\\%]|$)/i.test(path)) return 'admin'
    if (/^\/api\/analytics(?:[/\\%]|$)/i.test(path)) return 'events'
    try {
      const next = decodeURIComponent(path)
      if (next === path) break
      path = next
    } catch {
      break
    }
  }
  return null
}
export function ownsAnalyticsNamespace(pathname: string) {
  return ownedArea(pathname) !== null
}
export function analyticsHttpJson(value: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      Vary: 'Cookie, Origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
      ...extra
    }
  })
}
function failure(code: string, status = 503, extra: Record<string, string> = {}) {
  return analyticsHttpJson({ error: { code } }, status, extra)
}
class HttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
function canonicalInstant(value: string) {
  const time = Date.parse(value)
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
    Number.isFinite(time) &&
    new Date(time).toISOString().replace('.000Z', 'Z') === value
  )
}
export function parseAnalyticsHttpRange(parameters: URLSearchParams): AnalyticsHttpRange {
  for (const key of parameters.keys())
    if (!['from', 'to', 'page', 'perPage'].includes(key) || parameters.getAll(key).length !== 1)
      throw new HttpError('invalid_input', 400)
  const from = parameters.get('from') ?? '',
    to = parameters.get('to') ?? '',
    page = parameters.get('page') ?? '1',
    perPage = parameters.get('perPage') ?? '20'
  if (
    !canonicalInstant(from) ||
    !canonicalInstant(to) ||
    from >= to ||
    Date.parse(to) - Date.parse(from) > 31 * 86400000 ||
    !/^[1-9][0-9]{0,6}$/.test(page) ||
    Number(page) > 1000000 ||
    !/^[1-9][0-9]?$/.test(perPage) ||
    Number(perPage) > 50
  )
    throw new HttpError('invalid_input', 400)
  return { from, to, page: Number(page), perPage: Number(perPage) }
}
function cookie(request: Request, name: string) {
  const header = request.headers.get('cookie')
  if (header === null) return undefined
  if (header.length > 8192) throw new HttpError('invalid_input', 400)
  let result: string | undefined
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at < 0 || part.slice(0, at).trim() !== name) continue
    if (result !== undefined) throw new HttpError('invalid_input', 400)
    result = part.slice(at + 1).trim()
  }
  return result
}
function cookieInstruction(instruction: { name: string; value: string; maxAgeSeconds: number }) {
  if (
    instruction.name !== 'neteco-analytics-id' ||
    (instruction.value !== '' && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(instruction.value)) ||
    !Number.isSafeInteger(instruction.maxAgeSeconds) ||
    instruction.maxAgeSeconds < 0 ||
    instruction.maxAgeSeconds > 180 * 86400
  )
    throw new Error('analytics_cookie_unconfirmed')
  return `${instruction.name}=${encodeURIComponent(instruction.value)}; Path=/; Max-Age=${instruction.maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`
}
async function body(request: Request) {
  const maximum = 8192,
    declared = request.headers.get('content-length')
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > maximum))
    throw new HttpError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new HttpError('json_required', 415)
  if (!request.body) throw new HttpError('missing_body', 400)
  const reader = request.body.getReader(),
    bytes = new Uint8Array(maximum)
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new HttpError('invalid_json', 400)
      if (next.value.length > maximum - size) {
        await reader.cancel().catch(() => undefined)
        throw new HttpError('body_too_large', 413)
      }
      bytes.set(next.value, size)
      size += next.value.length
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))) as unknown
  } catch {
    throw new HttpError('invalid_json', 400)
  }
}
function errorStatus(code: string) {
  if (code === 'unauthenticated') return 401
  if (['email_unverified', 'mfa_required', 'forbidden', 'consent_required'].includes(code)) return 403
  if (['invalid_input', 'prohibited_data', 'invalid_timestamp', 'idempotency_conflict'].includes(code))
    return code === 'idempotency_conflict' ? 409 : 400
  return 503
}

/** Claimed namespaces never fall through to Node. OFF reads/acquisition do not
 * inspect cookies, read request bodies or execute SQL. Withdrawal stays pure. */
export async function handleAnalyticsHttp(request: Request, deps: AnalyticsHttpDependencies): Promise<Response | null> {
  const url = new URL(request.url),
    area = ownedArea(url.pathname)
  if (area === null) return null
  const withdrawal = url.pathname === '/api/analytics/session' && request.method === 'DELETE'
  if (url.pathname === '/api/analytics/session' && !withdrawal)
    return failure('method_not_allowed', 405, { Allow: 'DELETE' })
  if (!withdrawal && deps.enabled !== true) return failure('service_unavailable')
  try {
    const expectedOrigin = deps.origin,
      origin = new URL(expectedOrigin)
    if (origin.protocol !== 'https:' || origin.origin !== expectedOrigin || expectedOrigin.length > 2000)
      throw new Error('analytics_origin_invalid')
    if (
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.method === 'GET'
        ? request.headers.has('origin') && request.headers.get('origin') !== expectedOrigin
        : request.headers.get('origin') !== expectedOrigin)
    )
      return failure('csrf_rejected', 403)
    // Refusing acquisition or losing its ingress binding must never prevent
    // the visitor from clearing their anonymous measurement identifier.
    if (withdrawal) {
      if (url.searchParams.size) return failure('invalid_input', 400)
      return new Response(null, {
        status: 204,
        headers: {
          'Cache-Control': 'private, no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'Set-Cookie': cookieInstruction(withdrawAnalyticsSession())
        }
      })
    }
    const edge = await deps.edgeGate?.(request, area)
    if (edge === 'limited') return failure('rate_limited', 429, { 'Retry-After': '60' })
    if (edge !== 'allowed') return failure('abuse_control_unavailable')
    const expectedMethod =
      url.pathname === '/api/analytics/events'
        ? 'POST'
        : url.pathname === '/api/analytics/session'
          ? 'DELETE'
          : [
                '/api/admin/analytics',
                '/api/admin/analytics/reconciliation',
                '/api/admin/analytics/search',
                '/api/admin/search-analytics'
              ].includes(url.pathname)
            ? 'GET'
            : null
    if (expectedMethod === null) return failure('invalid_input', 400)
    if (request.method !== expectedMethod) return failure('method_not_allowed', 405, { Allow: expectedMethod })
    const policy = analyticsAssertEnabled(deps)
    analyticsAssertCurrentConfiguration(deps, policy, expectedOrigin)
    if (area === 'events') {
      if (url.searchParams.size) return failure('invalid_input', 400)
      const consentCookie = cookie(request, 'neteco-consent-v1'),
        anonymousCookie = cookie(request, 'neteco-analytics-id')
      if (!analyticsConsent(consentCookie)) return failure('consent_required', 403)
      const eventPayload = await body(request)
      const isSearchEvent =
        typeof eventPayload === 'object' &&
        eventPayload !== null &&
        'name' in eventPayload &&
        typeof (eventPayload as { name: unknown }).name === 'string' &&
        ['search_performed', 'search_result_clicked', 'add_to_cart'].includes((eventPayload as { name: string }).name)

      if (isSearchEvent) {
        const result = await recordSearchEvent(deps, {
          event: eventPayload,
          consentCookie,
          anonymousCookie,
          userAgent: request.headers.get('user-agent') ?? undefined
        })
        if (result.reason === 'consent_required') return failure('consent_required', 403)
        if (result.reason === 'disabled') return failure('service_unavailable')
        analyticsAssertCurrentConfiguration(deps, policy, expectedOrigin)
        return analyticsHttpJson(
          { accepted: result.accepted },
          202,
          result.cookie === null ? {} : { 'Set-Cookie': cookieInstruction(result.cookie) }
        )
      }

      const result = await collectClientAnalytics(deps, {
        event: eventPayload,
        consentCookie,
        anonymousCookie,
        userAgent: request.headers.get('user-agent') ?? undefined
      })
      if (result.reason === 'consent_required') return failure('consent_required', 403)
      if (result.reason === 'disabled') return failure('service_unavailable')
      analyticsAssertCurrentConfiguration(deps, policy, expectedOrigin)
      return analyticsHttpJson(
        { accepted: result.accepted },
        202,
        result.cookie === null ? {} : { 'Set-Cookie': cookieInstruction(result.cookie) }
      )
    }
    if (!deps.sessionCookieConfiguration) return failure('service_unavailable')
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return failure('unauthenticated', 401)
    await analyticsAuthorizeAdmin(deps, claims)

    if (['/api/admin/analytics/search', '/api/admin/search-analytics'].includes(url.pathname)) {
      const from = url.searchParams.get('from') ?? new Date(Date.now() - 30 * 86400000).toISOString()
      const to = url.searchParams.get('to') ?? new Date().toISOString()
      const rawDevice = url.searchParams.get('device') ?? 'all'
      const rawSegment = url.searchParams.get('segment') ?? 'all'
      const device: 'all' | SearchDevice = rawDevice === 'all' ? 'all' : searchDeviceSchema.parse(rawDevice)
      const segment: 'all' | SearchSegment = rawSegment === 'all' ? 'all' : searchSegmentSchema.parse(rawSegment)
      const page = Number(url.searchParams.get('page') ?? '1')
      const perPage = Number(url.searchParams.get('perPage') ?? '20')

      const result = await readSearchAnalyticsDashboard(deps, claims, { from, to, device, segment, page, perPage })
      await analyticsAuthorizeAdmin(deps, claims)
      analyticsAssertCurrentConfiguration(deps, policy, expectedOrigin)
      return analyticsHttpJson(result)
    }

    const range = parseAnalyticsHttpRange(url.searchParams)
    const result =
      url.pathname === '/api/admin/analytics/reconciliation'
        ? await readAnalyticsReconciliation(deps, claims, range)
        : await readAnalyticsSnapshot(deps, claims, range)
    await analyticsAuthorizeAdmin(deps, claims)
    analyticsAssertCurrentConfiguration(deps, policy, expectedOrigin)
    return analyticsHttpJson(result)
  } catch (error) {
    if (error instanceof HttpError) return failure(error.code, error.status)
    if (error instanceof AnalyticsMeasurementError) return failure(error.code, errorStatus(error.code))
    return failure('service_unavailable')
  }
}
