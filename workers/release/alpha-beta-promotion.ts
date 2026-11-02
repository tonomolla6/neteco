import { createHash, randomUUID } from 'node:crypto'
import {
  type AlphaBetaPromotionRecord,
  type PromotionSignoffRecord,
  type PromotionSignoffRole,
  AlphaBetaPromotionError,
  createPromotionSchema,
  promoteReleaseSchema,
  rejectPromotionSchema,
  submitSignoffSchema,
  updateChecklistSchema
} from '../../shared/alpha-beta-promotion'

function computeHash(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex')
}

interface RawPromotionRow {
  id: string
  release_version: string
  target_phase: 'Beta'
  status: string
  checklist_summary_json: string
  p0_defects_count: number
  p1_defects_count: number
  evidence_bundle_json: string
  evidence_hash: string
  promoted_at: string | null
  rejection_reason: string | null
  version: number
  created_at: string
  updated_at: string
  created_by: string
}

interface RawSignoffRow {
  id: string
  promotion_id: string
  role: string
  actor_id: string
  signature_hash: string
  statement: string
  signed_at: string
}

function mapPromotionRow(row: RawPromotionRow, signoffs: PromotionSignoffRecord[] = []): AlphaBetaPromotionRecord {
  return {
    id: row.id,
    releaseVersion: row.release_version,
    targetPhase: row.target_phase,
    status: row.status as AlphaBetaPromotionRecord['status'],
    checklistSummary: JSON.parse(row.checklist_summary_json),
    p0DefectsCount: Number(row.p0_defects_count),
    p1DefectsCount: Number(row.p1_defects_count),
    evidenceBundle: JSON.parse(row.evidence_bundle_json),
    evidenceHash: row.evidence_hash,
    promotedAt: row.promoted_at,
    rejectionReason: row.rejection_reason,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    signoffs
  }
}

async function checkIdempotency(
  db: D1Database,
  commandId: string,
  payloadHash: string
): Promise<{ exists: boolean; promotionId?: string }> {
  const existing = await db
    .prepare('SELECT command_id, promotion_id, payload_hash FROM alpha_beta_promotion_commands WHERE command_id = ?')
    .bind(commandId)
    .first<{ command_id: string; promotion_id: string; payload_hash: string }>()

  if (!existing) return { exists: false }
  if (existing.payload_hash !== payloadHash) {
    throw new AlphaBetaPromotionError(
      'idempotency_conflict',
      409,
      'Command payload hash does not match original command'
    )
  }
  return { exists: true, promotionId: existing.promotion_id }
}

export async function createAlphaBetaPromotion(
  db: D1Database,
  input: unknown,
  actorId: string,
  nowIso: string
): Promise<AlphaBetaPromotionRecord> {
  const validated = createPromotionSchema.parse(input)
  const payloadHash = computeHash(validated)

  const idemp = await checkIdempotency(db, validated.commandId, payloadHash)
  if (idemp.exists && idemp.promotionId) {
    return getAlphaBetaPromotion(db, idemp.promotionId)
  }

  const id = randomUUID()
  const evidenceHash = computeHash(validated.evidenceBundle)

  await db
    .prepare(
      `
      INSERT INTO alpha_beta_promotions (
        id, release_version, target_phase, status, checklist_summary_json,
        p0_defects_count, p1_defects_count, evidence_bundle_json, evidence_hash,
        promoted_at, rejection_reason, version, created_at, updated_at, created_by
      ) VALUES (?, ?, 'Beta', 'draft', ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, ?)
    `
    )
    .bind(
      id,
      validated.releaseVersion,
      JSON.stringify(validated.checklist),
      validated.p0DefectsCount,
      validated.p1DefectsCount,
      JSON.stringify(validated.evidenceBundle),
      evidenceHash,
      nowIso,
      nowIso,
      actorId
    )
    .run()

  await db
    .prepare(
      `
      INSERT INTO alpha_beta_promotion_commands (
        id, command_id, actor_id, action, promotion_id, payload_hash, payload_json, created_at
      ) VALUES (?, ?, ?, 'create_promotion', ?, ?, ?, ?)
    `
    )
    .bind(randomUUID(), validated.commandId, actorId, id, payloadHash, JSON.stringify(validated), nowIso)
    .run()

  return getAlphaBetaPromotion(db, id)
}

export async function getAlphaBetaPromotion(db: D1Database, promotionId: string): Promise<AlphaBetaPromotionRecord> {
  const row = await db
    .prepare('SELECT * FROM alpha_beta_promotions WHERE id = ?')
    .bind(promotionId)
    .first<RawPromotionRow>()

  if (!row) {
    throw new AlphaBetaPromotionError('promotion_not_found', 404, `Promotion ${promotionId} not found`)
  }

  const signoffRows = await db
    .prepare('SELECT * FROM alpha_beta_promotion_signoffs WHERE promotion_id = ? ORDER BY signed_at ASC')
    .bind(promotionId)
    .all<RawSignoffRow>()

  const signoffs: PromotionSignoffRecord[] = (signoffRows.results ?? []).map((s) => ({
    id: s.id,
    promotionId: s.promotion_id,
    role: s.role as PromotionSignoffRole,
    actorId: s.actor_id,
    signatureHash: s.signature_hash,
    statement: s.statement,
    signedAt: s.signed_at
  }))

  return mapPromotionRow(row, signoffs)
}

export async function listAlphaBetaPromotions(db: D1Database, limit = 50): Promise<AlphaBetaPromotionRecord[]> {
  const rows = await db
    .prepare('SELECT * FROM alpha_beta_promotions ORDER BY created_at DESC LIMIT ?')
    .bind(limit)
    .all<RawPromotionRow>()

  const promotions: AlphaBetaPromotionRecord[] = []
  for (const row of rows.results ?? []) {
    const signoffRows = await db
      .prepare('SELECT * FROM alpha_beta_promotion_signoffs WHERE promotion_id = ? ORDER BY signed_at ASC')
      .bind(row.id)
      .all<RawSignoffRow>()

    promotions.push(
      mapPromotionRow(
        row,
        (signoffRows.results ?? []).map((s) => ({
          id: s.id,
          promotionId: s.promotion_id,
          role: s.role as PromotionSignoffRole,
          actorId: s.actor_id,
          signatureHash: s.signature_hash,
          statement: s.statement,
          signedAt: s.signed_at
        }))
      )
    )
  }
  return promotions
}

export async function updateAlphaBetaChecklist(
  db: D1Database,
  input: unknown,
  actorId: string,
  nowIso: string
): Promise<AlphaBetaPromotionRecord> {
  const validated = updateChecklistSchema.parse(input)
  const payloadHash = computeHash(validated)

  const idemp = await checkIdempotency(db, validated.commandId, payloadHash)
  if (idemp.exists && idemp.promotionId) {
    return getAlphaBetaPromotion(db, idemp.promotionId)
  }

  const current = await getAlphaBetaPromotion(db, validated.promotionId)
  if (current.version !== validated.expectedVersion) {
    throw new AlphaBetaPromotionError('concurrency_conflict', 409, 'Promotion was modified by another actor')
  }

  if (current.status !== 'draft' && current.status !== 'in_review') {
    throw new AlphaBetaPromotionError(
      'invalid_state_transition',
      400,
      `Cannot update checklist in ${current.status} status`
    )
  }

  const evidenceBundle = validated.evidenceBundle ?? current.evidenceBundle
  const evidenceHash = validated.evidenceBundle ? computeHash(validated.evidenceBundle) : current.evidenceHash

  const res = (await db
    .prepare(
      `
      UPDATE alpha_beta_promotions
      SET checklist_summary_json = ?,
          p0_defects_count = ?,
          p1_defects_count = ?,
          evidence_bundle_json = ?,
          evidence_hash = ?,
          version = version + 1,
          updated_at = ?
      WHERE id = ? AND version = ?
    `
    )
    .bind(
      JSON.stringify(validated.checklist),
      validated.p0DefectsCount,
      validated.p1DefectsCount,
      JSON.stringify(evidenceBundle),
      evidenceHash,
      nowIso,
      validated.promotionId,
      validated.expectedVersion
    )
    .run()) as { meta?: { changes?: number }; success?: boolean }

  if (res?.meta?.changes === 0) {
    throw new AlphaBetaPromotionError('concurrency_conflict', 409, 'CAS update failed')
  }

  await db
    .prepare(
      `
      INSERT INTO alpha_beta_promotion_commands (
        id, command_id, actor_id, action, promotion_id, payload_hash, payload_json, created_at
      ) VALUES (?, ?, ?, 'update_checklist', ?, ?, ?, ?)
    `
    )
    .bind(
      randomUUID(),
      validated.commandId,
      actorId,
      validated.promotionId,
      payloadHash,
      JSON.stringify(validated),
      nowIso
    )
    .run()

  return getAlphaBetaPromotion(db, validated.promotionId)
}

export async function submitAlphaBetaSignoff(
  db: D1Database,
  input: unknown,
  actorId: string,
  nowIso: string
): Promise<AlphaBetaPromotionRecord> {
  const validated = submitSignoffSchema.parse(input)
  const payloadHash = computeHash(validated)

  const idemp = await checkIdempotency(db, validated.commandId, payloadHash)
  if (idemp.exists && idemp.promotionId) {
    return getAlphaBetaPromotion(db, idemp.promotionId)
  }

  const current = await getAlphaBetaPromotion(db, validated.promotionId)
  if (current.version !== validated.expectedVersion) {
    throw new AlphaBetaPromotionError('concurrency_conflict', 409, 'Promotion was modified by another actor')
  }

  if (current.status !== 'draft' && current.status !== 'in_review') {
    throw new AlphaBetaPromotionError('invalid_state_transition', 400, `Cannot sign off in ${current.status} status`)
  }

  // Acceptance Criterion: P0/P1 cero
  if (current.p0DefectsCount > 0 || current.p1DefectsCount > 0) {
    throw new AlphaBetaPromotionError(
      'p0_p1_defects_present',
      400,
      `Cannot approve promotion with ${current.p0DefectsCount} P0 and ${current.p1DefectsCount} P1 defects`
    )
  }

  // Acceptance Criterion: SLO/alertas/runbooks/restore/pentest/UAT y negocio/legal aprueban
  const chk = current.checklistSummary
  if (
    !chk.sloVerified ||
    !chk.alertsConfigured ||
    !chk.runbooksPublished ||
    !chk.restoreRehearsed ||
    !chk.pentestCleared ||
    !chk.uatPassed
  ) {
    throw new AlphaBetaPromotionError(
      'checklist_incomplete',
      400,
      'All 6 promotion gates (SLO, alerts, runbooks, restore rehearsal, pentest, UAT) must be verified'
    )
  }

  const signatureHash = createHash('sha256')
    .update(`${validated.promotionId}:${validated.role}:${actorId}:${validated.statement}:${nowIso}`)
    .digest('hex')

  // The signature is only valid when the signer holds the role they sign as (live, unexpired grant):
  // the role in the payload is a claim, not an entitlement.
  const held = await db
    .prepare(
      `SELECT 1 AS held FROM identity_roles
       WHERE identity_id = ? AND role_code = ? AND granted_at <= ? AND (expires_at IS NULL OR expires_at > ?)`
    )
    .bind(actorId, validated.role, nowIso, nowIso)
    .first<{ held: number }>()
  if (!held) {
    throw new AlphaBetaPromotionError('signoff_role_not_held', 403, `Signer does not hold the ${validated.role} role`)
  }

  const existing = await db
    .prepare('SELECT role, actor_id FROM alpha_beta_promotion_signoffs WHERE promotion_id = ?')
    .bind(validated.promotionId)
    .all<{ role: string; actor_id: string }>()
  const signed = existing.results ?? []
  if (signed.some((row) => row.actor_id === actorId && row.role !== validated.role)) {
    throw new AlphaBetaPromotionError(
      'signoff_actor_already_signed',
      409,
      'One person cannot sign more than one role of the same promotion'
    )
  }

  const rolesPresent = new Set([...signed.map((row) => row.role), validated.role])
  const isApproved = rolesPresent.has('business') && rolesPresent.has('legal') && rolesPresent.has('release_manager')
  const nextStatus = isApproved ? 'approved' : 'in_review'

  // Signature, command record and CAS state change commit together or not at all: the first two are
  // guarded by the version the caller read, so a lost race leaves no orphan signature.
  const guard = 'WHERE EXISTS (SELECT 1 FROM alpha_beta_promotions WHERE id = ? AND version = ?)'
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO alpha_beta_promotion_signoffs (
           id, promotion_id, role, actor_id, signature_hash, statement, signed_at
         ) SELECT ?, ?, ?, ?, ?, ?, ? ${guard}
         ON CONFLICT(promotion_id, role) DO UPDATE SET
           actor_id = excluded.actor_id,
           signature_hash = excluded.signature_hash,
           statement = excluded.statement,
           signed_at = excluded.signed_at`
      )
      .bind(
        randomUUID(),
        validated.promotionId,
        validated.role,
        actorId,
        signatureHash,
        validated.statement,
        nowIso,
        validated.promotionId,
        validated.expectedVersion
      ),
    db
      .prepare(
        `INSERT INTO alpha_beta_promotion_commands (
           id, command_id, actor_id, action, promotion_id, payload_hash, payload_json, created_at
         ) SELECT ?, ?, ?, 'submit_signoff', ?, ?, ?, ? ${guard}`
      )
      .bind(
        randomUUID(),
        validated.commandId,
        actorId,
        validated.promotionId,
        payloadHash,
        JSON.stringify(validated),
        nowIso,
        validated.promotionId,
        validated.expectedVersion
      ),
    db
      .prepare(
        `UPDATE alpha_beta_promotions
         SET status = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? RETURNING id`
      )
      .bind(nextStatus, nowIso, validated.promotionId, validated.expectedVersion)
  ])
  if (!results[2]?.results?.length) {
    throw new AlphaBetaPromotionError('concurrency_conflict', 409, 'Promotion was modified by another actor')
  }

  return getAlphaBetaPromotion(db, validated.promotionId)
}

export async function promoteAlphaBetaRelease(
  db: D1Database,
  input: unknown,
  actorId: string,
  nowIso: string
): Promise<AlphaBetaPromotionRecord> {
  const validated = promoteReleaseSchema.parse(input)
  const payloadHash = computeHash(validated)

  const idemp = await checkIdempotency(db, validated.commandId, payloadHash)
  if (idemp.exists && idemp.promotionId) {
    return getAlphaBetaPromotion(db, idemp.promotionId)
  }

  const current = await getAlphaBetaPromotion(db, validated.promotionId)
  if (current.version !== validated.expectedVersion) {
    throw new AlphaBetaPromotionError('concurrency_conflict', 409, 'Promotion was modified by another actor')
  }

  if (current.status !== 'approved') {
    throw new AlphaBetaPromotionError(
      'promotion_not_approved',
      400,
      `Cannot promote release when status is ${current.status}; requires approved checklist & signoffs`
    )
  }

  const res = (await db
    .prepare(
      `
      UPDATE alpha_beta_promotions
      SET status = 'promoted',
          promoted_at = ?,
          version = version + 1,
          updated_at = ?
      WHERE id = ? AND version = ?
    `
    )
    .bind(nowIso, nowIso, validated.promotionId, validated.expectedVersion)
    .run()) as { meta?: { changes?: number }; success?: boolean }

  if (res?.meta?.changes === 0) {
    throw new AlphaBetaPromotionError('concurrency_conflict', 409, 'CAS update failed')
  }

  await db
    .prepare(
      `
      INSERT INTO alpha_beta_promotion_commands (
        id, command_id, actor_id, action, promotion_id, payload_hash, payload_json, created_at
      ) VALUES (?, ?, ?, 'promote_release', ?, ?, ?, ?)
    `
    )
    .bind(
      randomUUID(),
      validated.commandId,
      actorId,
      validated.promotionId,
      payloadHash,
      JSON.stringify(validated),
      nowIso
    )
    .run()

  return getAlphaBetaPromotion(db, validated.promotionId)
}

export async function rejectAlphaBetaPromotion(
  db: D1Database,
  input: unknown,
  actorId: string,
  nowIso: string
): Promise<AlphaBetaPromotionRecord> {
  const validated = rejectPromotionSchema.parse(input)
  const payloadHash = computeHash(validated)

  const idemp = await checkIdempotency(db, validated.commandId, payloadHash)
  if (idemp.exists && idemp.promotionId) {
    return getAlphaBetaPromotion(db, idemp.promotionId)
  }

  const current = await getAlphaBetaPromotion(db, validated.promotionId)
  if (current.version !== validated.expectedVersion) {
    throw new AlphaBetaPromotionError('concurrency_conflict', 409, 'Promotion was modified by another actor')
  }

  if (current.status === 'promoted') {
    throw new AlphaBetaPromotionError(
      'cannot_reject_promoted_release',
      400,
      'Cannot reject an already promoted release'
    )
  }

  const res = (await db
    .prepare(
      `
      UPDATE alpha_beta_promotions
      SET status = 'rejected',
          rejection_reason = ?,
          version = version + 1,
          updated_at = ?
      WHERE id = ? AND version = ?
    `
    )
    .bind(validated.reason, nowIso, validated.promotionId, validated.expectedVersion)
    .run()) as { meta?: { changes?: number }; success?: boolean }

  if (res?.meta?.changes === 0) {
    throw new AlphaBetaPromotionError('concurrency_conflict', 409, 'CAS update failed')
  }

  await db
    .prepare(
      `
      INSERT INTO alpha_beta_promotion_commands (
        id, command_id, actor_id, action, promotion_id, payload_hash, payload_json, created_at
      ) VALUES (?, ?, ?, 'reject_promotion', ?, ?, ?, ?)
    `
    )
    .bind(
      randomUUID(),
      validated.commandId,
      actorId,
      validated.promotionId,
      payloadHash,
      JSON.stringify(validated),
      nowIso
    )
    .run()

  return getAlphaBetaPromotion(db, validated.promotionId)
}
