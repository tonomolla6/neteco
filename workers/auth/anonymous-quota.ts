import { hashOpaqueToken } from '../../server/utils/secrets'
import { SENSITIVE_RATE_LIMIT_POLICIES } from '../../server/utils/abuse-limit'

/** Exact D1 window after native edge protection. Subjects are canonical trusted
 * IPs or normalized email strings, not database identity IDs (no enumeration).
 */
export async function consumeAuthenticationQuota(
  database: D1Database,
  input: {
    subject: string
    kind: 'ip' | 'email'
    scope:
      | 'login'
      | 'mfa-complete'
      | 'register'
      | 'forgot-password'
      | 'reset-password'
      | 'verify-email'
      | 'account-email-change'
    pepper: string
    now?: number
  }
) {
  if (typeof input.pepper !== 'string' || input.pepper.length < 32 || input.pepper.startsWith('local-only-'))
    throw new Error('invalid_auth_quota_configuration')
  const now = input.now ?? Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(now) || now < 0 || !input.subject || input.subject.length > 254)
    throw new Error('invalid_auth_quota_input')
  const policy = SENSITIVE_RATE_LIMIT_POLICIES[input.scope]
  const hash = hashOpaqueToken(`neteco:auth-quota:v1:${input.kind}:${input.subject}`, input.pepper)
  const result = await database
    .prepare(
      `INSERT INTO authentication_rate_limits(subject_hash, scope, used, expires_at)
    VALUES (?1, ?2, 1, ?3 + ?4)
    ON CONFLICT(subject_hash, scope) DO UPDATE SET
      used = CASE WHEN authentication_rate_limits.expires_at <= ?3 THEN 1 ELSE min(authentication_rate_limits.used + 1, ?5 + 1) END,
      expires_at = CASE WHEN authentication_rate_limits.expires_at <= ?3 THEN ?3 + ?4 ELSE authentication_rate_limits.expires_at END
    RETURNING used, expires_at`
    )
    .bind(hash, input.scope, now, policy.windowSeconds, policy.limit)
    .first<{ used: number; expires_at: number }>()
  if (!result) throw new Error('auth_quota_unavailable')
  return { allowed: result.used <= policy.limit, retryAfter: Math.max(1, result.expires_at - now) }
}

export async function pruneAuthenticationQuotas(database: D1Database) {
  return database
    .prepare(
      `DELETE FROM authentication_rate_limits WHERE rowid IN
    (SELECT rowid FROM authentication_rate_limits WHERE expires_at <= ? ORDER BY expires_at LIMIT 500)`
    )
    .bind(Math.floor(Date.now() / 1000))
    .run()
}
