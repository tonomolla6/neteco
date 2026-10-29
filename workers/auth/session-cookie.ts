import { defaults, seal, unseal } from 'iron-webcrypto'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { ironCrypto } from './iron-crypto'

export interface SessionCookieConfiguration {
  password: string
  maxAgeSeconds: number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateSessionCookieConfiguration(configuration: SessionCookieConfiguration) {
  const { password, maxAgeSeconds } = configuration
  if (
    typeof password !== 'string' ||
    password.length < 32 ||
    password.startsWith('local-only-') ||
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds < 1 ||
    maxAgeSeconds > 30 * 86400
  )
    throw new Error('invalid_session_configuration')
}

/** Internal issuer: callers must obtain claims from password/MFA authentication,
 * never from request JSON. Rechecks the persisted session before sealing. Every
 * protected request still checks D1 so concurrent revocation remains effective.
 */
export async function issueD1SessionCookie(
  database: D1Database,
  claims: VerifiedSessionClaims,
  configuration: SessionCookieConfiguration
): Promise<string | null> {
  validateSessionCookieConfiguration(configuration)
  const now = Date.now()
  const instant = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const session = await database
    .prepare(
      `SELECT s.expires_at FROM auth_sessions s
    JOIN identities i ON i.id = s.identity_id
    WHERE s.id = ?1 AND s.identity_id = ?2 AND s.session_version = ?3
      AND i.session_version = s.session_version AND i.status IN ('active', 'pending')
      AND s.revoked_at IS NULL AND s.created_at <= ?4 AND s.expires_at > ?4`
    )
    .bind(claims.sessionId, claims.identityId, claims.sessionVersion, instant)
    .first<{ expires_at: string }>()
  if (!session) return null
  const maxAge = Math.min(configuration.maxAgeSeconds, Math.floor((Date.parse(session.expires_at) - now) / 1000))
  if (!Number.isSafeInteger(maxAge) || maxAge < 1) return null
  const sealed = await seal(
    ironCrypto,
    {
      id: crypto.randomUUID(),
      createdAt: now,
      data: { sessionId: claims.sessionId, sessionVersion: claims.sessionVersion, user: { id: claims.identityId } }
    },
    configuration.password,
    { ...defaults, ttl: maxAge * 1000 }
  )
  return `neteco-session=${encodeURIComponent(sealed)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
}

export const clearedSessionCookie = 'neteco-session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'

/** Logout requires the HTTP caller to apply its origin/CSRF policy first. */
export async function revokeD1Session(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration
) {
  const claims = await verifySessionCookie(request, configuration)
  if (claims) {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    await database
      .prepare(
        `UPDATE auth_sessions SET revoked_at = ?1
      WHERE id = ?2 AND identity_id = ?3 AND session_version = ?4
        AND revoked_at IS NULL AND created_at <= ?1`
      )
      .bind(now, claims.sessionId, claims.identityId, claims.sessionVersion)
      .run()
  }
  return clearedSessionCookie
}

/** Verifies the installed Nuxt/h3 iron-webcrypto v1 session envelope. Only the
 * cookie is accepted; roles and MFA flags in its data are never authorization.
 * Configuration errors throw; invalid/expired cookies return the same null.
 */
export async function verifySessionCookie(
  request: Request,
  configuration: SessionCookieConfiguration
): Promise<VerifiedSessionClaims | null> {
  const { password, maxAgeSeconds } = configuration
  validateSessionCookieConfiguration(configuration)
  const header = request.headers.get('cookie')
  if (!header || header.length > 8192) return null
  let sealed: string | undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== 'neteco-session') continue
    if (sealed !== undefined) return null
    try {
      sealed = decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return null
    }
  }
  if (!sealed || sealed.length > 4096) return null
  let session: unknown
  try {
    session = await unseal(ironCrypto, sealed, password, { ...defaults, ttl: maxAgeSeconds * 1000 })
  } catch {
    return null
  }
  const now = Date.now()
  if (
    !record(session) ||
    typeof session.createdAt !== 'number' ||
    !Number.isSafeInteger(session.createdAt) ||
    session.createdAt > now ||
    now - session.createdAt >= maxAgeSeconds * 1000 ||
    !record(session.data)
  )
    return null
  const data = session.data
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (
    typeof session.id !== 'string' ||
    !uuid.test(session.id) ||
    typeof data.sessionId !== 'string' ||
    !uuid.test(data.sessionId) ||
    typeof data.sessionVersion !== 'number' ||
    !Number.isSafeInteger(data.sessionVersion) ||
    data.sessionVersion < 1 ||
    !record(data.user) ||
    typeof data.user.id !== 'string' ||
    !uuid.test(data.user.id)
  )
    return null
  return { sessionId: data.sessionId, identityId: data.user.id, sessionVersion: data.sessionVersion }
}
