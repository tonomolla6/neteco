import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { activeOrderCustomerId } from '../catalog/customer-orders'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { SupportError } from './operations'
import {
  ownsSupportNamespace,
  supportBody,
  supportBoundary,
  supportHttpError,
  supportJson,
  type SupportHttpDependencies
} from './http'
import { InsightError, requireSupportAdmin } from './insight-commands'
import {
  askFaqAssistant,
  commandFaqHandoff,
  listFaqHandoffs,
  readFaqAssistantStats,
  recordFaqFeedback,
  requestFaqHandoff
} from './faq-assistant'
import {
  classifyTicketRootCause,
  createContactBacklogItem,
  listContactBacklog,
  readContactAnalysis,
  transitionContactBacklogItem
} from './contact-analysis'
import {
  commandEducationCandidate,
  detectEducationCandidates,
  listEducationCandidates,
  measureEducationDeflection
} from './education'
import {
  addB2bDocument,
  cancelB2bRequest,
  commandAdminB2bRequest,
  createB2bRequest,
  listAdminB2bRequests,
  listB2bRequests,
  readAdminB2bRequest,
  readB2bRequest,
  replyB2bRequest
} from './b2b-requests'

export interface SupportInsightsHttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration | null
  /** Published-knowledge switch (the same one that gates the help centre). */
  enabled?: boolean
  now?: () => string
  edgeGate?: SupportHttpDependencies['edgeGate']
}

const STATUS: Record<string, number> = {
  invalid_input: 422,
  window_too_large: 422,
  unauthenticated: 401,
  forbidden: 403,
  mfa_required: 403,
  email_unverified: 403,
  company_not_approved: 403,
  csrf_rejected: 403,
  not_found: 404,
  concurrency_conflict: 409,
  idempotency_conflict: 409,
  invalid_transition: 409,
  duplicate_backlog: 409,
  duplicate_document: 409,
  limit_exceeded: 409,
  conflict: 409,
  target_unavailable: 409,
  body_too_large: 413
}
const fail = (code: string, status = STATUS[code] ?? 503, extra: Record<string, string> = {}) =>
  supportJson({ error: { code } }, status, extra)
const nowOf = (deps: SupportInsightsHttpDependencies) =>
  deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

function ownsAny(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => ownsSupportNamespace(pathname, prefix))
}
export const ownsSupportAssistantNamespace = (path: string) => ownsSupportNamespace(path, '/api/support/assistant')
export const ownsSupportInsightsAdminNamespace = (path: string) =>
  ownsAny(path, [
    '/api/admin/support/assistant',
    '/api/admin/support/contact-analysis',
    '/api/admin/support/education',
    '/api/admin/support/b2b-requests'
  ])
export const ownsB2bRequestsNamespace = (path: string) => ownsSupportNamespace(path, '/api/account/b2b-requests')

async function boundary(
  request: Request,
  deps: SupportInsightsHttpDependencies,
  area: 'contact' | 'admin' | 'customer'
) {
  return supportBoundary(
    request,
    {
      database: deps.database,
      origin: deps.origin,
      sessionCookieConfiguration: deps.sessionCookieConfiguration,
      edgeGate: deps.edgeGate
    },
    area
  )
}
/** Strict query: only allowed keys, each once; `int` keys must be plain decimal integers. */
function query(url: URL, allowed: Record<string, 'string' | 'int'>): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null)
  for (const [key, value] of url.searchParams) {
    const kind = allowed[key]
    if (!kind || Object.hasOwn(out, key)) throw new InsightError('invalid_input')
    if (kind === 'int') {
      if (!/^\d{1,9}$/.test(value)) throw new InsightError('invalid_input')
      out[key] = Number(value)
    } else out[key] = value
  }
  return out
}
function mapError(error: unknown): Response {
  if (error instanceof InsightError) {
    const unavailable = ['knowledge_unavailable', 'service_unavailable'].includes(error.code)
    return fail(error.code, unavailable ? 503 : undefined)
  }
  if (error instanceof SupportError) return supportHttpError(error.code)
  return fail('service_unavailable', 503)
}
function methodNotAllowed(allow: string[]) {
  return supportJson({ error: { code: 'method_not_allowed' } }, 405, { Allow: allow.join(', ') })
}
const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
const key = (request: Request) => request.headers.get('idempotency-key') ?? ''

async function optionalCustomer(
  request: Request,
  deps: SupportInsightsHttpDependencies,
  now: string
): Promise<string | null> {
  if (!deps.sessionCookieConfiguration || !request.headers.has('cookie')) return null
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration).catch(() => null)
  return claims ? activeOrderCustomerId(deps.database, claims, now).catch(() => null) : null
}

// ------------------------------------------------------------------ SUP-012 public
export async function handleSupportAssistantHttp(
  request: Request,
  deps: SupportInsightsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsSupportAssistantNamespace(url.pathname)) return null
  const route = /^\/api\/support\/assistant\/(ask|handoff|feedback)$/.exec(url.pathname)?.[1]
  if (!route) return fail('not_found')
  if (request.method !== 'POST') return methodNotAllowed(['POST'])
  try {
    if (url.search) return fail('invalid_input')
    const blocked = await boundary(request, deps, 'contact')
    if (blocked) return blocked
    const now = nowOf(deps)
    const body = await supportBody(request)
    const service = { database: deps.database, enabled: deps.enabled === true, now: () => now }
    const customerId = await optionalCustomer(request, deps, now)
    if (route === 'ask') return supportJson(await askFaqAssistant(service, body, key(request), customerId))
    if (!service.enabled) return fail('knowledge_unavailable', 503)
    if (route === 'handoff') return supportJson(await requestFaqHandoff(service, body, customerId), 201)
    return supportJson(await recordFaqFeedback(service, body))
  } catch (error) {
    return mapError(error)
  }
}

// ------------------------------------------------------------------ administrative
type AdminOperation = (claims: VerifiedSessionClaims, now: string) => Promise<{ status: number; body: unknown }>
export async function handleSupportInsightsAdminHttp(
  request: Request,
  deps: SupportInsightsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsSupportInsightsAdminNamespace(url.pathname)) return null
  const path = url.pathname
  const db = deps.database
  const k = key(request)
  const body = () => supportBody(request)
  let methods: string[] = []
  let operation: AdminOperation | null = null
  let m: RegExpExecArray | null
  const read = (list: string[], run: AdminOperation) => ((methods = list), (operation = run))

  if (path === '/api/admin/support/assistant/handoffs')
    read(['GET'], async (c, now) => ({
      status: 200,
      body: await listFaqHandoffs(db, c, query(url, { status: 'string', limit: 'int' }), now)
    }))
  else if (path === '/api/admin/support/assistant/stats')
    read(['GET'], async (c, now) => ({
      status: 200,
      body: await readFaqAssistantStats(
        db,
        c,
        query(url, { from: 'string', to: 'string' }) as { from: string; to: string },
        now
      )
    }))
  else if ((m = new RegExp(`^/api/admin/support/assistant/handoffs/${UUID}/commands$`).exec(path)))
    read(['POST'], async (c, now) => ({
      status: 200,
      body: await commandFaqHandoff(db, c, m![1]!, await body(), k, now)
    }))
  else if (path === '/api/admin/support/contact-analysis')
    read(['GET'], async (c, now) => ({
      status: 200,
      body: await readContactAnalysis(
        db,
        c,
        query(url, { from: 'string', to: 'string', touchCostCents: 'int', limit: 'int' }),
        now
      )
    }))
  else if (path === '/api/admin/support/contact-analysis/classifications')
    read(['POST'], async (c, now) => ({
      status: 201,
      body: await classifyTicketRootCause(db, c, await body(), k, now)
    }))
  else if (path === '/api/admin/support/contact-analysis/backlog')
    read(['GET', 'POST'], async (c, now) =>
      request.method === 'GET'
        ? { status: 200, body: await listContactBacklog(db, c, query(url, { status: 'string', limit: 'int' }), now) }
        : { status: 201, body: await createContactBacklogItem(db, c, await body(), k, now) }
    )
  else if ((m = new RegExp(`^/api/admin/support/contact-analysis/backlog/${UUID}/commands$`).exec(path)))
    read(['POST'], async (c, now) => ({
      status: 200,
      body: await transitionContactBacklogItem(db, c, m![1]!, await body(), k, now)
    }))
  else if (path === '/api/admin/support/education/detect')
    read(['POST'], async (c, now) => ({
      status: 200,
      body: await detectEducationCandidates(db, c, await body(), k, now)
    }))
  else if (path === '/api/admin/support/education/candidates')
    read(['GET'], async (c, now) => ({
      status: 200,
      body: await listEducationCandidates(db, c, query(url, { status: 'string', limit: 'int' }), now)
    }))
  else if ((m = new RegExp(`^/api/admin/support/education/candidates/${UUID}/commands$`).exec(path)))
    read(['POST'], async (c, now) => ({
      status: 200,
      body: await commandEducationCandidate({ database: db, now: () => now }, c, m![1]!, await body(), k)
    }))
  else if ((m = new RegExp(`^/api/admin/support/education/candidates/${UUID}/deflection$`).exec(path)))
    read(['GET'], async (c, now) => {
      const q = query(url, { windowDays: 'int' })
      return {
        status: 200,
        body: await measureEducationDeflection(db, c, m![1]!, now, (q.windowDays as number | undefined) ?? 14)
      }
    })
  else if (path === '/api/admin/support/b2b-requests')
    read(['GET'], async (c, now) => ({
      status: 200,
      body: await listAdminB2bRequests(
        db,
        c,
        query(url, { status: 'string', kind: 'string', sla: 'string', limit: 'int' }),
        now
      )
    }))
  else if ((m = new RegExp(`^/api/admin/support/b2b-requests/${UUID}$`).exec(path)))
    read(['GET'], async (c, now) => ({ status: 200, body: await readAdminB2bRequest(db, c, m![1]!, now) }))
  else if ((m = new RegExp(`^/api/admin/support/b2b-requests/${UUID}/commands$`).exec(path)))
    read(['POST'], async (c, now) => ({
      status: 200,
      body: await commandAdminB2bRequest(db, c, m![1]!, await body(), k, now)
    }))

  if (!operation) return fail('not_found')
  if (!methods.includes(request.method)) return methodNotAllowed(methods)
  try {
    const blocked = await boundary(request, deps, 'admin')
    if (blocked) return blocked
    if (!deps.sessionCookieConfiguration) return fail('service_unavailable', 503)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return fail('unauthenticated')
    const now = nowOf(deps)
    const result = await (operation as AdminOperation)(claims, now)
    // Live authority is read again after the work: a revoked grant withholds the result.
    await requireSupportAdmin(db, claims, nowOf(deps))
    return supportJson(result.body, result.status)
  } catch (error) {
    return mapError(error)
  }
}

// ------------------------------------------------------------------ SUP-017 customer portal
export async function handleB2bRequestsHttp(
  request: Request,
  deps: SupportInsightsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsB2bRequestsNamespace(url.pathname)) return null
  const base = url.pathname === '/api/account/b2b-requests'
  const detail = new RegExp(`^/api/account/b2b-requests/${UUID}(?:/(reply|cancel|documents))?$`).exec(url.pathname)
  if (!base && !detail) return fail('not_found')
  const sub = detail?.[2]
  const methods = base ? ['GET', 'POST'] : sub ? ['POST'] : ['GET']
  if (!methods.includes(request.method)) return methodNotAllowed(methods)
  try {
    const blocked = await boundary(request, deps, 'customer')
    if (blocked) return blocked
    if (!deps.sessionCookieConfiguration) return fail('service_unavailable', 503)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return fail('unauthenticated')
    const db = deps.database,
      now = nowOf(deps),
      id = detail?.[1] ?? ''
    let status = 200
    let result: unknown
    if (request.method === 'GET') {
      result = base
        ? await listB2bRequests(db, claims, query(url, { status: 'string', limit: 'int' }), now)
        : (query(url, {}), await readB2bRequest(db, claims, id, now))
    } else {
      if (url.search) return fail('invalid_input')
      const input = await supportBody(request)
      const quota = await consumeIdentityQuota(db, {
        identityId: claims.identityId,
        scope: 'b2b-requests',
        limit: 30,
        windowSeconds: 3600,
        now: Math.floor(Date.parse(now) / 1000)
      })
      if (!quota.allowed) return fail('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
      status = 201
      result = base
        ? await createB2bRequest(db, claims, input, key(request), now)
        : sub === 'reply'
          ? await replyB2bRequest(db, claims, id, input, key(request), now)
          : sub === 'documents'
            ? await addB2bDocument(db, claims, id, input, key(request), now)
            : ((status = 200), await cancelB2bRequest(db, claims, id, input, key(request), now))
    }
    if (!(await activeOrderCustomerId(db, claims, nowOf(deps)))) return fail('unauthenticated')
    return supportJson(result, status)
  } catch (error) {
    return mapError(error)
  }
}
