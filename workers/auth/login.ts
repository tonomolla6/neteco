import { verifyWorkerPassword } from './password'
import { hashOpaqueToken, randomOpaqueToken } from '../../server/utils/secrets'

// A syntactically valid, non-account hash makes unknown-user attempts execute
// the normal scrypt cost. Its result can never authenticate an absent identity.
const dummyHash = '$scrypt$n=16384,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86)

/** Internal credential exchange. HTTP callers must enforce body limits,
 * trusted-origin CSRF and pre-auth abuse limits before expensive verification.
 * Never returns a session for an identity with verified MFA.
 */
export async function loginD1(
  database: D1Database,
  input: {
    email: string
    password: string
    tokenPepper: string
    now?: string
  }
) {
  const invalid = { ok: false as const, code: 'invalid_credentials' as const }
  if (
    typeof input.tokenPepper !== 'string' ||
    input.tokenPepper.length < 32 ||
    input.tokenPepper.startsWith('local-only-')
  )
    throw new Error('invalid_login_configuration')
  const now = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const timestamp = Date.parse(now)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, 'Z') !== now)
    throw new Error('invalid_login_instant')
  if (
    typeof input.email !== 'string' ||
    input.email.length > 254 ||
    typeof input.password !== 'string' ||
    input.password.length < 1 ||
    input.password.length > 128
  )
    return invalid
  const identity = await database
    .prepare(
      `SELECT i.id, i.password_hash, i.session_version, i.status,
    EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id = i.id AND m.verified_at IS NOT NULL) AS mfa
    FROM identities i WHERE i.email = ?`
    )
    .bind(input.email.trim().toLowerCase())
    .first<{
      id: string
      password_hash: string
      session_version: number
      status: string
      mfa: number
    }>()
  const verified = await verifyWorkerPassword(identity?.password_hash ?? dummyHash, input.password)
  if (!identity || !verified || !['active', 'pending'].includes(identity.status)) return invalid
  const id = crypto.randomUUID()
  const expiresAt = new Date(timestamp + (identity.mfa ? 300_000 : 3600_000)).toISOString().replace(/\.\d{3}Z$/, 'Z')
  // Revalidate password/version/MFA state inside the same statement that grants
  // the result. Password reset or enrollment during scrypt cannot bypass MFA.
  const eligibility = `SELECT id FROM identities WHERE id = ?1 AND password_hash = ?2 AND session_version = ?3
    AND status IN ('active', 'pending') AND
    EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id = identities.id AND m.verified_at IS NOT NULL) = ?4`
  if (identity.mfa) {
    const challenge = randomOpaqueToken()
    const inserted = await database
      .prepare(
        `INSERT INTO mfa_challenges(id, identity_id, session_version, token_hash, created_at, expires_at)
      SELECT ?5, id, ?3, ?6, ?7, ?8 FROM identities WHERE id IN (${eligibility}) RETURNING id`
      )
      .bind(
        identity.id,
        identity.password_hash,
        identity.session_version,
        1,
        id,
        hashOpaqueToken(challenge, input.tokenPepper),
        now,
        expiresAt
      )
      .first<{ id: string }>()
    return inserted ? { ok: true as const, kind: 'mfa_required' as const, challenge, expiresAt } : invalid
  }
  const inserted = await database
    .prepare(
      `INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at, last_seen_at)
    SELECT ?5, id, ?3, 0, ?6, ?7, ?6 FROM identities WHERE id IN (${eligibility}) RETURNING id`
    )
    .bind(identity.id, identity.password_hash, identity.session_version, 0, id, now, expiresAt)
    .first<{ id: string }>()
  return inserted
    ? {
        ok: true as const,
        kind: 'session' as const,
        sessionId: id,
        identityId: identity.id,
        sessionVersion: identity.session_version,
        expiresAt
      }
    : invalid
}
