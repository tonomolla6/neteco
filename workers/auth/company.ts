import { normalizeCustomerTaxId, customerTaxIdIsValid } from '../../shared/customer-tax-validation'
import { SENSITIVE_RATE_LIMIT_POLICIES } from '../../server/utils/abuse-limit'
import { consumeIdentityQuota } from './identity-quota'
import { verifyWorkerPassword } from './password'
import { verifySessionCookie } from './session-cookie'
import type { SessionCookieConfiguration } from './session-cookie'
import { prepareAccountSecurityNotice } from '../communications/account-security-notices'

export type CompanyUpdateResult =
  | { ok: true; companyId: string; status: 'pending' | 'approved' | 'rejected' | 'suspended' }
  | {
      ok: false
      code:
        | 'unauthenticated'
        | 'email_unverified'
        | 'mfa_required'
        | 'invalid_password'
        | 'rate_limited'
        | 'duplicate_tax_id'
        | 'invalid_tax_id'
      retryAfter?: number
    }

/** Owner-only fiscal submission. The password and session are checked again
 * inside the D1 batch after scrypt, so a simultaneous reset/revocation cannot
 * write. Every successful write has a matching append-only redacted event.
 */
export async function submitD1CompanyDetails(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration,
  input: { legalName: string; tradeName: string; taxId: string; countryCode: string; currentPassword: string }
): Promise<CompanyUpdateResult> {
  const claims = await verifySessionCookie(request, configuration)
  if (!claims) return { ok: false, code: 'unauthenticated' }
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const row = await database
    .prepare(
      `SELECT i.customer_id, i.email, i.password_hash, i.email_verified_at,
      s.mfa_verified, m.verified_at AS mfa_enabled
    FROM auth_sessions s JOIN identities i ON i.id = s.identity_id
    JOIN customers c ON c.id = i.customer_id AND c.status = 'active'
    LEFT JOIN identity_mfa m ON m.identity_id = i.id
    WHERE s.id = ?1 AND s.identity_id = ?2 AND s.session_version = ?3
      AND i.session_version = s.session_version AND i.status IN ('pending', 'active')
      AND s.revoked_at IS NULL AND s.created_at <= ?4 AND s.expires_at > ?4`
    )
    .bind(claims.sessionId, claims.identityId, claims.sessionVersion, now)
    .first<{
      customer_id: string
      email: string
      password_hash: string
      email_verified_at: string | null
      mfa_verified: number
      mfa_enabled: string | null
    }>()
  if (!row) return { ok: false, code: 'unauthenticated' }
  if (!row.email_verified_at || row.email_verified_at > now) return { ok: false, code: 'email_unverified' }
  if (row.mfa_enabled && !row.mfa_verified) return { ok: false, code: 'mfa_required' }
  const policy = SENSITIVE_RATE_LIMIT_POLICIES['professional-account']
  const quota = await consumeIdentityQuota(database, {
    identityId: claims.identityId,
    scope: 'professional-account',
    ...policy
  })
  if (!quota.allowed) return { ok: false, code: 'rate_limited', retryAfter: quota.retryAfter }
  const taxId = normalizeCustomerTaxId(input.taxId)
  if (!customerTaxIdIsValid(input.countryCode, taxId, { required: true })) return { ok: false, code: 'invalid_tax_id' }
  if (!(await verifyWorkerPassword(row.password_hash, input.currentPassword)))
    return { ok: false, code: 'invalid_password' }

  const changeId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const securityNotice = await prepareAccountSecurityNotice(database, {
    eventId: changeId,
    identityId: claims.identityId,
    kind: 'fiscal_details_submitted',
    recipient: row.email,
    sessionVersion: claims.sessionVersion,
    domainEventId: changeId,
    now
  })
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO companies(id, customer_id, legal_name, trade_name, tax_id,
          country_code, status, created_at, updated_at, last_change_id)
        SELECT ?1, i.customer_id, ?2, ?3, ?4, ?5, 'pending', ?6, ?6, ?7
        FROM identities i JOIN auth_sessions s ON s.identity_id = i.id
        JOIN customers c ON c.id = i.customer_id AND c.status = 'active'
        LEFT JOIN identity_mfa m ON m.identity_id = i.id
        WHERE i.id = ?8 AND s.id = ?9 AND s.session_version = ?10
          AND i.session_version = s.session_version AND i.password_hash = ?11
          AND i.customer_id = ?12 AND i.email = ?13
          AND i.status IN ('pending', 'active') AND i.email_verified_at IS NOT NULL
          AND i.email_verified_at <= ?6 AND (m.verified_at IS NULL OR s.mfa_verified = 1)
          AND s.revoked_at IS NULL AND s.created_at <= ?6 AND s.expires_at > ?6
        ON CONFLICT(customer_id) DO UPDATE SET
          legal_name = excluded.legal_name, trade_name = excluded.trade_name,
          tax_id = excluded.tax_id, country_code = excluded.country_code,
          status = CASE WHEN companies.legal_name <> excluded.legal_name
            OR companies.tax_id IS NOT excluded.tax_id
            OR companies.country_code <> excluded.country_code
            THEN 'pending' ELSE companies.status END,
          updated_at = excluded.updated_at, last_change_id = excluded.last_change_id`
        )
        .bind(
          companyId,
          input.legalName,
          input.tradeName || null,
          taxId,
          input.countryCode,
          now,
          changeId,
          claims.identityId,
          claims.sessionId,
          claims.sessionVersion,
          row.password_hash,
          row.customer_id,
          row.email
        ),
      database
        .prepare(
          `INSERT INTO company_review_events(id, company_id, actor_identity_id,
          event_type, tax_id_suffix, created_at)
        SELECT ?1, id, ?2, 'submitted', substr(tax_id, -4), ?3
        FROM companies WHERE customer_id = ?4 AND last_change_id = ?1`
        )
        .bind(changeId, claims.identityId, now, row.customer_id),
      ...securityNotice
    ])
  } catch (error) {
    if (error instanceof Error && error.message.includes('account_security_notice_atomic_guard')) {
      // A rejected atomic notice is not automatically an authentication error.
      // Only a fresh proof that this original owner authority disappeared may
      // classify the zero-write race as unauthenticated; outages still throw.
      const freshNow = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      const live = await database
        .prepare(
          `SELECT i.id FROM identities i
        JOIN auth_sessions s ON s.identity_id=i.id
        JOIN customers c ON c.id=i.customer_id AND c.status='active'
        LEFT JOIN identity_mfa m ON m.identity_id=i.id
        WHERE i.id=?1 AND s.id=?2 AND s.session_version=?3
        AND i.session_version=s.session_version AND i.customer_id=?4 AND i.email=?5 AND i.password_hash=?6
        AND i.status IN('pending','active') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=?7
        AND(m.verified_at IS NULL OR s.mfa_verified=1)
        AND s.revoked_at IS NULL AND s.created_at<=?7 AND s.expires_at>?7`
        )
        .bind(
          claims.identityId,
          claims.sessionId,
          claims.sessionVersion,
          row.customer_id,
          row.email,
          row.password_hash,
          freshNow
        )
        .first()
      if (!live) return { ok: false, code: 'unauthenticated' }
    }
    if (
      error instanceof Error &&
      error.message.includes('companies.country_code') &&
      error.message.includes('companies.tax_id')
    )
      return { ok: false, code: 'duplicate_tax_id' }
    throw error
  }
  const company = await database
    .prepare(
      `SELECT c.id, c.status FROM companies c
    JOIN company_review_events e ON e.company_id = c.id AND e.id = ?1
    WHERE c.customer_id = ?2 AND c.last_change_id = ?1 AND e.actor_identity_id = ?3`
    )
    .bind(changeId, row.customer_id, claims.identityId)
    .first<{ id: string; status: 'pending' | 'approved' | 'rejected' | 'suspended' }>()
  return company ? { ok: true, companyId: company.id, status: company.status } : { ok: false, code: 'unauthenticated' }
}
