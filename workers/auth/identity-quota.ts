/** Fixed window anchored at its first request, matching the legacy limiter.
 * This protects authenticated operations, not anonymous login/IP traffic.
 */
export async function consumeIdentityQuota(
  database: D1Database,
  input: {
    identityId: string
    scope: string
    limit: number
    windowSeconds: number
    now?: number
  }
) {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 10000 ||
    !Number.isSafeInteger(input.windowSeconds) ||
    input.windowSeconds < 1 ||
    input.windowSeconds > 86400 ||
    !Number.isSafeInteger(now + input.windowSeconds) ||
    !/^[a-z][a-z0-9-]{0,99}$/.test(input.scope)
  )
    throw new Error('invalid_quota_configuration')
  // One statement owns both increment and reset. No read-modify-write race or
  // in-memory counter, even when different isolates process the same identity.
  const row = await database
    .prepare(
      `INSERT INTO identity_rate_limits(identity_id, scope, used, window_started_at, expires_at)
    VALUES (?1, ?2, 1, ?3, ?3 + ?4)
    ON CONFLICT(identity_id, scope) DO UPDATE SET
      used = CASE WHEN identity_rate_limits.expires_at <= ?3 THEN 1 ELSE MIN(identity_rate_limits.used + 1, ?5 + 1) END,
      window_started_at = CASE WHEN identity_rate_limits.expires_at <= ?3 THEN ?3 ELSE identity_rate_limits.window_started_at END,
      expires_at = CASE WHEN identity_rate_limits.expires_at <= ?3 THEN ?3 + ?4 ELSE identity_rate_limits.expires_at END
    RETURNING used, expires_at`
    )
    .bind(input.identityId, input.scope, now, input.windowSeconds, input.limit)
    .first<{ used: number; expires_at: number }>()
  if (!row) throw new Error('quota_not_persisted')
  return {
    allowed: row.used <= input.limit,
    remaining: Math.max(0, input.limit - row.used),
    retryAfter: Math.max(1, row.expires_at - now)
  }
}
