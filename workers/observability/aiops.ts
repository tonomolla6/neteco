import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  type AiopsPrecision,
  type AiopsRecommendation,
  type AiopsSignal,
  computeAiopsPrecision,
  correlateSignals,
  correlateSchema,
  decideRecommendationSchema,
  ingestSignalSchema,
  recordOutcomeSchema
} from '../../shared/aiops-recommendations'
import { PerformanceInsightError } from '../../shared/performance-insights-error'
import {
  executeIdempotent,
  operationInstant,
  requireAdministration,
  sha256Hex,
  type OperationOptions
} from '../performance/command-log'

const MAX_SIGNAL_AGE_MS = 7 * 24 * 3600_000
export const AIOPS_PROPOSAL_TTL_MS = 24 * 3600_000
const MAX_CLUSTER_SIGNALS = 500

function parse<T>(
  schema: {
    safeParse(
      v: unknown
    ): { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } }
  },
  raw: unknown
): T {
  const result = schema.safeParse(raw)
  if (!result.success) throw new PerformanceInsightError('invalid_input', 400, result.error.issues[0]?.message)
  return result.data
}

interface SignalRow {
  id: string
  kind: AiopsSignal['kind']
  service: AiopsSignal['service']
  severity: AiopsSignal['severity']
  metric_value: number
  threshold_value: number
  observed_at: string
}
const signalFromRow = (r: SignalRow): AiopsSignal => ({
  id: r.id,
  kind: r.kind,
  service: r.service,
  severity: r.severity,
  metricValue: r.metric_value,
  thresholdValue: r.threshold_value,
  observedAt: r.observed_at
})

interface RecommendationRow {
  id: string
  correlation_key: string
  signal_ids_json: string
  services_json: string
  summary: string
  runbook_id: string
  runbook_steps_json: string
  destructive: number
  confidence: number
  status: AiopsRecommendation['status']
  decision_reason: string | null
  decided_by: string | null
  decided_at: string | null
  outcome: AiopsRecommendation['outcome']
  version: number
  created_at: string
  updated_at: string
}
const recommendationFromRow = (r: RecommendationRow): AiopsRecommendation => ({
  id: r.id,
  correlationKey: r.correlation_key,
  signalIds: JSON.parse(r.signal_ids_json),
  services: JSON.parse(r.services_json),
  summary: r.summary,
  runbookId: r.runbook_id,
  steps: JSON.parse(r.runbook_steps_json),
  destructive: r.destructive === 1,
  confidence: r.confidence,
  status: r.status,
  decisionReason: r.decision_reason,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  outcome: r.outcome,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

export async function ingestD1AiopsSignal(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  options?: OperationOptions
): Promise<AiopsSignal> {
  const input = parse(ingestSignalSchema, rawInput)
  const now = operationInstant(options)
  const actorId = await requireAdministration(database, claims, now)
  const observed = Date.parse(input.observedAt)
  if (observed > Date.parse(now)) throw new PerformanceInsightError('signal_in_future', 400)
  if (Date.parse(now) - observed > MAX_SIGNAL_AGE_MS) throw new PerformanceInsightError('signal_too_old', 400)
  const { commandId, idempotencyKey, ...body } = input
  return executeIdempotent<AiopsSignal>(
    { database, domain: 'aiops', actorId, action: 'ingest_signal', commandId, idempotencyKey, now },
    body,
    async () => {
      const id = crypto.randomUUID()
      const signal: AiopsSignal = { id, ...body }
      return {
        receipt: signal,
        statements: [
          database
            .prepare(
              `INSERT INTO aiops_signals (id, kind, service, severity, metric_value, threshold_value, observed_at, created_by, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
            )
            .bind(
              id,
              body.kind,
              body.service,
              body.severity,
              body.metricValue,
              body.thresholdValue,
              body.observedAt,
              actorId,
              now
            )
        ]
      }
    }
  )
}

export async function listD1AiopsSignals(database: D1Database, limit = 100): Promise<AiopsSignal[]> {
  const rows = await database
    .prepare(
      `SELECT id, kind, service, severity, metric_value, threshold_value, observed_at
       FROM aiops_signals ORDER BY observed_at DESC, id LIMIT ?1`
    )
    .bind(Math.min(Math.max(1, Math.trunc(limit)), 200))
    .all<SignalRow>()
  return (rows.results ?? []).map(signalFromRow)
}

export async function runD1AiopsCorrelation(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  options?: OperationOptions
): Promise<{ created: number; recommendations: AiopsRecommendation[] }> {
  const input = parse(correlateSchema, rawInput)
  const now = operationInstant(options)
  const actorId = await requireAdministration(database, claims, now)
  const { commandId, idempotencyKey, ...body } = input
  return executeIdempotent(
    { database, domain: 'aiops', actorId, action: 'correlate', commandId, idempotencyKey, now },
    body,
    async () => {
      const since = new Date(Date.parse(now) - body.lookbackMinutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
      const signalRows = await database
        .prepare(
          `SELECT id, kind, service, severity, metric_value, threshold_value, observed_at
           FROM aiops_signals WHERE observed_at >= ?1 AND observed_at <= ?2
           ORDER BY observed_at, id LIMIT ?3`
        )
        .bind(since, now, MAX_CLUSTER_SIGNALS)
        .all<SignalRow>()
      const candidates = correlateSignals((signalRows.results ?? []).map(signalFromRow), {
        windowMinutes: body.windowMinutes
      })
      const dayAgo = new Date(Date.parse(now) - AIOPS_PROPOSAL_TTL_MS).toISOString().replace(/\.\d{3}Z$/, 'Z')
      const existing = await database
        .prepare(`SELECT signal_ids_json FROM aiops_recommendations WHERE created_at >= ?1`)
        .bind(dayAgo)
        .all<{ signal_ids_json: string }>()
      const covered = new Set<string>()
      for (const row of existing.results ?? [])
        for (const id of JSON.parse(row.signal_ids_json) as string[]) covered.add(id)
      const created: AiopsRecommendation[] = []
      const statements: D1PreparedStatement[] = []
      for (const candidate of candidates) {
        if (candidate.signalIds.some((id) => covered.has(id))) continue
        const correlationKey = await sha256Hex(candidate.signalIds.join(','))
        const rec: AiopsRecommendation = {
          id: crypto.randomUUID(),
          correlationKey,
          signalIds: candidate.signalIds,
          services: candidate.services,
          summary: candidate.summary,
          runbookId: candidate.runbookId,
          steps: candidate.steps,
          destructive: candidate.destructive,
          confidence: candidate.confidence,
          status: 'proposed',
          decisionReason: null,
          decidedBy: null,
          decidedAt: null,
          outcome: 'pending',
          version: 1,
          createdAt: now,
          updatedAt: now
        }
        created.push(rec)
        statements.push(
          database
            .prepare(
              `INSERT INTO aiops_recommendations (id, correlation_key, signal_ids_json, services_json, summary, runbook_id,
                 runbook_steps_json, destructive, confidence, status, outcome, version, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'proposed', 'pending', 1, ?10, ?10)`
            )
            .bind(
              rec.id,
              correlationKey,
              JSON.stringify(rec.signalIds),
              JSON.stringify(rec.services),
              rec.summary,
              rec.runbookId,
              JSON.stringify(rec.steps),
              rec.destructive ? 1 : 0,
              rec.confidence,
              now
            )
        )
      }
      return { statements, receipt: { created: created.length, recommendations: created } }
    }
  )
}

async function loadRecommendation(database: D1Database, id: string): Promise<AiopsRecommendation> {
  const row = await database
    .prepare(`SELECT * FROM aiops_recommendations WHERE id = ?1`)
    .bind(id)
    .first<RecommendationRow>()
  if (!row) throw new PerformanceInsightError('not_found', 404)
  return recommendationFromRow(row)
}

export async function decideD1AiopsRecommendation(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  options?: OperationOptions
): Promise<AiopsRecommendation> {
  const input = parse(decideRecommendationSchema, rawInput)
  const now = operationInstant(options)
  const actorId = await requireAdministration(database, claims, now)
  const { commandId, idempotencyKey, ...body } = input
  return executeIdempotent<AiopsRecommendation>(
    { database, domain: 'aiops', actorId, action: 'decide_recommendation', commandId, idempotencyKey, now },
    body,
    async () => {
      const current = await loadRecommendation(database, body.recommendationId)
      if (current.version !== body.expectedVersion)
        throw new PerformanceInsightError('concurrency_conflict', 409, 'Recommendation changed')
      if (current.status !== 'proposed') throw new PerformanceInsightError('already_decided', 409)
      if (body.decision === 'approve') {
        if (Date.parse(now) - Date.parse(current.createdAt) > AIOPS_PROPOSAL_TTL_MS)
          throw new PerformanceInsightError('recommendation_expired', 409, 'Re-run the correlation')
        if (current.destructive && body.confirmDestructive !== true)
          throw new PerformanceInsightError('destructive_confirmation_required', 400)
      }
      // Authorization is read again immediately before the commit batch.
      await requireAdministration(database, claims, now)
      const status = body.decision === 'approve' ? 'approved' : 'rejected'
      const next: AiopsRecommendation = {
        ...current,
        status,
        decisionReason: body.reason,
        decidedBy: actorId,
        decidedAt: now,
        version: current.version + 1,
        updatedAt: now
      }
      return {
        receipt: next,
        guard: { table: 'aiops_recommendations', id: current.id, version: next.version },
        statements: [
          database
            .prepare(
              `UPDATE aiops_recommendations
               SET status = ?2, decision_reason = ?3, decided_by = ?4, decided_at = ?5, version = version + 1, updated_at = ?5
               WHERE id = ?1 AND version = ?6 AND status = 'proposed'`
            )
            .bind(current.id, status, body.reason, actorId, now, body.expectedVersion)
        ]
      }
    }
  )
}

export async function recordD1AiopsOutcome(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  options?: OperationOptions
): Promise<AiopsRecommendation> {
  const input = parse(recordOutcomeSchema, rawInput)
  const now = operationInstant(options)
  const actorId = await requireAdministration(database, claims, now)
  const { commandId, idempotencyKey, ...body } = input
  return executeIdempotent<AiopsRecommendation>(
    { database, domain: 'aiops', actorId, action: 'record_outcome', commandId, idempotencyKey, now },
    body,
    async () => {
      const current = await loadRecommendation(database, body.recommendationId)
      if (current.outcome !== 'pending') throw new PerformanceInsightError('outcome_already_recorded', 409)
      if (current.version !== body.expectedVersion)
        throw new PerformanceInsightError('concurrency_conflict', 409, 'Recommendation changed')
      await requireAdministration(database, claims, now)
      const next: AiopsRecommendation = {
        ...current,
        outcome: body.outcome,
        version: current.version + 1,
        updatedAt: now
      }
      return {
        receipt: next,
        guard: { table: 'aiops_recommendations', id: current.id, version: next.version },
        statements: [
          database
            .prepare(
              `UPDATE aiops_recommendations
               SET outcome = ?2, outcome_by = ?3, outcome_at = ?4, version = version + 1, updated_at = ?4
               WHERE id = ?1 AND version = ?5 AND outcome = 'pending'`
            )
            .bind(current.id, body.outcome, actorId, now, body.expectedVersion)
        ]
      }
    }
  )
}

export async function listD1AiopsRecommendations(database: D1Database, limit = 50): Promise<AiopsRecommendation[]> {
  const rows = await database
    .prepare(`SELECT * FROM aiops_recommendations ORDER BY created_at DESC, id LIMIT ?1`)
    .bind(Math.min(Math.max(1, Math.trunc(limit)), 100))
    .all<RecommendationRow>()
  return (rows.results ?? []).map(recommendationFromRow)
}

export async function readD1AiopsPrecision(database: D1Database): Promise<AiopsPrecision> {
  const rows = await database
    .prepare(`SELECT outcome, COUNT(*) AS n FROM aiops_recommendations GROUP BY outcome`)
    .all<{ outcome: 'pending' | 'true_positive' | 'false_positive'; n: number }>()
  const items: Array<{ outcome: 'pending' | 'true_positive' | 'false_positive' }> = []
  for (const row of rows.results ?? []) for (let i = 0; i < row.n; i++) items.push({ outcome: row.outcome })
  return computeAiopsPrecision(items)
}
