import { verifySessionCookie, type SessionCookieConfiguration } from './session-cookie'
import { checkAdministrativeEdgeLimit } from './edge-limit'
import { consumeIdentityQuota } from './identity-quota'
import { AccountLifecycleError } from './account-lifecycle-core'
import { AdminCompaniesError } from './admin-companies'
import { readD1PreferenceCenter, updateD1PreferenceCenter } from './preference-center'
import { listD1ReplenishmentPlans, saveD1ReplenishmentPlan } from './replenishment-reminders'
import {
  addD1CompanyDocument,
  listD1CompanyDocuments,
  listD1CompanyDocumentsForReview,
  removeD1CompanyDocument
} from './company-documents'
import {
  endD1Impersonation,
  getActiveD1Impersonation,
  listD1ImpersonationActions,
  recordD1ImpersonatedAction,
  startD1Impersonation
} from '../support/impersonation'

export interface AccountLifecycleHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  customerEdgeLimiter: RateLimit
  adminEdgeLimiter: RateLimit
  rateLimitPepper: string
  now?: () => string
}
const UUID = '[0-9a-fA-F-]{36}'
const ROUTES = {
  preferenceCenter: /^\/api\/account\/preference-center$/,
  replenishment: /^\/api\/account\/replenishment$/,
  replenishmentPlans: /^\/api\/account\/replenishment\/plans$/,
  companyDocuments: /^\/api\/account\/company\/documents$/,
  companyDocument: new RegExp(`^/api/account/company/documents/(${UUID})$`),
  reviewDocuments: new RegExp(`^/api/admin/companies/(${UUID})/documents$`),
  impersonation: /^\/api\/admin\/support-impersonation$/,
  impersonationCurrent: /^\/api\/admin\/support-impersonation\/current$/,
  impersonationEnd: new RegExp(`^/api/admin/support-impersonation/(${UUID})/end$`),
  impersonationActions: new RegExp(`^/api/admin/support-impersonation/(${UUID})/actions$`)
} as const
/** Claims the namespaces even when disabled; encoded aliases never bypass the authority. */
export function ownsAccountLifecycleNamespace(path: string): boolean {
  let candidate = path
  for (let i = 0; i < 4; i++) {
    if (
      /^\/api\/account\/(?:preference-center|replenishment|company\/documents)(?:[/\\%]|$)/i.test(candidate) ||
      /^\/api\/admin\/support-impersonation(?:[/\\%]|$)/i.test(candidate) ||
      /^\/api\/admin\/companies\/[^/]+\/documents(?:[/\\%]|$)/i.test(candidate)
    )
      return true
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
const STATUS: Record<string, number> = {
  invalid_input: 400,
  unauthenticated: 401,
  email_unverified: 403,
  mfa_required: 403,
  forbidden: 403,
  csrf_rejected: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  locked: 409,
  limit_reached: 409,
  consent_required: 422,
  insufficient_history: 422,
  rate_limited: 429,
  unavailable: 503
}
const headers = {
  'Cache-Control': 'private, no-store',
  Pragma: 'no-cache',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer'
}
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...headers, ...extra } })
const failure = (code: string, extra?: Record<string, string>) => json({ error: { code } }, STATUS[code] ?? 503, extra)
const UUID_V = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_BODY = 4096

async function readJson(request: Request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return undefined
  const declared = request.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) return undefined
  const reader = request.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > MAX_BODY) {
      await reader.cancel()
      return undefined
    }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    return undefined
  }
}
export async function handleAccountLifecycleHttp(
  request: Request,
  deps: AccountLifecycleHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname
  if (!ownsAccountLifecycleNamespace(path)) return null
  const match = (Object.keys(ROUTES) as (keyof typeof ROUTES)[])
    .map((name) => [name, ROUTES[name].exec(path)] as const)
    .find(([, m]) => m !== null)
  if (!match) return failure('not_found')
  const [route, m] = match,
    admin = route.startsWith('impersonation') || route === 'reviewDocuments'
  const allowed: Record<string, string[]> = {
    preferenceCenter: ['GET', 'PUT'],
    replenishment: ['GET'],
    replenishmentPlans: ['POST'],
    companyDocuments: ['GET', 'POST'],
    companyDocument: ['DELETE'],
    reviewDocuments: ['GET'],
    impersonation: ['POST'],
    impersonationCurrent: ['GET'],
    impersonationEnd: ['POST'],
    impersonationActions: ['GET', 'POST']
  }
  if (!allowed[route]!.includes(request.method))
    return failure('method_not_allowed', { Allow: allowed[route]!.join(', ') })
  try {
    const origin = new URL(deps.origin)
    if (origin.protocol !== 'https:' || origin.origin !== deps.origin || !deps.rateLimitPepper)
      return failure('unavailable')
    const mutating = request.method !== 'GET'
    if (
      url.origin !== deps.origin ||
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (mutating && request.headers.get('origin') !== deps.origin)
    )
      return failure('csrf_rejected')
    if (url.searchParams.size) return failure('invalid_input')
    const limited = await checkAdministrativeEdgeLimit(
      request,
      admin ? deps.adminEdgeLimiter : deps.customerEdgeLimiter,
      deps.rateLimitPepper,
      admin ? 'admin-support' : 'authentication'
    )
    if (limited !== 'allowed')
      return failure(
        limited === 'limited' ? 'rate_limited' : 'unavailable',
        limited === 'limited' ? { 'Retry-After': '60' } : undefined
      )
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return failure('unauthenticated')
    const options = { now: deps.now }
    let key: string | null = null,
      body: unknown
    const bodyRoutes = [
      'preferenceCenter',
      'replenishmentPlans',
      'companyDocuments',
      'impersonation',
      'impersonationActions'
    ]
    if (mutating && bodyRoutes.includes(route)) {
      key = request.headers.get('idempotency-key')
      if (!key || !UUID_V.test(key)) return failure('invalid_input')
      body = await readJson(request)
      if (body === undefined) return failure('invalid_input')
    }
    if (mutating && !admin) {
      const quota = await consumeIdentityQuota(deps.database, {
        identityId: claims.identityId,
        scope: 'account-lifecycle',
        limit: 60,
        windowSeconds: 3600,
        ...(deps.now ? { now: Math.floor(Date.parse(deps.now()) / 1000) } : {})
      })
      if (!quota.allowed) return failure('rate_limited', { 'Retry-After': String(quota.retryAfter) })
    }
    const db = deps.database
    switch (route) {
      case 'preferenceCenter':
        return json(
          request.method === 'GET'
            ? await readD1PreferenceCenter(db, claims, options)
            : await updateD1PreferenceCenter(db, claims, key!, body, options)
        )
      case 'replenishment':
        return json(await listD1ReplenishmentPlans(db, claims, options))
      case 'replenishmentPlans':
        return json(await saveD1ReplenishmentPlan(db, claims, key!, body, options))
      case 'companyDocuments':
        return request.method === 'GET'
          ? json(await listD1CompanyDocuments(db, claims, options))
          : json(await addD1CompanyDocument(db, claims, key!, body, options), 201)
      case 'companyDocument':
        return json(await removeD1CompanyDocument(db, claims, m![1]!, options))
      case 'reviewDocuments':
        return json(await listD1CompanyDocumentsForReview(db, claims, m![1]!, options))
      case 'impersonation':
        return json(await startD1Impersonation(db, claims, key!, body, options), 201)
      case 'impersonationCurrent':
        return json({ source: 'cloudflare', session: await getActiveD1Impersonation(db, claims, options) })
      case 'impersonationEnd':
        return json(await endD1Impersonation(db, claims, m![1]!, options))
      case 'impersonationActions': {
        if (request.method === 'GET') return json(await listD1ImpersonationActions(db, claims, m![1]!, options))
        const result = await recordD1ImpersonatedAction(db, claims, m![1]!, key!, body, options)
        return result.outcome === 'allowed'
          ? json(result, 201)
          : json({ error: { code: 'action_blocked' }, result }, 403)
      }
    }
  } catch (cause) {
    if (cause instanceof AccountLifecycleError || cause instanceof AdminCompaniesError) return failure(cause.code)
    return failure('unavailable')
  }
  return failure('not_found')
}
