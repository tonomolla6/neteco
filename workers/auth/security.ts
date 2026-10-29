import { SENSITIVE_RATE_LIMIT_POLICIES } from '../../server/utils/abuse-limit'
import { consumeIdentityQuota } from './identity-quota'
import { hashWorkerPassword, verifyWorkerPassword } from './password'
import { verifySessionCookie } from './session-cookie'
import type { SessionCookieConfiguration } from './session-cookie'
import { prepareAccountSecurityNotice } from '../communications/account-security-notices'

type Claims = NonNullable<Awaited<ReturnType<typeof verifySessionCookie>>>

const liveSessionSql = `SELECT i.id FROM auth_sessions s
JOIN identities i ON i.id = s.identity_id AND i.session_version = s.session_version
JOIN customers c ON c.id = i.customer_id AND c.status = 'active'
WHERE s.id = ? AND s.identity_id = ? AND s.session_version = ?
  AND i.status IN ('pending', 'active') AND s.revoked_at IS NULL
  AND s.created_at <= ? AND s.expires_at > ?`

function nowUtc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function liveBinds(claims: Claims, now: string) {
  return [claims.sessionId, claims.identityId, claims.sessionVersion, now, now] as const
}

async function sessionIsLive(database: D1Database, claims: Claims, now: string) {
  return Boolean(
    await database
      .prepare(liveSessionSql)
      .bind(...liveBinds(claims, now))
      .first<{ id: string }>()
  )
}

export async function listD1AccountSessions(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration
) {
  const claims = await verifySessionCookie(request, configuration)
  if (!claims) return null
  const now = nowUtc()
  const result = await database
    .prepare(
      `WITH current AS (${liveSessionSql})
      SELECT target.id, target.mfa_verified AS mfaVerified,
        target.created_at AS createdAt,
        COALESCE(target.last_seen_at, target.created_at) AS lastSeenAt,
        target.expires_at AS expiresAt,
        (target.id = ?) AS isCurrent
      FROM current JOIN auth_sessions target ON target.identity_id = current.id
      WHERE target.session_version = ? AND target.revoked_at IS NULL
        AND target.created_at <= ? AND target.expires_at > ?
      ORDER BY lastSeenAt DESC, target.created_at DESC, target.id DESC`
    )
    .bind(...liveBinds(claims, now), claims.sessionId, claims.sessionVersion, now, now)
    .all<{
      id: string
      mfaVerified: number
      createdAt: string
      lastSeenAt: string
      expiresAt: string
      isCurrent: number
    }>()
  if (!result.results.length) return null
  return result.results.map(({ isCurrent, mfaVerified, ...session }) => ({
    ...session,
    mfaVerified: Boolean(mfaVerified),
    current: Boolean(isCurrent)
  }))
}

export async function revokeD1AccountSession(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration,
  targetId: string
): Promise<'revoked' | 'current_session' | 'not_found' | 'unauthenticated'> {
  const claims = await verifySessionCookie(request, configuration)
  if (!claims) return 'unauthenticated'
  const now = nowUtc()
  if (targetId === claims.sessionId)
    return (await sessionIsLive(database, claims, now)) ? 'current_session' : 'unauthenticated'
  const updated = await database
    .prepare(
      `UPDATE auth_sessions SET revoked_at = ?
      WHERE id = ? AND identity_id = (${liveSessionSql})
        AND session_version = ? AND revoked_at IS NULL AND expires_at > ?
      RETURNING id`
    )
    .bind(now, targetId, ...liveBinds(claims, now), claims.sessionVersion, now)
    .first<{ id: string }>()
  if (updated) return 'revoked'
  return (await sessionIsLive(database, claims, now)) ? 'not_found' : 'unauthenticated'
}

export type PasswordChangeResult =
  | { ok: true; sessionVersion: number; identityId: string; sessionId: string }
  | {
      ok: false
      code: 'unauthenticated' | 'mfa_required' | 'invalid_password' | 'same_password' | 'rate_limited' | 'conflict'
      retryAfter?: number
    }

/** Password rotation keeps only the current session and gives it a new version.
 * The final guard deliberately violates a named CHECK on a lost race, rolling
 * back every statement in the D1 batch rather than leaving a half-rotated user.
 */
export async function changeD1Password(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration,
  input: { currentPassword: string; newPassword: string }
): Promise<PasswordChangeResult> {
  const claims = await verifySessionCookie(request, configuration)
  if (!claims) return { ok: false, code: 'unauthenticated' }
  const now = nowUtc()
  const current = await database
    .prepare(
      `SELECT i.email, i.password_hash, i.session_version, s.mfa_verified, m.verified_at AS mfa_enabled
      FROM auth_sessions s JOIN identities i ON i.id = s.identity_id
      JOIN customers c ON c.id = i.customer_id AND c.status = 'active'
      LEFT JOIN identity_mfa m ON m.identity_id = i.id
      WHERE s.id = ? AND s.identity_id = ? AND s.session_version = ?
        AND i.session_version = s.session_version AND i.status IN ('pending', 'active')
        AND s.revoked_at IS NULL AND s.created_at <= ? AND s.expires_at > ?`
    )
    .bind(...liveBinds(claims, now))
    .first<{
      email: string
      password_hash: string
      session_version: number
      mfa_verified: number
      mfa_enabled: string | null
    }>()
  if (!current) return { ok: false, code: 'unauthenticated' }
  if (current.mfa_enabled && !current.mfa_verified) return { ok: false, code: 'mfa_required' }
  const quota = await consumeIdentityQuota(database, {
    identityId: claims.identityId,
    scope: 'account-password',
    ...SENSITIVE_RATE_LIMIT_POLICIES['account-password']
  })
  if (!quota.allowed) return { ok: false, code: 'rate_limited', retryAfter: quota.retryAfter }
  if (!(await verifyWorkerPassword(current.password_hash, input.currentPassword)))
    return { ok: false, code: 'invalid_password' }
  if (input.currentPassword === input.newPassword) return { ok: false, code: 'same_password' }
  const newHash = await hashWorkerPassword(input.newPassword)
  const nextVersion = current.session_version + 1
  if (!Number.isSafeInteger(nextVersion)) throw new Error('session_version_overflow')
  const guardId = crypto.randomUUID()
  const notice = await prepareAccountSecurityNotice(database, {
    eventId: crypto.randomUUID(),
    identityId: claims.identityId,
    kind: 'password_changed',
    recipient: current.email,
    sessionVersion: nextVersion,
    now
  })
  try {
    await database.batch([
      database
        .prepare(
          `UPDATE identities SET password_hash = ?, session_version = session_version + 1, updated_at = ?
          WHERE id = ? AND password_hash = ? AND session_version = ? AND status IN ('pending', 'active')
            AND EXISTS(SELECT 1 FROM auth_sessions s JOIN customers c ON c.id = identities.customer_id
              LEFT JOIN identity_mfa m ON m.identity_id = identities.id
              WHERE s.id = ? AND s.identity_id = identities.id AND s.session_version = ?
                AND s.revoked_at IS NULL AND s.created_at <= ? AND s.expires_at > ?
                AND c.status = 'active' AND (m.verified_at IS NULL OR s.mfa_verified = 1))`
        )
        .bind(
          newHash,
          now,
          claims.identityId,
          current.password_hash,
          claims.sessionVersion,
          claims.sessionId,
          claims.sessionVersion,
          now,
          now
        ),
      database
        .prepare(
          `UPDATE auth_sessions SET session_version = ?, last_seen_at = ?
          WHERE id = ? AND identity_id = ? AND session_version = ?
            AND revoked_at IS NULL AND created_at <= ? AND expires_at > ?
            AND EXISTS(SELECT 1 FROM identities i WHERE i.id = ? AND i.session_version = ? AND i.password_hash = ?)`
        )
        .bind(
          nextVersion,
          now,
          claims.sessionId,
          claims.identityId,
          claims.sessionVersion,
          now,
          now,
          claims.identityId,
          nextVersion,
          newHash
        ),
      database
        .prepare(
          `UPDATE auth_sessions SET revoked_at = ?
          WHERE identity_id = ? AND id <> ? AND revoked_at IS NULL AND expires_at > ?
            AND EXISTS(SELECT 1 FROM auth_sessions current
              WHERE current.id = ? AND current.identity_id = ? AND current.session_version = ?
                AND current.revoked_at IS NULL)`
        )
        .bind(now, claims.identityId, claims.sessionId, now, claims.sessionId, claims.identityId, nextVersion),
      ...notice,
      database
        .prepare(
          `INSERT INTO identity_security_events(id, identity_id, event_type, created_at)
          SELECT ?, ?, 'guard-impossible', ? WHERE NOT EXISTS(
            SELECT 1 FROM auth_sessions s JOIN identities i ON i.id = s.identity_id
            WHERE s.id = ? AND s.identity_id = ? AND s.session_version = ?
              AND i.session_version = s.session_version AND i.password_hash = ?
              AND s.revoked_at IS NULL AND s.created_at <= ? AND s.expires_at > ?)`
        )
        .bind(guardId, claims.identityId, now, claims.sessionId, claims.identityId, nextVersion, newHash, now, now)
    ])
  } catch (cause) {
    const stillLive = await sessionIsLive(database, claims, now)
    if (!stillLive) return { ok: false, code: 'unauthenticated' }
    const currentHash = await database
      .prepare('SELECT password_hash FROM identities WHERE id = ?')
      .bind(claims.identityId)
      .first<{ password_hash: string }>()
    if (currentHash?.password_hash !== current.password_hash) return { ok: false, code: 'conflict' }
    throw cause
  }
  return { ok: true, sessionVersion: nextVersion, identityId: claims.identityId, sessionId: claims.sessionId }
}
