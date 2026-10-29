import type { SessionCookieConfiguration } from '../auth/session-cookie'
import { verifySessionCookie } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { supportBody, supportJson } from '../support/http'
import { SupportError } from '../support/operations'
import { supportUuid } from '../../shared/support-operations'
import { adminOrderViewHashSchema } from '../../shared/admin-order-views'
import {
  AdminOrderViewError,
  authorizeD1AdminOrderViewActor,
  readD1AdminOrderViews,
  readD1AdminOrderView,
  createD1AdminOrderView,
  updateD1AdminOrderView,
  archiveD1AdminOrderView,
  readD1AdminOrderViewCommand
} from './admin-order-views'
export interface AdminOrderViewsHttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration | null
  rateLimitPepper: string
  edgeGate: (request: Request) => Promise<'allowed' | 'denied' | 'unavailable'>
  now?: string
}
export function ownsAdminOrderViewsNamespace(path: string) {
  if (path.length > 4096) return false
  let current = path
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/admin\/order-views(?:[/\\%]|$)/i.test(current)) return true
    try {
      const next = decodeURIComponent(current)
      if (next === current) break
      current = next
    } catch {
      break
    }
  }
  return false
}
const statuses: Record<string, number> = {
  invalid_input: 422,
  unauthenticated: 401,
  email_unverified: 403,
  mfa_required: 403,
  forbidden: 403,
  not_found: 404,
  version_conflict: 409,
  idempotency_conflict: 409,
  view_archived: 409,
  limit_reached: 409,
  history_unconfirmed: 503,
  service_unavailable: 503,
  body_too_large: 413
}
const failure = (code: string) => supportJson({ error: { code } }, statuses[code] ?? 503)
export async function handleAdminOrderViewsHttp(
  request: Request,
  deps: AdminOrderViewsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsAdminOrderViewsNamespace(url.pathname)) return null
  const base = url.pathname === '/api/admin/order-views',
    detail = /^\/api\/admin\/order-views\/([a-f0-9-]{36})$/.exec(url.pathname),
    archive = /^\/api\/admin\/order-views\/([a-f0-9-]{36})\/archive$/.exec(url.pathname),
    command = /^\/api\/admin\/order-views\/commands\/([a-f0-9-]{36})$/.exec(url.pathname)
  const id = (detail ?? archive ?? command)?.[1]
  if ((!base && !detail && !archive && !command) || (id && !supportUuid.safeParse(id).success))
    return failure('not_found')
  const methods = base ? ['GET', 'POST'] : detail ? ['GET', 'PUT'] : archive ? ['POST'] : ['GET']
  if (!methods.includes(request.method))
    return supportJson({ error: { code: 'method_not_allowed' } }, 405, { Allow: methods.join(', ') })
  try {
    if (
      !deps.sessionCookieConfiguration ||
      new URL(deps.origin).origin !== deps.origin ||
      new URL(deps.origin).protocol !== 'https:' ||
      !deps.rateLimitPepper
    )
      return failure('service_unavailable')
    const write = request.method !== 'GET'
    if (
      url.origin !== deps.origin ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (write
        ? request.headers.get('origin') !== deps.origin
        : request.headers.has('origin') && request.headers.get('origin') !== deps.origin)
    )
      return failure('forbidden')
    const edge = await deps.edgeGate(request)
    if (edge === 'denied') return supportJson({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': '60' })
    if (edge !== 'allowed') return failure('service_unavailable')
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return failure('unauthenticated')
    await authorizeD1AdminOrderViewActor(deps.database, claims, { now: deps.now })
    for (const key of url.searchParams.keys())
      if (!command || key !== 'payloadHash' || url.searchParams.getAll(key).length !== 1)
        return failure('invalid_input')
    const options = { now: deps.now }
    if (command) {
      const hash = url.searchParams.get('payloadHash') ?? ''
      if (!adminOrderViewHashSchema.safeParse(hash).success) return failure('invalid_input')
      return supportJson(await readD1AdminOrderViewCommand(deps.database, claims, command[1]!, hash, options))
    }
    if (detail && request.method === 'GET')
      return supportJson(await readD1AdminOrderView(deps.database, claims, detail[1]!, options))
    if (base && request.method === 'GET')
      return supportJson(await readD1AdminOrderViews(deps.database, claims, options))
    const body = await supportBody(request),
      key = request.headers.get('idempotency-key') ?? ''
    if (!supportUuid.safeParse(key).success) return failure('invalid_input')
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'administrative-order-views',
      limit: 60,
      windowSeconds: 3600,
      now: deps.now ? Math.floor(Date.parse(deps.now) / 1000) : undefined
    })
    if (!quota.allowed)
      return supportJson({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': String(quota.retryAfter) })
    const commandOptions = { ...options, idempotencyKey: key }
    if (archive)
      return supportJson(await archiveD1AdminOrderView(deps.database, claims, archive[1]!, body, commandOptions))
    if (detail)
      return supportJson(await updateD1AdminOrderView(deps.database, claims, detail[1]!, body, commandOptions))
    return supportJson(await createD1AdminOrderView(deps.database, claims, body, commandOptions), 201)
  } catch (error) {
    if (error instanceof AdminOrderViewError) return failure(error.code)
    if (error instanceof SupportError && ['invalid_input', 'body_too_large'].includes(error.code))
      return failure(error.code)
    return failure('service_unavailable')
  }
}
