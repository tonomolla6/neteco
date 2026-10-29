import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  type AssignVariantInput,
  type CreateExperimentInput,
  type DecisionType,
  type ExperimentGuardrails,
  type ExperimentStatus,
  type ExperimentSummaryReport,
  type PrimaryMetric,
  type RecordDecisionInput,
  type TargetSegment,
  type TargetSurface,
  type TrackEventInput,
  type UpdateExperimentInput,
  type VariantMetrics,
  AssignVariantInputSchema,
  CreateExperimentInputSchema,
  ExperimentGuardrailsSchema,
  RecordDecisionInputSchema,
  TrackEventInputSchema,
  UpdateExperimentInputSchema,
  calculateSampleRatioMismatch,
  checkExperimentOverlap,
  evaluateGuardrails,
  experimentPayloadHash,
  stableAssignVariant,
  ExperimentsError
} from '../../shared/experiments-ab-testing'

export interface ExperimentOperationOptions {
  idempotencyKey: string
  now?: () => string
}

function getIsoNow(options?: { now?: () => string }): string {
  const custom = options?.now?.()
  if (custom) return custom
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function checkExperimentsAuth(database: D1Database, claims: VerifiedSessionClaims, now?: string): Promise<void> {
  const auth = await authorizeD1Session(database, claims, 'experiments.manage', { now })
  if (auth.allowed) return
  const fallback = await authorizeD1Session(database, claims, 'administration.manage', { now })
  if (fallback.allowed) return

  if (auth.code === 'unauthenticated' || fallback.code === 'unauthenticated') {
    throw new ExperimentsError('unauthenticated', 'Sesión no autenticada')
  }
  if (auth.code === 'mfa_required' || fallback.code === 'mfa_required') {
    throw new ExperimentsError('unauthenticated', 'MFA requerido')
  }
  throw new ExperimentsError('forbidden', 'Permisos insuficientes para gestionar experimentos')
}

export async function createD1Experiment(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: CreateExperimentInput,
  options: ExperimentOperationOptions
): Promise<{ experimentId: string; key: string; version: number }> {
  await checkExperimentsAuth(database, claims, options.now?.())

  const parsed = CreateExperimentInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new ExperimentsError('invalid_input', `Entrada inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = getIsoNow(options)
  const payloadHash = await experimentPayloadHash('create_experiment', input)

  // Check idempotency
  const existingCommand = await database
    .prepare(
      `SELECT receipt_json FROM experiment_commands
       WHERE actor_id = ? AND idempotency_key = ?`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ receipt_json: string }>()

  if (existingCommand) {
    return JSON.parse(existingCommand.receipt_json) as {
      experimentId: string
      key: string
      version: number
    }
  }

  // Key uniqueness
  const existingKey = await database.prepare(`SELECT id FROM experiments WHERE key = ?`).bind(input.key).first()

  if (existingKey) {
    throw new ExperimentsError('conflict', `Ya existe un experimento con la clave ${input.key}`)
  }

  const experimentId = crypto.randomUUID()
  const commandId = crypto.randomUUID()
  const receipt = {
    experimentId,
    key: input.key,
    version: 1,
    action: 'create_experiment',
    recordedAt: now
  }

  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO experiments (
          id, key, name, hypothesis, experiment_type, status, owner_id, owner_email,
          target_surface, target_segment, exclusive_group, primary_metric, guardrails_json,
          traffic_allocation_percent, min_sample_size, min_duration_days, start_date, end_date,
          holdout_percent, changes_description, version, created_at, updated_at, created_by
        ) VALUES (
          ?, ?, ?, ?, ?, 'draft', ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, 1, ?, ?, ?
        )`
      )
      .bind(
        experimentId,
        input.key,
        input.name,
        input.hypothesis,
        input.experimentType,
        claims.identityId,
        input.ownerEmail,
        input.targetSurface,
        input.targetSegment,
        input.exclusiveGroup ?? null,
        input.primaryMetric,
        JSON.stringify(input.guardrails),
        input.trafficAllocationPercent,
        input.minSampleSize,
        input.minDurationDays,
        input.startDate ?? null,
        input.endDate ?? null,
        input.holdoutPercent,
        input.changesDescription,
        now,
        now,
        claims.identityId
      )
  ]

  for (const variant of input.variants) {
    const variantId = crypto.randomUUID()
    statements.push(
      database
        .prepare(
          `INSERT INTO experiment_variants (
            id, experiment_id, variant_key, name, is_control, is_holdout, weight, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          variantId,
          experimentId,
          variant.variantKey,
          variant.name,
          variant.isControl ? 1 : 0,
          variant.isHoldout ? 1 : 0,
          variant.weight,
          JSON.stringify(variant.payload ?? {}),
          now
        )
    )
  }

  statements.push(
    database
      .prepare(
        `INSERT INTO experiment_commands (
          command_id, experiment_id, actor_id, action, idempotency_key,
          expected_version, result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?, ?, ?, 'create_experiment', ?, 0, 1, ?, ?, ?, ?)`
      )
      .bind(
        commandId,
        experimentId,
        claims.identityId,
        options.idempotencyKey,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(receipt),
        now
      )
  )

  await database.batch(statements)
  return receipt
}

export async function updateD1Experiment(
  database: D1Database,
  claims: VerifiedSessionClaims,
  experimentId: string,
  rawInput: UpdateExperimentInput,
  options: ExperimentOperationOptions
): Promise<{ experimentId: string; version: number }> {
  await checkExperimentsAuth(database, claims, options.now?.())

  const parsed = UpdateExperimentInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new ExperimentsError('invalid_input', `Entrada inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  // Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT receipt_json FROM experiment_commands
       WHERE actor_id = ? AND idempotency_key = ?`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ receipt_json: string }>()

  if (existingCommand) {
    return JSON.parse(existingCommand.receipt_json) as { experimentId: string; version: number }
  }

  const current = await database
    .prepare(`SELECT id, status, version, guardrails_json FROM experiments WHERE id = ?`)
    .bind(experimentId)
    .first<{ id: string; status: string; version: number; guardrails_json: string }>()

  if (!current) {
    throw new ExperimentsError('not_found', 'Experimento no encontrado')
  }

  if (current.status !== 'draft') {
    throw new ExperimentsError('conflict', 'Solo se pueden modificar experimentos en estado borrador')
  }

  if (current.version !== input.expectedVersion) {
    throw new ExperimentsError(
      'version_conflict',
      `Conflicto de versión: esperada ${input.expectedVersion}, actual ${current.version}`
    )
  }

  const newVersion = current.version + 1
  const commandId = crypto.randomUUID()
  const payloadHash = await experimentPayloadHash('update_experiment', input)
  const receipt = {
    experimentId,
    version: newVersion,
    action: 'update_experiment',
    recordedAt: now
  }

  const existingGuardrails = JSON.parse(current.guardrails_json || '{}')
  const mergedGuardrails = input.guardrails ? { ...existingGuardrails, ...input.guardrails } : existingGuardrails

  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `UPDATE experiments
         SET name = COALESCE(?, name),
             hypothesis = COALESCE(?, hypothesis),
             target_surface = COALESCE(?, target_surface),
             target_segment = COALESCE(?, target_segment),
             exclusive_group = CASE WHEN ? IS NOT NULL THEN ? ELSE exclusive_group END,
             primary_metric = COALESCE(?, primary_metric),
             guardrails_json = ?,
             traffic_allocation_percent = COALESCE(?, traffic_allocation_percent),
             min_sample_size = COALESCE(?, min_sample_size),
             min_duration_days = COALESCE(?, min_duration_days),
             holdout_percent = COALESCE(?, holdout_percent),
             changes_description = COALESCE(?, changes_description),
             version = ?,
             updated_at = ?
         WHERE id = ? AND version = ?`
      )
      .bind(
        input.name ?? null,
        input.hypothesis ?? null,
        input.targetSurface ?? null,
        input.targetSegment ?? null,
        input.exclusiveGroup !== undefined ? 1 : null,
        input.exclusiveGroup ?? null,
        input.primaryMetric ?? null,
        JSON.stringify(mergedGuardrails),
        input.trafficAllocationPercent ?? null,
        input.minSampleSize ?? null,
        input.minDurationDays ?? null,
        input.holdoutPercent ?? null,
        input.changesDescription ?? null,
        newVersion,
        now,
        experimentId,
        current.version
      ),
    database
      .prepare(
        `INSERT INTO experiment_commands (
          command_id, experiment_id, actor_id, action, idempotency_key,
          expected_version, result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?, ?, ?, 'update_experiment', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        commandId,
        experimentId,
        claims.identityId,
        options.idempotencyKey,
        input.expectedVersion,
        newVersion,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(receipt),
        now
      )
  ]

  await database.batch(statements)
  return receipt
}

export async function startD1Experiment(
  database: D1Database,
  claims: VerifiedSessionClaims,
  experimentId: string,
  options: ExperimentOperationOptions & { expectedVersion: number }
): Promise<{ experimentId: string; status: ExperimentStatus; version: number }> {
  await checkExperimentsAuth(database, claims, options.now?.())
  const now = getIsoNow(options)

  // Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT receipt_json FROM experiment_commands
       WHERE actor_id = ? AND idempotency_key = ?`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ receipt_json: string }>()

  if (existingCommand) {
    return JSON.parse(existingCommand.receipt_json) as {
      experimentId: string
      status: ExperimentStatus
      version: number
    }
  }

  const current = await database
    .prepare(
      `SELECT id, name, key, target_surface, target_segment, exclusive_group, status, version, start_date FROM experiments WHERE id = ?`
    )
    .bind(experimentId)
    .first<{
      id: string
      name: string
      key: string
      target_surface: TargetSurface
      target_segment: TargetSegment
      exclusive_group: string | null
      status: string
      version: number
      start_date: string | null
    }>()

  if (!current) {
    throw new ExperimentsError('not_found', 'Experimento no encontrado')
  }

  if (current.status === 'running') {
    throw new ExperimentsError('experiment_already_running', 'El experimento ya se encuentra en ejecución')
  }
  if (current.status === 'archived' || current.status === 'concluded') {
    throw new ExperimentsError('experiment_already_concluded', 'No se puede reactivar un experimento archivado')
  }
  if (current.version !== options.expectedVersion) {
    throw new ExperimentsError(
      'version_conflict',
      `Conflicto de versión: esperada ${options.expectedVersion}, actual ${current.version}`
    )
  }

  // DAT-018: Overlap conflict check against other running experiments
  const activeRunning = await database
    .prepare(
      `SELECT id, name, key, target_surface, target_segment, exclusive_group
       FROM experiments
       WHERE status = 'running' AND id <> ?`
    )
    .bind(experimentId)
    .all<{
      id: string
      name: string
      key: string
      target_surface: TargetSurface
      target_segment: TargetSegment
      exclusive_group: string | null
    }>()

  const overlap = checkExperimentOverlap(
    {
      id: current.id,
      targetSurface: current.target_surface,
      targetSegment: current.target_segment,
      exclusiveGroup: current.exclusive_group
    },
    activeRunning.results.map((r) => ({
      id: r.id,
      name: r.name,
      key: r.key,
      targetSurface: r.target_surface,
      targetSegment: r.target_segment,
      exclusiveGroup: r.exclusive_group
    }))
  )

  if (overlap.hasConflict) {
    throw new ExperimentsError('overlapping_experiment_conflict', overlap.reason)
  }

  const newVersion = current.version + 1
  const commandId = crypto.randomUUID()
  const payloadHash = await experimentPayloadHash('start_experiment', {
    experimentId,
    expectedVersion: options.expectedVersion
  })
  const startDate = current.start_date ?? now

  const receipt = {
    experimentId,
    status: 'running' as const,
    version: newVersion,
    action: 'start_experiment',
    recordedAt: now
  }

  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `UPDATE experiments
         SET status = 'running',
             start_date = ?,
             version = ?,
             updated_at = ?
         WHERE id = ? AND version = ?`
      )
      .bind(startDate, newVersion, now, experimentId, current.version),
    database
      .prepare(
        `INSERT INTO experiment_commands (
          command_id, experiment_id, actor_id, action, idempotency_key,
          expected_version, result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?, ?, ?, 'start_experiment', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        commandId,
        experimentId,
        claims.identityId,
        options.idempotencyKey,
        options.expectedVersion,
        newVersion,
        payloadHash,
        JSON.stringify({ experimentId }),
        JSON.stringify(receipt),
        now
      )
  ]

  await database.batch(statements)
  return receipt
}

export async function pauseD1Experiment(
  database: D1Database,
  claims: VerifiedSessionClaims,
  experimentId: string,
  options: ExperimentOperationOptions & { expectedVersion: number }
): Promise<{ experimentId: string; status: ExperimentStatus; version: number }> {
  await checkExperimentsAuth(database, claims, options.now?.())
  const now = getIsoNow(options)

  const existingCommand = await database
    .prepare(
      `SELECT receipt_json FROM experiment_commands
       WHERE actor_id = ? AND idempotency_key = ?`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ receipt_json: string }>()

  if (existingCommand) {
    return JSON.parse(existingCommand.receipt_json) as {
      experimentId: string
      status: ExperimentStatus
      version: number
    }
  }

  const current = await database
    .prepare(`SELECT id, status, version FROM experiments WHERE id = ?`)
    .bind(experimentId)
    .first<{ id: string; status: string; version: number }>()

  if (!current) {
    throw new ExperimentsError('not_found', 'Experimento no encontrado')
  }

  if (current.status !== 'running') {
    throw new ExperimentsError('experiment_not_running', 'El experimento no está en ejecución')
  }

  if (current.version !== options.expectedVersion) {
    throw new ExperimentsError(
      'version_conflict',
      `Conflicto de versión: esperada ${options.expectedVersion}, actual ${current.version}`
    )
  }

  const newVersion = current.version + 1
  const commandId = crypto.randomUUID()
  const payloadHash = await experimentPayloadHash('pause_experiment', {
    experimentId,
    expectedVersion: options.expectedVersion
  })

  const receipt = {
    experimentId,
    status: 'paused' as const,
    version: newVersion,
    action: 'pause_experiment',
    recordedAt: now
  }

  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `UPDATE experiments
         SET status = 'paused',
             version = ?,
             updated_at = ?
         WHERE id = ? AND version = ?`
      )
      .bind(newVersion, now, experimentId, current.version),
    database
      .prepare(
        `INSERT INTO experiment_commands (
          command_id, experiment_id, actor_id, action, idempotency_key,
          expected_version, result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?, ?, ?, 'pause_experiment', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        commandId,
        experimentId,
        claims.identityId,
        options.idempotencyKey,
        options.expectedVersion,
        newVersion,
        payloadHash,
        JSON.stringify({ experimentId }),
        JSON.stringify(receipt),
        now
      )
  ]

  await database.batch(statements)
  return receipt
}

export async function assignD1ExperimentVariant(
  database: D1Database,
  rawInput: AssignVariantInput,
  nowIso?: string
): Promise<{
  experimentKey: string
  variantKey: string | null
  payload: Record<string, unknown>
  isHoldout: boolean
  isControl: boolean
  isAssigned: boolean
}> {
  const parsed = AssignVariantInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new ExperimentsError('invalid_input', `Entrada inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = nowIso ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  // Find experiment
  const experiment = await database
    .prepare(
      `SELECT id, key, status, target_surface, target_segment, traffic_allocation_percent, holdout_percent
       FROM experiments
       WHERE key = ?`
    )
    .bind(input.experimentKey)
    .first<{
      id: string
      key: string
      status: string
      target_surface: string
      target_segment: string
      traffic_allocation_percent: number
      holdout_percent: number
    }>()

  if (!experiment) {
    throw new ExperimentsError('not_found', `Experimento "${input.experimentKey}" no encontrado`)
  }

  if (experiment.status !== 'running') {
    return {
      experimentKey: experiment.key,
      variantKey: null,
      payload: {},
      isHoldout: false,
      isControl: false,
      isAssigned: false
    }
  }

  // Segment context check
  if (
    experiment.target_segment !== 'all' &&
    input.context?.segment &&
    input.context.segment !== experiment.target_segment
  ) {
    return {
      experimentKey: experiment.key,
      variantKey: null,
      payload: {},
      isHoldout: false,
      isControl: false,
      isAssigned: false
    }
  }

  // Check existing assignment in DB
  const existing = await database
    .prepare(
      `SELECT a.variant_key, v.payload_json, v.is_holdout, v.is_control
       FROM experiment_assignments a
       LEFT JOIN experiment_variants v ON v.experiment_id = a.experiment_id AND v.variant_key = a.variant_key
       WHERE a.experiment_id = ? AND a.unit_type = ? AND a.unit_id = ?`
    )
    .bind(experiment.id, input.unitType, input.unitId)
    .first<{
      variant_key: string
      payload_json: string | null
      is_holdout: number | null
      is_control: number | null
    }>()

  if (existing) {
    return {
      experimentKey: experiment.key,
      variantKey: existing.variant_key,
      payload: JSON.parse(existing.payload_json || '{}'),
      isHoldout: existing.is_holdout === 1,
      isControl: existing.is_control === 1,
      isAssigned: true
    }
  }

  // Calculate deterministic stable assignment
  const variants = await database
    .prepare(
      `SELECT variant_key, weight, is_holdout, is_control, payload_json
       FROM experiment_variants
       WHERE experiment_id = ?`
    )
    .bind(experiment.id)
    .all<{
      variant_key: string
      weight: number
      is_holdout: number
      is_control: number
      payload_json: string
    }>()

  const assignment = stableAssignVariant({
    experimentKey: experiment.key,
    unitId: input.unitId,
    trafficAllocationPercent: experiment.traffic_allocation_percent,
    holdoutPercent: experiment.holdout_percent,
    variants: variants.results.map((v) => ({
      variantKey: v.variant_key,
      weight: v.weight,
      isHoldout: v.is_holdout === 1,
      isControl: v.is_control === 1
    }))
  })

  if (!assignment.isAssigned || !assignment.variantKey) {
    return {
      experimentKey: experiment.key,
      variantKey: null,
      payload: {},
      isHoldout: false,
      isControl: false,
      isAssigned: false
    }
  }

  const assignedVariantRow = variants.results.find((v) => v.variant_key === assignment.variantKey)
  const payload = JSON.parse(assignedVariantRow?.payload_json || '{}')
  const isHoldout = assignedVariantRow?.is_holdout === 1
  const isControl = assignedVariantRow?.is_control === 1

  // Persist assignment and record exposure
  const assignmentId = crypto.randomUUID()
  const exposureMetricId = crypto.randomUUID()

  await database.batch([
    database
      .prepare(
        `INSERT OR IGNORE INTO experiment_assignments (
          id, experiment_id, unit_type, unit_id, variant_key, assigned_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(assignmentId, experiment.id, input.unitType, input.unitId, assignment.variantKey, now),
    database
      .prepare(
        `INSERT INTO experiment_metrics_events (
          id, experiment_id, variant_key, unit_type, unit_id, event_type, event_value, recorded_at
        ) VALUES (?, ?, ?, ?, ?, 'exposure', 1, ?)`
      )
      .bind(exposureMetricId, experiment.id, assignment.variantKey, input.unitType, input.unitId, now)
  ])

  return {
    experimentKey: experiment.key,
    variantKey: assignment.variantKey,
    payload,
    isHoldout,
    isControl,
    isAssigned: true
  }
}

export async function recordD1ExperimentEvent(
  database: D1Database,
  rawInput: TrackEventInput,
  nowIso?: string
): Promise<{ success: boolean; recordedAt: string }> {
  const parsed = TrackEventInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new ExperimentsError('invalid_input', `Entrada inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = nowIso ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  const experiment = await database
    .prepare(`SELECT id FROM experiments WHERE key = ?`)
    .bind(input.experimentKey)
    .first<{ id: string }>()

  if (!experiment) {
    throw new ExperimentsError('not_found', `Experimento "${input.experimentKey}" no encontrado`)
  }

  const eventId = crypto.randomUUID()

  await database
    .prepare(
      `INSERT INTO experiment_metrics_events (
        id, experiment_id, variant_key, unit_type, unit_id, event_type,
        event_value, margin_basis_points, metadata_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      eventId,
      experiment.id,
      input.variantKey,
      input.unitType,
      input.unitId,
      input.eventType,
      input.eventValue,
      input.marginBasisPoints ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now
    )
    .run()

  return { success: true, recordedAt: now }
}

export async function getD1ExperimentReport(
  database: D1Database,
  experimentId: string,
  nowIso?: string
): Promise<ExperimentSummaryReport> {
  const now = nowIso ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  const exp = await database
    .prepare(
      `SELECT id, key, name, hypothesis, status, primary_metric, guardrails_json,
              min_sample_size, min_duration_days, start_date, decision, decision_rationale,
              decided_at, archived_at
       FROM experiments
       WHERE id = ?`
    )
    .bind(experimentId)
    .first<{
      id: string
      key: string
      name: string
      hypothesis: string
      status: ExperimentStatus
      primary_metric: PrimaryMetric
      guardrails_json: string
      min_sample_size: number
      min_duration_days: number
      start_date: string | null
      decision: DecisionType | null
      decision_rationale: string | null
      decided_at: string | null
      archived_at: string | null
    }>()

  if (!exp) {
    throw new ExperimentsError('not_found', 'Experimento no encontrado')
  }

  const guardrails: ExperimentGuardrails = ExperimentGuardrailsSchema.parse(JSON.parse(exp.guardrails_json || '{}'))

  const variants = await database
    .prepare(
      `SELECT variant_key, name, is_control, is_holdout, weight
       FROM experiment_variants
       WHERE experiment_id = ?`
    )
    .bind(experimentId)
    .all<{
      variant_key: string
      name: string
      is_control: number
      is_holdout: number
      weight: number
    }>()

  // Aggregated event counts
  const rawEvents = await database
    .prepare(
      `SELECT variant_key, event_type,
              count(*) as count,
              sum(event_value) as sum_value,
              avg(margin_basis_points) as avg_margin
       FROM experiment_metrics_events
       WHERE experiment_id = ?
       GROUP BY variant_key, event_type`
    )
    .bind(experimentId)
    .all<{
      variant_key: string
      event_type: string
      count: number
      sum_value: number | null
      avg_margin: number | null
    }>()

  // Percentiles for CWV
  const cwvRows = await database
    .prepare(
      `SELECT variant_key, event_type, event_value
       FROM experiment_metrics_events
       WHERE experiment_id = ? AND event_type IN ('web_vital_lcp', 'web_vital_cls', 'web_vital_inp')
       ORDER BY variant_key, event_type, event_value ASC`
    )
    .bind(experimentId)
    .all<{
      variant_key: string
      event_type: string
      event_value: number
    }>()

  const cwvByVariant: Record<string, { lcp: number[]; cls: number[]; inp: number[] }> = {}
  for (const row of cwvRows.results) {
    if (!cwvByVariant[row.variant_key]) {
      cwvByVariant[row.variant_key] = { lcp: [], cls: [], inp: [] }
    }
    if (row.event_type === 'web_vital_lcp') cwvByVariant[row.variant_key]!.lcp.push(row.event_value)
    if (row.event_type === 'web_vital_cls') cwvByVariant[row.variant_key]!.cls.push(row.event_value)
    if (row.event_type === 'web_vital_inp') cwvByVariant[row.variant_key]!.inp.push(row.event_value)
  }

  function getP75(arr: number[]): number | undefined {
    if (arr.length === 0) return undefined
    const idx = Math.floor(arr.length * 0.75)
    return arr[Math.min(idx, arr.length - 1)]
  }

  const observedCounts: Record<string, number> = {}
  const variantsMetrics: VariantMetrics[] = []

  let controlMetrics: VariantMetrics | undefined

  for (const v of variants.results) {
    const vEvents = rawEvents.results.filter((e) => e.variant_key === v.variant_key)

    const exposures = vEvents.find((e) => e.event_type === 'exposure')?.count ?? 0
    const conversions = vEvents.find((e) => e.event_type === 'conversion')?.count ?? 0
    const clicks = vEvents.find((e) => e.event_type === 'click')?.count ?? 0
    const ordersPlaced = vEvents.find((e) => e.event_type === 'order_placed')?.count ?? 0
    const totalRevenueCents = Math.round(vEvents.find((e) => e.event_type === 'order_placed')?.sum_value ?? 0)
    const averageOrderValueCents = ordersPlaced > 0 ? Math.round(totalRevenueCents / ordersPlaced) : 0
    const unsubscribes = vEvents.find((e) => e.event_type === 'unsubscribe')?.count ?? 0
    const complaints = vEvents.find((e) => e.event_type === 'complaint')?.count ?? 0

    const conversionEvents = vEvents.find((e) => e.event_type === 'conversion')
    const avgMargin =
      conversionEvents?.avg_margin !== null && conversionEvents?.avg_margin !== undefined
        ? Math.round(conversionEvents.avg_margin)
        : undefined

    const cwv = cwvByVariant[v.variant_key]
    const p75LcpMs = cwv ? getP75(cwv.lcp) : undefined
    const p75Cls = cwv ? getP75(cwv.cls) : undefined
    const p75InpMs = cwv ? getP75(cwv.inp) : undefined

    observedCounts[v.variant_key] = exposures

    const metric: VariantMetrics = {
      variantKey: v.variant_key,
      exposures,
      conversions,
      clicks,
      ordersPlaced,
      conversionRate: exposures > 0 ? conversions / exposures : 0,
      totalRevenueCents,
      averageOrderValueCents,
      unsubscribes,
      complaints,
      averageMarginBasisPoints: avgMargin,
      p75LcpMs,
      p75Cls,
      p75InpMs
    }

    variantsMetrics.push(metric)

    if (v.is_control === 1) {
      controlMetrics = metric
    }
  }

  // Calculate SRM
  const srm = calculateSampleRatioMismatch(
    variants.results.map((v) => ({ variantKey: v.variant_key, weight: v.weight })),
    observedCounts
  )

  // Evaluate Guardrails
  let overallGuardrailStatus: 'healthy' | 'warning' | 'breached' = 'healthy'
  const allBreaches = []
  for (const vm of variantsMetrics) {
    const evalRes = evaluateGuardrails(guardrails, vm)
    if (evalRes.status === 'breached') {
      overallGuardrailStatus = 'breached'
      allBreaches.push(...evalRes.breaches)
    }
  }

  // Calculate Duration and sample size
  let daysRunning = 0
  if (exp.start_date) {
    const diffMs = Date.parse(now) - Date.parse(exp.start_date)
    daysRunning = Math.max(0, Math.floor(diffMs / 86400000))
  }

  const totalExposures = Object.values(observedCounts).reduce((a, b) => a + b, 0)
  const hasMetMinSampleSize = totalExposures >= exp.min_sample_size
  const hasMetMinDuration = daysRunning >= exp.min_duration_days

  // Calculate Lift vs control
  let liftVsControlPercent: number | undefined
  if (controlMetrics && controlMetrics.conversionRate > 0) {
    const bestTreatment = variantsMetrics
      .filter((v) => v.variantKey !== controlMetrics?.variantKey && v.variantKey !== 'holdout')
      .sort((a, b) => b.conversionRate - a.conversionRate)[0]

    if (bestTreatment) {
      liftVsControlPercent =
        Math.round(
          ((bestTreatment.conversionRate - controlMetrics.conversionRate) / controlMetrics.conversionRate) * 1000
        ) / 10
    }
  }

  return {
    experimentId: exp.id,
    key: exp.key,
    name: exp.name,
    hypothesis: exp.hypothesis,
    status: exp.status,
    primaryMetric: exp.primary_metric,
    minSampleSize: exp.min_sample_size,
    minDurationDays: exp.min_duration_days,
    daysRunning,
    hasMetMinDuration,
    hasMetMinSampleSize,
    srm,
    guardrailsStatus: {
      status: overallGuardrailStatus,
      breaches: allBreaches
    },
    variantsMetrics,
    liftVsControlPercent,
    decision: exp.decision,
    decisionRationale: exp.decision_rationale,
    decidedAt: exp.decided_at,
    archivedAt: exp.archived_at
  }
}

export async function recordD1ExperimentDecision(
  database: D1Database,
  claims: VerifiedSessionClaims,
  experimentId: string,
  rawInput: RecordDecisionInput,
  options: ExperimentOperationOptions
): Promise<{
  experimentId: string
  status: ExperimentStatus
  decision: DecisionType
  archivedResults: ExperimentSummaryReport
  version: number
}> {
  await checkExperimentsAuth(database, claims, options.now?.())
  const parsed = RecordDecisionInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new ExperimentsError('invalid_input', `Entrada inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  // Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT receipt_json FROM experiment_commands
       WHERE actor_id = ? AND idempotency_key = ?`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ receipt_json: string }>()

  if (existingCommand) {
    return JSON.parse(existingCommand.receipt_json) as {
      experimentId: string
      status: ExperimentStatus
      decision: DecisionType
      archivedResults: ExperimentSummaryReport
      version: number
    }
  }

  const current = await database
    .prepare(`SELECT id, status, version FROM experiments WHERE id = ?`)
    .bind(experimentId)
    .first<{ id: string; status: string; version: number }>()

  if (!current) {
    throw new ExperimentsError('not_found', 'Experimento no encontrado')
  }

  if (current.status === 'archived') {
    throw new ExperimentsError('experiment_already_concluded', 'El experimento ya ha sido archivado')
  }

  if (current.version !== input.expectedVersion) {
    throw new ExperimentsError(
      'version_conflict',
      `Conflicto de versión: esperada ${input.expectedVersion}, actual ${current.version}`
    )
  }

  // Snapshot report results for archive (DAT-017)
  const report = await getD1ExperimentReport(database, experimentId, now)
  report.status = 'archived'
  report.decision = input.decision
  report.decisionRationale = input.decisionRationale
  report.decidedAt = now
  report.archivedAt = now

  const newVersion = current.version + 1
  const commandId = crypto.randomUUID()
  const payloadHash = await experimentPayloadHash('record_decision', input)

  const receipt = {
    experimentId,
    status: 'archived' as const,
    decision: input.decision,
    archivedResults: report,
    version: newVersion,
    action: 'record_decision',
    recordedAt: now
  }

  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `UPDATE experiments
         SET status = 'archived',
             decision = ?,
             decision_rationale = ?,
             decided_at = ?,
             decided_by = ?,
             archived_at = ?,
             archived_results_json = ?,
             version = ?,
             updated_at = ?
         WHERE id = ? AND version = ?`
      )
      .bind(
        input.decision,
        input.decisionRationale,
        now,
        claims.identityId,
        now,
        JSON.stringify(report),
        newVersion,
        now,
        experimentId,
        current.version
      ),
    database
      .prepare(
        `INSERT INTO experiment_commands (
          command_id, experiment_id, actor_id, action, idempotency_key,
          expected_version, result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?, ?, ?, 'record_decision', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        commandId,
        experimentId,
        claims.identityId,
        options.idempotencyKey,
        input.expectedVersion,
        newVersion,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(receipt),
        now
      )
  ]

  await database.batch(statements)
  return receipt
}

export async function listD1Experiments(
  database: D1Database,
  filters: {
    status?: string
    owner?: string
    surface?: string
    segment?: string
    search?: string
    limit?: number
    offset?: number
  }
): Promise<{ experiments: Array<Record<string, unknown>>; total: number }> {
  let query = `SELECT id, key, name, hypothesis, experiment_type, status, owner_id, owner_email,
                      target_surface, target_segment, exclusive_group, primary_metric,
                      traffic_allocation_percent, min_sample_size, min_duration_days,
                      start_date, end_date, holdout_percent, changes_description,
                      decision, decided_at, archived_at, version, created_at, updated_at
               FROM experiments
               WHERE 1=1`
  const params: unknown[] = []

  if (filters.status) {
    query += ` AND status = ?`
    params.push(filters.status)
  }
  if (filters.owner) {
    query += ` AND (owner_id = ? OR owner_email LIKE ?)`
    params.push(filters.owner, `%${filters.owner}%`)
  }
  if (filters.surface) {
    query += ` AND target_surface = ?`
    params.push(filters.surface)
  }
  if (filters.segment) {
    query += ` AND target_segment = ?`
    params.push(filters.segment)
  }
  if (filters.search) {
    query += ` AND (name LIKE ? OR hypothesis LIKE ? OR key LIKE ?)`
    params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`)
  }

  const countQuery = `SELECT count(*) as total FROM (${query})`
  const totalRow = await database
    .prepare(countQuery)
    .bind(...params)
    .first<{ total: number }>()
  const total = totalRow?.total ?? 0

  query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`
  const limit = Math.min(filters.limit ?? 50, 100)
  const offset = Math.max(filters.offset ?? 0, 0)
  params.push(limit, offset)

  const rows = await database
    .prepare(query)
    .bind(...params)
    .all<Record<string, unknown>>()

  return {
    experiments: rows.results.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      hypothesis: r.hypothesis,
      experimentType: r.experiment_type,
      status: r.status,
      ownerId: r.owner_id,
      ownerEmail: r.owner_email,
      targetSurface: r.target_surface,
      targetSegment: r.target_segment,
      exclusiveGroup: r.exclusive_group,
      primaryMetric: r.primary_metric,
      trafficAllocationPercent: r.traffic_allocation_percent,
      minSampleSize: r.min_sample_size,
      minDurationDays: r.min_duration_days,
      startDate: r.start_date,
      endDate: r.end_date,
      holdoutPercent: r.holdout_percent,
      changesDescription: r.changes_description,
      decision: r.decision,
      decidedAt: r.decided_at,
      archivedAt: r.archived_at,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    })),
    total
  }
}

export async function getD1Experiment(database: D1Database, idOrKey: string): Promise<Record<string, unknown> | null> {
  const row = await database
    .prepare(
      `SELECT id, key, name, hypothesis, experiment_type, status, owner_id, owner_email,
              target_surface, target_segment, exclusive_group, primary_metric, guardrails_json,
              traffic_allocation_percent, min_sample_size, min_duration_days,
              start_date, end_date, holdout_percent, changes_description,
              decision, decision_rationale, decided_at, archived_at, archived_results_json,
              version, created_at, updated_at
       FROM experiments
       WHERE id = ? OR key = ?`
    )
    .bind(idOrKey, idOrKey)
    .first<Record<string, unknown>>()

  if (!row) return null

  const variants = await database
    .prepare(
      `SELECT id, variant_key, name, is_control, is_holdout, weight, payload_json
       FROM experiment_variants
       WHERE experiment_id = ?`
    )
    .bind(row.id)
    .all<Record<string, unknown>>()

  return {
    id: row.id,
    key: row.key,
    name: row.name,
    hypothesis: row.hypothesis,
    experimentType: row.experiment_type,
    status: row.status,
    ownerId: row.owner_id,
    ownerEmail: row.owner_email,
    targetSurface: row.target_surface,
    targetSegment: row.target_segment,
    exclusiveGroup: row.exclusive_group,
    primaryMetric: row.primary_metric,
    guardrails: JSON.parse((row.guardrails_json as string) || '{}'),
    trafficAllocationPercent: row.traffic_allocation_percent,
    minSampleSize: row.min_sample_size,
    minDurationDays: row.min_duration_days,
    startDate: row.start_date,
    endDate: row.end_date,
    holdoutPercent: row.holdout_percent,
    changesDescription: row.changes_description,
    decision: row.decision,
    decisionRationale: row.decision_rationale,
    decidedAt: row.decided_at,
    archivedAt: row.archived_at,
    archivedResults: row.archived_results_json ? JSON.parse(row.archived_results_json as string) : null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    variants: variants.results.map((v) => ({
      id: v.id,
      variantKey: v.variant_key,
      name: v.name,
      isControl: v.is_control === 1,
      isHoldout: v.is_holdout === 1,
      weight: v.weight,
      payload: JSON.parse((v.payload_json as string) || '{}')
    }))
  }
}
