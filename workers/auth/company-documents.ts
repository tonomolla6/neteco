import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalPayloadHash } from '../catalog/cart'
import {
  COMPANY_DOCUMENT_LIMIT,
  companyDocumentInputSchema,
  companyDocumentListSchema,
  companyDocumentReceiptSchema,
  companyDocumentReviewSchema
} from '../../shared/company-documents'
import { AdminCompaniesError, authorizeD1CompanyReview } from './admin-companies'
import {
  customerAuthority,
  finalCustomer,
  lifecycleBindings,
  lifecycleFail,
  lifecycleNow,
  lifecycleUuid,
  type AccountLifecycleOptions
} from './account-lifecycle-core'

const SELECT = `SELECT d.id,d.company_id companyId,d.kind,d.file_name fileName,d.content_type contentType,d.size_bytes sizeBytes,d.sha256,
 CASE WHEN d.removed_at IS NULL THEN 'active' ELSE 'removed' END status,d.created_at createdAt,d.removed_at removedAt`
async function ownCompany(db: D1Database, customerId: string) {
  const row = await db
    .prepare('SELECT id,status FROM companies WHERE customer_id=?1')
    .bind(customerId)
    .first<{ id: string; status: 'pending' | 'approved' | 'rejected' | 'suspended' }>()
  return row ?? lifecycleFail('not_found')
}
function receipt(raw: unknown, commandId: string | null) {
  const parsed = companyDocumentReceiptSchema.safeParse({ source: 'cloudflare', commandId, ...(raw as object) })
  return parsed.success ? parsed.data : lifecycleFail('unavailable')
}
export async function listD1CompanyDocuments(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  options: AccountLifecycleOptions = {}
) {
  const owner = await customerAuthority(db, claims, options),
    company = await ownCompany(db, owner.customerId),
    { results } = await db
      .prepare(
        `${SELECT} FROM company_documents d WHERE d.company_id=?1 AND d.removed_at IS NULL ORDER BY d.created_at,d.id`
      )
      .bind(company.id)
      .all()
  await finalCustomer(db, claims, owner.customerId, options)
  const parsed = companyDocumentListSchema.safeParse({
    source: 'cloudflare',
    companyStatus: company.status,
    limit: COMPANY_DOCUMENT_LIMIT,
    documents: results
  })
  return parsed.success ? parsed.data : lifecycleFail('unavailable')
}
async function storedByCommand(db: D1Database, companyId: string, key: string) {
  const row = await db
    .prepare(`${SELECT},d.payload_hash hash FROM company_documents d WHERE d.company_id=?1 AND d.command_id=?2`)
    .bind(companyId, key)
    .first<Record<string, unknown>>()
  if (!row) return null
  const { hash, ...rest } = row
  return { hash: String(hash), receipt: receipt(rest, key) }
}
export async function addD1CompanyDocument(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  key: string,
  input: unknown,
  options: AccountLifecycleOptions = {}
) {
  const parsed = companyDocumentInputSchema.safeParse(input)
  if (!parsed.success || !lifecycleUuid.safeParse(key).success) return lifecycleFail('invalid_input')
  const value = parsed.data,
    owner = await customerAuthority(db, claims, options),
    company = await ownCompany(db, owner.customerId),
    hash = await canonicalPayloadHash({ companyId: company.id, actorId: owner.actorId, ...value }),
    previous = await storedByCommand(db, company.id, key)
  if (previous) {
    await finalCustomer(db, claims, owner.customerId, options)
    return previous.hash === hash ? previous.receipt : lifecycleFail('conflict')
  }
  if (company.status === 'approved') return lifecycleFail('locked')
  const state = await db
    .prepare(
      `SELECT (SELECT count(*) FROM company_documents WHERE company_id=?1 AND removed_at IS NULL) active,
 EXISTS(SELECT 1 FROM company_documents WHERE company_id=?1 AND removed_at IS NULL AND sha256=?2) duplicate`
    )
    .bind(company.id, value.sha256)
    .first<{ active: number; duplicate: number }>()
  if (!state) return lifecycleFail('unavailable')
  if (state.duplicate) return lifecycleFail('conflict')
  if (state.active >= COMPANY_DOCUMENT_LIMIT) return lifecycleFail('limit_reached')
  const now = lifecycleNow(options)
  try {
    await db
      .prepare(
        `INSERT INTO company_documents(id,company_id,customer_id,command_id,payload_hash,kind,file_name,content_type,size_bytes,sha256,created_by,created_at)
 SELECT ?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?3,?1 WHERE EXISTS(SELECT 1 FROM auth_sessions s WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND s.revoked_at IS NULL AND s.expires_at>?1)`
      )
      .bind(
        ...lifecycleBindings(claims, now),
        crypto.randomUUID(),
        company.id,
        owner.customerId,
        key,
        hash,
        value.kind,
        value.fileName,
        value.contentType,
        value.sizeBytes,
        value.sha256
      )
      .run()
  } catch {
    /* Triggers reject races; the durable read below decides the outcome. */
  }
  const recovered = await storedByCommand(db, company.id, key)
  await finalCustomer(db, claims, owner.customerId, options)
  if (recovered) return recovered.hash === hash ? recovered.receipt : lifecycleFail('conflict')
  return lifecycleFail('conflict')
}
export async function removeD1CompanyDocument(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  documentId: string,
  options: AccountLifecycleOptions = {}
) {
  if (!lifecycleUuid.safeParse(documentId).success) return lifecycleFail('invalid_input')
  const owner = await customerAuthority(db, claims, options),
    company = await ownCompany(db, owner.customerId),
    read = () =>
      db
        .prepare(`${SELECT},d.removed_by removedBy FROM company_documents d WHERE d.id=?1 AND d.company_id=?2`)
        .bind(documentId, company.id)
        .first<Record<string, unknown>>()
  let row = await read()
  if (!row) return lifecycleFail('not_found')
  if (row.status === 'active') {
    const now = lifecycleNow(options)
    try {
      await db
        .prepare(
          'UPDATE company_documents SET removed_at=?1,removed_by=?2 WHERE id=?3 AND company_id=?4 AND removed_at IS NULL'
        )
        .bind(now, owner.actorId, documentId, company.id)
        .run()
    } catch {
      /* re-read below */
    }
    row = await read()
  }
  await finalCustomer(db, claims, owner.customerId, options)
  if (!row || row.status !== 'removed') return lifecycleFail('unavailable')
  const { removedBy, ...rest } = row
  void removedBy
  return receipt(rest, null)
}
const reviewRow = z.object({}).passthrough()
export async function listD1CompanyDocumentsForReview(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  companyId: string,
  options: AccountLifecycleOptions = {}
) {
  if (!lifecycleUuid.safeParse(companyId).success) return lifecycleFail('invalid_input')
  await authorizeD1CompanyReview(db, claims, options)
  const company = await db.prepare('SELECT 1 ok FROM companies WHERE id=?1').bind(companyId).first()
  if (!company) return lifecycleFail('not_found')
  const { results } = await db
    .prepare(
      `${SELECT},d.created_by createdBy,d.removed_by removedBy FROM company_documents d WHERE d.company_id=?1 ORDER BY d.created_at,d.id`
    )
    .bind(companyId)
    .all()
  await authorizeD1CompanyReview(db, claims, options)
  const parsed = companyDocumentReviewSchema.safeParse({
    source: 'cloudflare',
    companyId,
    documents: results.map((r) => reviewRow.parse(r))
  })
  return parsed.success ? parsed.data : lifecycleFail('unavailable')
}
export { AdminCompaniesError }
