import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalPayloadHash } from '../catalog/cart'
import { searchSql, searchTerm } from '../catalog/admin-catalog'
import { companyStatusCanTransition } from '../../server/domain/company'
import { customerTaxIdIsValid } from '../../shared/customer-tax-validation'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import {
  companyReviewQuerySchema,
  companyReviewInputSchema,
  companyReviewListSchema,
  companyReviewReceiptSchema,
  companyReviewCommandSchema
} from '../../shared/company-review'
export interface AdminCompaniesOptions {
  now?: () => string
}
export class AdminCompaniesError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'invalid_tax_id'
      | 'unavailable'
  ) {
    super(code)
  }
}
function fail(code: AdminCompaniesError['code']): never {
  throw new AdminCompaniesError(code)
}
const uuid = z.string().uuid()
const cte = `WITH clock AS MATERIALIZED(SELECT COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now')) now),
 authority AS MATERIALIZED(SELECT i.id actorId,s.mfa_verified mfaVerified,
 (i.email_verified_at IS NOT NULL AND i.email_verified_at<=(SELECT now FROM clock)) emailVerified,
 EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=(SELECT now FROM clock)
 AND(r.expires_at IS NULL OR r.expires_at>(SELECT now FROM clock))) permitted
 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND i.session_version=s.session_version
 AND i.status IN('pending','active') AND s.revoked_at IS NULL AND s.created_at<=(SELECT now FROM clock) AND s.expires_at>(SELECT now FROM clock))`
const allowed = 'emailVerified=1 AND mfaVerified=1 AND permitted=1'
function params(claims: VerifiedSessionClaims | null, options: AdminCompaniesOptions) {
  if (
    !claims ||
    !uuid.safeParse(claims.identityId).success ||
    !uuid.safeParse(claims.sessionId).success ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 1
  )
    fail('unauthenticated')
  const now = options.now?.() ?? null
  if (now !== null && !catalogPolicyInstantSchema.safeParse(now).success) fail('unavailable')
  return [now, claims.sessionId, claims.identityId, claims.sessionVersion]
}
export async function authorizeD1CompanyReview(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  options: AdminCompaniesOptions = {}
) {
  const row = await db
    .prepare(`${cte} SELECT * FROM authority`)
    .bind(...params(claims, options))
    .first<{ actorId: string; mfaVerified: number; emailVerified: number; permitted: number }>()
  if (!row) fail('unauthenticated')
  if (row.emailVerified !== 1) fail('email_unverified')
  if (row.mfaVerified !== 1) fail('mfa_required')
  if (row.permitted !== 1) fail('forbidden')
  return row
}
export async function listD1AdminCompanies(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  query: unknown = {},
  options: AdminCompaniesOptions = {}
) {
  const parsed = companyReviewQuerySchema.safeParse(query)
  if (!parsed.success) fail('invalid_input')
  const q = parsed.data
  await authorizeD1CompanyReview(db, claims, options)
  const row = await db
    .prepare(
      `${cte}, matching AS MATERIALIZED(
 SELECT c.*,i.email contact_email,r.created_at reviewed_at,CASE WHEN c.status IN('rejected','suspended') THEN r.reason ELSE NULL END rejection_reason
 FROM companies c JOIN customers customer ON customer.id=c.customer_id LEFT JOIN identities i ON i.customer_id=c.customer_id
 LEFT JOIN company_admin_review_commands r ON r.company_id=c.id AND r.command_id=c.last_change_id
 WHERE c.created_at<=(SELECT now FROM clock) AND c.updated_at<=(SELECT now FROM clock)
 AND (?5='' OR instr(${searchSql('c.legal_name')},?5)>0 OR instr(${searchSql("COALESCE(c.trade_name,'')")},?5)>0 OR instr(lower(COALESCE(c.tax_id,'')),?5)>0)
 AND (?6 IS NULL OR c.status=?6)), company_page AS MATERIALIZED(
 SELECT * FROM matching ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,created_at DESC,id LIMIT ?7 OFFSET ?8)
 SELECT (SELECT count(*) FROM matching) total,(SELECT json_group_array(json_object('id',id,'legalName',legal_name,'tradeName',trade_name,
 'taxId',tax_id,'countryCode',country_code,'status',status,'createdAt',created_at,'updatedAt',updated_at,'contactEmail',contact_email,
 'currentChangeId',last_change_id,'reviewedAt',reviewed_at,'rejectionReason',rejection_reason)) FROM company_page) items
 FROM authority WHERE ${allowed}`
    )
    .bind(...params(claims, options), searchTerm(q.q), q.status ?? null, q.perPage, (q.page - 1) * q.perPage)
    .first<{ total: number; items: string }>()
  await authorizeD1CompanyReview(db, claims, options)
  if (!row) fail('unavailable')
  return companyReviewListSchema.parse({
    source: 'cloudflare',
    items: JSON.parse(row.items),
    total: row.total,
    page: q.page,
    perPage: q.perPage
  })
}
interface Stored {
  command_id: string
  company_id: string
  actor_id: string
  payload_hash: string
  to_status: string
  created_at: string
}
function receipt(row: Stored) {
  return companyReviewReceiptSchema.parse({
    source: 'cloudflare',
    companyId: row.company_id,
    commandId: row.command_id,
    status: row.to_status,
    changeId: row.command_id,
    createdAt: row.created_at
  })
}
async function stored(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  key: string,
  options: AdminCompaniesOptions
) {
  return db
    .prepare(
      `${cte} SELECT c.* FROM company_admin_review_commands c,authority WHERE ${allowed} AND c.company_id=?5 AND c.command_id=?6 AND c.actor_id=actorId`
    )
    .bind(...params(claims, options), id, key)
    .first<Stored>()
}
async function company(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  options: AdminCompaniesOptions
) {
  if (!uuid.safeParse(id).success) fail('not_found')
  const row = await db
    .prepare(
      `${cte} SELECT c.status,c.last_change_id,c.tax_id,c.country_code FROM companies c,authority WHERE ${allowed} AND c.id=?5 AND c.created_at<=(SELECT now FROM clock) AND c.updated_at<=(SELECT now FROM clock)`
    )
    .bind(...params(claims, options), id)
    .first<{
      status: 'pending' | 'approved' | 'rejected' | 'suspended'
      last_change_id: string | null
      tax_id: string | null
      country_code: string
    }>()
  if (!row) {
    await authorizeD1CompanyReview(db, claims, options)
    fail('not_found')
  }
  return row
}
export async function readD1CompanyReviewCommand(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  key: string,
  options: AdminCompaniesOptions = {}
) {
  if (!uuid.safeParse(key).success) fail('invalid_input')
  await authorizeD1CompanyReview(db, claims, options)
  await company(db, claims, id, options)
  const row = await stored(db, claims, id, key, options)
  await authorizeD1CompanyReview(db, claims, options)
  return companyReviewCommandSchema.parse({
    source: 'cloudflare',
    companyId: id,
    commandId: key,
    outcome: row ? 'applied' : 'unknown',
    receipt: row ? receipt(row) : null
  })
}
export async function executeD1CompanyReview(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  key: string,
  input: unknown,
  options: AdminCompaniesOptions = {}
) {
  const parsed = companyReviewInputSchema.safeParse(input)
  if (!parsed.success || !uuid.safeParse(key).success) fail('invalid_input')
  await authorizeD1CompanyReview(db, claims, options)
  const current = await company(db, claims, id, options),
    value = parsed.data
  const hash = await canonicalPayloadHash({ companyId: id, actorId: claims!.identityId, ...value })
  const previous = await stored(db, claims, id, key, options)
  if (previous) {
    if (previous.payload_hash !== hash) fail('conflict')
    const recovered = await readD1CompanyReviewCommand(db, claims, id, key, options)
    if (!recovered.receipt) fail('unavailable')
    return recovered.receipt
  }
  if (
    current.last_change_id !== value.expectedChangeId ||
    current.status !== value.expectedStatus ||
    !companyStatusCanTransition(current.status, value.status)
  )
    fail('conflict')
  if (
    value.status === 'approved' &&
    (!current.tax_id || !customerTaxIdIsValid(current.country_code, current.tax_id, { required: true }))
  )
    fail('invalid_tax_id')
  let batchFailed = false
  try {
    await db.batch([
      db
        .prepare(
          `${cte} INSERT INTO company_admin_review_commands(command_id,company_id,actor_id,session_id,session_version,payload_hash,expected_change_id,from_status,to_status,reason,tax_id_suffix,created_at)
 SELECT ?5,c.id,actorId,?2,?4,?7,?8,?9,?10,?11,substr(c.tax_id,-4),(SELECT now FROM clock)
 FROM companies c,authority WHERE ${allowed} AND c.id=?6 AND c.last_change_id IS ?8 AND c.status=?9 AND c.tax_id IS ?12 AND c.country_code=?13 AND c.updated_at<=(SELECT now FROM clock)`
        )
        .bind(
          ...params(claims, options),
          key,
          id,
          hash,
          value.expectedChangeId,
          value.expectedStatus,
          value.status,
          value.reason,
          current.tax_id,
          current.country_code
        )
    ])
  } catch {
    batchFailed = true
  }
  // Lost transport is not absence: resolve only from the authorized durable
  // command, never by automatically submitting another review.
  const result = await readD1CompanyReviewCommand(db, claims, id, key, options)
  if (result.receipt) {
    const confirmed = await stored(db, claims, id, key, options)
    await authorizeD1CompanyReview(db, claims, options)
    if (!confirmed || confirmed.payload_hash !== hash) fail('conflict')
    return result.receipt
  }
  const fresh = await company(db, claims, id, options)
  await authorizeD1CompanyReview(db, claims, options)
  if (fresh.last_change_id !== value.expectedChangeId || fresh.status !== value.expectedStatus) fail('conflict')
  if (batchFailed) fail('unavailable')
  fail('conflict')
}
