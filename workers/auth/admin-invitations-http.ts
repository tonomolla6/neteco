import { verifySessionCookie, clearedSessionCookie, type SessionCookieConfiguration } from './session-cookie'
import { consumeIdentityQuota } from './identity-quota'
import { supportBody, supportJson } from '../support/http'
import { SupportError } from '../support/operations'
import { supportUuid } from '../../shared/support-operations'
import { adminInvitationHashSchema } from '../../shared/admin-invitations'
import {
  AdminInvitationError,
  authorizeD1AdminInvitationActor,
  readD1AdminInvitations,
  readD1AdminInvitation,
  createD1AdminInvitation,
  revokeD1AdminInvitation,
  previewD1AdminInvitation,
  acceptD1AdminInvitation,
  readD1AdminInvitationCommand
} from './admin-invitations'
export interface AdminInvitationsHttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration | null
  edgeGate?: (request: Request) => Promise<'allowed' | 'denied' | 'unavailable'>
  now?: string
}
export function ownsAdminInvitationsNamespace(path: string) {
  if (path.length > 4096) return false
  let candidate = path
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/(admin|account)\/invitations(?:[/\\%]|$)/i.test(candidate)) return true
    try {
      const decoded = decodeURIComponent(candidate)
      if (decoded === candidate) break
      candidate = decoded
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
  invitation_unavailable: 409,
  role_already_granted: 409,
  body_too_large: 413,
  service_unavailable: 503,
  history_unconfirmed: 503
}
const failure = (code: string) => supportJson({ error: { code } }, statuses[code] ?? 503)
export async function handleAdminInvitationsHttp(
  request: Request,
  deps: AdminInvitationsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsAdminInvitationsNamespace(url.pathname)) return null
  const base = '/api/admin/invitations',
    list = url.pathname === base,
    detail = /^\/api\/admin\/invitations\/([a-f0-9-]{36})$/.exec(url.pathname),
    revoke = /^\/api\/admin\/invitations\/([a-f0-9-]{36})\/revoke$/.exec(url.pathname),
    command = /^\/api\/(admin|account)\/invitations\/commands\/([a-f0-9-]{36})$/.exec(url.pathname),
    preview = url.pathname === '/api/account/invitations/preview',
    accept = url.pathname === '/api/account/invitations/accept'
  if (
    (!list && !detail && !revoke && !command && !preview && !accept) ||
    ((detail || revoke) && !supportUuid.safeParse((detail ?? revoke)![1]).success) ||
    (command && !supportUuid.safeParse(command[2]).success)
  )
    return failure('not_found')
  const method = preview || accept || revoke ? 'POST' : list ? null : 'GET'
  if (method ? request.method !== method : !['GET', 'POST'].includes(request.method))
    return supportJson({ error: { code: 'method_not_allowed' } }, 405, { Allow: method ?? 'GET, POST' })
  try {
    if (
      !deps.sessionCookieConfiguration ||
      new URL(deps.origin).origin !== deps.origin ||
      new URL(deps.origin).protocol !== 'https:'
    )
      return failure('service_unavailable')
    if (
      url.origin !== deps.origin ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.method === 'POST'
        ? request.headers.get('origin') !== deps.origin
        : request.headers.has('origin') && request.headers.get('origin') !== deps.origin)
    )
      return failure('forbidden')
    const edge = await deps.edgeGate?.(request)
    if (edge === 'denied') return supportJson({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': '60' })
    if (edge !== 'allowed') return failure('service_unavailable')
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return failure('unauthenticated')
    const admin = url.pathname.startsWith('/api/admin/')
    await authorizeD1AdminInvitationActor(deps.database, claims, admin, { now: deps.now })
    const allowedQuery = command ? ['payloadHash'] : list && request.method === 'GET' ? ['page', 'perPage'] : []
    for (const key of url.searchParams.keys())
      if (!allowedQuery.includes(key) || url.searchParams.getAll(key).length !== 1) return failure('invalid_input')
    const options = { now: deps.now }
    if (command) {
      const hash = url.searchParams.get('payloadHash') ?? ''
      if (!adminInvitationHashSchema.safeParse(hash).success) return failure('invalid_input')
      return supportJson(
        await readD1AdminInvitationCommand(deps.database, claims, command[2]!, hash, {
          ...options,
          audience: admin ? 'admin' : 'account'
        })
      )
    }
    if (detail) return supportJson(await readD1AdminInvitation(deps.database, claims, detail[1]!, options))
    if (list && request.method === 'GET')
      return supportJson(
        await readD1AdminInvitations(deps.database, claims, Object.fromEntries(url.searchParams), options)
      )
    const body = await supportBody(request),
      key = request.headers.get('idempotency-key') ?? ''
    if (!preview && !supportUuid.safeParse(key).success) return failure('invalid_input')
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: preview ? 'admin-invitation-preview' : 'admin-invitation-write',
      limit: 60,
      windowSeconds: 3600,
      now: deps.now ? Math.floor(Date.parse(deps.now) / 1000) : undefined
    })
    if (!quota.allowed)
      return supportJson({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': String(quota.retryAfter) })
    if (preview) return supportJson(await previewD1AdminInvitation(deps.database, claims, body, options))
    const commandOptions = { ...options, idempotencyKey: key }
    if (accept)
      return supportJson(await acceptD1AdminInvitation(deps.database, claims, body, commandOptions), 201, {
        'Set-Cookie': clearedSessionCookie
      })
    if (revoke)
      return supportJson(await revokeD1AdminInvitation(deps.database, claims, revoke[1]!, body, commandOptions), 201)
    return supportJson(await createD1AdminInvitation(deps.database, claims, body, commandOptions), 201)
  } catch (error) {
    if (error instanceof AdminInvitationError) return failure(error.code)
    if (error instanceof SupportError && ['invalid_input', 'body_too_large'].includes(error.code))
      return failure(error.code)
    return failure('service_unavailable')
  }
}
