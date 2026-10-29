import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  type ThirdPartyEvaluation,
  type ThirdPartyKind,
  type ThirdPartyScript,
  type ThirdPartyVerdict,
  evaluateThirdPartyExperiment,
  recordExperimentSchema,
  registerScriptSchema,
  removeScriptSchema
} from '../../shared/third-party-value'
import { PerformanceInsightError } from '../../shared/performance-insights-error'
import { executeIdempotent, operationInstant, requireAdministration, type OperationOptions } from './command-log'

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

interface ScriptRow {
  id: string
  vendor: string
  name: string
  kind: ThirdPartyKind
  monthly_cost_cents: number
  load_ms_p75: number
  status: 'active' | 'removed'
  removal_reason: string | null
  version: number
  created_at: string
  updated_at: string
  latest_verdict: ThirdPartyVerdict | null
}
const SCRIPT_SELECT = `SELECT s.*, (SELECT e.verdict FROM third_party_experiments e WHERE e.script_id = s.id
  ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1) AS latest_verdict FROM third_party_scripts s`
const scriptFromRow = (r: ScriptRow): ThirdPartyScript => ({
  id: r.id,
  vendor: r.vendor,
  name: r.name,
  kind: r.kind,
  monthlyCostCents: r.monthly_cost_cents,
  loadMsP75: r.load_ms_p75,
  status: r.status,
  removalReason: r.removal_reason,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  latestVerdict: r.latest_verdict
})

async function loadScript(database: D1Database, id: string): Promise<ThirdPartyScript> {
  const row = await database.prepare(`${SCRIPT_SELECT} WHERE s.id = ?1`).bind(id).first<ScriptRow>()
  if (!row) throw new PerformanceInsightError('not_found', 404)
  return scriptFromRow(row)
}

export async function registerD1ThirdPartyScript(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  options?: OperationOptions
): Promise<ThirdPartyScript> {
  const input = parse(registerScriptSchema, rawInput)
  const now = operationInstant(options)
  const actorId = await requireAdministration(database, claims, now)
  const { commandId, idempotencyKey, ...body } = input
  return executeIdempotent<ThirdPartyScript>(
    { database, domain: 'third_party', actorId, action: 'register_script', commandId, idempotencyKey, now },
    body,
    async () => {
      const id = crypto.randomUUID()
      const script: ThirdPartyScript = {
        id,
        vendor: body.vendor,
        name: body.name,
        kind: body.kind,
        monthlyCostCents: body.monthlyCostCents,
        loadMsP75: body.loadMsP75,
        status: 'active',
        removalReason: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
        latestVerdict: null
      }
      return {
        receipt: script,
        statements: [
          database
            .prepare(
              `INSERT INTO third_party_scripts (id, vendor, name, kind, monthly_cost_cents, load_ms_p75, status, version, created_by, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', 1, ?7, ?8, ?8)`
            )
            .bind(id, body.vendor, body.name, body.kind, body.monthlyCostCents, body.loadMsP75, actorId, now)
        ]
      }
    }
  )
}

export interface RecordedExperiment {
  id: string
  scriptId: string
  evaluation: ThirdPartyEvaluation
  createdAt: string
}

export async function recordD1ThirdPartyExperiment(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  options?: OperationOptions
): Promise<RecordedExperiment> {
  const input = parse(recordExperimentSchema, rawInput)
  const now = operationInstant(options)
  const actorId = await requireAdministration(database, claims, now)
  const { commandId, idempotencyKey, ...body } = input
  return executeIdempotent<RecordedExperiment>(
    { database, domain: 'third_party', actorId, action: 'record_experiment', commandId, idempotencyKey, now },
    body,
    async () => {
      const script = await loadScript(database, body.scriptId)
      if (script.status !== 'active') throw new PerformanceInsightError('script_not_active', 409)
      let evaluation: ThirdPartyEvaluation
      try {
        evaluation = evaluateThirdPartyExperiment({
          periodDays: body.periodDays,
          marginBps: body.marginBps,
          monthlyCostCents: script.monthlyCostCents,
          control: body.control,
          treatment: body.treatment
        })
      } catch {
        throw new PerformanceInsightError('invalid_input', 400, 'Inconsistent experiment counts')
      }
      const id = crypto.randomUUID()
      const c = body.control
      const t = body.treatment
      return {
        receipt: { id, scriptId: script.id, evaluation, createdAt: now },
        statements: [
          database
            .prepare(
              `INSERT INTO third_party_experiments (id, script_id, period_days, margin_bps,
                 control_visitors, control_conversions, control_revenue_cents, control_lcp_ms_p75,
                 treatment_visitors, treatment_conversions, treatment_revenue_cents, treatment_lcp_ms_p75,
                 verdict, evaluation_json, created_by, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`
            )
            .bind(
              id,
              script.id,
              body.periodDays,
              body.marginBps,
              c.visitors,
              c.conversions,
              c.revenueCents,
              c.lcpMsP75,
              t.visitors,
              t.conversions,
              t.revenueCents,
              t.lcpMsP75,
              evaluation.verdict,
              JSON.stringify(evaluation),
              actorId,
              now
            )
        ]
      }
    }
  )
}

export async function removeD1ThirdPartyScript(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  options?: OperationOptions
): Promise<ThirdPartyScript> {
  const input = parse(removeScriptSchema, rawInput)
  const now = operationInstant(options)
  const actorId = await requireAdministration(database, claims, now)
  const { commandId, idempotencyKey, ...body } = input
  return executeIdempotent<ThirdPartyScript>(
    { database, domain: 'third_party', actorId, action: 'remove_script', commandId, idempotencyKey, now },
    body,
    async () => {
      const current = await loadScript(database, body.scriptId)
      if (current.version !== body.expectedVersion) throw new PerformanceInsightError('concurrency_conflict', 409)
      if (current.status === 'removed') throw new PerformanceInsightError('already_removed', 409)
      await requireAdministration(database, claims, now)
      const next: ThirdPartyScript = {
        ...current,
        status: 'removed',
        removalReason: body.reason,
        version: current.version + 1,
        updatedAt: now
      }
      return {
        receipt: next,
        guard: { table: 'third_party_scripts', id: current.id, version: next.version },
        statements: [
          database
            .prepare(
              `UPDATE third_party_scripts
               SET status = 'removed', removal_reason = ?2, removed_by = ?3, removed_at = ?4, version = version + 1, updated_at = ?4
               WHERE id = ?1 AND version = ?5 AND status = 'active'`
            )
            .bind(current.id, body.reason, actorId, now, body.expectedVersion)
        ]
      }
    }
  )
}

export async function listD1ThirdPartyScripts(database: D1Database, limit = 100): Promise<ThirdPartyScript[]> {
  const rows = await database
    .prepare(`${SCRIPT_SELECT} ORDER BY s.status, s.created_at DESC, s.id LIMIT ?1`)
    .bind(Math.min(Math.max(1, Math.trunc(limit)), 200))
    .all<ScriptRow>()
  return (rows.results ?? []).map(scriptFromRow)
}

/** Scripts the storefront may still load. Removal in the registry removes the script here. */
export async function readD1ThirdPartyManifest(
  database: D1Database
): Promise<Array<{ id: string; vendor: string; name: string; kind: ThirdPartyKind }>> {
  const rows = await database
    .prepare(`SELECT id, vendor, name, kind FROM third_party_scripts WHERE status = 'active' ORDER BY vendor, name`)
    .all<{ id: string; vendor: string; name: string; kind: ThirdPartyKind }>()
  return rows.results ?? []
}
