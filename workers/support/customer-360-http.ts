import type { SessionCookieConfiguration } from '../auth/session-cookie'
import { verifySessionCookie } from '../auth/session-cookie'
import { supportJson } from './http'
import { catalogPolicyUuidSchema as uuid } from '../../shared/catalog-publication-policy'
import { Customer360Error, authorizeD1Customer360Actor, listD1Customer360, readD1Customer360 } from './customer-360'
export interface Customer360HttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration | null
  rateLimitPepper: string
  edgeGate: (request: Request) => Promise<'allowed' | 'limited' | 'unavailable'>
  now?: string
}
export function ownsCustomer360Namespace(path: string): boolean {
  let candidate = path
  for (let i = 0; i < 4; i++) {
    if (/^\/api\/admin\/customer-context(?:[/\\%]|$)/i.test(candidate)) return true
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
const codes: Record<string, number> = {
  invalid_input: 422,
  unauthenticated: 401,
  email_unverified: 403,
  mfa_required: 403,
  forbidden: 403,
  not_found: 404,
  history_unconfirmed: 503,
  service_unavailable: 503,
  export_too_large: 503
}
const failure = (code: string) => supportJson({ error: { code } }, codes[code] ?? 503)
export async function handleCustomer360Http(
  request: Request,
  deps: Customer360HttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCustomer360Namespace(url.pathname)) return null
  const base = url.pathname === '/api/admin/customer-context',
    detail = /^\/api\/admin\/customer-context\/([a-f0-9-]{36})$/.exec(url.pathname)
  if (!base && (!detail || !uuid.safeParse(detail[1]).success)) return failure('not_found')
  if (request.method !== 'GET') return supportJson({ error: { code: 'method_not_allowed' } }, 405, { Allow: 'GET' })
  try {
    if (
      new URL(deps.origin).origin !== deps.origin ||
      new URL(deps.origin).protocol !== 'https:' ||
      !deps.rateLimitPepper ||
      typeof deps.edgeGate !== 'function' ||
      !deps.sessionCookieConfiguration
    )
      return failure('service_unavailable')
    if (
      url.origin !== deps.origin ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin)
    )
      return failure('forbidden')
    const edge = await deps.edgeGate(request)
    if (edge === 'limited') return supportJson({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': '60' })
    if (edge !== 'allowed') return failure('service_unavailable')
    if (url.search.length > 2048) return failure('invalid_input')
    const query: Record<string, string> = Object.create(null)
    for (const [key, value] of url.searchParams) {
      if (Object.hasOwn(query, key)) return failure('invalid_input')
      query[key] = value
    }
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return failure('unauthenticated')
    const options = deps.now === undefined ? {} : { now: deps.now }
    await authorizeD1Customer360Actor(deps.database, claims, options)
    return supportJson(
      base
        ? await listD1Customer360(deps.database, claims, query, options)
        : await readD1Customer360(deps.database, claims, detail![1]!, query, options)
    )
  } catch (error) {
    return failure(
      error instanceof Customer360Error && Object.hasOwn(codes, error.code) ? error.code : 'service_unavailable'
    )
  }
}
