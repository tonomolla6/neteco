import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  type EdgeResolution,
  type EdgeRuleRecord,
  EDGE_DEFAULT_VARIANT,
  createRuleSchema,
  deriveEdgeSegment,
  evaluatePersonalizationEvidence,
  previewSchema,
  recordEvidenceSchema,
  ruleTransitionSchema,
  safeResolveEdgePersonalization
} from '../../shared/edge-personalization'
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

interface RuleRow {
  id: string
  slot: string
  segment: EdgeRuleRecord['segment']
  variant_key: string
  status: EdgeRuleRecord['status']
  evidence_id: string | null
  version: number
  created_at: string
  updated_at: string
}
const ruleFromRow = (r: RuleRow): EdgeRuleRecord => ({
  id: r.id,
  slot: r.slot,
  segment: r.segment,
  variantKey: r.variant_key,
  status: r.status,
  evidenceId: r.evidence_id,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})
async function loadRule(database: D1Database, id: string): Promise<EdgeRuleRecord> {
  const row = await database.prepare(`SELECT * FROM edge_personalization_rules WHERE id = ?1`).bind(id).first<RuleRow>()
  if (!row) throw new PerformanceInsightError('not_found', 404)
  return ruleFromRow(row)
}

export async function createD1EdgeRule(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  options?: OperationOptions
): Promise<EdgeRuleRecord> {
  const input = parse(createRuleSchema, rawInput)
  const now = operationInstant(options)
  const actorId = await requireAdministration(database, claims, now)
  const { commandId, idempotencyKey, ...body } = input
  return executeIdempotent<EdgeRuleRecord>(
    { database, domain: 'edge_personalization', actorId, action: 'create_rule', commandId, idempotencyKey, now },
    body,
    async () => {
      const id = crypto.randomUUID()
      const rule: EdgeRuleRecord = {
        id,
        slot: body.slot,
        segment: body.segment,
        variantKey: body.variantKey,
        status: 'draft',
        evidenceId: null,
        version: 1,
        createdAt: now,
        updatedAt: now
      }
      return {
        receipt: rule,
        statements: [
          database
            .prepare(
              `INSERT INTO edge_personalization_rules (id, slot, segment, variant_key, status, version, created_by, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, 'draft', 1, ?5, ?6, ?6)`
            )
            .bind(id, body.slot, body.segment, body.variantKey, actorId, now)
        ]
      }
    }
  )
}

export async function recordD1EdgeEvidence(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  options?: OperationOptions
): Promise<{ id: string; ruleId: string; eligible: boolean; reasons: string[]; liftBps: number; createdAt: string }> {
  const input = parse(recordEvidenceSchema, rawInput)
  const now = operationInstant(options)
  const actorId = await requireAdministration(database, claims, now)
  const { commandId, idempotencyKey, ...body } = input
  return executeIdempotent(
    { database, domain: 'edge_personalization', actorId, action: 'record_evidence', commandId, idempotencyKey, now },
    body,
    async () => {
      await loadRule(database, body.ruleId)
      let verdict
      try {
        verdict = evaluatePersonalizationEvidence(body)
      } catch {
        throw new PerformanceInsightError('invalid_evidence', 400, 'Inconsistent evidence counts')
      }
      const id = crypto.randomUUID()
      return {
        receipt: {
          id,
          ruleId: body.ruleId,
          eligible: verdict.eligible,
          reasons: verdict.reasons,
          liftBps: verdict.liftBps,
          createdAt: now
        },
        statements: [
          database
            .prepare(
              `INSERT INTO edge_personalization_evidence (id, rule_id, control_visitors, control_conversions,
                 treatment_visitors, treatment_conversions, lcp_delta_ms, cache_hit_rate_bps, baseline_cache_hit_rate_bps,
                 recorded_by, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
            )
            .bind(
              id,
              body.ruleId,
              body.controlVisitors,
              body.controlConversions,
              body.treatmentVisitors,
              body.treatmentConversions,
              body.lcpDeltaMs,
              body.cacheHitRateBps,
              body.baselineCacheHitRateBps,
              actorId,
              now
            )
        ]
      }
    }
  )
}

export async function enableD1EdgeRule(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  options?: OperationOptions
): Promise<EdgeRuleRecord> {
  const input = parse(ruleTransitionSchema, rawInput)
  const now = operationInstant(options)
  const actorId = await requireAdministration(database, claims, now)
  const { commandId, idempotencyKey, ...body } = input
  return executeIdempotent<EdgeRuleRecord>(
    { database, domain: 'edge_personalization', actorId, action: 'enable_rule', commandId, idempotencyKey, now },
    body,
    async () => {
      const current = await loadRule(database, body.ruleId)
      if (current.version !== body.expectedVersion) throw new PerformanceInsightError('concurrency_conflict', 409)
      if (current.status === 'enabled') throw new PerformanceInsightError('already_enabled', 409)
      const row = await database
        .prepare(
          `SELECT id, control_visitors, control_conversions, treatment_visitors, treatment_conversions,
                  lcp_delta_ms, cache_hit_rate_bps, baseline_cache_hit_rate_bps
           FROM edge_personalization_evidence WHERE rule_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
        .bind(current.id)
        .first<{
          id: string
          control_visitors: number
          control_conversions: number
          treatment_visitors: number
          treatment_conversions: number
          lcp_delta_ms: number
          cache_hit_rate_bps: number
          baseline_cache_hit_rate_bps: number
        }>()
      if (!row) throw new PerformanceInsightError('evidence_required', 409, 'No evidence recorded for this rule')
      const verdict = evaluatePersonalizationEvidence({
        controlVisitors: row.control_visitors,
        controlConversions: row.control_conversions,
        treatmentVisitors: row.treatment_visitors,
        treatmentConversions: row.treatment_conversions,
        lcpDeltaMs: row.lcp_delta_ms,
        cacheHitRateBps: row.cache_hit_rate_bps,
        baselineCacheHitRateBps: row.baseline_cache_hit_rate_bps
      })
      if (!verdict.eligible) throw new PerformanceInsightError('evidence_insufficient', 409, verdict.reasons.join(','))
      await requireAdministration(database, claims, now)
      const next: EdgeRuleRecord = {
        ...current,
        status: 'enabled',
        evidenceId: row.id,
        version: current.version + 1,
        updatedAt: now
      }
      return {
        receipt: next,
        guard: { table: 'edge_personalization_rules', id: current.id, version: next.version },
        statements: [
          database
            .prepare(
              `UPDATE edge_personalization_rules SET status = 'enabled', evidence_id = ?2, version = version + 1, updated_at = ?3
               WHERE id = ?1 AND version = ?4 AND status <> 'enabled'`
            )
            .bind(current.id, row.id, now, body.expectedVersion)
        ]
      }
    }
  )
}

export async function disableD1EdgeRule(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  options?: OperationOptions
): Promise<EdgeRuleRecord> {
  const input = parse(ruleTransitionSchema, rawInput)
  const now = operationInstant(options)
  const actorId = await requireAdministration(database, claims, now)
  const { commandId, idempotencyKey, ...body } = input
  return executeIdempotent<EdgeRuleRecord>(
    { database, domain: 'edge_personalization', actorId, action: 'disable_rule', commandId, idempotencyKey, now },
    body,
    async () => {
      const current = await loadRule(database, body.ruleId)
      if (current.version !== body.expectedVersion) throw new PerformanceInsightError('concurrency_conflict', 409)
      if (current.status !== 'enabled') throw new PerformanceInsightError('not_enabled', 409)
      await requireAdministration(database, claims, now)
      const next: EdgeRuleRecord = { ...current, status: 'disabled', version: current.version + 1, updatedAt: now }
      return {
        receipt: next,
        guard: { table: 'edge_personalization_rules', id: current.id, version: next.version },
        statements: [
          database
            .prepare(
              `UPDATE edge_personalization_rules SET status = 'disabled', version = version + 1, updated_at = ?2
               WHERE id = ?1 AND version = ?3 AND status = 'enabled'`
            )
            .bind(current.id, now, body.expectedVersion)
        ]
      }
    }
  )
}

export async function listD1EdgeRules(database: D1Database, limit = 100): Promise<EdgeRuleRecord[]> {
  const rows = await database
    .prepare(`SELECT * FROM edge_personalization_rules ORDER BY slot, segment LIMIT ?1`)
    .bind(Math.min(Math.max(1, Math.trunc(limit)), 200))
    .all<RuleRow>()
  return (rows.results ?? []).map(ruleFromRow)
}

/**
 * Runtime resolution (no admin authority needed; reads only enabled rules for one slot).
 * Never throws: any failure yields the deterministic default.
 */
export async function resolveD1EdgePersonalization(
  database: D1Database,
  rawInput: { killSwitch?: boolean } & Record<string, unknown>
): Promise<EdgeResolution> {
  const { killSwitch, ...rest } = rawInput
  try {
    const input = parse(previewSchema, rest)
    const segment = deriveEdgeSegment(input)
    const rows = await database
      .prepare(
        `SELECT slot, segment, variant_key, status FROM edge_personalization_rules WHERE slot = ?1 AND status = 'enabled'`
      )
      .bind(input.slot)
      .all<{ slot: string; segment: EdgeRuleRecord['segment']; variant_key: string; status: 'enabled' }>()
    return safeResolveEdgePersonalization({
      slot: input.slot,
      segment,
      consent: input.consent,
      killSwitch: killSwitch === true,
      rules: (rows.results ?? []).map((r) => ({
        slot: r.slot,
        segment: r.segment,
        variantKey: r.variant_key,
        status: r.status
      }))
    })
  } catch {
    return { variant: EDGE_DEFAULT_VARIANT, personalized: false, cacheVariant: 'default', reason: 'error_fallback' }
  }
}
