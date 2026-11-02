import { z } from 'zod'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { verifiedAdminCookieDeadline } from './admin-session-deadline'

type Dependencies = {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  now?: string
}
const schema = z
  .object({
    serviceId: z.enum(['catalog', 'checkout', 'operations']),
    owner: z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/),
    expectedVersion: z.number().int().min(0).max(2147483646)
  })
  .strict()
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }
  })
const error = (code: string, status: number) => json({ error: { code } }, status)
const databaseClock = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
const actor = `EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
 WHERE s.id=?2 AND i.id=?3 AND s.session_version=?4 AND s.revoked_at IS NULL AND s.mfa_verified=1
 AND s.created_at<=${databaseClock} AND s.expires_at>${databaseClock} AND i.status IN ('active','pending') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=${databaseClock}
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id AND p.permission_code='administration.manage'
 AND r.granted_at<=${databaseClock} AND (r.expires_at IS NULL OR r.expires_at>${databaseClock}))) AND (CAST(strftime('%s',${databaseClock}) AS INTEGER)+1)*1000<=?11`
export function ownsDeveloperOwnershipNamespace(path: string) {
  for (let i = 0; i < 4; i++) {
    if (/^\/api\/admin\/developer-platform(?:[/\\%]|$)/i.test(path)) return true
    try {
      const decoded = decodeURIComponent(path)
      if (decoded === path) break
      path = decoded
    } catch {
      break
    }
  }
  return false
}
async function readBody(request: Request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '') || !request.body)
    return null
  const reader = request.body.getReader(),
    bytes = new Uint8Array(4096)
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (length + next.value.length > bytes.length) {
        await reader.cancel()
        return null
      }
      bytes.set(next.value, length)
      length += next.value.length
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
}
async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
}
export async function handleDeveloperOwnership(request: Request, deps: Dependencies): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsDeveloperOwnershipNamespace(url.pathname)) return null
  if (url.pathname !== '/api/admin/developer-platform/ownership' || url.search) return error('not_found', 404)
  if (!['GET', 'POST'].includes(request.method)) return error('method_not_allowed', 405)
  try {
    const origin = new URL(deps.origin)
    if (origin.protocol !== 'https:' || origin.origin !== deps.origin) return error('service_unavailable', 503)
    if (
      (request.method === 'GET'
        ? request.headers.has('origin') && request.headers.get('origin') !== deps.origin
        : request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    const clock = () => deps.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    const now = clock()
    const auth = async () => {
      const current = await verifySessionCookie(request, deps.sessionCookieConfiguration)
      if (
        !current ||
        current.identityId !== claims.identityId ||
        current.sessionId !== claims.sessionId ||
        current.sessionVersion !== claims.sessionVersion
      )
        return { allowed: false, code: 'unauthenticated' } as const
      return authorizeD1Session(deps.database, claims, 'administration.manage', { now: clock(), requireMfa: true })
    }
    const allowed = await auth()
    if (!allowed.allowed) return error(allowed.code, allowed.code === 'unauthenticated' ? 401 : 403)
    if (request.method === 'GET') {
      const rows = await deps.database
        .prepare(
          'SELECT service_id AS serviceId,owner,version,updated_at AS updatedAt FROM developer_service_owners ORDER BY service_id'
        )
        .all()
      if (!(await auth()).allowed) return error('forbidden', 403)
      return json({ items: rows.results })
    }
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'developer-ownership',
      limit: 30,
      windowSeconds: 3600,
      now: Math.floor(Date.parse(now) / 1000)
    })
    if (!quota.allowed) return error('quota_exceeded', 429)
    const command = request.headers.get('idempotency-key') ?? ''
    if (!z.string().uuid().safeParse(command).success) return error('invalid_idempotency_key', 400)
    const parsed = schema.safeParse(await readBody(request))
    if (!parsed.success) return error('invalid_input', 422)
    const input = parsed.data,
      digest = await hash(JSON.stringify(input))
    const read = () =>
      deps.database
        .prepare(
          'SELECT payload_hash,service_id,owner,version,created_at FROM developer_ownership_commands WHERE actor_id=? AND command_id=?'
        )
        .bind(claims.identityId, command)
        .first<{ payload_hash: string; service_id: string; owner: string; version: number; created_at: string }>()
    const response = (row: NonNullable<Awaited<ReturnType<typeof read>>>) =>
      row.payload_hash === digest
        ? json({ serviceId: row.service_id, owner: row.owner, version: row.version, updatedAt: row.created_at })
        : error('idempotency_conflict', 409)
    const prior = await read()
    if (prior) {
      if (!(await auth()).allowed) return error('forbidden', 403)
      return response(prior)
    }
    if (!(await auth()).allowed) return error('forbidden', 403)
    const cookieDeadline = await verifiedAdminCookieDeadline(request, deps.sessionCookieConfiguration, claims)
    if (cookieDeadline === null || !(await auth()).allowed) return error('forbidden', 403)
    try {
      const result = await deps.database
        .prepare(
          `INSERT INTO developer_ownership_commands(actor_id,command_id,payload_hash,service_id,owner,version,created_at)
       SELECT ?3,?5,?6,?7,?8,?9,${databaseClock} WHERE ${actor} AND COALESCE((SELECT version FROM developer_service_owners WHERE service_id=?7),0)=?10
       RETURNING payload_hash,service_id,owner,version,created_at`
        )
        .bind(
          deps.now ?? null,
          claims.sessionId,
          claims.identityId,
          claims.sessionVersion,
          command,
          digest,
          input.serviceId,
          input.owner,
          input.expectedVersion + 1,
          input.expectedVersion,
          cookieDeadline
        )
        .first<NonNullable<Awaited<ReturnType<typeof read>>>>()
      if (result) {
        if (!(await auth()).allowed) return error('forbidden', 403)
        return response(result)
      }
    } catch {
      const replay = await read()
      if (replay) {
        if (!(await auth()).allowed) return error('forbidden', 403)
        return response(replay)
      }
    }
    if (!(await auth()).allowed) return error('forbidden', 403)
    const current = await deps.database
      .prepare('SELECT version FROM developer_service_owners WHERE service_id=?')
      .bind(input.serviceId)
      .first<{ version: number }>()
    return (current?.version ?? 0) !== input.expectedVersion
      ? error('version_conflict', 409)
      : error('service_unavailable', 503)
  } catch {
    return error('service_unavailable', 503)
  }
}
