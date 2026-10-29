import { z } from 'zod'
import {
  ABUSE_RETENTION_DAYS,
  ABUSE_RULES,
  BIN_COUNT,
  DRIFT_MIN_SAMPLES,
  RULE_BY_FEATURE,
  assessAbuseInputSchema,
  baselineInputSchema,
  binIndex,
  computePsi,
  createModelInputSchema,
  driftInputSchema,
  driftStatus,
  metricsWindowSchema,
  proportionsFromSamples,
  pseudonymizeSubject,
  reviewAbuseInputSchema,
  scoreAbuse,
  summarizeReviewMetrics,
  type AbuseContribution,
  type AbuseDecision,
  type AbuseModel,
  type DriftStatus
} from '../../shared/security-abuse-detection'
import {
  SecurityControlError,
  adminExistsSql,
  assertSecret,
  isUniqueViolation,
  parseInput,
  payloadHash,
  plusDays,
  requireAdmin
} from './controls-common'

export interface AbuseModelView extends AbuseModel {
  id: string
  version: number
  status: 'draft' | 'active' | 'retired'
  createdAt: string
  activatedAt: string | null
}

interface ModelRow {
  id: string
  version: number
  weights_json: string
  review_threshold: number
  hold_threshold: number
  status: 'draft' | 'active' | 'retired'
  created_at: string
  activated_at: string | null
}

const toModel = (row: ModelRow): AbuseModelView => ({
  id: row.id,
  version: row.version,
  weights: JSON.parse(row.weights_json) as Record<string, number>,
  reviewThreshold: row.review_threshold,
  holdThreshold: row.hold_threshold,
  status: row.status,
  createdAt: row.created_at,
  activatedAt: row.activated_at
})

function statement(database: D1Database, sql: string, params: unknown[]) {
  const highest = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1])))
  return database.prepare(sql).bind(...params.slice(0, highest))
}

export async function getActiveModel(database: D1Database): Promise<AbuseModelView> {
  const row = await database.prepare(`SELECT * FROM abuse_model_versions WHERE status='active'`).first<ModelRow>()
  if (!row) throw new SecurityControlError('model_not_found', 404)
  return toModel(row)
}

async function getModel(database: D1Database, id: string): Promise<AbuseModelView> {
  const row = await database.prepare(`SELECT * FROM abuse_model_versions WHERE id=?1`).bind(id).first<ModelRow>()
  if (!row) throw new SecurityControlError('model_not_found', 404)
  return toModel(row)
}

export interface AdminContext {
  actorIdentityId: string
  now: string
}

export async function createModelVersion(database: D1Database, rawInput: unknown, context: AdminContext) {
  const input = parseInput(createModelInputSchema, rawInput)
  await requireAdmin(database, context.actorIdentityId, context.now)
  const id = crypto.randomUUID()
  const params = [
    id, // 1
    JSON.stringify(input.weights), // 2
    input.reviewThreshold, // 3
    input.holdThreshold, // 4
    context.actorIdentityId, // 5
    context.now, // 6
    crypto.randomUUID(), // 7 audit
    JSON.stringify({
      weights: input.weights,
      reviewThreshold: input.reviewThreshold,
      holdThreshold: input.holdThreshold
    }) // 8
  ]
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await database.batch([
        statement(
          database,
          `INSERT INTO abuse_model_versions(id, version, weights_json, review_threshold, hold_threshold, status, created_by, created_at)
           SELECT ?1, COALESCE(MAX(version),0)+1, ?2, ?3, ?4, 'draft', ?5, ?6 FROM abuse_model_versions
           WHERE ${adminExistsSql('?5', '?6')}`,
          params
        ),
        statement(
          database,
          `INSERT INTO abuse_audit(id, actor_identity_id, action, ref_id, detail_json, created_at)
           SELECT ?7, ?5, 'model_created', ?1, ?8, ?6 WHERE EXISTS(SELECT 1 FROM abuse_model_versions WHERE id=?1)`,
          params
        )
      ])
      break
    } catch (error) {
      // Two creators computed the same next version: the loser retries with the new maximum.
      if (!isUniqueViolation(error) || attempt === 2) throw error
    }
  }
  const row = await database.prepare(`SELECT * FROM abuse_model_versions WHERE id=?1`).bind(id).first<ModelRow>()
  if (!row) {
    await requireAdmin(database, context.actorIdentityId, context.now)
    throw new SecurityControlError('model_not_found', 404)
  }
  return toModel(row)
}

export async function activateModelVersion(
  database: D1Database,
  rawInput: { modelVersionId: string },
  context: AdminContext
) {
  const id = parseInput(z.string().uuid(), rawInput.modelVersionId)
  await requireAdmin(database, context.actorIdentityId, context.now)
  const model = await getModel(database, id)
  if (model.status !== 'draft') throw new SecurityControlError('invalid_transition', 409)
  const params = [
    id,
    context.actorIdentityId,
    context.now,
    crypto.randomUUID(),
    JSON.stringify({ version: model.version })
  ]
  await database.batch([
    statement(
      database,
      `UPDATE abuse_model_versions SET status='retired'
       WHERE status='active' AND EXISTS(SELECT 1 FROM abuse_model_versions WHERE id=?1 AND status='draft') AND ${adminExistsSql('?2', '?3')}`,
      params
    ),
    statement(
      database,
      `UPDATE abuse_model_versions SET status='active', activated_at=?3 WHERE id=?1 AND status='draft' AND ${adminExistsSql('?2', '?3')}
         AND NOT EXISTS(SELECT 1 FROM abuse_model_versions WHERE status='active')`,
      params
    ),
    statement(
      database,
      `INSERT INTO abuse_audit(id, actor_identity_id, action, ref_id, detail_json, created_at)
       SELECT ?4, ?2, 'model_activated', ?1, ?5, ?3 WHERE EXISTS(SELECT 1 FROM abuse_model_versions WHERE id=?1 AND status='active')`,
      params
    )
  ])
  const after = await getModel(database, id)
  if (after.status !== 'active') {
    await requireAdmin(database, context.actorIdentityId, context.now)
    throw new SecurityControlError('invalid_transition', 409)
  }
  return after
}

export interface AssessmentExplanation {
  humanReviewRequired: boolean
  modelVersion: number
  thresholds: { review: number; hold: number }
  contributions: AbuseContribution[]
}

export interface AssessmentView {
  id: string
  modelVersionId: string
  subjectKind: string
  subjectRef: string
  context: string
  features: Record<string, number>
  score: number
  decision: AbuseDecision
  reviewStatus: 'not_required' | 'pending' | 'reviewed'
  explanation: AssessmentExplanation
  createdAt: string
  expiresAt: string
}

interface AssessmentRow {
  id: string
  payload_hash: string
  model_version_id: string
  subject_kind: string
  subject_ref: string
  context: string
  features_json: string
  score: number
  decision: AbuseDecision
  explanation_json: string
  review_status: 'not_required' | 'pending' | 'reviewed'
  created_at: string
  expires_at: string
}

const toAssessment = (row: AssessmentRow): AssessmentView => ({
  id: row.id,
  modelVersionId: row.model_version_id,
  subjectKind: row.subject_kind,
  subjectRef: row.subject_ref,
  context: row.context,
  features: JSON.parse(row.features_json) as Record<string, number>,
  score: row.score,
  decision: row.decision,
  reviewStatus: row.review_status,
  explanation: JSON.parse(row.explanation_json) as AssessmentExplanation,
  createdAt: row.created_at,
  expiresAt: row.expires_at
})

/**
 * System entry point (called by checkout/login guards, or by an admin tool). The raw subject is hashed with a
 * keyed pseudonym and discarded; only numeric aggregates are kept. The outcome is a request for review at most.
 */
export async function assessAbuse(
  database: D1Database,
  rawInput: unknown,
  context: { now: string; pepper: string }
): Promise<{ assessment: AssessmentView; replayed: boolean }> {
  const input = parseInput(assessAbuseInputSchema, rawInput)
  assertSecret(context.pepper)
  const subjectRef = await pseudonymizeSubject(input.subjectKind, input.subjectId, context.pepper)
  const hash = await payloadHash('assess', {
    subjectKind: input.subjectKind,
    subjectRef,
    context: input.context,
    features: input.features
  })
  const existing = await database
    .prepare(`SELECT * FROM abuse_assessments WHERE command_id=?1`)
    .bind(input.commandId)
    .first<AssessmentRow>()
  if (existing) {
    if (existing.payload_hash !== hash) throw new SecurityControlError('idempotency_conflict', 409)
    return { assessment: toAssessment(existing), replayed: true }
  }
  const model = await getActiveModel(database)
  const result = scoreAbuse(input.features, model)
  const explanation: AssessmentExplanation = {
    humanReviewRequired: result.decision !== 'allow',
    modelVersion: model.version,
    thresholds: { review: model.reviewThreshold, hold: model.holdThreshold },
    contributions: result.contributions
  }
  const id = crypto.randomUUID()
  try {
    await database
      .prepare(
        `INSERT INTO abuse_assessments(id, command_id, payload_hash, model_version_id, subject_kind, subject_ref, context,
           features_json, score, decision, explanation_json, review_status, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
      )
      .bind(
        id,
        input.commandId,
        hash,
        model.id,
        input.subjectKind,
        subjectRef,
        input.context,
        JSON.stringify(input.features),
        result.score,
        result.decision,
        JSON.stringify(explanation),
        result.decision === 'allow' ? 'not_required' : 'pending',
        context.now,
        plusDays(context.now, ABUSE_RETENTION_DAYS)
      )
      .run()
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const raced = await database
      .prepare(`SELECT * FROM abuse_assessments WHERE command_id=?1`)
      .bind(input.commandId)
      .first<AssessmentRow>()
    if (raced && raced.payload_hash === hash) return { assessment: toAssessment(raced), replayed: true }
    throw new SecurityControlError('idempotency_conflict', 409)
  }
  const row = await database.prepare(`SELECT * FROM abuse_assessments WHERE id=?1`).bind(id).first<AssessmentRow>()
  return { assessment: toAssessment(row!), replayed: false }
}

export async function listReviewQueue(database: D1Database, filter: { limit?: number }, context: AdminContext) {
  await requireAdmin(database, context.actorIdentityId, context.now)
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
  const { results } = await database
    .prepare(`SELECT * FROM abuse_assessments WHERE review_status='pending' ORDER BY created_at, rowid LIMIT ?1`)
    .bind(limit)
    .all<AssessmentRow>()
  return results.map(toAssessment)
}

export interface AbuseReviewView {
  id: string
  assessmentId: string
  reviewerIdentityId: string
  outcome: 'confirmed_abuse' | 'false_positive'
  note: string
  createdAt: string
}

export async function reviewAssessment(database: D1Database, rawInput: unknown, context: AdminContext) {
  const input = parseInput(reviewAbuseInputSchema, rawInput)
  await requireAdmin(database, context.actorIdentityId, context.now)
  const row = await database
    .prepare(`SELECT review_status FROM abuse_assessments WHERE id=?1`)
    .bind(input.assessmentId)
    .first<{ review_status: string }>()
  if (!row) throw new SecurityControlError('assessment_not_found', 404)
  if (row.review_status === 'not_required') throw new SecurityControlError('review_not_required', 409)
  if (row.review_status === 'reviewed') throw new SecurityControlError('already_reviewed', 409)
  const reviewId = crypto.randomUUID()
  const params = [
    input.assessmentId, // 1
    context.actorIdentityId, // 2
    context.now, // 3
    reviewId, // 4
    input.outcome, // 5
    input.note, // 6
    crypto.randomUUID(), // 7 audit
    JSON.stringify({ outcome: input.outcome }) // 8
  ]
  await database.batch([
    statement(
      database,
      `UPDATE abuse_assessments SET review_status='reviewed' WHERE id=?1 AND review_status='pending' AND ${adminExistsSql('?2', '?3')}`,
      params
    ),
    statement(
      database,
      `INSERT INTO abuse_reviews(id, assessment_id, reviewer_identity_id, outcome, note, created_at)
       SELECT ?4, ?1, ?2, ?5, ?6, ?3
       WHERE EXISTS(SELECT 1 FROM abuse_assessments WHERE id=?1 AND review_status='reviewed')
         AND NOT EXISTS(SELECT 1 FROM abuse_reviews WHERE assessment_id=?1)`,
      params
    ),
    statement(
      database,
      `INSERT INTO abuse_audit(id, actor_identity_id, action, ref_id, detail_json, created_at)
       SELECT ?7, ?2, 'review_submitted', ?1, ?8, ?3 WHERE EXISTS(SELECT 1 FROM abuse_reviews WHERE id=?4)`,
      params
    )
  ])
  const review = await database
    .prepare(
      `SELECT id, assessment_id, reviewer_identity_id, outcome, note, created_at FROM abuse_reviews WHERE assessment_id=?1`
    )
    .bind(input.assessmentId)
    .first<{
      id: string
      assessment_id: string
      reviewer_identity_id: string
      outcome: AbuseReviewView['outcome']
      note: string
      created_at: string
    }>()
  if (!review || review.id !== reviewId) {
    await requireAdmin(database, context.actorIdentityId, context.now)
    throw new SecurityControlError('already_reviewed', 409)
  }
  const updated = await database
    .prepare(`SELECT * FROM abuse_assessments WHERE id=?1`)
    .bind(input.assessmentId)
    .first<AssessmentRow>()
  return {
    assessment: toAssessment(updated!),
    review: {
      id: review.id,
      assessmentId: review.assessment_id,
      reviewerIdentityId: review.reviewer_identity_id,
      outcome: review.outcome,
      note: review.note,
      createdAt: review.created_at
    } satisfies AbuseReviewView
  }
}

/** Review-based quality metrics. Allowed traffic is unlabelled, so the false-positive rate is over reviewed flags. */
export async function getAbuseMetrics(database: D1Database, rawInput: unknown) {
  const input = parseInput(metricsWindowSchema, rawInput)
  const { results } = await database
    .prepare(
      `SELECT a.decision AS decision, a.review_status AS review_status, r.outcome AS outcome, COUNT(*) AS n
       FROM abuse_assessments a LEFT JOIN abuse_reviews r ON r.assessment_id=a.id
       WHERE a.created_at>=?1 AND a.created_at<?2 AND (?3 IS NULL OR a.model_version_id=?3)
       GROUP BY a.decision, a.review_status, r.outcome`
    )
    .bind(input.from, input.to, input.modelVersionId ?? null)
    .all<{ decision: AbuseDecision; review_status: string; outcome: string | null; n: number }>()
  const byDecision: Record<AbuseDecision, number> = { allow: 0, review: 0, hold: 0 }
  let confirmed = 0
  let falsePositive = 0
  let pending = 0
  let flagged = 0
  for (const row of results) {
    byDecision[row.decision] += row.n
    if (row.decision === 'allow') continue
    flagged += row.n
    if (row.outcome === 'confirmed_abuse') confirmed += row.n
    else if (row.outcome === 'false_positive') falsePositive += row.n
    else if (row.review_status === 'pending') pending += row.n
  }
  return {
    ...summarizeReviewMetrics({ confirmed, falsePositive, pending, flagged }),
    byDecision,
    from: input.from,
    to: input.to
  }
}

export async function recordBaseline(database: D1Database, rawInput: unknown, context: AdminContext) {
  const input = parseInput(baselineInputSchema, rawInput)
  await requireAdmin(database, context.actorIdentityId, context.now)
  await getModel(database, input.modelVersionId)
  const entries = Object.entries(input.samples)
  await database.batch([
    ...entries.map(([feature, samples]) =>
      database
        .prepare(
          `INSERT INTO abuse_baselines(model_version_id, feature, proportions_json, sample_size, created_by, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE ${adminExistsSql('?5', '?6')}
           ON CONFLICT(model_version_id, feature) DO UPDATE SET proportions_json=excluded.proportions_json,
             sample_size=excluded.sample_size, created_by=excluded.created_by, created_at=excluded.created_at`
        )
        .bind(
          input.modelVersionId,
          feature,
          JSON.stringify(proportionsFromSamples(samples, RULE_BY_FEATURE.get(feature)!.cap)),
          samples.length,
          context.actorIdentityId,
          context.now
        )
    ),
    database
      .prepare(
        `INSERT INTO abuse_audit(id, actor_identity_id, action, ref_id, detail_json, created_at)
         SELECT ?1, ?2, 'baseline_recorded', ?3, ?4, ?5 WHERE ${adminExistsSql('?2', '?5')}`
      )
      .bind(
        crypto.randomUUID(),
        context.actorIdentityId,
        input.modelVersionId,
        JSON.stringify({ features: entries.map(([f]) => f) }),
        context.now
      )
  ])
  return {
    modelVersionId: input.modelVersionId,
    features: entries.map(([feature, samples]) => ({ feature, sampleSize: samples.length }))
  }
}

export interface DriftReport {
  id: string
  modelVersionId: string
  feature: string
  windowStart: string
  windowEnd: string
  sampleSize: number
  psi: number | null
  status: DriftStatus
}

export async function computeDrift(
  database: D1Database,
  rawInput: unknown,
  context: AdminContext
): Promise<DriftReport[]> {
  const input = parseInput(driftInputSchema, rawInput)
  await requireAdmin(database, context.actorIdentityId, context.now)
  await getModel(database, input.modelVersionId)
  const { results: baselines } = await database
    .prepare(`SELECT feature, proportions_json FROM abuse_baselines WHERE model_version_id=?1 ORDER BY feature`)
    .bind(input.modelVersionId)
    .all<{ feature: string; proportions_json: string }>()
  if (baselines.length === 0) throw new SecurityControlError('baseline_missing', 409)
  // One bounded read for the whole window; per-feature work happens in memory (no N+1).
  const { results: rows } = await database
    .prepare(
      `SELECT features_json FROM abuse_assessments WHERE model_version_id=?1 AND created_at>=?2 AND created_at<?3
       ORDER BY created_at LIMIT 10000`
    )
    .bind(input.modelVersionId, input.from, input.to)
    .all<{ features_json: string }>()
  const windows = rows.map((row) => JSON.parse(row.features_json) as Record<string, number>)

  const reports: DriftReport[] = baselines.map((baseline) => {
    const rule = RULE_BY_FEATURE.get(baseline.feature)
    const sampleSize = windows.length
    let psi: number | null = null
    let status: DriftStatus = 'insufficient_data'
    if (rule && sampleSize >= DRIFT_MIN_SAMPLES) {
      const current = new Array<number>(BIN_COUNT).fill(0)
      for (const features of windows) current[binIndex(features[baseline.feature] ?? 0, rule.cap)]! += 1
      psi = computePsi(
        JSON.parse(baseline.proportions_json) as number[],
        current.map((count) => count / sampleSize)
      )
      status = driftStatus(psi)
    }
    return {
      id: crypto.randomUUID(),
      modelVersionId: input.modelVersionId,
      feature: baseline.feature,
      windowStart: input.from,
      windowEnd: input.to,
      sampleSize,
      psi,
      status
    }
  })
  await database.batch([
    ...reports.map((report) =>
      database
        .prepare(
          `INSERT INTO abuse_drift_reports(id, model_version_id, feature, window_start, window_end, sample_size, psi, status, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
        )
        .bind(
          report.id,
          report.modelVersionId,
          report.feature,
          report.windowStart,
          report.windowEnd,
          report.sampleSize,
          report.psi,
          report.status,
          context.now
        )
    ),
    database
      .prepare(
        `INSERT INTO abuse_audit(id, actor_identity_id, action, ref_id, detail_json, created_at) VALUES (?1, ?2, 'drift_computed', ?3, ?4, ?5)`
      )
      .bind(
        crypto.randomUUID(),
        context.actorIdentityId,
        input.modelVersionId,
        JSON.stringify({ alerts: reports.filter((r) => r.status === 'alert').map((r) => r.feature) }),
        context.now
      )
  ])
  return reports
}

/** Retention: resolved assessments (and their reviews, by cascade) are deleted after expiry; pending ones are kept. */
export async function purgeExpiredAssessments(
  database: D1Database,
  context: { now: string }
): Promise<{ deleted: number }> {
  const { results } = await database
    .prepare(
      `DELETE FROM abuse_assessments WHERE expires_at<=?1 AND review_status IN ('not_required','reviewed') RETURNING id`
    )
    .bind(context.now)
    .all<{ id: string }>()
  if (results.length > 0) {
    await database
      .prepare(
        `INSERT INTO abuse_audit(id, actor_identity_id, action, ref_id, detail_json, created_at) VALUES (?1, NULL, 'assessments_purged', NULL, ?2, ?3)`
      )
      .bind(crypto.randomUUID(), JSON.stringify({ deleted: results.length }), context.now)
      .run()
  }
  return { deleted: results.length }
}

export { ABUSE_RULES }
