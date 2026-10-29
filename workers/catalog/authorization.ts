/** Claims must come from the verified server-side session cookie, not a request
 * body or a bare session ID. This module authorizes; it does not authenticate a
 * password, verify cookie signatures or grant object/organization ownership.
 */
export interface VerifiedSessionClaims {
  sessionId: string
  identityId: string
  sessionVersion: number
}

export type AuthorizationResult =
  | { allowed: true; identityId: string; sessionId: string }
  | { allowed: false; code: 'unauthenticated' | 'email_unverified' | 'mfa_required' | 'forbidden' }

export async function authorizeD1Session(
  database: D1Database,
  claims: VerifiedSessionClaims,
  permission: string,
  options: { now?: string; requireMfa?: boolean } = {}
): Promise<AuthorizationResult> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const instant = Date.parse(now)
  if (!Number.isFinite(instant) || new Date(instant).toISOString().replace(/\.\d{3}Z$/, 'Z') !== now)
    throw new Error('invalid_authorization_instant')
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(permission) || permission.length > 100)
    throw new Error('invalid_permission')
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (
    !claims ||
    !uuid.test(claims.sessionId) ||
    !uuid.test(claims.identityId) ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 1
  ) {
    return { allowed: false, code: 'unauthenticated' }
  }
  // Read permission grants fresh: revocation/role expiry must affect the next
  // operation, regardless of the role names cached in the sealed cookie.
  const row = await database
    .prepare(
      `SELECT i.id, s.mfa_verified,
    (i.email_verified_at IS NOT NULL AND i.email_verified_at <= ?1) AS email_verified,
    EXISTS(SELECT 1 FROM identity_roles assigned
      JOIN role_permissions granted ON granted.role_code = assigned.role_code
      WHERE assigned.identity_id = i.id AND granted.permission_code = ?2
        AND assigned.granted_at <= ?1 AND (assigned.expires_at IS NULL OR assigned.expires_at > ?1)) AS permitted
    FROM auth_sessions s JOIN identities i ON i.id = s.identity_id
    WHERE s.id = ?3 AND s.identity_id = ?4 AND s.session_version = ?5
      AND s.session_version = i.session_version AND s.revoked_at IS NULL
      AND s.created_at <= ?1 AND s.expires_at > ?1
      AND i.status IN ('pending', 'active')`
    )
    .bind(now, permission, claims.sessionId, claims.identityId, claims.sessionVersion)
    .first<{ id: string; mfa_verified: number; email_verified: number; permitted: number }>()
  if (!row) return { allowed: false, code: 'unauthenticated' }
  if (!row.email_verified) return { allowed: false, code: 'email_unverified' }
  if ((options.requireMfa ?? true) && !row.mfa_verified) return { allowed: false, code: 'mfa_required' }
  if (!row.permitted) return { allowed: false, code: 'forbidden' }
  return { allowed: true, identityId: row.id, sessionId: claims.sessionId }
}
