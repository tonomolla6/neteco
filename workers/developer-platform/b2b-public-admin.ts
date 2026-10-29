import { z } from 'zod'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import { consumeIdentityQuota } from '../auth/identity-quota'

type Dependencies = { database: D1Database; sessionCookieConfiguration: SessionCookieConfiguration; origin: string; now?: string }
const create = z.object({ action: z.literal('create'), environment: z.enum(['live', 'sandbox']), scopes: z.array(z.enum(['requests.read', 'requests.write'])).min(1).max(2).refine((a) => new Set(a).size === a.length), quotaDaily: z.number().int().min(1).max(10000) }).strict()
const revoke = z.object({ action: z.literal('revoke'), id: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict()
const schema = z.union([create, revoke])
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } })
const error = (code: string, status: number) => json({ error: { code } }, status)
async function hash(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (b) => b.toString(16).padStart(2, '0')).join('') }
const actor = `EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
 WHERE s.id=?2 AND i.id=?3 AND s.session_version=?4 AND s.revoked_at IS NULL AND s.mfa_verified=1
 AND s.created_at<=?1 AND s.expires_at>?1 AND i.status IN ('active','pending') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=?1
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id
 AND p.permission_code='administration.manage' AND r.granted_at<=?1 AND (r.expires_at IS NULL OR r.expires_at>?1)))`
async function body(request: Request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '') || !request.body) return null
  const reader = request.body.getReader(), bytes = new Uint8Array(4096)
  let size = 0
  try { while (true) { const part = await reader.read(); if (part.done) break; if (size + part.value.length > bytes.length) { await reader.cancel(); return null }; bytes.set(part.value, size); size += part.value.length }; return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))) as unknown } catch { return null } finally { reader.releaseLock() }
}
export function ownsB2bPublicAdminNamespace(pathname: string) {
  for (let i = 0; i < 4; i++) {
    if (/^\/api\/admin\/b2b-public(?:[/\\%]|$)/i.test(pathname)) return true
    try { const next = decodeURIComponent(pathname); if (next === pathname) break; pathname = next } catch { break }
  }
  return false
}
export async function handleB2bPublicAdmin(request: Request, deps: Dependencies): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsB2bPublicAdminNamespace(url.pathname)) return null
  const metrics = url.pathname === '/api/admin/b2b-public/metrics'
  if ((url.pathname !== '/api/admin/b2b-public/keys' && !metrics) || url.search) return error('not_found', 404)
  if (metrics ? request.method !== 'GET' : !['GET', 'POST'].includes(request.method)) return error('method_not_allowed', 405)
  try {
    const origin = new URL(deps.origin)
    if (origin.protocol !== 'https:' || origin.origin !== deps.origin) return error('service_unavailable', 503)
    if ((request.method === 'GET' ? request.headers.has('origin') && request.headers.get('origin') !== deps.origin : request.headers.get('origin') !== deps.origin) || request.headers.get('sec-fetch-site') === 'cross-site') return error('csrf_rejected', 403)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    const now = deps.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    const auth = async () => authorizeD1Session(deps.database, claims, 'administration.manage', { now, requireMfa: true })
    const allowed = await auth()
    if (!allowed.allowed) return error(allowed.code, allowed.code === 'unauthenticated' ? 401 : 403)
    if (!metrics && request.method === 'GET') {
      const rows = await deps.database.prepare(`SELECT id,environment,scopes,quota_daily AS quotaDaily,status,version,created_at AS createdAt FROM b2b_public_keys ORDER BY created_at DESC,id LIMIT 100`).all()
      if (!(await auth()).allowed) return error('forbidden', 403)
      return json({ items: rows.results })
    }
    if (metrics) {
      const day = now.slice(0, 10)
      const row = await deps.database.prepare(`SELECT (SELECT count(*) FROM b2b_public_keys WHERE status='active') AS activeKeys,
        (SELECT COALESCE(sum(used),0) FROM b2b_public_quota WHERE day=?) AS requestsToday`).bind(day).first<{ activeKeys: number; requestsToday: number }>()
      if (!(await auth()).allowed) return error('forbidden', 403)
      if (!row) return error('service_unavailable', 503)
      return json({ day, ...row })
    }
    const quota = await consumeIdentityQuota(deps.database, { identityId: claims.identityId, scope: 'b2b-key-admin', limit: 30, windowSeconds: 3600, now: Math.floor(Date.parse(now) / 1000) })
    if (!quota.allowed) return error('quota_exceeded', 429)
    const command = request.headers.get('idempotency-key') ?? ''
    if (!z.string().uuid().safeParse(command).success) return error('invalid_idempotency_key', 400)
    const parsed = schema.safeParse(await body(request))
    if (!parsed.success) return error('invalid_input', 422)
    const input = parsed.data
    const canonical = input.action === 'create' ? { ...input, scopes: [...input.scopes].sort() } : input
    const digest = await hash(JSON.stringify(canonical))
    const read = () => deps.database.prepare('SELECT payload_hash,key_id,action FROM b2b_public_admin_commands WHERE actor_id=? AND command_id=?').bind(claims.identityId, command).first<{payload_hash:string;key_id:string;action:string}>()
    const prior = await read()
    if (prior) {
      if (!(await auth()).allowed) return error('forbidden', 403)
      return prior.payload_hash === digest ? json({ id: prior.key_id, key: null }) : error('idempotency_conflict', 409)
    }
    const keyId = input.action === 'create' ? crypto.randomUUID() : input.id
    const secret = input.action === 'create' ? `${input.environment === 'sandbox' ? 'sbx_' : 'live_'}${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2,'0')).join('')}` : null
    const binds = [now, claims.sessionId, claims.identityId, claims.sessionVersion] as const
    const action = input.action === 'create'
      ? deps.database.prepare(`INSERT INTO b2b_public_keys(id,key_hash,environment,scopes,quota_daily,status,version,created_at) SELECT ?5,?6,?7,?8,?9,'active',1,?1 WHERE ${actor}`).bind(...binds,keyId,await hash(secret!),input.environment,[...input.scopes].sort().join(' '),input.quotaDaily)
      : deps.database.prepare(`UPDATE b2b_public_keys SET status='revoked',version=version+1 WHERE id=?5 AND status='active' AND version=?6 AND ${actor}`).bind(...binds,keyId,input.expectedVersion)
    const expected = input.action === 'create' ? 1 : input.expectedVersion + 1
    try {
      await deps.database.batch([
        action,
        deps.database.prepare(`INSERT INTO b2b_public_admin_commands(actor_id,command_id,payload_hash,action,key_id,created_at) SELECT ?3,?5,?6,?7,?8,?1 WHERE ${actor} AND changes()=1 AND EXISTS(SELECT 1 FROM b2b_public_keys WHERE id=?8 AND version=?9 AND status=?10)`).bind(...binds,command,digest,input.action,keyId,expected,input.action === 'create' ? 'active' : 'revoked'),
        deps.database.prepare(`INSERT INTO b2b_public_admin_guards(id,ok) SELECT ?5,0 WHERE NOT (${actor} AND EXISTS(SELECT 1 FROM b2b_public_admin_commands c JOIN b2b_public_admin_audit a ON a.actor_id=c.actor_id AND a.command_id=c.command_id WHERE c.actor_id=?3 AND c.command_id=?6 AND c.payload_hash=?7 AND c.key_id=?8))`).bind(...binds,crypto.randomUUID(),command,digest,keyId)
      ])
    } catch {
      const concurrent = await read()
      if (concurrent && !(await auth()).allowed) return error('forbidden', 403)
      if (concurrent) return concurrent.payload_hash === digest ? json({ id: concurrent.key_id, key: null }) : error('idempotency_conflict', 409)
      if (!(await auth()).allowed) return error('forbidden', 403)
      return error('version_conflict', 409)
    }
    if (!(await auth()).allowed) return error('forbidden', 403)
    return json({ id: keyId, key: secret }, input.action === 'create' ? 201 : 200)
  } catch { return error('service_unavailable', 503) }
}
