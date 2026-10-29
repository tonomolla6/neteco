import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { supportBody, supportJson } from '../support/http'
import { SupportError } from '../support/operations'
import { supportUuid } from '../../shared/support-operations'
import { communicationEventIdSchema } from '../../shared/communication-history'
import {
  CommunicationHistoryError,
  readCommunicationHistory,
  retryCommunicationPreparation,
  readCommunicationRetryCommand
} from './history'
export interface CommunicationHistoryHttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration | null
  edgeGate?: (request: Request) => Promise<'allowed' | 'denied' | 'unavailable'>
  now?: string
}
export function ownsCommunicationHistoryNamespace(path: string) {
  if (path.length > 4096) return false
  let candidate = path
  for (let i = 0; i < 4; i++) {
    if (/^\/api\/admin\/communications\/history(?:[/\\%]|$)/i.test(candidate)) return true
    try {
      const next = decodeURIComponent(candidate)
      if (next === candidate) return false
      candidate = next
    } catch {
      return false
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
  not_retryable: 409,
  body_too_large: 413,
  service_unavailable: 503
}
const failure = (code: string, status = statuses[code] ?? 503) => supportJson({ error: { code } }, status)
export async function handleCommunicationHistoryHttp(
  request: Request,
  deps: CommunicationHistoryHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCommunicationHistoryNamespace(url.pathname)) return null
  const base = '/api/admin/communications/history',
    list = url.pathname === base,
    command = /^\/api\/admin\/communications\/history\/commands\/([0-9a-f-]{36})$/.exec(url.pathname),
    mutation = /^\/api\/admin\/communications\/history\/(email(?:%3A|:)[a-f0-9]{64})\/commands$/.exec(url.pathname)
  const eventId = mutation ? decodeURIComponent(mutation[1]!) : null
  if (
    (!list && !command && !mutation) ||
    (command && !supportUuid.safeParse(command[1]).success) ||
    (eventId && !communicationEventIdSchema.safeParse(eventId).success)
  )
    return failure('not_found')
  const method = mutation ? 'POST' : 'GET'
  if (request.method !== method) return supportJson({ error: { code: 'method_not_allowed' } }, 405, { Allow: method })
  try {
    if (
      new URL(deps.origin).origin !== deps.origin ||
      new URL(deps.origin).protocol !== 'https:' ||
      !deps.sessionCookieConfiguration
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
    const edge = await deps.edgeGate?.(request)
    if (edge === 'denied') return supportJson({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': '60' })
    if (edge !== 'allowed') return failure('service_unavailable')
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return failure('unauthenticated')
    const authorized = await authorizeD1Session(deps.database, claims, 'administration.manage', {
      now: deps.now,
      requireMfa: true
    })
    if (!authorized.allowed) return failure(authorized.code)
    const allowed = list ? ['page', 'perPage', 'status', 'eventType', 'eventId'] : []
    for (const key of url.searchParams.keys())
      if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) return failure('invalid_input')
    if (list)
      return supportJson(
        await readCommunicationHistory(deps.database, claims, Object.fromEntries(url.searchParams), { now: deps.now })
      )
    if (command)
      return supportJson(
        await readCommunicationRetryCommand(
          deps.database,
          claims,
          command[1]!,
          request.headers.get('X-Neteco-Command-Payload-Hash') ?? '',
          { now: deps.now }
        )
      )
    const input = await supportBody(request),
      key = request.headers.get('Idempotency-Key') ?? ''
    if (!supportUuid.safeParse(key).success) return failure('invalid_input')
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'communication-preparation-retry',
      limit: 60,
      windowSeconds: 3600,
      now: deps.now ? Math.floor(Date.parse(deps.now) / 1000) : undefined
    })
    if (!quota.allowed)
      return supportJson({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': String(quota.retryAfter) })
    return supportJson(
      await retryCommunicationPreparation(deps.database, claims, eventId!, input, {
        idempotencyKey: key,
        now: deps.now
      }),
      201
    )
  } catch (error) {
    if (error instanceof CommunicationHistoryError) return failure(error.code)
    if (error instanceof SupportError && ['invalid_input', 'body_too_large'].includes(error.code))
      return failure(error.code)
    return failure('service_unavailable')
  }
}
