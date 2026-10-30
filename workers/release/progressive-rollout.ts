import { createHash, randomUUID } from 'node:crypto'
import {
  type BetaScopeNotice,
  type CreateRolloutInput,
  type EvaluateSubjectInput,
  type GuardrailConfig,
  type ManualRollbackInput,
  type ProgressiveRolloutRecord,
  type PromoteRolloutFullInput,
  type RecordRolloutMetricsInput,
  type RolloutEvaluationResult,
  type UpdateRolloutInput,
  ProgressiveRolloutError,
  createRolloutSchema,
  evaluateSubjectSchema,
  manualRollbackSchema,
  promoteRolloutFullSchema,
  recordRolloutMetricsSchema,
  updateRolloutSchema
} from '../../shared/progressive-rollout'

function computeHash(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex')
}

export function hashBucket(featureKey: string, subjectId: string): number {
  const hex = createHash('sha256').update(`${featureKey}:${subjectId}`).digest('hex')
  return parseInt(hex.slice(0, 8), 16) % 100
}

interface RawRolloutRow {
  id: string
  feature_key: string
  name: string
  status: string
  traffic_percentage: number
  cohorts_json: string
  zones_json: string
  guardrails_json: string
  beta_scope_notice_json: string
  trip_reason: string | null
  version: number
  created_at: string
  updated_at: string
  created_by: string
}

function mapRolloutRow(row: RawRolloutRow): ProgressiveRolloutRecord {
  return {
    id: row.id,
    featureKey: row.feature_key,
    name: row.name,
    status: row.status as ProgressiveRolloutRecord['status'],
    trafficPercentage: Number(row.traffic_percentage),
    cohorts: JSON.parse(row.cohorts_json),
    zones: JSON.parse(row.zones_json),
    guardrails: JSON.parse(row.guardrails_json) as GuardrailConfig,
    betaScopeNotice: JSON.parse(row.beta_scope_notice_json) as BetaScopeNotice,
    tripReason: row.trip_reason,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by
  }
}

async function checkIdempotency(
  db: D1Database,
  commandId: string,
  payloadHash: string
): Promise<{ exists: boolean; rolloutId?: string }> {
  const existing = await db
    .prepare('SELECT command_id, rollout_id, payload_hash FROM rollout_commands WHERE command_id = ?')
    .bind(commandId)
    .first<{ command_id: string; rollout_id: string; payload_hash: string }>()

  if (!existing) return { exists: false }
  if (existing.payload_hash !== payloadHash) {
    throw new ProgressiveRolloutError(
      'idempotency_conflict',
      409,
      'Command payload hash does not match original command'
    )
  }
  return { exists: true, rolloutId: existing.rollout_id }
}

export async function createProgressiveRollout(
  db: D1Database,
  input: CreateRolloutInput,
  actorId: string,
  nowIso: string
): Promise<ProgressiveRolloutRecord> {
  const validated = createRolloutSchema.parse(input)
  const payloadHash = computeHash(validated)

  const idemp = await checkIdempotency(db, validated.commandId, payloadHash)
  if (idemp.exists && idemp.rolloutId) {
    return getProgressiveRollout(db, idemp.rolloutId)
  }

  const id = randomUUID()

  await db
    .prepare(
      `
      INSERT INTO progressive_rollouts (
        id, feature_key, name, status, traffic_percentage,
        cohorts_json, zones_json, guardrails_json, beta_scope_notice_json,
        trip_reason, version, created_at, updated_at, created_by
      ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)
    `
    )
    .bind(
      id,
      validated.featureKey,
      validated.name,
      validated.trafficPercentage,
      JSON.stringify(validated.cohorts),
      JSON.stringify(validated.zones),
      JSON.stringify(validated.guardrails),
      JSON.stringify(validated.betaScopeNotice),
      nowIso,
      nowIso,
      actorId
    )
    .run()

  await db
    .prepare(
      `
      INSERT INTO rollout_commands (
        id, command_id, actor_id, action, rollout_id, payload_hash, payload_json, created_at
      ) VALUES (?, ?, ?, 'create_rollout', ?, ?, ?, ?)
    `
    )
    .bind(randomUUID(), validated.commandId, actorId, id, payloadHash, JSON.stringify(validated), nowIso)
    .run()

  return getProgressiveRollout(db, id)
}

export async function getProgressiveRollout(db: D1Database, rolloutId: string): Promise<ProgressiveRolloutRecord> {
  const row = await db.prepare('SELECT * FROM progressive_rollouts WHERE id = ?').bind(rolloutId).first<RawRolloutRow>()

  if (!row) {
    throw new ProgressiveRolloutError('rollout_not_found', 404, `Rollout ${rolloutId} not found`)
  }
  return mapRolloutRow(row)
}

export async function listProgressiveRollouts(db: D1Database, limit = 50): Promise<ProgressiveRolloutRecord[]> {
  const rows = await db
    .prepare('SELECT * FROM progressive_rollouts ORDER BY created_at DESC LIMIT ?')
    .bind(limit)
    .all<RawRolloutRow>()

  return (rows.results ?? []).map(mapRolloutRow)
}

export async function updateProgressiveRollout(
  db: D1Database,
  input: UpdateRolloutInput,
  actorId: string,
  nowIso: string
): Promise<ProgressiveRolloutRecord> {
  const validated = updateRolloutSchema.parse(input)
  const payloadHash = computeHash(validated)

  const idemp = await checkIdempotency(db, validated.commandId, payloadHash)
  if (idemp.exists && idemp.rolloutId) {
    return getProgressiveRollout(db, idemp.rolloutId)
  }

  const current = await getProgressiveRollout(db, validated.rolloutId)
  if (current.version !== validated.expectedVersion) {
    throw new ProgressiveRolloutError('concurrency_conflict', 409, 'Rollout was modified by another actor')
  }

  const nextTraffic = validated.trafficPercentage ?? current.trafficPercentage
  const nextCohorts = validated.cohorts ?? current.cohorts
  const nextZones = validated.zones ?? current.zones
  const nextStatus = validated.status ?? current.status
  const nextGuardrails = validated.guardrails ?? current.guardrails
  const nextNotice = validated.betaScopeNotice ?? current.betaScopeNotice

  const res = (await db
    .prepare(
      `
      UPDATE progressive_rollouts
      SET traffic_percentage = ?,
          cohorts_json = ?,
          zones_json = ?,
          status = ?,
          guardrails_json = ?,
          beta_scope_notice_json = ?,
          version = version + 1,
          updated_at = ?
      WHERE id = ? AND version = ?
    `
    )
    .bind(
      nextTraffic,
      JSON.stringify(nextCohorts),
      JSON.stringify(nextZones),
      nextStatus,
      JSON.stringify(nextGuardrails),
      JSON.stringify(nextNotice),
      nowIso,
      validated.rolloutId,
      validated.expectedVersion
    )
    .run()) as { meta?: { changes?: number }; success?: boolean }

  if (res?.meta?.changes === 0) {
    throw new ProgressiveRolloutError('concurrency_conflict', 409, 'CAS update failed')
  }

  await db
    .prepare(
      `
      INSERT INTO rollout_commands (
        id, command_id, actor_id, action, rollout_id, payload_hash, payload_json, created_at
      ) VALUES (?, ?, ?, 'update_rollout', ?, ?, ?, ?)
    `
    )
    .bind(
      randomUUID(),
      validated.commandId,
      actorId,
      validated.rolloutId,
      payloadHash,
      JSON.stringify(validated),
      nowIso
    )
    .run()

  return getProgressiveRollout(db, validated.rolloutId)
}

export async function evaluateProgressiveRollout(
  db: D1Database,
  input: EvaluateSubjectInput
): Promise<RolloutEvaluationResult> {
  const validated = evaluateSubjectSchema.parse(input)
  const row = await db
    .prepare('SELECT * FROM progressive_rollouts WHERE feature_key = ? ORDER BY created_at DESC LIMIT 1')
    .bind(validated.featureKey)
    .first<RawRolloutRow>()

  if (!row) {
    return {
      enabled: false,
      featureKey: validated.featureKey,
      status: 'draft',
      reason: 'not_found',
      betaScopeNotice: null
    }
  }

  const rollout = mapRolloutRow(row)

  if (rollout.status === 'rolled_back') {
    return {
      enabled: false,
      featureKey: rollout.featureKey,
      status: 'rolled_back',
      reason: 'rolled_back',
      betaScopeNotice: null
    }
  }

  if (rollout.status === 'tripped') {
    return {
      enabled: false,
      featureKey: rollout.featureKey,
      status: 'tripped',
      reason: 'tripped',
      betaScopeNotice: null
    }
  }

  if (rollout.status === 'draft' || rollout.status === 'paused') {
    return {
      enabled: false,
      featureKey: rollout.featureKey,
      status: rollout.status,
      reason: 'disabled',
      betaScopeNotice: null
    }
  }

  if (rollout.status === 'promoted_full') {
    return {
      enabled: true,
      featureKey: rollout.featureKey,
      status: 'promoted_full',
      reason: 'promoted_full',
      betaScopeNotice: null
    }
  }

  // Active status evaluation
  if (validated.cohort && rollout.cohorts.includes(validated.cohort)) {
    return {
      enabled: true,
      featureKey: rollout.featureKey,
      status: 'active',
      reason: 'cohort_match',
      betaScopeNotice: rollout.betaScopeNotice
    }
  }

  if (rollout.zones.length > 0) {
    if (!validated.zone || !rollout.zones.includes(validated.zone)) {
      return {
        enabled: false,
        featureKey: rollout.featureKey,
        status: 'active',
        reason: 'disabled',
        betaScopeNotice: null
      }
    }
  }

  const bucket = hashBucket(rollout.featureKey, validated.subjectId)
  if (bucket < rollout.trafficPercentage) {
    return {
      enabled: true,
      featureKey: rollout.featureKey,
      status: 'active',
      reason: 'traffic_bucket',
      betaScopeNotice: rollout.betaScopeNotice
    }
  }

  return {
    enabled: false,
    featureKey: rollout.featureKey,
    status: 'active',
    reason: 'disabled',
    betaScopeNotice: null
  }
}

export async function recordRolloutMetrics(
  db: D1Database,
  input: RecordRolloutMetricsInput,
  actorId: string,
  nowIso: string
): Promise<{
  breached: boolean
  rolloutStatus: ProgressiveRolloutRecord['status']
  details: { errorRateBreached: boolean; latencyBreached: boolean; reasons: string[] }
}> {
  const validated = recordRolloutMetricsSchema.parse(input)
  const payloadHash = computeHash(validated)

  const idemp = await checkIdempotency(db, validated.commandId, payloadHash)
  if (idemp.exists && idemp.rolloutId) {
    const cur = await getProgressiveRollout(db, idemp.rolloutId)
    return {
      breached: cur.status === 'tripped',
      rolloutStatus: cur.status,
      details: { errorRateBreached: false, latencyBreached: false, reasons: ['idempotent_replay'] }
    }
  }

  const current = await getProgressiveRollout(db, validated.rolloutId)
  if (current.version !== validated.expectedVersion) {
    throw new ProgressiveRolloutError('concurrency_conflict', 409, 'Rollout was modified by another actor')
  }

  const errorRatePercent = validated.sampleCount > 0 ? (validated.errorCount / validated.sampleCount) * 100 : 0
  const reasons: string[] = []
  let errorRateBreached = false
  let latencyBreached = false

  if (validated.sampleCount >= current.guardrails.minSampleCount) {
    if (errorRatePercent > current.guardrails.maxErrorRatePercent) {
      errorRateBreached = true
      reasons.push(
        `Error rate ${errorRatePercent.toFixed(2)}% exceeded maximum ${current.guardrails.maxErrorRatePercent}%`
      )
    }
    if (validated.p95LatencyMs > current.guardrails.maxP95LatencyMs) {
      latencyBreached = true
      reasons.push(`P95 latency ${validated.p95LatencyMs}ms exceeded threshold ${current.guardrails.maxP95LatencyMs}ms`)
    }
  }

  const breached = errorRateBreached || latencyBreached
  const breachDetails = { errorRateBreached, latencyBreached, reasons }

  const evalId = randomUUID()
  await db
    .prepare(
      `
      INSERT INTO rollout_guardrail_evaluations (
        id, rollout_id, window_start, window_end, sample_count,
        error_count, error_rate_percent, p95_latency_ms, breached,
        breach_details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .bind(
      evalId,
      validated.rolloutId,
      validated.windowStart,
      validated.windowEnd,
      validated.sampleCount,
      validated.errorCount,
      errorRatePercent,
      validated.p95LatencyMs,
      breached ? 1 : 0,
      JSON.stringify(breachDetails),
      nowIso
    )
    .run()

  let newStatus = current.status
  if (breached && current.status === 'active') {
    newStatus = 'tripped'
    await db
      .prepare(
        `
        UPDATE progressive_rollouts
        SET status = 'tripped',
            trip_reason = ?,
            version = version + 1,
            updated_at = ?
        WHERE id = ? AND version = ?
      `
      )
      .bind(`Guardrail breach: ${reasons.join('; ')}`, nowIso, validated.rolloutId, validated.expectedVersion)
      .run()
  }

  await db
    .prepare(
      `
      INSERT INTO rollout_commands (
        id, command_id, actor_id, action, rollout_id, payload_hash, payload_json, created_at
      ) VALUES (?, ?, ?, 'record_metrics', ?, ?, ?, ?)
    `
    )
    .bind(
      randomUUID(),
      validated.commandId,
      actorId,
      validated.rolloutId,
      payloadHash,
      JSON.stringify(validated),
      nowIso
    )
    .run()

  return {
    breached,
    rolloutStatus: newStatus,
    details: breachDetails
  }
}

export async function manualRollbackProgressiveRollout(
  db: D1Database,
  input: ManualRollbackInput,
  actorId: string,
  nowIso: string
): Promise<ProgressiveRolloutRecord> {
  const validated = manualRollbackSchema.parse(input)
  const payloadHash = computeHash(validated)

  const idemp = await checkIdempotency(db, validated.commandId, payloadHash)
  if (idemp.exists && idemp.rolloutId) {
    return getProgressiveRollout(db, idemp.rolloutId)
  }

  const current = await getProgressiveRollout(db, validated.rolloutId)
  if (current.version !== validated.expectedVersion) {
    throw new ProgressiveRolloutError('concurrency_conflict', 409, 'Rollout was modified by another actor')
  }

  const res = (await db
    .prepare(
      `
      UPDATE progressive_rollouts
      SET status = 'rolled_back',
          trip_reason = ?,
          version = version + 1,
          updated_at = ?
      WHERE id = ? AND version = ?
    `
    )
    .bind(`Manual rollback: ${validated.reason}`, nowIso, validated.rolloutId, validated.expectedVersion)
    .run()) as { meta?: { changes?: number }; success?: boolean }

  if (res?.meta?.changes === 0) {
    throw new ProgressiveRolloutError('concurrency_conflict', 409, 'CAS update failed')
  }

  await db
    .prepare(
      `
      INSERT INTO rollout_commands (
        id, command_id, actor_id, action, rollout_id, payload_hash, payload_json, created_at
      ) VALUES (?, ?, ?, 'manual_rollback', ?, ?, ?, ?)
    `
    )
    .bind(
      randomUUID(),
      validated.commandId,
      actorId,
      validated.rolloutId,
      payloadHash,
      JSON.stringify(validated),
      nowIso
    )
    .run()

  return getProgressiveRollout(db, validated.rolloutId)
}

export async function promoteProgressiveRolloutFull(
  db: D1Database,
  input: PromoteRolloutFullInput,
  actorId: string,
  nowIso: string
): Promise<ProgressiveRolloutRecord> {
  const validated = promoteRolloutFullSchema.parse(input)
  const payloadHash = computeHash(validated)

  const idemp = await checkIdempotency(db, validated.commandId, payloadHash)
  if (idemp.exists && idemp.rolloutId) {
    return getProgressiveRollout(db, idemp.rolloutId)
  }

  const current = await getProgressiveRollout(db, validated.rolloutId)
  if (current.version !== validated.expectedVersion) {
    throw new ProgressiveRolloutError('concurrency_conflict', 409, 'Rollout was modified by another actor')
  }

  const res = (await db
    .prepare(
      `
      UPDATE progressive_rollouts
      SET status = 'promoted_full',
          traffic_percentage = 100,
          version = version + 1,
          updated_at = ?
      WHERE id = ? AND version = ?
    `
    )
    .bind(nowIso, validated.rolloutId, validated.expectedVersion)
    .run()) as { meta?: { changes?: number }; success?: boolean }

  if (res?.meta?.changes === 0) {
    throw new ProgressiveRolloutError('concurrency_conflict', 409, 'CAS update failed')
  }

  await db
    .prepare(
      `
      INSERT INTO rollout_commands (
        id, command_id, actor_id, action, rollout_id, payload_hash, payload_json, created_at
      ) VALUES (?, ?, ?, 'promote_full', ?, ?, ?, ?)
    `
    )
    .bind(
      randomUUID(),
      validated.commandId,
      actorId,
      validated.rolloutId,
      payloadHash,
      JSON.stringify(validated),
      nowIso
    )
    .run()

  return getProgressiveRollout(db, validated.rolloutId)
}
