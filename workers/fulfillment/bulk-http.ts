import type { SessionCookieConfiguration } from '../auth/session-cookie'
import { verifySessionCookie } from '../auth/session-cookie'
import { authorizeD1AdminInvitationActor, AdminInvitationError } from '../auth/admin-invitations'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { supportBody, supportJson } from '../support/http'
import { SupportError } from '../support/operations'
import { supportUuid } from '../../shared/support-operations'
import {
  adminOrderBulkHashSchema,
  adminOrderBulkPreviewInputSchema,
  adminOrderBulkCreateInputSchema
} from '../../shared/admin-order-bulk'
import {
  AdminOrderBulkError,
  previewD1AdminOrderBulk,
  createD1AdminOrderBulk,
  readD1AdminOrderBulk,
  readD1AdminOrderBulkCommand
} from './bulk'

export interface AdminOrderBulkHttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration | null
  rateLimitPepper: string
  edgeGate: (request: Request) => Promise<'allowed' | 'denied' | 'unavailable'>
  now?: string
}

export function ownsAdminOrderBulkNamespace(path: string): boolean {
  if (path.length > 4096) return false
  let candidate = path
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/admin\/orders\/bulk-fulfillment(?:[/\\%]|$)/i.test(candidate)) return true
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
  revalidation_required: 409,
  idempotency_conflict: 409,
  history_unconfirmed: 503,
  service_unavailable: 503,
  body_too_large: 413
}
const failure = (code: string) => supportJson({ error: { code } }, statuses[code] ?? 503)
export async function handleAdminOrderBulkHttp(
  request: Request,
  deps: AdminOrderBulkHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsAdminOrderBulkNamespace(url.pathname)) return null
  const base = '/api/admin/orders/bulk-fulfillment',
    preview = url.pathname === base + '/preview',
    create = url.pathname === base + '/commands',
    group = new RegExp('^' + base + '/([a-f0-9-]{36})$').exec(url.pathname),
    command = new RegExp('^' + base + '/commands/([a-f0-9-]{36})$').exec(url.pathname)
  const id = (group ?? command)?.[1]
  if ((!preview && !create && !group && !command) || (id && !supportUuid.safeParse(id).success))
    return failure('not_found')
  const method = preview || create ? 'POST' : 'GET'
  if (request.method !== method) return supportJson({ error: { code: 'method_not_allowed' } }, 405, { Allow: method })
  try {
    if (
      !deps.sessionCookieConfiguration ||
      !deps.rateLimitPepper ||
      new URL(deps.origin).origin !== deps.origin ||
      new URL(deps.origin).protocol !== 'https:'
    )
      return failure('service_unavailable')
    if (
      url.origin !== deps.origin ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (method === 'POST'
        ? request.headers.get('origin') !== deps.origin
        : request.headers.has('origin') && request.headers.get('origin') !== deps.origin)
    )
      return failure('forbidden')
    const edge = await deps.edgeGate(request)
    if (edge === 'denied') return supportJson({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': '60' })
    if (edge !== 'allowed') return failure('service_unavailable')
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return failure('unauthenticated')
    const options = deps.now === undefined ? {} : { now: deps.now }
    await authorizeD1AdminInvitationActor(deps.database, claims, true, options)
    for (const key of url.searchParams.keys())
      if (!command || key !== 'payloadHash' || url.searchParams.getAll(key).length !== 1)
        return failure('invalid_input')
    if (command) {
      const hash = url.searchParams.get('payloadHash') ?? ''
      if (!adminOrderBulkHashSchema.safeParse(hash).success) return failure('invalid_input')
      return supportJson(await readD1AdminOrderBulkCommand(deps.database, claims, command[1]!, hash, options))
    }
    if (group) return supportJson(await readD1AdminOrderBulk(deps.database, claims, group[1]!, options))
    const body = await supportBody(request),
      parsed = preview
        ? adminOrderBulkPreviewInputSchema.safeParse(body)
        : adminOrderBulkCreateInputSchema.safeParse(body)
    if (!parsed.success) return failure('invalid_input')
    const key = request.headers.get('idempotency-key') ?? ''
    if (create && !supportUuid.safeParse(key).success) return failure('invalid_input')
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'admin-order-bulk',
      limit: 60,
      windowSeconds: 3600,
      ...(deps.now === undefined ? {} : { now: Math.floor(Date.parse(deps.now) / 1000) })
    })
    if (!quota.allowed)
      return supportJson({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': String(quota.retryAfter) })
    if (preview) return supportJson(await previewD1AdminOrderBulk(deps.database, claims, parsed.data, options))
    return supportJson(
      await createD1AdminOrderBulk(deps.database, claims, parsed.data, { ...options, idempotencyKey: key }),
      201
    )
  } catch (error) {
    if (error instanceof AdminOrderBulkError) return failure(error.code)
    if (
      error instanceof AdminInvitationError &&
      ['unauthenticated', 'email_unverified', 'mfa_required', 'forbidden', 'service_unavailable'].includes(error.code)
    )
      return failure(error.code)
    if (error instanceof SupportError && ['invalid_input', 'body_too_large'].includes(error.code))
      return failure(error.code)
    return failure('service_unavailable')
  }
}
