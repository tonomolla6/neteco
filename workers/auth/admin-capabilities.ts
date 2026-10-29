import { ADMIN_NAVIGATION_PERMISSIONS, type AdminCapabilities } from '../../shared/admin-navigation'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { verifySessionCookie, type SessionCookieConfiguration } from './session-cookie'

/** Self-only projection, no heartbeat write and no cached role authorization. */
export async function readD1AdminCapabilities(
  database: D1Database,
  claims: VerifiedSessionClaims,
  now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
): Promise<AdminCapabilities | null> {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
  if (
    !claims ||
    !uuid.test(claims.identityId) ||
    !uuid.test(claims.sessionId) ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 1
  )
    return null
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z') !== now)
    throw new Error('invalid_capability_instant')
  const row = await database
    .prepare(
      `SELECT s.mfa_verified,
    (i.email_verified_at IS NOT NULL AND i.email_verified_at <= ?1) AS email_verified,
    (SELECT json_group_array(permission_code) FROM (SELECT DISTINCT p.permission_code
      FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
      WHERE r.identity_id=i.id AND r.granted_at<=?1 AND (r.expires_at IS NULL OR r.expires_at>?1)
      AND p.permission_code IN ('administration.manage','catalog.write','catalog.publish','inventory.read','support.manage')
      ORDER BY p.permission_code)) AS permissions
    FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
    WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND i.session_version=s.session_version
      AND i.status IN ('pending','active') AND s.revoked_at IS NULL AND s.created_at<=?1 AND s.expires_at>?1`
    )
    .bind(now, claims.sessionId, claims.identityId, claims.sessionVersion)
    .first<{ mfa_verified: number; email_verified: number; permissions: string }>()
  if (!row) return null
  const parsed: unknown = JSON.parse(row.permissions)
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (value) => typeof value === 'string' && (ADMIN_NAVIGATION_PERMISSIONS as readonly string[]).includes(value)
    )
  )
    throw new Error('invalid_capability_projection')
  const state =
    parsed.length === 0
      ? 'forbidden'
      : !row.email_verified
        ? 'email_unverified'
        : !row.mfa_verified
          ? 'mfa_required'
          : 'ready'
  return {
    source: 'cloudflare',
    ...claims,
    state,
    permissions:
      state === 'ready' ? ADMIN_NAVIGATION_PERMISSIONS.filter((permission) => parsed.includes(permission)) : []
  }
}
export interface AdminCapabilitiesHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  now?: string
}
export async function handleAdminCapabilitiesHttp(
  request: Request,
  deps: AdminCapabilitiesHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/api/admin/capabilities') return null
  const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
    Response.json(value, {
      status,
      headers: {
        'Cache-Control': 'private, no-store',
        Pragma: 'no-cache',
        Vary: 'Cookie',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        ...headers
      }
    })
  const error = (code: string, status: number, headers: Record<string, string> = {}) =>
    json({ error: { code } }, status, headers)
  if (request.method !== 'GET') return error('method_not_allowed', 405, { Allow: 'GET' })
  if (url.search) return error('invalid_input', 400)
  try {
    const origin = new URL(deps.origin)
    if (origin.protocol !== 'https:' || origin.origin !== deps.origin || deps.origin.length > 2000)
      return error('unavailable', 503)
    if (
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    const capabilities = await readD1AdminCapabilities(deps.database, claims, deps.now)
    return capabilities ? json(capabilities) : error('unauthenticated', 401)
  } catch {
    return error('unavailable', 503)
  }
}
