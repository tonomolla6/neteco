import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import {
  analyzeExperiment,
  assignArm,
  marginOf,
  promoExperimentInputSchema,
  promoObservationInputSchema,
  promoSubjectKeySchema,
  type ArmStats,
  type PromoAnalysis,
  type PromoArm,
  type PromoExperimentInput
} from '../../shared/promo-experiments'
import {
  authorizeAdmin,
  canonicalJson,
  executeCommand,
  fail,
  mapStorageError,
  replayCommand,
  requireIdempotencyKey,
  sha256Hex,
  type CommandReceipt,
  type VerifiedSessionClaims
} from './common'

type ExperimentAction = 'start' | 'stop' | 'conclude'
type ExperimentStatus = 'draft' | 'running' | 'stopped' | 'concluded'
const ACTION_FROM: Record<ExperimentAction, readonly ExperimentStatus[]> = {
  start: ['draft'],
  stop: ['running'],
  conclude: ['running', 'stopped']
}
const ACTION_TO: Record<ExperimentAction, ExperimentStatus> = {
  start: 'running',
  stop: 'stopped',
  conclude: 'concluded'
}

interface ExperimentRow {
  id: string
  code: string
  name: string
  promotion_code: string
  status: ExperimentStatus
  version: number
  holdout_basis_points: number
  min_sample_per_arm: number
  min_incremental_margin_cents: number
  conclusion: string | null
  concluded_at: string | null
}

export interface PromoExperimentView {
  id: string
  code: string
  name: string
  promotionCode: string
  status: ExperimentStatus
  version: number
  holdoutBasisPoints: number
  minSamplePerArm: number
  minIncrementalMarginCents: number
  conclusion: string | null
  concludedAt: string | null
}

const COLUMNS = `id, code, name, promotion_code, status, version, holdout_basis_points, min_sample_per_arm,
  min_incremental_margin_cents, conclusion, concluded_at`

const viewOf = (row: ExperimentRow): PromoExperimentView => ({
  id: row.id,
  code: row.code,
  name: row.name,
  promotionCode: row.promotion_code,
  status: row.status,
  version: row.version,
  holdoutBasisPoints: row.holdout_basis_points,
  minSamplePerArm: row.min_sample_per_arm,
  minIncrementalMarginCents: row.min_incremental_margin_cents,
  conclusion: row.conclusion,
  concludedAt: row.concluded_at
})

async function readExperiment(db: D1Database, id: string): Promise<ExperimentRow> {
  if (!catalogPolicyUuidSchema.safeParse(id).success) fail('not_found')
  const row = await db.prepare(`SELECT ${COLUMNS} FROM promo_experiments WHERE id = ?`).bind(id).first<ExperimentRow>()
  if (!row) fail('not_found')
  return row
}

function commandInsert(db: D1Database, receipt: CommandReceipt, actorId: string, key: string, expected: number) {
  return db
    .prepare(
      `INSERT INTO promo_experiment_commands(command_id, actor_id, experiment_id, action, idempotency_key,
         expected_version, applied_version, payload_hash, receipt_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      receipt.commandId,
      actorId,
      receipt.targetId,
      receipt.action,
      key,
      expected,
      receipt.appliedVersion,
      receipt.payloadHash,
      JSON.stringify(receipt),
      receipt.recordedAt
    )
}

export async function createPromoExperiment(
  db: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  idempotencyKey: string,
  now: string
): Promise<CommandReceipt> {
  requireIdempotencyKey(idempotencyKey)
  const parsed = promoExperimentInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input: PromoExperimentInput = parsed.data
  await authorizeAdmin(db, claims, now)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'create', input }))
  const replay = await replayCommand(db, 'promo_experiment_commands', claims.identityId, idempotencyKey, payloadHash)
  if (replay) return replay
  const id = crypto.randomUUID()
  const receipt: CommandReceipt = {
    commandId: crypto.randomUUID(),
    action: 'create',
    targetId: id,
    appliedVersion: 1,
    payloadHash,
    recordedAt: now
  }
  return executeCommand(
    db,
    'promo_experiment_commands',
    claims.identityId,
    idempotencyKey,
    payloadHash,
    [
      db
        .prepare(
          `INSERT INTO promo_experiments(id, code, name, promotion_code, status, version, holdout_basis_points,
             min_sample_per_arm, min_incremental_margin_cents, created_at, updated_at, updated_by)
           VALUES (?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          input.code,
          input.name,
          input.promotionCode,
          input.holdoutBasisPoints,
          input.minSamplePerArm,
          input.minIncrementalMarginCents,
          now,
          now,
          claims.identityId
        ),
      commandInsert(db, receipt, claims.identityId, idempotencyKey, 0)
    ],
    receipt
  )
}

export async function listPromoExperiments(
  db: D1Database,
  claims: VerifiedSessionClaims,
  now: string
): Promise<PromoExperimentView[]> {
  await authorizeAdmin(db, claims, now)
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM promo_experiments ORDER BY code LIMIT 200`)
    .all<ExperimentRow>()
  return results.map(viewOf)
}

async function statsFor(db: D1Database, experimentId: string): Promise<{ holdout: ArmStats; treatment: ArmStats }> {
  // One aggregate query. LEFT JOIN keeps assigned subjects without orders at margin 0.
  const { results } = await db
    .prepare(
      `WITH per_subject AS (
         SELECT a.arm AS arm, COALESCE(SUM(o.margin_cents), 0) AS margin
         FROM promo_experiment_assignments a
         LEFT JOIN promo_experiment_observations o
           ON o.experiment_id = a.experiment_id AND o.subject_hash = a.subject_hash
         WHERE a.experiment_id = ?
         GROUP BY a.subject_hash, a.arm
       )
       SELECT arm, count(*) AS n, COALESCE(SUM(margin), 0) AS total, COALESCE(SUM(margin * 1.0 * margin), 0) AS squares
       FROM per_subject GROUP BY arm`
    )
    .bind(experimentId)
    .all<{ arm: PromoArm; n: number; total: number; squares: number }>()
  const empty = (): ArmStats => ({ n: 0, sum: 0, sumSquares: 0 })
  const out = { holdout: empty(), treatment: empty() }
  for (const row of results)
    out[row.arm] = { n: Number(row.n), sum: Number(row.total), sumSquares: Number(row.squares) }
  return out
}

export interface PromoAnalysisView extends PromoAnalysis {
  experimentId: string
  status: ExperimentStatus
}

async function analyze(db: D1Database, row: ExperimentRow): Promise<PromoAnalysis> {
  return analyzeExperiment(
    {
      holdoutBasisPoints: row.holdout_basis_points,
      minSamplePerArm: row.min_sample_per_arm,
      minIncrementalMarginCents: row.min_incremental_margin_cents
    },
    await statsFor(db, row.id)
  )
}

export async function analyzePromoExperiment(
  db: D1Database,
  claims: VerifiedSessionClaims,
  experimentId: string,
  now: string
): Promise<PromoAnalysisView> {
  await authorizeAdmin(db, claims, now)
  const row = await readExperiment(db, experimentId)
  return { experimentId: row.id, status: row.status, ...(await analyze(db, row)) }
}

/**
 * The conclusion is derived on the server from the margin analysis; a caller can never
 * choose "rollout". Evidence below the bar or a sample-ratio mismatch is inconclusive.
 */
export async function transitionPromoExperiment(
  db: D1Database,
  claims: VerifiedSessionClaims,
  experimentId: string,
  action: ExperimentAction,
  expectedVersion: number,
  idempotencyKey: string,
  now: string
): Promise<CommandReceipt> {
  requireIdempotencyKey(idempotencyKey)
  if (!(action in ACTION_FROM) || !Number.isInteger(expectedVersion) || expectedVersion < 1) fail('invalid_input')
  await authorizeAdmin(db, claims, now)
  const payloadHash = await sha256Hex(canonicalJson({ action, experimentId, expectedVersion }))
  const replay = await replayCommand(db, 'promo_experiment_commands', claims.identityId, idempotencyKey, payloadHash)
  if (replay) return replay
  const row = await readExperiment(db, experimentId)
  if (row.version !== expectedVersion) fail('version_conflict')
  if (!ACTION_FROM[action].includes(row.status)) fail('invalid_transition')
  const receipt: CommandReceipt = {
    commandId: crypto.randomUUID(),
    action,
    targetId: experimentId,
    appliedVersion: expectedVersion + 1,
    payloadHash,
    recordedAt: now
  }
  let conclusion: string | null = null
  if (action === 'conclude') {
    const { decision } = await analyze(db, row)
    conclusion = decision === 'promote' ? 'rollout' : decision === 'reject' ? 'no_rollout' : 'inconclusive'
  }
  return executeCommand(
    db,
    'promo_experiment_commands',
    claims.identityId,
    idempotencyKey,
    payloadHash,
    [
      commandInsert(db, receipt, claims.identityId, idempotencyKey, expectedVersion),
      db
        .prepare(
          `UPDATE promo_experiments SET status = ?, version = ?, conclusion = ?, concluded_at = ?,
             updated_at = ?, updated_by = ? WHERE id = ? AND version = ?`
        )
        .bind(
          ACTION_TO[action],
          expectedVersion + 1,
          conclusion,
          conclusion === null ? null : now,
          now,
          claims.identityId,
          experimentId,
          expectedVersion
        )
    ],
    receipt
  )
}

/** Internal (checkout/system) entry point: idempotent, deterministic, stores a hash only. */
export async function assignPromoSubject(
  db: D1Database,
  experimentId: string,
  subjectKey: string,
  now: string
): Promise<{ arm: PromoArm; subjectHash: string; created: boolean }> {
  if (!promoSubjectKeySchema.safeParse(subjectKey).success) fail('invalid_input')
  const row = await readExperiment(db, experimentId)
  if (row.status !== 'running') fail('experiment_not_running')
  const { arm, subjectHash } = await assignArm(row.id, subjectKey, row.holdout_basis_points)
  const existing = await db
    .prepare('SELECT arm FROM promo_experiment_assignments WHERE experiment_id = ? AND subject_hash = ?')
    .bind(row.id, subjectHash)
    .first<{ arm: PromoArm }>()
  if (existing) return { arm: existing.arm, subjectHash, created: false }
  try {
    await db
      .prepare(
        `INSERT INTO promo_experiment_assignments(experiment_id, subject_hash, arm, assigned_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(experiment_id, subject_hash) DO NOTHING`
      )
      .bind(row.id, subjectHash, arm, now)
      .run()
  } catch (error) {
    mapStorageError(error)
  }
  return { arm, subjectHash, created: true }
}

export async function recordPromoObservation(
  db: D1Database,
  experimentId: string,
  rawInput: unknown,
  now: string
): Promise<void> {
  const parsed = promoObservationInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data
  const row = await readExperiment(db, experimentId)
  if (row.status !== 'running' && row.status !== 'stopped') fail('experiment_not_running')
  const { subjectHash } = await assignArm(row.id, input.subjectKey, row.holdout_basis_points)
  const assigned = await db
    .prepare('SELECT 1 AS ok FROM promo_experiment_assignments WHERE experiment_id = ? AND subject_hash = ?')
    .bind(row.id, subjectHash)
    .first()
  if (!assigned) fail('not_found')
  const margin = marginOf(input)
  const existing = await db
    .prepare(
      `SELECT subject_hash, revenue_gross_cents, net_revenue_cents, cogs_cents, variable_cost_cents
       FROM promo_experiment_observations WHERE experiment_id = ? AND order_ref = ?`
    )
    .bind(row.id, input.orderRef)
    .first<Record<string, unknown>>()
  if (existing) {
    const same =
      existing.subject_hash === subjectHash &&
      existing.revenue_gross_cents === input.revenueGrossCents &&
      existing.net_revenue_cents === input.netRevenueCents &&
      existing.cogs_cents === input.cogsCents &&
      existing.variable_cost_cents === input.variableCostCents
    if (!same) fail('conflict')
    return
  }
  try {
    await db
      .prepare(
        `INSERT INTO promo_experiment_observations(id, experiment_id, subject_hash, order_ref, revenue_gross_cents,
           net_revenue_cents, cogs_cents, variable_cost_cents, margin_cents, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        row.id,
        subjectHash,
        input.orderRef,
        input.revenueGrossCents,
        input.netRevenueCents,
        input.cogsCents,
        input.variableCostCents,
        margin,
        now
      )
      .run()
  } catch (error) {
    mapStorageError(error)
  }
}
