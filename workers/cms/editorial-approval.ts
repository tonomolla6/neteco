import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { cmsIdempotencyKeySchema } from '../../shared/cms-commands'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { sha256Hex } from '../catalog/inventory'
import { isD1CheckConstraintFailure } from '../runtime/d1-errors'

/** Legal pages are always critical, whatever content type the client declares. */
const LEGAL_SLUG =
  /^(aviso-legal|legal|privacidad|politica-[a-z0-9-]+|cookies|terminos[a-z0-9-]*|condiciones[a-z0-9-]*)$/
export function isLegalContentSlug(slug: string) {
  return LEGAL_SLUG.test(slug)
}

export const MAX_CRITICAL_MFA_AGE_SECONDS = 900 // 15 minutes for critical operations

export type EditorialReviewStatus = 'draft' | 'in_review' | 'approved' | 'published' | 'rejected' | 'withdrawn'

export type EditorialContentType = 'general' | 'legal' | 'chemical_safety' | 'pricing'

export class EditorialApprovalError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'mfa_expired'
      | 'forbidden'
      | 'not_found'
      | 'version_conflict'
      | 'idempotency_conflict'
      | 'invalid_transition'
      | 'checklist_incomplete'
      | 'author_cannot_approve'
      | 'author_cannot_publish'
      | 'review_not_approved'
  ) {
    super(code)
  }
}

export interface ChecklistItem {
  id: string
  reviewId: string
  itemKey: string
  title: string
  completed: boolean
  completedBy: string | null
  completedAt: string | null
  createdAt: string
}

export interface ReviewComment {
  id: string
  reviewId: string
  authorId: string
  authorEmail?: string
  comment: string
  createdAt: string
}

export interface EditorialReviewSummary {
  id: string
  pageId: string
  pageTitle: string
  pageSlug: string
  versionId: string
  versionNumber: number
  contentType: EditorialContentType
  status: EditorialReviewStatus
  isCritical: boolean
  authorId: string
  authorEmail?: string
  assignedReviewerId: string | null
  assignedReviewerEmail?: string | null
  approvedBy: string | null
  approvedAt: string | null
  publishedBy: string | null
  publishedAt: string | null
  rejectionReason: string | null
  withdrawnReason: string | null
  version: number
  checklistCompletedCount: number
  checklistTotalCount: number
  createdAt: string
  updatedAt: string
}

export interface EditorialReviewDetail extends EditorialReviewSummary {
  checklist: ChecklistItem[]
  comments: ReviewComment[]
  diff: {
    publishedVersionId: string | null
    publishedDocument: unknown | null
    proposedVersionId: string
    proposedDocument: unknown
  }
  capabilities: {
    canApprove: boolean
    canReject: boolean
    canAssign: boolean
    canComment: boolean
    canWithdraw: boolean
    canToggleChecklist: boolean
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`
}

export function editorialNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function checkMfaFreshness(
  database: D1Database,
  claims: VerifiedSessionClaims,
  now = editorialNow(),
  maxAgeSeconds = MAX_CRITICAL_MFA_AGE_SECONDS
): Promise<void> {
  const session = await database
    .prepare(
      'SELECT id, mfa_verified, created_at FROM auth_sessions WHERE id = ? AND identity_id = ? AND session_version = ? AND revoked_at IS NULL AND expires_at > ?'
    )
    .bind(claims.sessionId, claims.identityId, claims.sessionVersion, now)
    .first<{ id: string; mfa_verified: number; created_at: string }>()

  if (!session || session.mfa_verified !== 1) {
    throw new EditorialApprovalError('mfa_required')
  }

  const sessionAgeSeconds = (Date.parse(now) - Date.parse(session.created_at)) / 1000
  if (sessionAgeSeconds > maxAgeSeconds) {
    throw new EditorialApprovalError('mfa_expired')
  }
}

const CHECKLIST_TITLES: Record<string, Record<string, string>> = {
  general: {
    ortografia_estilo: 'Revisión ortográfica y de estilo editorial',
    enlaces_revisados: 'Comprobación de enlaces internos y externos'
  },
  legal: {
    revision_legal: 'Revisión de términos legales y condiciones generales',
    conformidad_privacidad: 'Conformidad con RGPD y política de privacidad',
    terminos_vigentes: 'Verificación de vigencia regulatoria y menciones obligatorias'
  },
  chemical_safety: {
    fds_vigente: 'Ficha de Datos de Seguridad (FDS) vigente y accesible',
    pictogramas_clp: 'Pictogramas de peligro CLP revisados y conformes',
    frases_hp_revisadas: 'Frases de peligro H y consejos de prudencia P contrastados'
  },
  pricing: {
    exactitud_precios: 'Exactitud de precios unitarios y tarifas escalonadas',
    iva_claramente_indicado: 'Indicación clara de base imponible e IVA desglosado',
    condiciones_comerciales: 'Validez temporal y condiciones de portes/pedido mínimo'
  }
}

async function replayCommand<T>(database: D1Database, actorId: string, key: string, hash: string): Promise<T | null> {
  const previous = await database
    .prepare(
      'SELECT payload_hash, response_json FROM editorial_approval_commands WHERE actor_id = ? AND idempotency_key = ?'
    )
    .bind(actorId, key)
    .first<{ payload_hash: string; response_json: string }>()

  if (!previous) return null
  if (previous.payload_hash !== hash) {
    throw new EditorialApprovalError('idempotency_conflict')
  }
  return JSON.parse(previous.response_json) as T
}

export async function createEditorialReview(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: {
    pageId: string
    versionId: string
    contentType?: EditorialContentType
    isCritical?: boolean
    assignedReviewerId?: string | null
    note?: string
  },
  options: { idempotencyKey: string; now?: string }
): Promise<EditorialReviewDetail> {
  const pageId = catalogPolicyUuidSchema.parse(input.pageId)
  const versionId = catalogPolicyUuidSchema.parse(input.versionId)
  const key = cmsIdempotencyKeySchema.parse(options.idempotencyKey)
  const now = options.now ?? editorialNow()

  const auth = await authorizeD1Session(database, claims, 'catalog.write', { now, requireMfa: true })
  if (!auth.allowed) throw new EditorialApprovalError(auth.code)

  const hash = await sha256Hex(canonical({ action: 'create_review', input, pageId, versionId }))
  const replay = await replayCommand<EditorialReviewDetail>(database, claims.identityId, key, hash)
  if (replay) return replay

  // Fetch page and version
  const page = await database
    .prepare('SELECT id, slug, title FROM content_pages WHERE id = ?')
    .bind(pageId)
    .first<{ id: string; slug: string; title: string }>()
  if (!page) throw new EditorialApprovalError('not_found')

  const version = await database
    .prepare('SELECT id, version, document FROM content_versions WHERE id = ? AND page_id = ?')
    .bind(versionId, pageId)
    .first<{ id: string; version: number; document: string }>()
  if (!version) throw new EditorialApprovalError('not_found')

  // Criticality is decided by the server: the client may only raise it, never lower it.
  const priorCritical = await database
    .prepare(
      'SELECT content_type FROM editorial_reviews WHERE page_id = ? AND is_critical = 1 ORDER BY created_at DESC LIMIT 1'
    )
    .bind(pageId)
    .first<{ content_type: EditorialContentType }>()
  const legalSlug = isLegalContentSlug(page.slug)
  const requestedType: EditorialContentType = input.contentType ?? 'general'
  const contentType: EditorialContentType =
    requestedType !== 'general' ? requestedType : legalSlug ? 'legal' : (priorCritical?.content_type ?? 'general')
  const template = await database
    .prepare('SELECT content_type, is_critical, items_json FROM editorial_checklist_templates WHERE content_type = ?')
    .bind(contentType)
    .first<{ content_type: string; is_critical: number; items_json: string }>()
  if (!template) throw new EditorialApprovalError('invalid_input')

  const isCritical = template.is_critical === 1 || input.isCritical === true || legalSlug || Boolean(priorCritical)
  const reviewId = crypto.randomUUID()
  const assignedReviewerId = input.assignedReviewerId ? catalogPolicyUuidSchema.parse(input.assignedReviewerId) : null

  const itemsKeys: string[] = JSON.parse(template.items_json)
  const checklistStatements: D1PreparedStatement[] = []
  const initialChecklist: ChecklistItem[] = []

  for (const itemKey of itemsKeys) {
    const itemId = crypto.randomUUID()
    const title = CHECKLIST_TITLES[contentType]?.[itemKey] ?? itemKey
    checklistStatements.push(
      database
        .prepare(
          'INSERT INTO editorial_checklist_items(id, review_id, item_key, title, completed, completed_by, completed_at, created_at) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?)'
        )
        .bind(itemId, reviewId, itemKey, title, now)
    )
    initialChecklist.push({
      id: itemId,
      reviewId,
      itemKey,
      title,
      completed: false,
      completedBy: null,
      completedAt: null,
      createdAt: now
    })
  }

  const initialStatus: EditorialReviewStatus = 'in_review'
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        'INSERT INTO editorial_reviews(id, page_id, version_id, content_type, status, is_critical, author_id, assigned_reviewer_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'
      )
      .bind(
        reviewId,
        pageId,
        versionId,
        contentType,
        initialStatus,
        isCritical ? 1 : 0,
        claims.identityId,
        assignedReviewerId,
        now,
        now
      ),
    ...checklistStatements
  ]

  const comments: ReviewComment[] = []
  if (input.note && input.note.trim().length > 0) {
    const commentId = crypto.randomUUID()
    statements.push(
      database
        .prepare(
          'INSERT INTO editorial_review_comments(id, review_id, author_id, comment, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(commentId, reviewId, claims.identityId, input.note.trim(), now)
    )
    comments.push({
      id: commentId,
      reviewId,
      authorId: claims.identityId,
      comment: input.note.trim(),
      createdAt: now
    })
  }

  // Audit
  const auditId = crypto.randomUUID()
  statements.push(
    database
      .prepare(
        'INSERT INTO editorial_review_audit(id, review_id, actor_id, action, from_status, to_status, details_json, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)'
      )
      .bind(
        auditId,
        reviewId,
        claims.identityId,
        'create_review',
        initialStatus,
        JSON.stringify({ contentType, isCritical, assignedReviewerId }),
        now
      )
  )

  const detail: EditorialReviewDetail = {
    id: reviewId,
    pageId,
    pageTitle: page.title,
    pageSlug: page.slug,
    versionId,
    versionNumber: version.version,
    contentType,
    status: initialStatus,
    isCritical,
    authorId: claims.identityId,
    assignedReviewerId,
    approvedBy: null,
    approvedAt: null,
    publishedBy: null,
    publishedAt: null,
    rejectionReason: null,
    withdrawnReason: null,
    version: 1,
    checklistCompletedCount: 0,
    checklistTotalCount: initialChecklist.length,
    createdAt: now,
    updatedAt: now,
    checklist: initialChecklist,
    comments,
    diff: {
      publishedVersionId: null,
      publishedDocument: null,
      proposedVersionId: versionId,
      proposedDocument: JSON.parse(version.document)
    },
    capabilities: {
      canApprove: true,
      canReject: true,
      canAssign: true,
      canComment: true,
      canWithdraw: true,
      canToggleChecklist: true
    }
  }

  // Record command
  const commandId = crypto.randomUUID()
  statements.push(
    database
      .prepare(
        'INSERT INTO editorial_approval_commands(id, actor_id, review_id, action, idempotency_key, payload_hash, input_json, before_state, after_state, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        commandId,
        claims.identityId,
        reviewId,
        'create_review',
        key,
        hash,
        canonical(input),
        'null',
        JSON.stringify({ status: initialStatus, version: 1 }),
        JSON.stringify(detail),
        now
      )
  )

  await database.batch(statements)
  return detail
}

export async function assignReviewer(
  database: D1Database,
  claims: VerifiedSessionClaims,
  reviewId: string,
  input: { assignedReviewerId: string; expectedVersion: number },
  options: { idempotencyKey: string; now?: string }
): Promise<EditorialReviewDetail> {
  catalogPolicyUuidSchema.parse(reviewId)
  const reviewerId = catalogPolicyUuidSchema.parse(input.assignedReviewerId)
  const key = cmsIdempotencyKeySchema.parse(options.idempotencyKey)
  const now = options.now ?? editorialNow()

  const auth = await authorizeD1Session(database, claims, 'catalog.write', { now, requireMfa: true })
  if (!auth.allowed) throw new EditorialApprovalError(auth.code)

  const hash = await sha256Hex(canonical({ action: 'assign_reviewer', reviewId, input }))
  const replay = await replayCommand<EditorialReviewDetail>(database, claims.identityId, key, hash)
  if (replay) return replay

  const review = await database
    .prepare('SELECT id, version, status FROM editorial_reviews WHERE id = ?')
    .bind(reviewId)
    .first<{ id: string; version: number; status: string }>()
  if (!review) throw new EditorialApprovalError('not_found')

  if (review.version !== input.expectedVersion) {
    throw new EditorialApprovalError('version_conflict')
  }

  const nextVersion = review.version + 1
  const commandId = crypto.randomUUID()
  const auditId = crypto.randomUUID()

  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        'UPDATE editorial_reviews SET assigned_reviewer_id = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?'
      )
      .bind(reviewerId, nextVersion, now, reviewId, review.version),
    database
      .prepare(
        'INSERT INTO editorial_review_audit(id, review_id, actor_id, action, from_status, to_status, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        auditId,
        reviewId,
        claims.identityId,
        'assign_reviewer',
        review.status,
        review.status,
        JSON.stringify({ reviewerId }),
        now
      )
  ]

  const updatedDetail = await getEditorialReview(database, claims, reviewId)
  updatedDetail.assignedReviewerId = reviewerId
  updatedDetail.version = nextVersion
  updatedDetail.updatedAt = now

  statements.push(
    database
      .prepare(
        'INSERT INTO editorial_approval_commands(id, actor_id, review_id, action, idempotency_key, payload_hash, input_json, before_state, after_state, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        commandId,
        claims.identityId,
        reviewId,
        'assign_reviewer',
        key,
        hash,
        canonical(input),
        JSON.stringify({ version: review.version }),
        JSON.stringify({ version: nextVersion, assignedReviewerId: reviewerId }),
        JSON.stringify(updatedDetail),
        now
      )
  )

  await database.batch(statements)
  return updatedDetail
}

export async function updateChecklistItem(
  database: D1Database,
  claims: VerifiedSessionClaims,
  reviewId: string,
  input: { itemKey: string; completed: boolean; expectedVersion: number },
  options: { idempotencyKey: string; now?: string }
): Promise<EditorialReviewDetail> {
  catalogPolicyUuidSchema.parse(reviewId)
  const key = cmsIdempotencyKeySchema.parse(options.idempotencyKey)
  const now = options.now ?? editorialNow()

  const auth = await authorizeD1Session(database, claims, 'catalog.write', { now, requireMfa: true })
  if (!auth.allowed) throw new EditorialApprovalError(auth.code)

  const hash = await sha256Hex(canonical({ action: 'update_checklist', reviewId, input }))
  const replay = await replayCommand<EditorialReviewDetail>(database, claims.identityId, key, hash)
  if (replay) return replay

  const review = await database
    .prepare('SELECT id, version, status FROM editorial_reviews WHERE id = ?')
    .bind(reviewId)
    .first<{ id: string; version: number; status: string }>()
  if (!review) throw new EditorialApprovalError('not_found')

  if (review.version !== input.expectedVersion) {
    throw new EditorialApprovalError('version_conflict')
  }

  const nextVersion = review.version + 1
  const commandId = crypto.randomUUID()
  const auditId = crypto.randomUUID()

  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        'UPDATE editorial_checklist_items SET completed = ?, completed_by = ?, completed_at = ? WHERE review_id = ? AND item_key = ?'
      )
      .bind(
        input.completed ? 1 : 0,
        input.completed ? claims.identityId : null,
        input.completed ? now : null,
        reviewId,
        input.itemKey
      ),
    database
      .prepare('UPDATE editorial_reviews SET version = ?, updated_at = ? WHERE id = ? AND version = ?')
      .bind(nextVersion, now, reviewId, review.version),
    database
      .prepare(
        'INSERT INTO editorial_review_audit(id, review_id, actor_id, action, from_status, to_status, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        auditId,
        reviewId,
        claims.identityId,
        'update_checklist',
        review.status,
        review.status,
        JSON.stringify(input),
        now
      )
  ]

  const updatedDetail = await getEditorialReview(database, claims, reviewId)
  updatedDetail.version = nextVersion
  updatedDetail.updatedAt = now
  const item = updatedDetail.checklist.find((i) => i.itemKey === input.itemKey)
  if (item) {
    item.completed = input.completed
    item.completedBy = input.completed ? claims.identityId : null
    item.completedAt = input.completed ? now : null
  }

  statements.push(
    database
      .prepare(
        'INSERT INTO editorial_approval_commands(id, actor_id, review_id, action, idempotency_key, payload_hash, input_json, before_state, after_state, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        commandId,
        claims.identityId,
        reviewId,
        'update_checklist',
        key,
        hash,
        canonical(input),
        JSON.stringify({ version: review.version }),
        JSON.stringify({ version: nextVersion, itemKey: input.itemKey, completed: input.completed }),
        JSON.stringify(updatedDetail),
        now
      )
  )

  await database.batch(statements)
  return updatedDetail
}

export async function addReviewComment(
  database: D1Database,
  claims: VerifiedSessionClaims,
  reviewId: string,
  input: { comment: string },
  options: { idempotencyKey: string; now?: string }
): Promise<ReviewComment> {
  catalogPolicyUuidSchema.parse(reviewId)
  const text = input.comment.trim()
  if (text.length === 0 || text.length > 2000) throw new EditorialApprovalError('invalid_input')
  const now = options.now ?? editorialNow()

  const auth = await authorizeD1Session(database, claims, 'catalog.write', { now, requireMfa: true })
  if (!auth.allowed) throw new EditorialApprovalError(auth.code)

  const commentId = crypto.randomUUID()
  const auditId = crypto.randomUUID()

  await database.batch([
    database
      .prepare(
        'INSERT INTO editorial_review_comments(id, review_id, author_id, comment, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .bind(commentId, reviewId, claims.identityId, text, now),
    database
      .prepare(
        'INSERT INTO editorial_review_audit(id, review_id, actor_id, action, from_status, to_status, details_json, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)'
      )
      .bind(
        auditId,
        reviewId,
        claims.identityId,
        'add_comment',
        JSON.stringify({ commentId, length: text.length }),
        now
      )
  ])

  return {
    id: commentId,
    reviewId,
    authorId: claims.identityId,
    comment: text,
    createdAt: now
  }
}

export async function approveEditorialReview(
  database: D1Database,
  claims: VerifiedSessionClaims,
  reviewId: string,
  input: { expectedVersion: number; note?: string },
  options: { idempotencyKey: string; now?: string; maxMfaAgeSeconds?: number }
): Promise<EditorialReviewDetail> {
  catalogPolicyUuidSchema.parse(reviewId)
  const key = cmsIdempotencyKeySchema.parse(options.idempotencyKey)
  const now = options.now ?? editorialNow()

  // Approval requires catalog.publish!
  const auth = await authorizeD1Session(database, claims, 'catalog.publish', { now, requireMfa: true })
  if (!auth.allowed) throw new EditorialApprovalError(auth.code)

  const hash = await sha256Hex(canonical({ action: 'approve', reviewId, input }))
  const replay = await replayCommand<EditorialReviewDetail>(database, claims.identityId, key, hash)
  if (replay) return replay

  const review = await database
    .prepare('SELECT id, version, status, is_critical, author_id FROM editorial_reviews WHERE id = ?')
    .bind(reviewId)
    .first<{ id: string; version: number; status: string; is_critical: number; author_id: string }>()
  if (!review) throw new EditorialApprovalError('not_found')

  if (review.version !== input.expectedVersion) {
    throw new EditorialApprovalError('version_conflict')
  }

  if (review.status !== 'in_review') {
    throw new EditorialApprovalError('invalid_transition')
  }

  // Separation of duties for critical reviews
  if (review.is_critical === 1) {
    if (claims.identityId === review.author_id) {
      throw new EditorialApprovalError('author_cannot_approve')
    }
    // Check recent MFA
    await checkMfaFreshness(database, claims, now, options.maxMfaAgeSeconds)
  }

  // Check checklist completeness
  const incomplete = await database
    .prepare('SELECT COUNT(*) as count FROM editorial_checklist_items WHERE review_id = ? AND completed = 0')
    .bind(reviewId)
    .first<{ count: number }>()
  if ((incomplete?.count ?? 0) > 0) {
    throw new EditorialApprovalError('checklist_incomplete')
  }

  const nextVersion = review.version + 1
  const commandId = crypto.randomUUID()
  const auditId = crypto.randomUUID()

  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        'UPDATE editorial_reviews SET status = ?, approved_by = ?, approved_at = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?'
      )
      .bind('approved', claims.identityId, now, nextVersion, now, reviewId, review.version),
    database
      .prepare(
        'INSERT INTO editorial_review_audit(id, review_id, actor_id, action, from_status, to_status, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        auditId,
        reviewId,
        claims.identityId,
        'approve',
        review.status,
        'approved',
        JSON.stringify({ note: input.note }),
        now
      )
  ]

  if (input.note && input.note.trim().length > 0) {
    statements.push(
      database
        .prepare(
          'INSERT INTO editorial_review_comments(id, review_id, author_id, comment, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(crypto.randomUUID(), reviewId, claims.identityId, input.note.trim(), now)
    )
  }

  const updatedDetail = await getEditorialReview(database, claims, reviewId)
  updatedDetail.status = 'approved'
  updatedDetail.approvedBy = claims.identityId
  updatedDetail.approvedAt = now
  updatedDetail.version = nextVersion
  updatedDetail.updatedAt = now

  statements.push(
    database
      .prepare(
        'INSERT INTO editorial_approval_commands(id, actor_id, review_id, action, idempotency_key, payload_hash, input_json, before_state, after_state, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        commandId,
        claims.identityId,
        reviewId,
        'approve',
        key,
        hash,
        canonical(input),
        JSON.stringify({ status: review.status, version: review.version }),
        JSON.stringify({ status: 'approved', version: nextVersion, approvedBy: claims.identityId }),
        JSON.stringify(updatedDetail),
        now
      )
  )

  try {
    await database.batch(statements)
  } catch (err) {
    if (isD1CheckConstraintFailure(err) || String(err).includes('editorial_checklist_incomplete')) {
      throw new EditorialApprovalError('checklist_incomplete')
    }
    if (String(err).includes('editorial_invalid_transition')) {
      throw new EditorialApprovalError('invalid_transition')
    }
    throw err
  }

  return updatedDetail
}

export async function rejectEditorialReview(
  database: D1Database,
  claims: VerifiedSessionClaims,
  reviewId: string,
  input: { expectedVersion: number; reason: string },
  options: { idempotencyKey: string; now?: string }
): Promise<EditorialReviewDetail> {
  catalogPolicyUuidSchema.parse(reviewId)
  const key = cmsIdempotencyKeySchema.parse(options.idempotencyKey)
  const reason = input.reason.trim()
  if (reason.length < 3 || reason.length > 500) throw new EditorialApprovalError('invalid_input')
  const now = options.now ?? editorialNow()

  // Rejection requires catalog.publish
  const auth = await authorizeD1Session(database, claims, 'catalog.publish', { now, requireMfa: true })
  if (!auth.allowed) throw new EditorialApprovalError(auth.code)

  const hash = await sha256Hex(canonical({ action: 'reject', reviewId, input }))
  const replay = await replayCommand<EditorialReviewDetail>(database, claims.identityId, key, hash)
  if (replay) return replay

  const review = await database
    .prepare('SELECT id, version, status FROM editorial_reviews WHERE id = ?')
    .bind(reviewId)
    .first<{ id: string; version: number; status: string }>()
  if (!review) throw new EditorialApprovalError('not_found')

  if (review.version !== input.expectedVersion) {
    throw new EditorialApprovalError('version_conflict')
  }

  if (review.status !== 'in_review') {
    throw new EditorialApprovalError('invalid_transition')
  }

  const nextVersion = review.version + 1
  const commandId = crypto.randomUUID()
  const auditId = crypto.randomUUID()
  const commentId = crypto.randomUUID()

  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        'UPDATE editorial_reviews SET status = ?, rejection_reason = ?, withdrawn_reason = NULL, version = ?, updated_at = ? WHERE id = ? AND version = ?'
      )
      .bind('rejected', reason, nextVersion, now, reviewId, review.version),
    database
      .prepare(
        'INSERT INTO editorial_review_comments(id, review_id, author_id, comment, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .bind(commentId, reviewId, claims.identityId, `[Rechazado]: ${reason}`, now),
    database
      .prepare(
        'INSERT INTO editorial_review_audit(id, review_id, actor_id, action, from_status, to_status, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(auditId, reviewId, claims.identityId, 'reject', review.status, 'rejected', JSON.stringify({ reason }), now)
  ]

  const updatedDetail = await getEditorialReview(database, claims, reviewId)
  updatedDetail.status = 'rejected'
  updatedDetail.rejectionReason = reason
  updatedDetail.version = nextVersion
  updatedDetail.updatedAt = now

  statements.push(
    database
      .prepare(
        'INSERT INTO editorial_approval_commands(id, actor_id, review_id, action, idempotency_key, payload_hash, input_json, before_state, after_state, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        commandId,
        claims.identityId,
        reviewId,
        'reject',
        key,
        hash,
        canonical(input),
        JSON.stringify({ status: review.status, version: review.version }),
        JSON.stringify({ status: 'rejected', version: nextVersion, rejectionReason: reason }),
        JSON.stringify(updatedDetail),
        now
      )
  )

  await database.batch(statements)
  return updatedDetail
}

export async function withdrawEditorialReview(
  database: D1Database,
  claims: VerifiedSessionClaims,
  reviewId: string,
  input: { expectedVersion: number; reason: string },
  options: { idempotencyKey: string; now?: string }
): Promise<EditorialReviewDetail> {
  catalogPolicyUuidSchema.parse(reviewId)
  const key = cmsIdempotencyKeySchema.parse(options.idempotencyKey)
  const reason = input.reason.trim()
  if (reason.length < 3 || reason.length > 500) throw new EditorialApprovalError('invalid_input')
  const now = options.now ?? editorialNow()

  const auth = await authorizeD1Session(database, claims, 'catalog.write', { now, requireMfa: true })
  if (!auth.allowed) throw new EditorialApprovalError(auth.code)

  const hash = await sha256Hex(canonical({ action: 'withdraw', reviewId, input }))
  const replay = await replayCommand<EditorialReviewDetail>(database, claims.identityId, key, hash)
  if (replay) return replay

  const review = await database
    .prepare('SELECT id, version, status FROM editorial_reviews WHERE id = ?')
    .bind(reviewId)
    .first<{ id: string; version: number; status: string }>()
  if (!review) throw new EditorialApprovalError('not_found')

  if (review.version !== input.expectedVersion) {
    throw new EditorialApprovalError('version_conflict')
  }

  if (review.status === 'withdrawn') {
    throw new EditorialApprovalError('invalid_transition')
  }

  const nextVersion = review.version + 1
  const commandId = crypto.randomUUID()
  const auditId = crypto.randomUUID()

  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        'UPDATE editorial_reviews SET status = ?, withdrawn_reason = ?, rejection_reason = NULL, version = ?, updated_at = ? WHERE id = ? AND version = ?'
      )
      .bind('withdrawn', reason, nextVersion, now, reviewId, review.version),
    database
      .prepare(
        'INSERT INTO editorial_review_comments(id, review_id, author_id, comment, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .bind(crypto.randomUUID(), reviewId, claims.identityId, `[Retirado]: ${reason}`, now),
    database
      .prepare(
        'INSERT INTO editorial_review_audit(id, review_id, actor_id, action, from_status, to_status, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        auditId,
        reviewId,
        claims.identityId,
        'withdraw',
        review.status,
        'withdrawn',
        JSON.stringify({ reason }),
        now
      )
  ]

  const updatedDetail = await getEditorialReview(database, claims, reviewId)
  updatedDetail.status = 'withdrawn'
  updatedDetail.withdrawnReason = reason
  updatedDetail.version = nextVersion
  updatedDetail.updatedAt = now

  statements.push(
    database
      .prepare(
        'INSERT INTO editorial_approval_commands(id, actor_id, review_id, action, idempotency_key, payload_hash, input_json, before_state, after_state, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        commandId,
        claims.identityId,
        reviewId,
        'withdraw',
        key,
        hash,
        canonical(input),
        JSON.stringify({ status: review.status, version: review.version }),
        JSON.stringify({ status: 'withdrawn', version: nextVersion, withdrawnReason: reason }),
        JSON.stringify(updatedDetail),
        now
      )
  )

  await database.batch(statements)
  return updatedDetail
}

export async function getEditorialReview(
  database: D1Database,
  claims: VerifiedSessionClaims,
  reviewId: string
): Promise<EditorialReviewDetail> {
  catalogPolicyUuidSchema.parse(reviewId)

  const raw = await database
    .prepare(
      `SELECT r.id, r.page_id, r.version_id, r.content_type, r.status, r.is_critical,
              r.author_id, ia.email as author_email,
              r.assigned_reviewer_id, ir.email as assigned_reviewer_email,
              r.approved_by, r.approved_at, r.published_by, r.published_at,
              r.rejection_reason, r.withdrawn_reason, r.version, r.created_at, r.updated_at,
              p.title as page_title, p.slug as page_slug,
              v.version as version_number, v.document as proposed_document
       FROM editorial_reviews r
       JOIN content_pages p ON p.id = r.page_id
       JOIN content_versions v ON v.id = r.version_id
       LEFT JOIN identities ia ON ia.id = r.author_id
       LEFT JOIN identities ir ON ir.id = r.assigned_reviewer_id
       WHERE r.id = ?`
    )
    .bind(reviewId)
    .first<{
      id: string
      page_id: string
      version_id: string
      content_type: string
      status: string
      is_critical: number
      author_id: string
      author_email: string | null
      assigned_reviewer_id: string | null
      assigned_reviewer_email: string | null
      approved_by: string | null
      approved_at: string | null
      published_by: string | null
      published_at: string | null
      rejection_reason: string | null
      withdrawn_reason: string | null
      version: number
      created_at: string
      updated_at: string
      page_title: string
      page_slug: string
      version_number: number
      proposed_document: string
    }>()

  if (!raw) throw new EditorialApprovalError('not_found')

  // Checklist items
  const items = await database
    .prepare(
      'SELECT id, review_id, item_key, title, completed, completed_by, completed_at, created_at FROM editorial_checklist_items WHERE review_id = ? ORDER BY item_key ASC'
    )
    .bind(reviewId)
    .all<{
      id: string
      review_id: string
      item_key: string
      title: string
      completed: number
      completed_by: string | null
      completed_at: string | null
      created_at: string
    }>()

  const checklist: ChecklistItem[] = (items.results ?? []).map((row) => ({
    id: row.id,
    reviewId: row.review_id,
    itemKey: row.item_key,
    title: row.title,
    completed: row.completed === 1,
    completedBy: row.completed_by,
    completedAt: row.completed_at,
    createdAt: row.created_at
  }))

  // Comments
  const comms = await database
    .prepare(
      `SELECT c.id, c.review_id, c.author_id, c.comment, c.created_at, i.email as author_email
       FROM editorial_review_comments c
       LEFT JOIN identities i ON i.id = c.author_id
       WHERE c.review_id = ? ORDER BY c.created_at ASC`
    )
    .bind(reviewId)
    .all<{
      id: string
      review_id: string
      author_id: string
      comment: string
      created_at: string
      author_email: string | null
    }>()

  const comments: ReviewComment[] = (comms.results ?? []).map((row) => ({
    id: row.id,
    reviewId: row.review_id,
    authorId: row.author_id,
    authorEmail: row.author_email ?? undefined,
    comment: row.comment,
    createdAt: row.created_at
  }))

  // Lookup published version document
  let publishedVersionId: string | null = null
  let publishedDocument: unknown | null = null

  const pub = await database
    .prepare(
      `SELECT cp.version_id, cv.document
       FROM content_publication_states cps
       JOIN content_publications cp ON cp.id = cps.publication_id
       JOIN content_versions cv ON cv.id = cp.version_id
       WHERE cps.page_id = ?`
    )
    .bind(raw.page_id)
    .first<{ version_id: string; document: string }>()

  if (pub) {
    publishedVersionId = pub.version_id
    try {
      publishedDocument = JSON.parse(pub.document)
    } catch {
      publishedDocument = null
    }
  }

  const isAuthor = claims.identityId === raw.author_id
  const isCritical = raw.is_critical === 1
  const canApprove = raw.status === 'in_review' && (!isCritical || !isAuthor)
  const canReject = raw.status === 'in_review'
  const canWithdraw = raw.status !== 'withdrawn' && raw.status !== 'published'
  const canToggleChecklist = raw.status === 'in_review'
  const canAssign = raw.status === 'in_review' || raw.status === 'draft'

  return {
    id: raw.id,
    pageId: raw.page_id,
    pageTitle: raw.page_title,
    pageSlug: raw.page_slug,
    versionId: raw.version_id,
    versionNumber: raw.version_number,
    contentType: raw.content_type as EditorialContentType,
    status: raw.status as EditorialReviewStatus,
    isCritical,
    authorId: raw.author_id,
    authorEmail: raw.author_email ?? undefined,
    assignedReviewerId: raw.assigned_reviewer_id,
    assignedReviewerEmail: raw.assigned_reviewer_email ?? undefined,
    approvedBy: raw.approved_by,
    approvedAt: raw.approved_at,
    publishedBy: raw.published_by,
    publishedAt: raw.published_at,
    rejectionReason: raw.rejection_reason,
    withdrawnReason: raw.withdrawn_reason,
    version: raw.version,
    checklistCompletedCount: checklist.filter((i) => i.completed).length,
    checklistTotalCount: checklist.length,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    checklist,
    comments,
    diff: {
      publishedVersionId,
      publishedDocument,
      proposedVersionId: raw.version_id,
      proposedDocument: JSON.parse(raw.proposed_document)
    },
    capabilities: {
      canApprove,
      canReject,
      canAssign,
      canComment: true,
      canWithdraw,
      canToggleChecklist
    }
  }
}

export async function listEditorialReviews(
  database: D1Database,
  claims: VerifiedSessionClaims,
  filters: {
    page?: number
    perPage?: number
    status?: EditorialReviewStatus
    assignedTo?: 'me' | string
    pageId?: string
  } = {}
): Promise<{
  items: EditorialReviewSummary[]
  page: number
  perPage: number
  total: number
}> {
  const page = Math.max(1, filters.page ?? 1)
  const perPage = Math.min(100, Math.max(1, filters.perPage ?? 25))
  const offset = (page - 1) * perPage

  const conditions: string[] = ['1=1']
  const params: unknown[] = []

  if (filters.status) {
    conditions.push('r.status = ?')
    params.push(filters.status)
  }

  if (filters.assignedTo) {
    if (filters.assignedTo === 'me') {
      conditions.push('r.assigned_reviewer_id = ?')
      params.push(claims.identityId)
    } else {
      conditions.push('r.assigned_reviewer_id = ?')
      params.push(filters.assignedTo)
    }
  }

  if (filters.pageId) {
    conditions.push('r.page_id = ?')
    params.push(filters.pageId)
  }

  const whereSql = conditions.join(' AND ')

  const countRow = await database
    .prepare(`SELECT COUNT(*) as count FROM editorial_reviews r WHERE ${whereSql}`)
    .bind(...params)
    .first<{ count: number }>()
  const total = countRow?.count ?? 0

  const rows = await database
    .prepare(
      `SELECT r.id, r.page_id, r.version_id, r.content_type, r.status, r.is_critical,
              r.author_id, ia.email as author_email,
              r.assigned_reviewer_id, ir.email as assigned_reviewer_email,
              r.approved_by, r.approved_at, r.published_by, r.published_at,
              r.rejection_reason, r.withdrawn_reason, r.version, r.created_at, r.updated_at,
              p.title as page_title, p.slug as page_slug,
              v.version as version_number,
              (SELECT COUNT(*) FROM editorial_checklist_items ci WHERE ci.review_id = r.id AND ci.completed = 1) as completed_count,
              (SELECT COUNT(*) FROM editorial_checklist_items ci WHERE ci.review_id = r.id) as total_count
       FROM editorial_reviews r
       JOIN content_pages p ON p.id = r.page_id
       JOIN content_versions v ON v.id = r.version_id
       LEFT JOIN identities ia ON ia.id = r.author_id
       LEFT JOIN identities ir ON ir.id = r.assigned_reviewer_id
       WHERE ${whereSql}
       ORDER BY r.updated_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...params, perPage, offset)
    .all<{
      id: string
      page_id: string
      version_id: string
      content_type: string
      status: string
      is_critical: number
      author_id: string
      author_email: string | null
      assigned_reviewer_id: string | null
      assigned_reviewer_email: string | null
      approved_by: string | null
      approved_at: string | null
      published_by: string | null
      published_at: string | null
      rejection_reason: string | null
      withdrawn_reason: string | null
      version: number
      created_at: string
      updated_at: string
      page_title: string
      page_slug: string
      version_number: number
      completed_count: number
      total_count: number
    }>()

  const items: EditorialReviewSummary[] = (rows.results ?? []).map((row) => ({
    id: row.id,
    pageId: row.page_id,
    pageTitle: row.page_title,
    pageSlug: row.page_slug,
    versionId: row.version_id,
    versionNumber: row.version_number,
    contentType: row.content_type as EditorialContentType,
    status: row.status as EditorialReviewStatus,
    isCritical: row.is_critical === 1,
    authorId: row.author_id,
    authorEmail: row.author_email ?? undefined,
    assignedReviewerId: row.assigned_reviewer_id,
    assignedReviewerEmail: row.assigned_reviewer_email ?? undefined,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    publishedBy: row.published_by,
    publishedAt: row.published_at,
    rejectionReason: row.rejection_reason,
    withdrawnReason: row.withdrawn_reason,
    version: row.version,
    checklistCompletedCount: row.completed_count,
    checklistTotalCount: row.total_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))

  return { items, page, perPage, total }
}
