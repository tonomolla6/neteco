import { createTotpEnrollment, generateRecoveryCodes, recoveryCodeHashes, validateTotp } from '../../server/domain/mfa'
import { SENSITIVE_RATE_LIMIT_POLICIES } from '../../server/utils/abuse-limit'
import { decryptSecret, encryptSecret } from '../../server/utils/secrets'
import { consumeIdentityQuota } from './identity-quota'
import { verifyWorkerPassword } from './password'
import { verifySessionCookie } from './session-cookie'
import type { SessionCookieConfiguration } from './session-cookie'
import { prepareAccountSecurityNotice } from '../communications/account-security-notices'

type Configuration = SessionCookieConfiguration & { tokenPepper: string; encryptionKey: string }
type FailureCode =
  | 'unauthenticated'
  | 'email_unverified'
  | 'mfa_already_enabled'
  | 'invalid_password'
  | 'invalid_mfa_setup'
  | 'rate_limited'

type Failure = { ok: false; code: FailureCode; retryAfter?: number }

const nowUtc = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

async function quota(database: D1Database, identityId: string): Promise<Failure | null> {
  const outcome = await consumeIdentityQuota(database, {
    identityId,
    scope: 'mfa-setup',
    ...SENSITIVE_RATE_LIMIT_POLICIES['mfa-setup']
  })
  return outcome.allowed ? null : { ok: false, code: 'rate_limited', retryAfter: outcome.retryAfter }
}

/** Enrollment requires the current password and verified email. A pending
 * enrollment is replaceable; an activated factor is never replaced here.
 */
export async function beginD1MfaEnrollment(
  database: D1Database,
  request: Request,
  configuration: Configuration,
  currentPassword: string
): Promise<Failure | { ok: true; setupId: string; uri: string; manualKey: string; recoveryCodes: string[] }> {
  const claims = await verifySessionCookie(request, configuration)
  if (!claims) return { ok: false, code: 'unauthenticated' }
  const now = nowUtc()
  const row = await database
    .prepare(
      `SELECT i.email, i.password_hash, i.email_verified_at, m.verified_at AS mfa_enabled
      FROM auth_sessions s JOIN identities i ON i.id = s.identity_id
      JOIN customers c ON c.id = i.customer_id AND c.status = 'active'
      LEFT JOIN identity_mfa m ON m.identity_id = i.id
      WHERE s.id = ?1 AND s.identity_id = ?2 AND s.session_version = ?3
        AND i.session_version = s.session_version AND i.status IN ('pending', 'active')
        AND s.revoked_at IS NULL AND s.created_at <= ?4 AND s.expires_at > ?4`
    )
    .bind(claims.sessionId, claims.identityId, claims.sessionVersion, now)
    .first<{ email: string; password_hash: string; email_verified_at: string | null; mfa_enabled: string | null }>()
  if (!row) return { ok: false, code: 'unauthenticated' }
  if (!row.email_verified_at || row.email_verified_at > now) return { ok: false, code: 'email_unverified' }
  if (row.mfa_enabled) return { ok: false, code: 'mfa_already_enabled' }
  const denied = await quota(database, claims.identityId)
  if (denied) return denied
  if (!(await verifyWorkerPassword(row.password_hash, currentPassword))) return { ok: false, code: 'invalid_password' }

  const setupId = crypto.randomUUID()
  const { secret, uri } = createTotpEnrollment(row.email)
  const recoveryCodes = generateRecoveryCodes()
  const expiresAt = new Date(Date.parse(now) + 10 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const inserted = await database
    .prepare(
      `INSERT INTO mfa_enrollments(id, identity_id, session_id, session_version, encrypted_secret, recovery_code_hashes,
        attempts, created_at, expires_at, activation_id)
      SELECT ?1, i.id, ?9, ?8, ?2, ?3, 0, ?4, ?5, NULL
      FROM identities i JOIN auth_sessions s ON s.identity_id = i.id
      JOIN customers c ON c.id = i.customer_id AND c.status = 'active'
      WHERE i.id = ?6 AND i.password_hash = ?7 AND i.status IN ('pending', 'active')
        AND i.email_verified_at IS NOT NULL AND i.email_verified_at <= ?4
        AND i.session_version = ?8 AND s.id = ?9 AND s.session_version = ?8
        AND s.revoked_at IS NULL AND s.created_at <= ?4 AND s.expires_at > ?4
        AND NOT EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id = i.id AND m.verified_at IS NOT NULL)
      ON CONFLICT(identity_id) DO UPDATE SET
        id = excluded.id, session_id = excluded.session_id, session_version = excluded.session_version,
        encrypted_secret = excluded.encrypted_secret,
        recovery_code_hashes = excluded.recovery_code_hashes, attempts = 0,
        created_at = excluded.created_at, expires_at = excluded.expires_at, activation_id = NULL
      RETURNING id`
    )
    .bind(
      setupId,
      encryptSecret(secret, configuration.encryptionKey),
      JSON.stringify(recoveryCodeHashes(recoveryCodes, configuration.tokenPepper)),
      now,
      expiresAt,
      claims.identityId,
      row.password_hash,
      claims.sessionVersion,
      claims.sessionId
    )
    .first<{ id: string }>()
  if (!inserted || inserted.id !== setupId) return { ok: false, code: 'unauthenticated' }
  return { ok: true, setupId, uri, manualKey: secret, recoveryCodes }
}

interface PendingEnrollment {
  email: string
  encrypted_secret: string
  recovery_code_hashes: string
}

/** The activation marker is unique per attempt and the final CHECK guard
 * rolls back the entire D1 batch if any session/factor precondition is lost.
 */
export async function verifyD1MfaEnrollment(
  database: D1Database,
  request: Request,
  configuration: Configuration,
  input: { setupId: string; code: string }
): Promise<Failure | { ok: true }> {
  const claims = await verifySessionCookie(request, configuration)
  if (!claims) return { ok: false, code: 'unauthenticated' }
  const now = nowUtc()
  const denied = await quota(database, claims.identityId)
  if (denied) return denied
  const enrollment = await database
    .prepare(
      `SELECT i.email, e.encrypted_secret, e.recovery_code_hashes
      FROM mfa_enrollments e JOIN identities i ON i.id = e.identity_id
      JOIN customers c ON c.id = i.customer_id AND c.status = 'active'
      JOIN auth_sessions s ON s.identity_id = i.id
      WHERE e.id = ?1 AND e.identity_id = ?2 AND e.session_id = ?5
        AND e.session_version = ?4 AND e.activation_id IS NULL
        AND e.created_at <= ?3 AND e.expires_at > ?3 AND e.attempts < 6
        AND i.status IN ('pending', 'active') AND i.email_verified_at IS NOT NULL
        AND i.email_verified_at <= ?3 AND i.session_version = ?4
        AND s.id = ?5 AND s.session_version = ?4 AND s.revoked_at IS NULL
        AND s.created_at <= ?3 AND s.expires_at > ?3
        AND NOT EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id = i.id AND m.verified_at IS NOT NULL)`
    )
    .bind(input.setupId, claims.identityId, now, claims.sessionVersion, claims.sessionId)
    .first<PendingEnrollment>()
  if (!enrollment) return { ok: false, code: 'invalid_mfa_setup' }
  const step = validateTotp({
    secret: decryptSecret(enrollment.encrypted_secret, configuration.encryptionKey),
    token: input.code,
    timestamp: Date.parse(now)
  })
  if (step === null) {
    await database
      .prepare(
        `UPDATE mfa_enrollments SET attempts = attempts + 1
        WHERE id = ? AND identity_id = ? AND session_id = ? AND session_version = ? AND activation_id IS NULL
          AND created_at <= ? AND expires_at > ? AND attempts < 6`
      )
      .bind(input.setupId, claims.identityId, claims.sessionId, claims.sessionVersion, now, now)
      .run()
    return { ok: false, code: 'invalid_mfa_setup' }
  }
  const activationId = crypto.randomUUID()
  const notice = await prepareAccountSecurityNotice(database, {
    eventId: activationId,
    identityId: claims.identityId,
    kind: 'mfa_enabled',
    recipient: enrollment.email,
    sessionVersion: claims.sessionVersion,
    now,
    domainEventId: activationId
  })
  try {
    await database.batch([
      database
        .prepare(
          `UPDATE mfa_enrollments SET activation_id = ?1, attempts = attempts + 1
          WHERE id = ?2 AND identity_id = ?3 AND session_id = ?7 AND session_version = ?8
            AND activation_id IS NULL
            AND encrypted_secret = ?4 AND recovery_code_hashes = ?5
            AND created_at <= ?6 AND expires_at > ?6 AND attempts < 6
            AND NOT EXISTS(SELECT 1 FROM identity_mfa m
              WHERE m.identity_id = mfa_enrollments.identity_id AND m.verified_at IS NOT NULL)`
        )
        .bind(
          activationId,
          input.setupId,
          claims.identityId,
          enrollment.encrypted_secret,
          enrollment.recovery_code_hashes,
          now,
          claims.sessionId,
          claims.sessionVersion
        ),
      database
        .prepare(
          `INSERT INTO identity_mfa(identity_id, encrypted_secret, recovery_code_hashes,
            verified_at, last_used_step, updated_at)
          SELECT identity_id, encrypted_secret, recovery_code_hashes, ?1, ?2, ?1
          FROM mfa_enrollments WHERE id = ?3 AND identity_id = ?4 AND activation_id = ?5
          ON CONFLICT(identity_id) DO UPDATE SET
            encrypted_secret = excluded.encrypted_secret,
            recovery_code_hashes = excluded.recovery_code_hashes,
            verified_at = excluded.verified_at,
            last_used_step = excluded.last_used_step,
            updated_at = excluded.updated_at
          WHERE identity_mfa.verified_at IS NULL`
        )
        .bind(now, step, input.setupId, claims.identityId, activationId),
      database
        .prepare(
          `UPDATE auth_sessions SET mfa_verified = 1, last_seen_at = ?1
          WHERE id = ?2 AND identity_id = ?3 AND session_version = ?4
            AND revoked_at IS NULL AND created_at <= ?1 AND expires_at > ?1
            AND EXISTS(SELECT 1 FROM identities i JOIN customers c ON c.id = i.customer_id
              JOIN identity_mfa m ON m.identity_id = i.id
              JOIN mfa_enrollments e ON e.identity_id = i.id
              WHERE i.id = ?3 AND i.session_version = ?4 AND i.status IN ('pending', 'active')
                AND c.status = 'active' AND e.id = ?5 AND e.activation_id = ?6
                AND e.session_id = ?2 AND e.session_version = ?4
                AND m.verified_at = ?1 AND m.encrypted_secret = e.encrypted_secret
                AND m.last_used_step = ?7)`
        )
        .bind(now, claims.sessionId, claims.identityId, claims.sessionVersion, input.setupId, activationId, step),
      database
        .prepare(
          `UPDATE auth_sessions SET revoked_at = ?1
          WHERE identity_id = ?2 AND id <> ?3 AND revoked_at IS NULL AND expires_at > ?1
            AND EXISTS(SELECT 1 FROM auth_sessions current
              WHERE current.id = ?3 AND current.identity_id = ?2
                AND current.session_version = ?4 AND current.mfa_verified = 1
                AND current.revoked_at IS NULL)`
        )
        .bind(now, claims.identityId, claims.sessionId, claims.sessionVersion),
      database
        .prepare(
          `INSERT INTO identity_security_events(id, identity_id, event_type, created_at)
          SELECT ?1, ?2, 'guard-impossible', ?3 WHERE NOT EXISTS(
            SELECT 1 FROM mfa_enrollments e JOIN identity_mfa m ON m.identity_id = e.identity_id
            JOIN auth_sessions s ON s.identity_id = e.identity_id
            JOIN identities i ON i.id = e.identity_id
            WHERE e.id = ?4 AND e.identity_id = ?2 AND e.activation_id = ?5
              AND m.encrypted_secret = e.encrypted_secret AND m.verified_at = ?3
              AND m.last_used_step = ?6 AND s.id = ?7 AND s.session_version = ?8
              AND e.session_id = ?7 AND e.session_version = ?8
              AND s.mfa_verified = 1 AND s.revoked_at IS NULL AND s.expires_at > ?3
              AND i.session_version = ?8)`
        )
        .bind(
          crypto.randomUUID(),
          claims.identityId,
          now,
          input.setupId,
          activationId,
          step,
          claims.sessionId,
          claims.sessionVersion
        ),
      // Keep the original activation CHECK first so lost enrollment/session
      // races retain their existing failure contract. Both guards still roll
      // back the entire batch, before the enrollment is consumed.
      ...notice,
      database
        .prepare('DELETE FROM mfa_enrollments WHERE id = ? AND identity_id = ? AND activation_id = ?')
        .bind(input.setupId, claims.identityId, activationId)
    ])
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes('identity_security_event_type'))
      return { ok: false, code: 'invalid_mfa_setup' }
    throw cause
  }
  return { ok: true }
}

/** Bounded scheduled cleanup: an expired pending secret must not persist
 * indefinitely just because its owner never retries the setup flow.
 */
export async function pruneD1MfaEnrollments(database: D1Database, now: string) {
  await database
    .prepare(
      `DELETE FROM mfa_enrollments WHERE id IN (
        SELECT id FROM mfa_enrollments WHERE expires_at <= ?
        ORDER BY expires_at, id LIMIT 100
      )`
    )
    .bind(now)
    .run()
}
