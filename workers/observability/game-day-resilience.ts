import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  type GameDayDrill,
  type GameDayDrillCreateInput,
  type GameDayDrillCompleteInput,
  type GameDayScenarioId,
  type GameDayScenarioInput,
  type ScenarioEvaluation,
  type TrafficExpansionGateResult,
  evaluateScenarioResult,
  evaluateTrafficExpansionGate,
  gameDayDrillCreateInputSchema,
  gameDayDrillCompleteInputSchema,
  gameDayScenarioInputSchema
} from '../../shared/game-day-resilience'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'

export class GameDayResilienceError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'version_conflict'
      | 'idempotency_conflict'
      | 'service_unavailable'
  ) {
    super(code)
    this.name = 'GameDayResilienceError'
  }
}

function fail(code: GameDayResilienceError['code']): never {
  throw new GameDayResilienceError(code)
}

export interface GameDayOptions {
  now?: () => string
}

export interface GameDayCommandMeta {
  commandId?: string
  idempotencyKey?: string
}

function instant(options?: GameDayOptions): string {
  const raw = options?.now?.() ?? new Date().toISOString()
  return catalogPolicyInstantSchema.parse(raw.replace(/\.\d{3}Z$/, 'Z'))
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function assertAuthorized(database: D1Database, claims: VerifiedSessionClaims, nowIso: string): Promise<void> {
  const auth = await authorizeD1Session(database, claims, 'administration.manage', {
    now: nowIso,
    requireMfa: true
  })
  if (!auth.allowed) {
    fail(auth.code)
  }
}

interface CommandRow {
  command_id: string
  payload_hash: string
  receipt_json: string
}

interface DrillRow {
  id: string
  cohort: string
  status: 'in_progress' | 'passed' | 'warning' | 'failed' | 'aborted'
  expansion_gate: 'pending' | 'approved' | 'blocked' | 'conditional'
  lead_engineer_id: string
  scenarios_total: number
  scenarios_passed: number
  scenarios_failed: number
  version: number
  notes: string
  summary_json: string
  started_at: string
  completed_at: string | null
  created_at: string
  updated_at: string
}

interface ScenarioRow {
  id: string
  drill_id: string
  scenario_id: GameDayScenarioId
  target_detection_seconds: number
  actual_detection_seconds: number
  target_recovery_seconds: number
  actual_recovery_seconds: number
  target_data_loss_seconds: number
  actual_data_loss_seconds: number
  alert_triggered: number
  alert_severity: 'warning' | 'critical'
  alert_channel: 'slack_sre' | 'pagerduty' | 'email_ops'
  rollback_restore_status: 'not_needed' | 'rollback_executed' | 'restore_completed' | 'failed'
  coordination_status: 'completed' | 'delayed' | 'failed'
  runbook_reference: string
  status: 'passed' | 'warning' | 'failed'
  details_json: string
  evaluated_at: string
}

function mapDrillRow(row: DrillRow): GameDayDrill {
  return {
    id: row.id,
    cohort: row.cohort,
    status: row.status,
    expansionGate: row.expansion_gate,
    leadEngineerId: row.lead_engineer_id,
    scenariosTotal: row.scenarios_total,
    scenariosPassed: row.scenarios_passed,
    scenariosFailed: row.scenarios_failed,
    version: row.version,
    notes: row.notes,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function createD1GameDayDrill(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: GameDayDrillCreateInput,
  commandMeta?: GameDayCommandMeta,
  options?: GameDayOptions
): Promise<GameDayDrill> {
  const nowIso = instant(options)
  await assertAuthorized(database, claims, nowIso)
  const parsed = gameDayDrillCreateInputSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')

  const commandId = commandMeta?.commandId ?? crypto.randomUUID()
  const idempotencyKey = commandMeta?.idempotencyKey ?? `create-drill-${Date.now()}`
  const payloadString = JSON.stringify({ cohort: parsed.data.cohort, notes: parsed.data.notes })
  const payloadHash = await sha256Hex(payloadString)

  // Idempotency check
  const existingCmd = await database
    .prepare(
      'SELECT command_id, payload_hash, receipt_json FROM game_day_commands WHERE actor_id = ?1 AND idempotency_key = ?2'
    )
    .bind(claims.identityId, idempotencyKey)
    .first<CommandRow>()

  if (existingCmd) {
    if (existingCmd.payload_hash !== payloadHash) fail('idempotency_conflict')
    const cachedReceipt = JSON.parse(existingCmd.receipt_json) as { drill: GameDayDrill }
    return cachedReceipt.drill
  }

  const drillId = crypto.randomUUID()
  const drill: GameDayDrill = {
    id: drillId,
    cohort: parsed.data.cohort,
    status: 'in_progress',
    expansionGate: 'pending',
    leadEngineerId: claims.identityId,
    scenariosTotal: 0,
    scenariosPassed: 0,
    scenariosFailed: 0,
    version: 1,
    notes: parsed.data.notes,
    startedAt: nowIso,
    completedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso
  }

  await database
    .prepare(
      `INSERT INTO game_day_drills (
        id, cohort, status, expansion_gate, lead_engineer_id,
        scenarios_total, scenarios_passed, scenarios_failed, version,
        notes, summary_json, started_at, completed_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
    )
    .bind(
      drill.id,
      drill.cohort,
      drill.status,
      drill.expansionGate,
      drill.leadEngineerId,
      drill.scenariosTotal,
      drill.scenariosPassed,
      drill.scenariosFailed,
      drill.version,
      drill.notes,
      JSON.stringify({}),
      drill.startedAt,
      drill.completedAt,
      drill.createdAt,
      drill.updatedAt
    )
    .run()

  const receipt = { drill }
  await database
    .prepare(
      `INSERT INTO game_day_commands (
        command_id, actor_id, action, idempotency_key, payload_hash, input_json, receipt_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
    .bind(
      commandId,
      claims.identityId,
      'create_drill',
      idempotencyKey,
      payloadHash,
      payloadString,
      JSON.stringify(receipt),
      nowIso
    )
    .run()

  return drill
}

export interface ScenarioResultRecord extends ScenarioEvaluation {
  id: string
  drillId: string
  scenarioId: GameDayScenarioId
  evaluatedAt: string
}

export async function recordD1GameDayScenarioResult(
  database: D1Database,
  claims: VerifiedSessionClaims,
  drillId: string,
  input: GameDayScenarioInput,
  commandMeta?: GameDayCommandMeta,
  options?: GameDayOptions
): Promise<ScenarioResultRecord> {
  const nowIso = instant(options)
  await assertAuthorized(database, claims, nowIso)
  const parsed = gameDayScenarioInputSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')

  const commandId = commandMeta?.commandId ?? crypto.randomUUID()
  const idempotencyKey = commandMeta?.idempotencyKey ?? `scen-${drillId}-${parsed.data.scenarioId}`
  const payloadString = JSON.stringify({ drillId, ...parsed.data })
  const payloadHash = await sha256Hex(payloadString)

  // Check command idempotency
  const existingCmd = await database
    .prepare(
      'SELECT command_id, payload_hash, receipt_json FROM game_day_commands WHERE actor_id = ?1 AND idempotency_key = ?2'
    )
    .bind(claims.identityId, idempotencyKey)
    .first<CommandRow>()

  if (existingCmd) {
    if (existingCmd.payload_hash !== payloadHash) fail('idempotency_conflict')
    const receipt = JSON.parse(existingCmd.receipt_json) as { result: ScenarioResultRecord }
    return receipt.result
  }

  // Check drill exists and is active
  const drill = await database.prepare('SELECT * FROM game_day_drills WHERE id = ?1').bind(drillId).first<DrillRow>()

  if (!drill) fail('not_found')
  if (drill.status !== 'in_progress') fail('conflict')

  // Check for duplicate scenario in same drill
  const existingScenario = await database
    .prepare('SELECT id FROM game_day_scenario_results WHERE drill_id = ?1 AND scenario_id = ?2')
    .bind(drillId, parsed.data.scenarioId)
    .first()

  if (existingScenario) fail('conflict')

  const evaluation = evaluateScenarioResult(parsed.data)
  const resultId = crypto.randomUUID()

  await database
    .prepare(
      `INSERT INTO game_day_scenario_results (
        id, drill_id, scenario_id, target_detection_seconds, actual_detection_seconds,
        target_recovery_seconds, actual_recovery_seconds, target_data_loss_seconds,
        actual_data_loss_seconds, alert_triggered, alert_severity, alert_channel,
        rollback_restore_status, coordination_status, runbook_reference, status,
        details_json, evaluated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`
    )
    .bind(
      resultId,
      drillId,
      parsed.data.scenarioId,
      parsed.data.targetDetectionSeconds,
      parsed.data.actualDetectionSeconds,
      parsed.data.targetRecoverySeconds,
      parsed.data.actualRecoverySeconds,
      parsed.data.targetDataLossSeconds,
      parsed.data.actualDataLossSeconds,
      parsed.data.alertTriggered ? 1 : 0,
      parsed.data.alertSeverity,
      parsed.data.alertChannel,
      parsed.data.rollbackRestoreStatus,
      parsed.data.coordinationStatus,
      parsed.data.runbookReference,
      evaluation.status,
      JSON.stringify(parsed.data.details ?? {}),
      nowIso
    )
    .run()

  const record: ScenarioResultRecord = {
    id: resultId,
    drillId,
    scenarioId: parsed.data.scenarioId,
    status: evaluation.status,
    targetMet: evaluation.targetMet,
    breaches: evaluation.breaches,
    warnings: evaluation.warnings,
    evaluatedAt: nowIso
  }

  const receipt = { result: record }
  await database
    .prepare(
      `INSERT INTO game_day_commands (
        command_id, actor_id, action, idempotency_key, payload_hash, input_json, receipt_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
    .bind(
      commandId,
      claims.identityId,
      'record_scenario',
      idempotencyKey,
      payloadHash,
      payloadString,
      JSON.stringify(receipt),
      nowIso
    )
    .run()

  return record
}

export async function completeD1GameDayDrill(
  database: D1Database,
  claims: VerifiedSessionClaims,
  drillId: string,
  input: GameDayDrillCompleteInput,
  commandMeta?: GameDayCommandMeta,
  options?: GameDayOptions
): Promise<GameDayDrill> {
  const nowIso = instant(options)
  await assertAuthorized(database, claims, nowIso)
  const parsed = gameDayDrillCompleteInputSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')

  const commandId = commandMeta?.commandId ?? crypto.randomUUID()
  const idempotencyKey = commandMeta?.idempotencyKey ?? `complete-${drillId}-${parsed.data.expectedVersion}`
  const payloadString = JSON.stringify({ drillId, ...parsed.data })
  const payloadHash = await sha256Hex(payloadString)

  const existingCmd = await database
    .prepare(
      'SELECT command_id, payload_hash, receipt_json FROM game_day_commands WHERE actor_id = ?1 AND idempotency_key = ?2'
    )
    .bind(claims.identityId, idempotencyKey)
    .first<CommandRow>()

  if (existingCmd) {
    if (existingCmd.payload_hash !== payloadHash) fail('idempotency_conflict')
    const receipt = JSON.parse(existingCmd.receipt_json) as { drill: GameDayDrill }
    return receipt.drill
  }

  const drill = await database.prepare('SELECT * FROM game_day_drills WHERE id = ?1').bind(drillId).first<DrillRow>()

  if (!drill) fail('not_found')
  if (drill.version !== parsed.data.expectedVersion) fail('version_conflict')

  // Read scenario results
  const scenarioResults = await database
    .prepare('SELECT * FROM game_day_scenario_results WHERE drill_id = ?1')
    .bind(drillId)
    .all<ScenarioRow>()

  const evaluatedScenarios = (scenarioResults.results ?? []).map((row) => ({
    scenarioId: row.scenario_id,
    status: row.status,
    targetMet: row.status === 'passed',
    breaches: row.status === 'failed' ? ['target_breached'] : [],
    warnings: row.status === 'warning' ? ['target_warning'] : []
  }))

  const gateResult = evaluateTrafficExpansionGate({
    completedAt: nowIso,
    now: nowIso,
    scenarios: evaluatedScenarios
  })

  const hasFailed = evaluatedScenarios.some((s) => s.status === 'failed')
  const hasWarning = evaluatedScenarios.some((s) => s.status === 'warning')
  const newStatus: 'passed' | 'warning' | 'failed' = hasFailed ? 'failed' : hasWarning ? 'warning' : 'passed'

  const passedCount = evaluatedScenarios.filter((s) => s.status === 'passed').length
  const failedCount = evaluatedScenarios.filter((s) => s.status === 'failed').length

  const updatedNotes = parsed.data.notes ? `${drill.notes ? `${drill.notes}\n` : ''}${parsed.data.notes}` : drill.notes

  try {
    await database
      .prepare(
        `UPDATE game_day_drills
         SET status = ?1,
             expansion_gate = ?2,
             scenarios_total = ?3,
             scenarios_passed = ?4,
             scenarios_failed = ?5,
             version = version + 1,
             notes = ?6,
             summary_json = ?7,
             completed_at = ?8,
             updated_at = ?9
         WHERE id = ?10 AND version = ?11`
      )
      .bind(
        newStatus,
        gateResult.status,
        evaluatedScenarios.length,
        passedCount,
        failedCount,
        updatedNotes,
        JSON.stringify(gateResult),
        nowIso,
        nowIso,
        drillId,
        drill.version
      )
      .run()
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('game_day_drill_version_conflict')) {
      fail('version_conflict')
    }
    throw err
  }

  const updatedDrill: GameDayDrill = {
    ...mapDrillRow(drill),
    status: newStatus,
    expansionGate: gateResult.status,
    scenariosTotal: evaluatedScenarios.length,
    scenariosPassed: passedCount,
    scenariosFailed: failedCount,
    version: drill.version + 1,
    notes: updatedNotes,
    completedAt: nowIso,
    updatedAt: nowIso
  }

  const receipt = { drill: updatedDrill }
  await database
    .prepare(
      `INSERT INTO game_day_commands (
        command_id, actor_id, action, idempotency_key, payload_hash, input_json, receipt_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
    .bind(
      commandId,
      claims.identityId,
      'complete_drill',
      idempotencyKey,
      payloadHash,
      payloadString,
      JSON.stringify(receipt),
      nowIso
    )
    .run()

  return updatedDrill
}

export interface DrillDetail extends GameDayDrill {
  scenarios: ScenarioRow[]
}

export async function getD1GameDayDrillDetail(
  database: D1Database,
  claims: VerifiedSessionClaims,
  drillId: string,
  options?: GameDayOptions
): Promise<DrillDetail> {
  const nowIso = instant(options)
  await assertAuthorized(database, claims, nowIso)

  const drill = await database.prepare('SELECT * FROM game_day_drills WHERE id = ?1').bind(drillId).first<DrillRow>()

  if (!drill) fail('not_found')

  const scenariosResult = await database
    .prepare('SELECT * FROM game_day_scenario_results WHERE drill_id = ?1 ORDER BY evaluated_at ASC')
    .bind(drillId)
    .all<ScenarioRow>()

  return {
    ...mapDrillRow(drill),
    scenarios: scenariosResult.results ?? []
  }
}

export async function listD1GameDayDrills(
  database: D1Database,
  claims: VerifiedSessionClaims,
  options?: GameDayOptions
): Promise<GameDayDrill[]> {
  const nowIso = instant(options)
  await assertAuthorized(database, claims, nowIso)

  const rows = await database.prepare('SELECT * FROM game_day_drills ORDER BY created_at DESC').all<DrillRow>()

  return (rows.results ?? []).map(mapDrillRow)
}

export interface TrafficExpansionGateEvaluation extends TrafficExpansionGateResult {
  latestDrillId: string | null
  completedAt: string | null
  freshnessDays: number | null
}

export async function evaluateD1TrafficExpansionGate(
  database: D1Database,
  claims: VerifiedSessionClaims,
  options?: GameDayOptions
): Promise<TrafficExpansionGateEvaluation> {
  const nowIso = instant(options)
  await assertAuthorized(database, claims, nowIso)

  const latestDrill = await database
    .prepare('SELECT * FROM game_day_drills WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1')
    .first<DrillRow>()

  if (!latestDrill) {
    return {
      status: 'blocked',
      approved: false,
      latestDrillId: null,
      completedAt: null,
      freshnessDays: null,
      scenariosTotal: 0,
      scenariosPassed: 0,
      scenariosFailed: 0,
      reasons: ['no_completed_game_day_drills: no game day simulations have been executed']
    }
  }

  const scenarioResults = await database
    .prepare('SELECT * FROM game_day_scenario_results WHERE drill_id = ?1')
    .bind(latestDrill.id)
    .all<ScenarioRow>()

  const evaluatedScenarios = (scenarioResults.results ?? []).map((row) => ({
    scenarioId: row.scenario_id,
    status: row.status,
    targetMet: row.status === 'passed',
    breaches: row.status === 'failed' ? ['target_breached'] : [],
    warnings: row.status === 'warning' ? ['target_warning'] : []
  }))

  const gateResult = evaluateTrafficExpansionGate({
    completedAt: latestDrill.completed_at,
    now: nowIso,
    scenarios: evaluatedScenarios
  })

  const completedMs = latestDrill.completed_at ? Date.parse(latestDrill.completed_at) : 0
  const nowMs = Date.parse(nowIso)
  const freshnessDays = completedMs > 0 ? Math.floor((nowMs - completedMs) / (1000 * 60 * 60 * 24)) : null

  return {
    ...gateResult,
    latestDrillId: latestDrill.id,
    completedAt: latestDrill.completed_at,
    freshnessDays
  }
}
