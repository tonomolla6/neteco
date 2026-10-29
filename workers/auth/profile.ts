import { primaryRole } from '../../shared/identity-roles'
import { verifySessionCookie } from './session-cookie'
import type { SessionCookieConfiguration } from './session-cookie'

/** Nuxt session refresh projection. Never trusts cached user/role/MFA fields.
 * No session lifetime extension: expiry and version remain authoritative in D1.
 */
export async function readD1UserSession(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration
) {
  const claims = await verifySessionCookie(request, configuration)
  if (!claims) return {}
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const row = await database
    .prepare(
      `SELECT i.id, i.email, s.mfa_verified, c.name, c.phone, company.legal_name AS company,
    (i.email_verified_at IS NOT NULL AND i.email_verified_at <= ?1) AS email_verified,
    (SELECT json_group_array(role_code) FROM (SELECT role_code FROM identity_roles
      WHERE identity_id = i.id AND granted_at <= ?1 AND (expires_at IS NULL OR expires_at > ?1)
      ORDER BY role_code)) AS roles
    FROM auth_sessions s JOIN identities i ON i.id = s.identity_id
    LEFT JOIN customers c ON c.id = i.customer_id AND c.status = 'active'
    LEFT JOIN companies company ON company.customer_id = c.id
    WHERE s.id = ?2 AND s.identity_id = ?3 AND s.session_version = ?4
      AND i.session_version = s.session_version AND i.status IN ('pending', 'active')
      AND s.revoked_at IS NULL AND s.created_at <= ?1 AND s.expires_at > ?1`
    )
    .bind(now, claims.sessionId, claims.identityId, claims.sessionVersion)
    .first<{
      id: string
      email: string
      mfa_verified: number
      email_verified: number
      roles: string
      name: string | null
      phone: string | null
      company: string | null
    }>()
  if (!row) return {}
  const parsed: unknown = JSON.parse(row.roles)
  if (!Array.isArray(parsed) || !parsed.every((role) => typeof role === 'string'))
    throw new Error('invalid_profile_roles')
  // The Nuxt session refresh is the activity heartbeat. Write at most once
  // every five minutes, without extending either the cookie or D1 expiry.
  const touchBefore = new Date(Date.parse(now) - 300_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  await database
    .prepare(
      `UPDATE auth_sessions SET last_seen_at = ?1
      WHERE id = ?2 AND identity_id = ?3 AND session_version = ?4
        AND revoked_at IS NULL AND created_at <= ?1 AND expires_at > ?1
        AND (last_seen_at IS NULL OR last_seen_at <= ?5)`
    )
    .bind(now, claims.sessionId, claims.identityId, claims.sessionVersion, touchBefore)
    .run()
  const roles = parsed.length ? parsed : ['customer']
  return {
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      phone: row.phone,
      company: row.company,
      role: primaryRole(roles),
      roles,
      emailVerified: Boolean(row.email_verified),
      mfaVerified: Boolean(row.mfa_verified)
    },
    sessionId: claims.sessionId,
    sessionVersion: claims.sessionVersion
  }
}

/** Account-page projection. The signed cookie identifies a session; ownership
 * is resolved again from D1 in the same query that reads personal/fiscal data.
 */
export async function readD1AccountProfile(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration
) {
  const claims = await verifySessionCookie(request, configuration)
  if (!claims) return null
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const row = await database
    .prepare(
      `SELECT i.email, c.name, c.phone,
      company.id AS company_id, company.legal_name AS company,
      company.trade_name, company.tax_id, company.country_code,
      company.status AS company_status
    FROM auth_sessions s JOIN identities i ON i.id = s.identity_id
    LEFT JOIN customers c ON c.id = i.customer_id AND c.status = 'active'
    LEFT JOIN companies company ON company.customer_id = c.id
    WHERE s.id = ?1 AND s.identity_id = ?2 AND s.session_version = ?3
      AND i.session_version = s.session_version AND i.status IN ('pending', 'active')
      AND s.revoked_at IS NULL AND s.created_at <= ?4 AND s.expires_at > ?4`
    )
    .bind(claims.sessionId, claims.identityId, claims.sessionVersion, now)
    .first<{
      email: string
      name: string | null
      phone: string | null
      company_id: string | null
      company: string | null
      trade_name: string | null
      tax_id: string | null
      country_code: string | null
      company_status: string | null
    }>()
  if (!row) return null
  return {
    name: row.name,
    phone: row.phone,
    email: row.email,
    companyId: row.company_id,
    company: row.company,
    tradeName: row.trade_name,
    taxId: row.tax_id,
    countryCode: row.country_code,
    companyStatus: row.company_status,
    companyRole: null
  }
}

/** Single-statement owner-scoped update; a stale/revoked session writes nothing. */
export async function updateD1CustomerProfile(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration,
  input: { name: string; phone: string | null }
) {
  const claims = await verifySessionCookie(request, configuration)
  if (!claims) return false
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const updated = await database
    .prepare(
      `UPDATE customers SET name = ?1, phone = ?2, updated_at = ?3
    WHERE id = (SELECT i.customer_id FROM auth_sessions s JOIN identities i ON i.id = s.identity_id
      WHERE s.id = ?4 AND s.identity_id = ?5 AND s.session_version = ?6
        AND i.session_version = s.session_version AND i.status IN ('pending', 'active')
        AND s.revoked_at IS NULL AND s.created_at <= ?3 AND s.expires_at > ?3)
      AND status = 'active' RETURNING id`
    )
    .bind(input.name, input.phone, now, claims.sessionId, claims.identityId, claims.sessionVersion)
    .first<{ id: string }>()
  return Boolean(updated)
}
