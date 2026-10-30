import { consumeIdentityQuota } from '../auth/identity-quota'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  PromoFraudError,
  decidePromoFraudCase,
  listCustomerPromoFraudCases,
  listPromoFraudCases,
  readPromoFraudCase,
  resolvePromoFraudAppeal,
  submitPromoFraudAppeal
} from './promo-fraud'

/** SEC-036. Review queue (administrators) and appeals (the affected customer). Assessment itself is
 * a server-side call and has no HTTP route, so a client can never choose the customer, the signals
 * or the clock. */
export interface PromoFraudHttpDependencies {
  database: D1Database
  origin: string
  session: (request: Request) => Promise<VerifiedSessionClaims | null>
  now?: () => string
}
const ADMIN_BASE = '/api/admin/promo-fraud/cases'
const MINE_BASE = '/api/account/promo-fraud/cases'
const MAX_BODY = 16 * 1024
const UUID = '([0-9a-fA-F-]{36}|[^/]+)'
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

export function ownsPromoFraudNamespace(pathname: string) {
  let candidate = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    if (/^\/api\/(?:admin|account)\/promo-fraud(?:[/\\%]|$)/i.test(candidate)) return true
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

class BodyError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
async function readBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY))
    throw new BodyError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new BodyError('json_required', 415)
  if (!request.body) throw new BodyError('missing_body', 400)
  const reader = request.body.getReader()
  const bytes = new Uint8Array(MAX_BODY)
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new BodyError('invalid_json', 400)
      if (next.value.byteLength > MAX_BODY - length) throw new BodyError('body_too_large', 413)
      bytes.set(next.value, length)
      length += next.value.byteLength
    }
  } catch (failure) {
    void reader.cancel().catch(() => undefined)
    throw failure
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown
  } catch {
    throw new BodyError('invalid_json', 400)
  }
}

const STATUS: Record<PromoFraudError['code'], number> = {
  unauthenticated: 401,
  email_unverified: 403,
  mfa_required: 403,
  forbidden: 403,
  self_review: 403,
  same_reviewer: 403,
  not_found: 404,
  customer_not_found: 404,
  invalid_input: 422,
  version_conflict: 409,
  invalid_transition: 409,
  idempotency_conflict: 409,
  already_assessed: 409,
  appeal_not_allowed: 409,
  security_configuration_missing: 503
}

export async function handlePromoFraudHttp(
  request: Request,
  deps: PromoFraudHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsPromoFraudNamespace(url.pathname)) return null
  const path = url.pathname
  const routes = {
    adminList: path === ADMIN_BASE,
    adminRead: new RegExp(`^${ADMIN_BASE}/${UUID}$`).exec(path),
    adminDecision: new RegExp(`^${ADMIN_BASE}/${UUID}/decision$`).exec(path),
    adminResolution: new RegExp(`^${ADMIN_BASE}/${UUID}/appeal-resolution$`).exec(path),
    mineList: path === MINE_BASE,
    mineAppeal: new RegExp(`^${MINE_BASE}/${UUID}/appeal$`).exec(path)
  }
  const reads = routes.adminList || routes.adminRead || routes.mineList
  const writes = routes.adminDecision || routes.adminResolution || routes.mineAppeal
  if (!reads && !writes) return error('not_found', 404)
  const method = reads ? 'GET' : 'POST'
  if (request.method !== method) return error('method_not_allowed', 405, { Allow: method })
  const params = url.searchParams
  let listQuery: { filter: 'pending' | 'all'; limit: number } | undefined
  if (routes.adminList) {
    for (const key of params.keys())
      if (!['filter', 'limit'].includes(key) || params.getAll(key).length !== 1) return error('invalid_input', 422)
    const filter = params.get('filter') ?? 'pending'
    const limit = params.get('limit') ?? '50'
    if (!['pending', 'all'].includes(filter) || !/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 200)
      return error('invalid_input', 422)
    listQuery = { filter: filter as 'pending' | 'all', limit: Number(limit) }
  } else if (params.size) return error('invalid_input', 422)
  try {
    const configured = new URL(deps.origin)
    if (configured.protocol !== 'https:' || configured.origin !== deps.origin) return error('service_unavailable', 503)
    const origin = request.headers.get('origin')
    if (
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (writes ? origin !== deps.origin : origin !== null && origin !== deps.origin)
    )
      return error('csrf_rejected', 403)
    const claims = await deps.session(request)
    if (!claims) return error('unauthenticated', 401)
    const options = { now: deps.now?.() }
    if (reads) {
      if (routes.adminList)
        return json({ items: await listPromoFraudCases(deps.database, claims, listQuery!, options) })
      if (routes.mineList) return json({ items: await listCustomerPromoFraudCases(deps.database, claims, options) })
      return json(await readPromoFraudCase(deps.database, claims, routes.adminRead![1]!, options))
    }
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'promo-fraud-commands',
      limit: 60,
      windowSeconds: 3600,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now()) / 1000) } : {})
    })
    if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
    const payload = await readBody(request)
    if (routes.adminDecision)
      return json({
        case: await decidePromoFraudCase(deps.database, claims, routes.adminDecision[1]!, payload, options)
      })
    if (routes.adminResolution)
      return json({
        case: await resolvePromoFraudAppeal(deps.database, claims, routes.adminResolution[1]!, payload, options)
      })
    return json({ case: await submitPromoFraudAppeal(deps.database, claims, routes.mineAppeal![1]!, payload, options) })
  } catch (failure) {
    if (failure instanceof BodyError) return error(failure.code, failure.status)
    if (failure instanceof PromoFraudError) return error(failure.code, STATUS[failure.code])
    return error('service_unavailable', 503)
  }
}
