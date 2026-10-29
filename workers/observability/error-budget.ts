import {
  type SreJourney,
  type ReleaseType,
  type EvaluateReleaseInput,
  type RecordSliMeasurementInput,
  type EmergencyOverrideInput,
  type SreReleaseDecision,
  type ErrorBudgetOverview,
  type BudgetStatusSummary,
  type JourneyBudgetStatus,
  recordSliMeasurementSchema,
  evaluateReleaseSchema,
  emergencyOverrideSchema,
  ErrorBudgetReleaseError,
  calculateJourneyBudget,
  SRE_JOURNEYS
} from '../../shared/error-budget-releases'
import type { VerifiedSessionClaims } from '../catalog/authorization'

export interface SreOperationOptions {
  now?: string
}

function getIsoNow(options?: SreOperationOptions): string {
  if (options?.now) return options.now
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function sha256Hex(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content)
  const hashBuf = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function recordD1SliMeasurement(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: RecordSliMeasurementInput,
  options?: SreOperationOptions
): Promise<{ id: string; journey: SreJourney; totalEvents: number; failedEvents: number }> {
  const parsed = recordSliMeasurementSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new ErrorBudgetReleaseError('invalid_input', 400, parsed.error.message)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  const payloadHash = await sha256Hex(
    JSON.stringify({
      journey: input.journey,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      totalEvents: input.totalEvents,
      failedEvents: input.failedEvents,
      targetSloRatio: input.targetSloRatio
    })
  )

  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM sre_release_decision_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, input.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new ErrorBudgetReleaseError('idempotency_conflict', 409, 'Idempotency conflict for SLI measurement')
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  const measurementId = crypto.randomUUID()
  const metadataJson = JSON.stringify(input.metadata ?? {})

  const receipt = {
    id: measurementId,
    journey: input.journey,
    totalEvents: input.totalEvents,
    failedEvents: input.failedEvents
  }

  await database.batch([
    database
      .prepare(
        `INSERT INTO sre_sli_measurements (
          id, journey, window_start, window_end, total_events, failed_events,
          target_slo_ratio, metadata_json, recorded_at, recorded_by
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      )
      .bind(
        measurementId,
        input.journey,
        input.windowStart,
        input.windowEnd,
        input.totalEvents,
        input.failedEvents,
        input.targetSloRatio,
        metadataJson,
        now,
        claims.identityId
      ),
    database
      .prepare(
        `INSERT INTO sre_release_decision_commands (
          command_id, actor_id, action, idempotency_key, expected_version,
          result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?1, ?2, 'record_sli_measurement', ?3, 0, 1, ?4, ?5, ?6, ?7)`
      )
      .bind(
        input.commandId,
        claims.identityId,
        input.idempotencyKey,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(receipt),
        now
      )
  ])

  return receipt
}

export async function readD1ErrorBudgetOverview(
  database: D1Database,
  options?: SreOperationOptions
): Promise<ErrorBudgetOverview> {
  const now = getIsoNow(options)

  const rows = await database
    .prepare(
      `SELECT journey,
              sum(total_events) as sum_total,
              sum(failed_events) as sum_failed,
              avg(target_slo_ratio) as avg_target
       FROM sre_sli_measurements
       GROUP BY journey`
    )
    .all<{
      journey: SreJourney
      sum_total: number
      sum_failed: number
      avg_target: number
    }>()

  const journeys: Partial<Record<SreJourney, JourneyBudgetStatus>> = {}
  const blockingJourneys: SreJourney[] = []

  for (const j of SRE_JOURNEYS) {
    const row = rows.results?.find((r) => r.journey === j)
    const targetSloRatio = row?.avg_target ?? (j === 'checkout_orders' ? 0.9995 : 0.999)
    const totalEvents = row?.sum_total ?? 0
    const failedEvents = row?.sum_failed ?? 0

    const status = calculateJourneyBudget({
      journey: j,
      totalEvents,
      failedEvents,
      targetSloRatio
    })
    journeys[j] = status

    if (status.isExhausted) {
      blockingJourneys.push(j)
    }
  }

  return {
    generatedAt: now,
    featureFreezeActive: blockingJourneys.length > 0,
    blockingJourneys,
    journeys
  }
}

export async function evaluateD1ReleaseDecision(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: EvaluateReleaseInput,
  options?: SreOperationOptions
): Promise<SreReleaseDecision> {
  const parsed = evaluateReleaseSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new ErrorBudgetReleaseError('invalid_input', 400, parsed.error.message)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  const payloadHash = await sha256Hex(
    JSON.stringify({
      releaseVersion: input.releaseVersion,
      releaseType: input.releaseType,
      commitHash: input.commitHash
    })
  )

  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM sre_release_decision_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, input.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new ErrorBudgetReleaseError('idempotency_conflict', 409, 'Idempotency conflict for release evaluation')
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  const overview = await readD1ErrorBudgetOverview(database, options)
  const freezeActive = overview.featureFreezeActive
  const isReliabilityPriority =
    input.releaseType === 'reliability_fix' || input.releaseType === 'hotfix' || input.releaseType === 'rollback'

  let decisionStatus: 'approved' | 'blocked_budget_exhausted'
  if (freezeActive && !isReliabilityPriority) {
    decisionStatus = 'blocked_budget_exhausted'
  } else {
    decisionStatus = 'approved'
  }

  const decisionId = crypto.randomUUID()
  const summary: BudgetStatusSummary = {
    evaluatedAt: now,
    freezeActive,
    blockingJourneys: overview.blockingJourneys,
    journeys: overview.journeys as Record<SreJourney, JourneyBudgetStatus>
  }

  const decision: SreReleaseDecision = {
    id: decisionId,
    releaseVersion: input.releaseVersion,
    releaseType: input.releaseType,
    commitHash: input.commitHash,
    requestedBy: claims.identityId,
    status: decisionStatus,
    budgetStatusSummary: summary,
    justification: null,
    overriddenBy: null,
    overriddenAt: null,
    createdAt: now
  }

  await database.batch([
    database
      .prepare(
        `INSERT INTO sre_release_decisions (
          id, release_version, release_type, commit_hash, requested_by,
          status, budget_status_summary, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
      )
      .bind(
        decisionId,
        input.releaseVersion,
        input.releaseType,
        input.commitHash,
        claims.identityId,
        decisionStatus,
        JSON.stringify(summary),
        now
      ),
    database
      .prepare(
        `INSERT INTO sre_release_decision_commands (
          command_id, actor_id, action, idempotency_key, expected_version,
          result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?1, ?2, 'evaluate_release', ?3, 0, 1, ?4, ?5, ?6, ?7)`
      )
      .bind(
        input.commandId,
        claims.identityId,
        input.idempotencyKey,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(decision),
        now
      )
  ])

  return decision
}

export async function emergencyOverrideD1ReleaseDecision(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: EmergencyOverrideInput,
  options?: SreOperationOptions
): Promise<SreReleaseDecision> {
  const parsed = emergencyOverrideSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new ErrorBudgetReleaseError('invalid_input', 400, parsed.error.message)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  const payloadHash = await sha256Hex(
    JSON.stringify({
      decisionId: input.decisionId,
      justification: input.justification
    })
  )

  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM sre_release_decision_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, input.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new ErrorBudgetReleaseError('idempotency_conflict', 409, 'Idempotency conflict for emergency override')
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  const existing = await database
    .prepare(`SELECT * FROM sre_release_decisions WHERE id = ?1`)
    .bind(input.decisionId)
    .first<{
      id: string
      release_version: string
      release_type: ReleaseType
      commit_hash: string
      requested_by: string
      status: string
      budget_status_summary: string
      created_at: string
    }>()

  if (!existing) {
    throw new ErrorBudgetReleaseError('not_found', 404, 'Release decision not found')
  }

  if (existing.status !== 'blocked_budget_exhausted') {
    throw new ErrorBudgetReleaseError('invalid_state', 400, 'Only blocked decisions can be emergency overridden')
  }

  const updated: SreReleaseDecision = {
    id: existing.id,
    releaseVersion: existing.release_version,
    releaseType: existing.release_type,
    commitHash: existing.commit_hash,
    requestedBy: existing.requested_by,
    status: 'overridden_emergency',
    budgetStatusSummary: JSON.parse(existing.budget_status_summary),
    justification: input.justification,
    overriddenBy: claims.identityId,
    overriddenAt: now,
    createdAt: existing.created_at
  }

  await database.batch([
    database
      .prepare(
        `UPDATE sre_release_decisions
         SET status = 'overridden_emergency',
             justification = ?2,
             overridden_by = ?3,
             overridden_at = ?4
         WHERE id = ?1`
      )
      .bind(input.decisionId, input.justification, claims.identityId, now),
    database
      .prepare(
        `INSERT INTO sre_release_decision_commands (
          command_id, actor_id, action, idempotency_key, expected_version,
          result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?1, ?2, 'emergency_override', ?3, 1, 2, ?4, ?5, ?6, ?7)`
      )
      .bind(
        input.commandId,
        claims.identityId,
        input.idempotencyKey,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(updated),
        now
      )
  ])

  return updated
}

export async function listD1ReleaseDecisions(database: D1Database, limit = 50): Promise<SreReleaseDecision[]> {
  const rows = await database
    .prepare(`SELECT * FROM sre_release_decisions ORDER BY created_at DESC LIMIT ?1`)
    .bind(limit)
    .all<{
      id: string
      release_version: string
      release_type: ReleaseType
      commit_hash: string
      requested_by: string
      status: 'approved' | 'blocked_budget_exhausted' | 'overridden_emergency'
      budget_status_summary: string
      justification: string | null
      overridden_by: string | null
      overridden_at: string | null
      created_at: string
    }>()

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    releaseVersion: r.release_version,
    releaseType: r.release_type,
    commitHash: r.commit_hash,
    requestedBy: r.requested_by,
    status: r.status,
    budgetStatusSummary: JSON.parse(r.budget_status_summary),
    justification: r.justification,
    overriddenBy: r.overridden_by,
    overriddenAt: r.overridden_at,
    createdAt: r.created_at
  }))
}
