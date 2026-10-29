import { safeRecordAdminSessionDeviceSignal, safeRecordMfaChangeSignal } from './security-anomalies'
import { findRecoveryCode, validateTotp } from '../../server/domain/mfa'
import { decryptSecret, hashOpaqueToken } from '../../server/utils/secrets'

interface Challenge {
  id: string
  identity_id: string
  session_version: number
  encrypted_secret: string
  last_used_step: number | null
  recovery_code_hashes: string
}

/** Internal password-challenge completion, not an HTTP login or enrollment API.
 * Password verification must issue the challenge; raw identity IDs never suffice.
 */
export async function completeD1MfaChallenge(
  database: D1Database,
  input: {
    challenge: string
    code: string
    tokenPepper: string
    encryptionKey: string
    now?: string
    /** SEC-035 optional peppered network evidence (64 hex) for alert-only signals. */
    ipHash?: string | null
    userAgentHash?: string | null
  }
) {
  const now = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const timestamp = Date.parse(now)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, 'Z') !== now)
    throw new Error('invalid_mfa_instant')
  if (!input.tokenPepper || input.tokenPepper.length < 32 || input.tokenPepper.startsWith('local-only-'))
    throw new Error('invalid_mfa_configuration')
  const invalid = { ok: false as const, code: 'invalid_mfa_challenge' as const }
  if (
    !/^[A-Za-z0-9_-]{43,86}$/.test(input.challenge) ||
    typeof input.code !== 'string' ||
    input.code.length < 6 ||
    input.code.length > 32
  )
    return invalid
  const challenge = await database
    .prepare(
      `SELECT c.id, c.identity_id, c.session_version,
      m.encrypted_secret, m.last_used_step, m.recovery_code_hashes
    FROM mfa_challenges c JOIN identities i ON i.id = c.identity_id
    JOIN identity_mfa m ON m.identity_id = i.id AND m.verified_at IS NOT NULL AND m.verified_at <= ?1
    WHERE c.token_hash = ?2 AND c.used_at IS NULL AND c.created_at <= ?1 AND c.expires_at > ?1 AND c.attempts < 6
      AND i.status IN ('pending', 'active') AND i.session_version = c.session_version`
    )
    .bind(now, hashOpaqueToken(input.challenge, input.tokenPepper))
    .first<Challenge>()
  if (!challenge) return invalid
  const recoveryHashes: unknown = JSON.parse(challenge.recovery_code_hashes)
  if (
    !Array.isArray(recoveryHashes) ||
    !recoveryHashes.every((hash): hash is string => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash))
  )
    throw new Error('invalid_mfa_storage')
  const step = validateTotp({
    secret: decryptSecret(challenge.encrypted_secret, input.encryptionKey),
    token: input.code.trim(),
    timestamp,
    lastUsedStep: challenge.last_used_step
  })
  const recovery = step === null ? findRecoveryCode(input.code, recoveryHashes, input.tokenPepper) : null
  if (step === null && !recovery) {
    await database
      .prepare('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = ? AND used_at IS NULL AND attempts < 6')
      .bind(challenge.id)
      .run()
    return invalid
  }
  const sessionId = crypto.randomUUID()
  const expiresAt = new Date(timestamp + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  try {
    await database.batch([
      database
        .prepare(
          `UPDATE mfa_challenges SET used_at = ?1, consumption_id = ?2, attempts = attempts + 1
        WHERE id = ?3 AND used_at IS NULL AND created_at <= ?1 AND expires_at > ?1 AND attempts < 6
          AND EXISTS(SELECT 1 FROM identities i JOIN identity_mfa m ON m.identity_id = i.id
            WHERE i.id = mfa_challenges.identity_id AND i.session_version = mfa_challenges.session_version
              AND i.status IN ('pending', 'active') AND m.verified_at IS NOT NULL AND m.verified_at <= ?1
              AND m.encrypted_secret = ?4 AND m.last_used_step IS ?5 AND m.recovery_code_hashes = ?6)`
        )
        .bind(
          now,
          sessionId,
          challenge.id,
          challenge.encrypted_secret,
          challenge.last_used_step,
          challenge.recovery_code_hashes
        ),
      database
        .prepare(
          `UPDATE identity_mfa SET last_used_step = ?1, recovery_code_hashes = ?2, updated_at = ?3
        WHERE identity_id = ?4 AND EXISTS(SELECT 1 FROM mfa_challenges WHERE id = ?5 AND consumption_id = ?6)`
        )
        .bind(
          step ?? challenge.last_used_step,
          recovery ? JSON.stringify(recovery.remaining) : challenge.recovery_code_hashes,
          now,
          challenge.identity_id,
          challenge.id,
          sessionId
        ),
      database
        .prepare(
          `INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at, last_seen_at)
        SELECT ?1, identity_id, session_version, 1, ?2, ?3, ?2 FROM mfa_challenges WHERE id = ?4 AND consumption_id = ?1`
        )
        .bind(sessionId, now, expiresAt, challenge.id),
      // Deliberate named CHECK failure rolls back every write on a lost race.
      database
        .prepare(
          `INSERT INTO mfa_challenges(id, identity_id, session_version, token_hash, created_at, expires_at, used_at)
        SELECT ?1, ?2, 1, ?3, ?4, ?5, ?4 WHERE NOT EXISTS(SELECT 1 FROM auth_sessions WHERE id = ?1)`
        )
        .bind(sessionId, challenge.identity_id, '0'.repeat(64), now, expiresAt)
    ])
  } catch (error) {
    if (error instanceof Error && error.message.includes('mfa_challenge_consumption')) return invalid
    throw error
  }
  // SEC-035: alert-only signals derived from this committed session; failures never affect authentication.
  await safeRecordAdminSessionDeviceSignal(database, {
    identityId: challenge.identity_id,
    sessionId,
    ipHash: input.ipHash ?? null,
    userAgentHash: input.userAgentHash ?? null,
    occurredAt: now
  })
  if (recovery)
    await safeRecordMfaChangeSignal(database, {
      identityId: challenge.identity_id,
      sessionId,
      changeType: 'mfa_recovery_code_used',
      sourceEventId: sessionId,
      ipHash: input.ipHash ?? null,
      userAgentHash: input.userAgentHash ?? null,
      occurredAt: now,
      onlyIfAdmin: true
    })
  return {
    ok: true as const,
    sessionId,
    identityId: challenge.identity_id,
    sessionVersion: challenge.session_version,
    expiresAt
  }
}
