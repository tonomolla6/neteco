import {
  calculateNextReviewDate,
  computeReviewGovernanceStatus,
  createCaseStudySchema,
  evaluateCaseStudyPayloadHash,
  evaluatePublishReadiness,
  performPeriodicReviewSchema,
  updateCaseStudySchema,
  validateStrictNoCommunityPayload,
  type CreateCaseStudyInput,
  type PerformPeriodicReviewInput,
  type PublicCaseStudy,
  type ReviewGovernanceStatus,
  type UpdateCaseStudyInput
} from '../../shared/customer-case-studies'

export class CaseStudyError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'not_found'
      | 'unauthorized'
      | 'forbidden'
      | 'version_conflict'
      | 'idempotency_conflict'
      | 'publish_not_allowed'
      | 'already_published'
      | 'review_overdue'
      | 'community_features_forbidden'
  ) {
    super(code)
    this.name = 'CaseStudyError'
  }
}

export const liveAdminSql = (param: string) =>
  `EXISTS(SELECT 1 FROM identities i JOIN identity_roles ir ON ir.identity_id = i.id
     JOIN role_permissions rp ON rp.role_code = ir.role_code
     WHERE i.id = ${param} AND i.status = 'active' AND rp.permission_code = 'administration.manage'
       AND (ir.expires_at IS NULL OR ir.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`

export async function requireAdmin(db: D1Database, identityId: string): Promise<void> {
  const row = await db
    .prepare(`SELECT ${liveAdminSql('?1')} AS ok`)
    .bind(identityId)
    .first<{ ok: number }>()
  if (!row?.ok) throw new CaseStudyError('forbidden')
}

interface CaseStudyRow {
  id: string
  slug: string
  title: string
  subtitle: string | null
  publication_status: string
  permission_signer_name: string
  permission_signer_role: string
  permission_company_name: string
  permission_company_cif: string
  permission_document_ref: string
  permission_document_sha256: string
  permission_signed_at: string
  permission_scope: string
  publish_authorized_by_customer: number
  sector: string
  facility_description: string
  initial_situation: string
  baseline_metrics_json: string
  neteco_products_json: string
  dosage_protocol: string
  implementation_duration_weeks: number
  solution_summary: string
  outcome_metrics_json: string
  verification_method: string
  verifier_identity: string
  verification_certificate_ref: string | null
  verification_evidence_sha256: string
  review_interval_months: number
  last_reviewed_at: string
  last_reviewed_by: string
  next_review_due_at: string
  review_status: string
  cover_image_url: string | null
  version: number
  published_at: string | null
  created_at: string
  updated_at: string
}

export interface CaseStudyAdminResult {
  id: string
  slug: string
  title: string
  subtitle: string | null
  publicationStatus: string
  signedPermission: {
    signerName: string
    signerRole: string
    companyName: string
    companyCif: string
    documentRef: string
    documentSha256: string
    signedAt: string
    scope: string
    publishAuthorized: boolean
  }
  context: {
    sector: string
    facilityDescription: string
    initialSituation: string
    baselineMetrics: unknown[]
  }
  solution: {
    netecoProducts: string[]
    dosageProtocol: string
    implementationDurationWeeks: number
    solutionSummary: string
  }
  verifiableOutcome: {
    outcomeMetrics: unknown[]
    verificationMethod: string
    verifierIdentity: string
    certificateRef: string | null
    evidenceSha256: string
  }
  reviewIntervalMonths: number
  lastReviewedAt: string
  lastReviewedBy: string
  nextReviewDueAt: string
  reviewStatus: ReviewGovernanceStatus
  coverImageUrl: string | null
  version: number
  publishedAt: string | null
  createdAt: string
}

function mapRowToAdminResult(row: CaseStudyRow): CaseStudyAdminResult {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    publicationStatus: row.publication_status,
    signedPermission: {
      signerName: row.permission_signer_name,
      signerRole: row.permission_signer_role,
      companyName: row.permission_company_name,
      companyCif: row.permission_company_cif,
      documentRef: row.permission_document_ref,
      documentSha256: row.permission_document_sha256,
      signedAt: row.permission_signed_at,
      scope: row.permission_scope,
      publishAuthorized: row.publish_authorized_by_customer === 1
    },
    context: {
      sector: row.sector,
      facilityDescription: row.facility_description,
      initialSituation: row.initial_situation,
      baselineMetrics: JSON.parse(row.baseline_metrics_json)
    },
    solution: {
      netecoProducts: JSON.parse(row.neteco_products_json),
      dosageProtocol: row.dosage_protocol,
      implementationDurationWeeks: row.implementation_duration_weeks,
      solutionSummary: row.solution_summary
    },
    verifiableOutcome: {
      outcomeMetrics: JSON.parse(row.outcome_metrics_json),
      verificationMethod: row.verification_method,
      verifierIdentity: row.verifier_identity,
      certificateRef: row.verification_certificate_ref,
      evidenceSha256: row.verification_evidence_sha256
    },
    reviewIntervalMonths: row.review_interval_months,
    lastReviewedAt: row.last_reviewed_at,
    lastReviewedBy: row.last_reviewed_by,
    nextReviewDueAt: row.next_review_due_at,
    reviewStatus: row.review_status as ReviewGovernanceStatus,
    coverImageUrl: row.cover_image_url,
    version: row.version,
    publishedAt: row.published_at,
    createdAt: row.created_at
  }
}

export interface CreateCaseStudyParams {
  actorId: string
  now?: string
  input: CreateCaseStudyInput
}

export async function createCaseStudy(db: D1Database, params: CreateCaseStudyParams): Promise<CaseStudyAdminResult> {
  await requireAdmin(db, params.actorId)

  // Enforce MKT-031: strictly NO community comments or social features
  const communityCheck = validateStrictNoCommunityPayload(params.input)
  if (!communityCheck.isClean) {
    throw new CaseStudyError('community_features_forbidden')
  }

  const parsed = createCaseStudySchema.safeParse(params.input)
  if (!parsed.success) throw new CaseStudyError('invalid_input')

  const now = params.now ?? new Date().toISOString()
  const caseId = params.input.commandId
  const payloadHash = await evaluateCaseStudyPayloadHash(parsed.data)

  // Idempotency check
  const existingCmd = await db
    .prepare('SELECT applied_version, payload_hash FROM customer_case_commands WHERE entity_id = ? AND command_id = ?')
    .bind(caseId, params.input.commandId)
    .first<{ applied_version: number; payload_hash: string }>()

  if (existingCmd) {
    if (existingCmd.payload_hash !== payloadHash) throw new CaseStudyError('idempotency_conflict')
    const existing = await getCaseStudyById(db, caseId)
    if (existing) return existing
  }

  const reviewIntervalMonths = parsed.data.reviewIntervalMonths as 3 | 6 | 12 | 24
  const nextReviewDueAt = calculateNextReviewDate(now, reviewIntervalMonths)
  const reviewStatus = computeReviewGovernanceStatus({ nextReviewDueAt, now })

  await db.batch([
    db
      .prepare(
        `INSERT INTO customer_case_studies (
          id, slug, title, subtitle, publication_status,
          permission_signer_name, permission_signer_role, permission_company_name,
          permission_company_cif, permission_document_ref, permission_document_sha256,
          permission_signed_at, permission_scope, publish_authorized_by_customer,
          sector, facility_description, initial_situation, baseline_metrics_json,
          neteco_products_json, dosage_protocol, implementation_duration_weeks,
          solution_summary, outcome_metrics_json, verification_method, verifier_identity,
          verification_certificate_ref, verification_evidence_sha256,
          review_interval_months, last_reviewed_at, last_reviewed_by, next_review_due_at,
          review_status, cover_image_url, version, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, 'draft',
          ?5, ?6, ?7,
          ?8, ?9, ?10,
          ?11, ?12, ?13,
          ?14, ?15, ?16, ?17,
          ?18, ?19, ?20,
          ?21, ?22, ?23, ?24,
          ?25, ?26,
          ?27, ?28, ?29, ?30,
          ?31, ?32, 1, ?28, ?28
        )`
      )
      .bind(
        caseId,
        parsed.data.slug,
        parsed.data.title,
        parsed.data.subtitle ?? null,
        parsed.data.signedPermission.signerName,
        parsed.data.signedPermission.signerRole,
        parsed.data.signedPermission.companyName,
        parsed.data.signedPermission.companyCif,
        parsed.data.signedPermission.documentRef,
        parsed.data.signedPermission.documentSha256,
        parsed.data.signedPermission.signedAt,
        parsed.data.signedPermission.scope,
        parsed.data.signedPermission.publishAuthorized ? 1 : 0,
        parsed.data.context.sector,
        parsed.data.context.facilityDescription,
        parsed.data.context.initialSituation,
        JSON.stringify(parsed.data.context.baselineMetrics),
        JSON.stringify(parsed.data.solution.netecoProducts),
        parsed.data.solution.dosageProtocol,
        parsed.data.solution.implementationDurationWeeks,
        parsed.data.solution.solutionSummary,
        JSON.stringify(parsed.data.verifiableOutcome.outcomeMetrics),
        parsed.data.verifiableOutcome.verificationMethod,
        parsed.data.verifiableOutcome.verifierIdentity,
        parsed.data.verifiableOutcome.certificateRef ?? null,
        parsed.data.verifiableOutcome.evidenceSha256,
        reviewIntervalMonths,
        now,
        params.actorId,
        nextReviewDueAt,
        reviewStatus,
        parsed.data.coverImageUrl ?? null
      ),
    db
      .prepare(
        `INSERT INTO customer_case_commands (
          id, actor_id, entity_id, action, command_id,
          expected_version, applied_version, payload_hash, payload_json, created_at
        ) VALUES (
          ?1, ?2, ?3, 'create_case_study', ?4,
          0, 1, ?5, ?6, ?7
        )`
      )
      .bind(
        `cmd-audit-${caseId}`,
        params.actorId,
        caseId,
        params.input.commandId,
        payloadHash,
        JSON.stringify(parsed.data),
        now
      )
  ])

  const created = await getCaseStudyById(db, caseId)
  if (!created) throw new CaseStudyError('not_found')
  return created
}

export interface PublishCaseStudyParams {
  actorId: string
  now?: string
  input: {
    caseId: string
    expectedVersion: number
    commandId: string
  }
}

export async function publishCaseStudy(db: D1Database, params: PublishCaseStudyParams): Promise<CaseStudyAdminResult> {
  await requireAdmin(db, params.actorId)

  const now = params.now ?? new Date().toISOString()
  const row = await db
    .prepare('SELECT * FROM customer_case_studies WHERE id = ?')
    .bind(params.input.caseId)
    .first<CaseStudyRow>()

  if (!row) throw new CaseStudyError('not_found')
  if (row.version !== params.input.expectedVersion) throw new CaseStudyError('version_conflict')

  // Evaluate readiness
  let outcomeMetrics: unknown[]
  try {
    outcomeMetrics = JSON.parse(row.outcome_metrics_json)
  } catch {
    outcomeMetrics = []
  }

  const currentReviewStatus = computeReviewGovernanceStatus({
    nextReviewDueAt: row.next_review_due_at,
    now
  })

  const readiness = evaluatePublishReadiness({
    publishAuthorizedByCustomer: row.publish_authorized_by_customer === 1,
    outcomeMetricsCount: outcomeMetrics.length,
    reviewStatus: currentReviewStatus,
    signedDocumentSha256: row.permission_document_sha256
  })

  if (!readiness.canPublish) {
    throw new CaseStudyError('publish_not_allowed')
  }

  const newVersion = row.version + 1
  const payloadHash = await evaluateCaseStudyPayloadHash(params.input)

  await db.batch([
    db
      .prepare(
        `UPDATE customer_case_studies SET
          publication_status = 'published', published_at = ?1,
          review_status = ?2, version = ?3, updated_at = ?1
        WHERE id = ?4 AND version = ?5`
      )
      .bind(now, currentReviewStatus, newVersion, row.id, row.version),
    db
      .prepare(
        `INSERT INTO customer_case_commands (
          id, actor_id, entity_id, action, command_id,
          expected_version, applied_version, payload_hash, payload_json, created_at
        ) VALUES (
          ?1, ?2, ?3, 'publish_case_study', ?4,
          ?5, ?6, ?7, ?8, ?9
        )`
      )
      .bind(
        `cmd-audit-${params.input.commandId}`,
        params.actorId,
        row.id,
        params.input.commandId,
        row.version,
        newVersion,
        payloadHash,
        JSON.stringify(params.input),
        now
      )
  ])

  const updated = await getCaseStudyById(db, row.id)
  if (!updated) throw new CaseStudyError('not_found')
  return updated
}

export interface PerformPeriodicReviewParams {
  actorId: string
  now?: string
  input: PerformPeriodicReviewInput
}

export async function performPeriodicReview(
  db: D1Database,
  params: PerformPeriodicReviewParams
): Promise<CaseStudyAdminResult> {
  await requireAdmin(db, params.actorId)

  const parsed = performPeriodicReviewSchema.safeParse(params.input)
  if (!parsed.success) throw new CaseStudyError('invalid_input')

  const now = params.now ?? new Date().toISOString()
  const row = await db
    .prepare('SELECT * FROM customer_case_studies WHERE id = ?')
    .bind(params.input.caseId)
    .first<CaseStudyRow>()

  if (!row) throw new CaseStudyError('not_found')
  if (row.version !== params.input.expectedVersion) throw new CaseStudyError('version_conflict')

  const nextDue = calculateNextReviewDate(now, parsed.data.nextReviewIntervalMonths)
  const newVersion = row.version + 1
  const payloadHash = await evaluateCaseStudyPayloadHash(parsed.data)

  await db.batch([
    db
      .prepare(
        `UPDATE customer_case_studies SET
          last_reviewed_at = ?1, last_reviewed_by = ?2,
          review_interval_months = ?3, next_review_due_at = ?4,
          review_status = 'current', version = ?5, updated_at = ?1
        WHERE id = ?6 AND version = ?7`
      )
      .bind(now, params.actorId, parsed.data.nextReviewIntervalMonths, nextDue, newVersion, row.id, row.version),
    db
      .prepare(
        `INSERT INTO customer_case_commands (
          id, actor_id, entity_id, action, command_id,
          expected_version, applied_version, payload_hash, payload_json, created_at
        ) VALUES (
          ?1, ?2, ?3, 'perform_periodic_review', ?4,
          ?5, ?6, ?7, ?8, ?9
        )`
      )
      .bind(
        `cmd-audit-${params.input.commandId}`,
        params.actorId,
        row.id,
        params.input.commandId,
        row.version,
        newVersion,
        payloadHash,
        JSON.stringify(parsed.data),
        now
      )
  ])

  const updated = await getCaseStudyById(db, row.id)
  if (!updated) throw new CaseStudyError('not_found')
  return updated
}

export async function updateCaseStudy(
  db: D1Database,
  params: {
    actorId: string
    now?: string
    input: UpdateCaseStudyInput
  }
): Promise<CaseStudyAdminResult> {
  await requireAdmin(db, params.actorId)

  const communityCheck = validateStrictNoCommunityPayload(params.input)
  if (!communityCheck.isClean) {
    throw new CaseStudyError('community_features_forbidden')
  }

  const parsed = updateCaseStudySchema.safeParse(params.input)
  if (!parsed.success) throw new CaseStudyError('invalid_input')

  const now = params.now ?? new Date().toISOString()
  const row = await db
    .prepare('SELECT * FROM customer_case_studies WHERE id = ?')
    .bind(params.input.caseId)
    .first<CaseStudyRow>()

  if (!row) throw new CaseStudyError('not_found')
  if (row.version !== params.input.expectedVersion) throw new CaseStudyError('version_conflict')

  const newVersion = row.version + 1
  const payloadHash = await evaluateCaseStudyPayloadHash(parsed.data)

  const title = parsed.data.title ?? row.title
  const subtitle = parsed.data.subtitle ?? row.subtitle
  const coverImageUrl = parsed.data.coverImageUrl ?? row.cover_image_url

  await db.batch([
    db
      .prepare(
        `UPDATE customer_case_studies SET
          title = ?1, subtitle = ?2, cover_image_url = ?3,
          version = ?4, updated_at = ?5
        WHERE id = ?6 AND version = ?7`
      )
      .bind(title, subtitle, coverImageUrl, newVersion, now, row.id, row.version),
    db
      .prepare(
        `INSERT INTO customer_case_commands (
          id, actor_id, entity_id, action, command_id,
          expected_version, applied_version, payload_hash, payload_json, created_at
        ) VALUES (
          ?1, ?2, ?3, 'update_case_study', ?4,
          ?5, ?6, ?7, ?8, ?9
        )`
      )
      .bind(
        `cmd-audit-${params.input.commandId}`,
        params.actorId,
        row.id,
        params.input.commandId,
        row.version,
        newVersion,
        payloadHash,
        JSON.stringify(parsed.data),
        now
      )
  ])

  const updated = await getCaseStudyById(db, row.id)
  if (!updated) throw new CaseStudyError('not_found')
  return updated
}

export async function getCaseStudyById(db: D1Database, id: string): Promise<CaseStudyAdminResult | null> {
  const row = await db.prepare('SELECT * FROM customer_case_studies WHERE id = ?').bind(id).first<CaseStudyRow>()
  if (!row) return null
  return mapRowToAdminResult(row)
}

export async function evaluateOverdueCaseStudies(db: D1Database, now: string): Promise<void> {
  await db
    .prepare(
      `UPDATE customer_case_studies SET review_status = 'overdue', updated_at = ?1
       WHERE next_review_due_at < ?1 AND review_status != 'overdue'`
    )
    .bind(now)
    .run()
}

export async function listPublicCaseStudies(
  db: D1Database,
  params: {
    sector?: string
    limit?: number
    offset?: number
    now?: string
  }
): Promise<{ cases: PublicCaseStudy[]; total: number }> {
  const now = params.now ?? new Date().toISOString()
  await evaluateOverdueCaseStudies(db, now)

  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50)
  const offset = Math.max(params.offset ?? 0, 0)

  let sql = `
    SELECT * FROM customer_case_studies
    WHERE publication_status = 'published'
      AND review_status != 'overdue'
      AND next_review_due_at > ?1
  `
  const binds: unknown[] = [now]

  if (params.sector) {
    sql += ` AND sector = ?${binds.length + 1}`
    binds.push(params.sector)
  }

  sql += ` ORDER BY created_at DESC LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`
  binds.push(limit, offset)

  const rows = await db
    .prepare(sql)
    .bind(...binds)
    .all<CaseStudyRow>()
  const caseRows = (rows.results ?? []) as CaseStudyRow[]

  const cases: PublicCaseStudy[] = caseRows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    subtitle: r.subtitle,
    coverImageUrl: r.cover_image_url,
    sector: r.sector,
    facilityDescription: r.facility_description,
    initialSituation: r.initial_situation,
    netecoProducts: JSON.parse(r.neteco_products_json),
    dosageProtocol: r.dosage_protocol,
    implementationDurationWeeks: r.implementation_duration_weeks,
    solutionSummary: r.solution_summary,
    outcomeMetrics: JSON.parse(r.outcome_metrics_json),
    verificationMethod: r.verification_method,
    verifierIdentity: r.verifier_identity,
    certificateRef: r.verification_certificate_ref,
    permissionCompanyName: r.permission_company_name,
    customerAuthorizationStatement: `Publicación expresamente autorizada por ${r.permission_company_name} (firmado por ${r.permission_signer_name}, ${r.permission_signer_role}).`,
    reviewValidUntil: r.next_review_due_at,
    publishedAt: r.published_at ?? r.created_at
  }))

  return { cases, total: cases.length }
}

export async function getPublicCaseStudyBySlug(
  db: D1Database,
  slug: string,
  now = new Date().toISOString()
): Promise<PublicCaseStudy> {
  await evaluateOverdueCaseStudies(db, now)

  const row = await db
    .prepare(
      `SELECT * FROM customer_case_studies
       WHERE slug = ?1 AND publication_status = 'published'
         AND review_status != 'overdue' AND next_review_due_at > ?2`
    )
    .bind(slug, now)
    .first<CaseStudyRow>()

  if (!row) throw new CaseStudyError('not_found')

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    coverImageUrl: row.cover_image_url,
    sector: row.sector,
    facilityDescription: row.facility_description,
    initialSituation: row.initial_situation,
    netecoProducts: JSON.parse(row.neteco_products_json),
    dosageProtocol: row.dosage_protocol,
    implementationDurationWeeks: row.implementation_duration_weeks,
    solutionSummary: row.solution_summary,
    outcomeMetrics: JSON.parse(row.outcome_metrics_json),
    verificationMethod: row.verification_method,
    verifierIdentity: row.verifier_identity,
    certificateRef: row.verification_certificate_ref,
    permissionCompanyName: row.permission_company_name,
    customerAuthorizationStatement: `Publicación expresamente autorizada por ${row.permission_company_name} (firmado por ${row.permission_signer_name}, ${row.permission_signer_role}).`,
    reviewValidUntil: row.next_review_due_at,
    publishedAt: row.published_at ?? row.created_at
  }
}

export async function listAdminCaseStudies(
  db: D1Database,
  params: {
    publicationStatus?: string
    reviewStatus?: string
    limit?: number
    offset?: number
  }
): Promise<{ cases: CaseStudyAdminResult[]; total: number }> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100)
  const offset = Math.max(params.offset ?? 0, 0)

  let sql = 'SELECT * FROM customer_case_studies WHERE 1=1'
  const binds: unknown[] = []

  if (params.publicationStatus) {
    binds.push(params.publicationStatus)
    sql += ` AND publication_status = ?${binds.length}`
  }

  if (params.reviewStatus) {
    binds.push(params.reviewStatus)
    sql += ` AND review_status = ?${binds.length}`
  }

  sql += ` ORDER BY created_at DESC LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`
  binds.push(limit, offset)

  const rows = await db
    .prepare(sql)
    .bind(...binds)
    .all<CaseStudyRow>()
  const cases = (rows.results ?? []).map((r) => mapRowToAdminResult(r as CaseStudyRow))

  return { cases, total: cases.length }
}
