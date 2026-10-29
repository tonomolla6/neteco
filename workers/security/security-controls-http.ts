import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import type { ApiKeyScope } from '../../shared/security-b2b-api-keys'
import { DEVICE_STATUSES, type DeviceStatus } from '../../shared/security-warehouse-devices'
import {
  activateModelVersion,
  assessAbuse,
  computeDrift,
  createModelVersion,
  getAbuseMetrics,
  listReviewQueue,
  recordBaseline,
  reviewAssessment
} from './abuse-detection'
import {
  authenticateApiKey,
  createApiKey,
  listApiKeyAudit,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  updateApiKeyPolicy
} from './b2b-api-keys'
import { SecurityControlError, assertSecret, requireAdmin } from './controls-common'
import { sealOfflineBundle } from './offline-bundle'
import {
  confirmDeviceWipe,
  deviceCheckin,
  enrollDevice,
  listDeviceAudit,
  listDevices,
  lockDevice,
  reportDeviceLost,
  reportDevicePosture,
  requestDeviceWipe,
  retireDevice,
  unlockDevice
} from './warehouse-devices'

export interface SecurityControlsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration | null
  secrets: { apiKeyPepper?: string; offlineMasterKey?: string; abuseSubjectPepper?: string }
}

const ADMIN_PREFIX = '/api/admin/security-controls/'
const DEVICE_PREFIX = '/api/devices/v1/'
const B2B_PING = '/api/b2b/v1/ping'
const MAX_BODY_BYTES = 64 * 1024

export function ownsSecurityControlsNamespace(pathname: string): boolean {
  return pathname.startsWith(ADMIN_PREFIX) || pathname.startsWith(DEVICE_PREFIX) || pathname === B2B_PING
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      pragma: 'no-cache',
      vary: 'Cookie',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      ...headers
    }
  })
}

const fail = (code: string, status: number, headers: Record<string, string> = {}) =>
  json({ error: { code } }, status, headers)

function canonicalNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) throw new SecurityControlError('payload_too_large', 413)
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new SecurityControlError('payload_too_large', 413)
  if (text.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape')
    return parsed as Record<string, unknown>
  } catch {
    throw new SecurityControlError('invalid_json', 400)
  }
}

/** Session cookie is only a claim: the session row and the identity are re-read on every request. */
async function resolveIdentity(request: Request, deps: SecurityControlsHttpDependencies, now: string): Promise<string> {
  if (!deps.sessionCookieConfiguration) throw new SecurityControlError('service_unavailable', 503)
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) throw new SecurityControlError('unauthorized', 401)
  const live = await deps.database
    .prepare(
      `SELECT 1 AS ok FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
       WHERE s.id=?1 AND s.identity_id=?2 AND s.session_version=?3 AND i.session_version=s.session_version
         AND i.status='active' AND s.revoked_at IS NULL AND s.expires_at>?4`
    )
    .bind(claims.sessionId, claims.identityId, claims.sessionVersion, now)
    .first()
  if (!live) throw new SecurityControlError('unauthorized', 401)
  return claims.identityId
}

async function handleAdmin(request: Request, url: URL, deps: SecurityControlsHttpDependencies): Promise<Response> {
  const now = canonicalNow()
  const actor = await resolveIdentity(request, deps, now)
  await requireAdmin(deps.database, actor, now)
  const rest = url.pathname.slice(ADMIN_PREFIX.length)
  const method = request.method
  const ctx = { actorIdentityId: actor, now }
  const keyCtx = { ...ctx, pepper: deps.secrets.apiKeyPepper ?? '' }
  const db = deps.database
  const only = (...methods: string[]) => {
    if (!methods.includes(method)) throw new SecurityControlError('method_not_allowed', 405)
  }
  const body = () => readBody(request)
  let match: RegExpExecArray | null

  // ---- SEC-038
  if (rest === 'api-keys') {
    only('GET', 'POST')
    if (method === 'GET') {
      const keys = await listApiKeys(db, { companyId: url.searchParams.get('companyId') ?? undefined })
      await requireAdmin(db, actor, now)
      return json({ keys })
    }
    assertSecret(deps.secrets.apiKeyPepper)
    const result = await createApiKey(db, await body(), keyCtx)
    return json(result, result.replayed ? 200 : 201)
  }
  if ((match = /^api-keys\/([^/]+)\/rotate$/.exec(rest))) {
    only('POST')
    assertSecret(deps.secrets.apiKeyPepper)
    return json(await rotateApiKey(db, { ...(await body()), keyId: match[1] }, keyCtx))
  }
  if ((match = /^api-keys\/([^/]+)\/revoke$/.exec(rest))) {
    only('POST')
    return json(await revokeApiKey(db, { ...(await body()), keyId: match[1] }, ctx))
  }
  if ((match = /^api-keys\/([^/]+)\/audit$/.exec(rest))) {
    only('GET')
    const audit = await listApiKeyAudit(db, match[1]!)
    await requireAdmin(db, actor, now)
    return json({ audit })
  }
  if ((match = /^api-keys\/([^/]+)$/.exec(rest))) {
    only('PATCH')
    return json(await updateApiKeyPolicy(db, { ...(await body()), keyId: match[1] }, ctx))
  }

  // ---- SEC-039
  if (rest === 'devices') {
    only('GET', 'POST')
    if (method === 'GET') {
      const status = url.searchParams.get('status')
      if (status && !DEVICE_STATUSES.includes(status as DeviceStatus))
        throw new SecurityControlError('invalid_input', 400)
      const devices = await listDevices(db, {
        status: (status as DeviceStatus | null) ?? undefined,
        identityId: url.searchParams.get('identityId') ?? undefined
      })
      await requireAdmin(db, actor, now)
      return json({ devices })
    }
    const result = await enrollDevice(db, await body(), ctx)
    return json(result, result.replayed ? 200 : 201)
  }
  if ((match = /^devices\/([^/]+)\/(lock|unlock|lost|wipe|retire)$/.exec(rest))) {
    only('POST')
    const input = { ...(await body()), deviceId: match[1] }
    const action = {
      lock: lockDevice,
      unlock: unlockDevice,
      lost: reportDeviceLost,
      wipe: requestDeviceWipe,
      retire: retireDevice
    }[match[2] as 'lock']
    return json(await action(db, input, ctx))
  }
  if ((match = /^devices\/([^/]+)\/audit$/.exec(rest))) {
    only('GET')
    const audit = await listDeviceAudit(db, match[1]!)
    await requireAdmin(db, actor, now)
    return json({ audit })
  }

  // ---- SEC-040
  const abuseCtx = { now, pepper: deps.secrets.abuseSubjectPepper ?? '' }
  if (rest === 'abuse/assessments') {
    only('POST')
    assertSecret(deps.secrets.abuseSubjectPepper)
    const result = await assessAbuse(db, await body(), abuseCtx)
    return json(result, result.replayed ? 200 : 201)
  }
  if (rest === 'abuse/queue') {
    only('GET')
    const limit = Number(url.searchParams.get('limit') ?? 50)
    const queue = await listReviewQueue(db, { limit: Number.isFinite(limit) ? limit : 50 }, ctx)
    await requireAdmin(db, actor, now)
    return json({ queue })
  }
  if ((match = /^abuse\/assessments\/([^/]+)\/review$/.exec(rest))) {
    only('POST')
    return json(await reviewAssessment(db, { ...(await body()), assessmentId: match[1] }, ctx))
  }
  if (rest === 'abuse/metrics') {
    only('GET')
    const metrics = await getAbuseMetrics(db, {
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      modelVersionId: url.searchParams.get('modelVersionId') ?? undefined
    })
    await requireAdmin(db, actor, now)
    return json({ metrics })
  }
  if (rest === 'abuse/models') {
    only('POST')
    return json({ model: await createModelVersion(db, await body(), ctx) }, 201)
  }
  if ((match = /^abuse\/models\/([^/]+)\/activate$/.exec(rest))) {
    only('POST')
    return json({ model: await activateModelVersion(db, { modelVersionId: match[1]! }, ctx) })
  }
  if (rest === 'abuse/baselines') {
    only('POST')
    return json({ baseline: await recordBaseline(db, await body(), ctx) })
  }
  if (rest === 'abuse/drift') {
    only('POST')
    return json({ reports: await computeDrift(db, await body(), ctx) })
  }
  throw new SecurityControlError('not_found', 404)
}

async function handleDevice(request: Request, url: URL, deps: SecurityControlsHttpDependencies): Promise<Response> {
  const match = /^\/api\/devices\/v1\/([^/]+)\/(checkin|posture|wipe-ack|offline-bundle)$/.exec(url.pathname)
  if (!match) throw new SecurityControlError('not_found', 404)
  if (request.method !== 'POST') throw new SecurityControlError('method_not_allowed', 405)
  const now = canonicalNow()
  const identity = await resolveIdentity(request, deps, now)
  const ctx = { actorIdentityId: identity, now }
  const deviceId = match[1]!
  const db = deps.database
  switch (match[2]) {
    case 'checkin':
      return json(await deviceCheckin(db, { deviceId }, ctx))
    case 'posture':
      return json(await reportDevicePosture(db, { deviceId, posture: (await readBody(request)) as never }, ctx))
    case 'wipe-ack':
      return json(await confirmDeviceWipe(db, { ...(await readBody(request)), deviceId }, ctx))
    default: {
      const masterKey = assertSecret(deps.secrets.offlineMasterKey)
      const envelope = await sealOfflineBundle(
        db,
        { deviceId, manifest: await readBody(request) },
        { ...ctx, masterKey }
      )
      return json({ envelope })
    }
  }
}

async function handleB2bPing(request: Request, deps: SecurityControlsHttpDependencies): Promise<Response> {
  if (request.method !== 'GET') throw new SecurityControlError('method_not_allowed', 405)
  const pepper = assertSecret(deps.secrets.apiKeyPepper)
  const requiredScope: ApiKeyScope = 'catalog:read'
  const result = await authenticateApiKey(
    deps.database,
    {
      presented: request.headers.get('x-neteco-api-key') ?? '',
      requiredScope,
      ip: request.headers.get('cf-connecting-ip')
    },
    { now: canonicalNow(), pepper }
  )
  if (!result.ok) {
    return fail(
      result.code,
      result.status,
      result.retryAfterSeconds ? { 'retry-after': String(result.retryAfterSeconds) } : {}
    )
  }
  return json({ ok: true, companyId: result.key.companyId, scopes: result.key.scopes })
}

export async function handleSecurityControlsHttp(
  request: Request,
  deps: SecurityControlsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsSecurityControlsNamespace(url.pathname)) return null
  try {
    if (url.pathname === B2B_PING) return await handleB2bPing(request, deps)
    if (url.pathname.startsWith(DEVICE_PREFIX)) return await handleDevice(request, url, deps)
    return await handleAdmin(request, url, deps)
  } catch (error) {
    if (error instanceof SecurityControlError) {
      return fail(error.code, error.status, error.status === 405 ? { allow: 'GET, POST, PATCH' } : {})
    }
    // Constraint or driver errors must not leak SQL details to clients.
    return fail('internal_error', 500)
  }
}
