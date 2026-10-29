import { z } from 'zod'
import { analyticsCountSchema, analyticsEnvironmentSchema } from '../../shared/analytics-measurement'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import {
  analyticsAssertPolicy,
  analyticsAssertCurrentPolicy,
  analyticsChecked,
  analyticsClock,
  analyticsDatabase,
  analyticsPolicyFingerprint,
  AnalyticsMeasurementError,
  type AnalyticsMeasurementDependencies
} from './authority'
import { isD1CheckConstraintFailure } from '../runtime/d1-errors'

const optionsSchema = z
  .object({
    enabled: z.literal(true),
    limit: analyticsCountSchema.min(1).max(100),
    maxBatches: analyticsCountSchema.min(1).max(10),
    quota: z
      .object({
        windowSeconds: analyticsCountSchema.min(1).max(86400),
        maximumRequestedEvents: analyticsCountSchema.min(1).max(10000)
      })
      .strict()
  })
  .strict()
  .refine((value) => value.limit <= value.quota.maximumRequestedEvents)
export interface AnalyticsRetentionOptions {
  enabled?: boolean
  limit: number
  maxBatches: number
  quota: { windowSeconds: number; maximumRequestedEvents: number }
}
export interface AnalyticsRetentionReport {
  enabled: boolean
  environment: 'local' | 'preview' | 'production'
  generatedAt: string | null
  batches: number
  requested: number
  removed: number
  remainingExpired: number | null
  quotaExhausted: boolean
  financialContractsTouched: false
}
const countSchema = z.object({ count: analyticsCountSchema }).strict()
/** Explicit server-side privacy maintenance port, not a Cron configuration.
 * Expiration deletes only consented client telemetry. Commerce facts, capture
 * provenance, orders, payments, fiscal and refund contracts are never deleted. */
export async function dispatchAnalyticsRetention(
  deps: AnalyticsMeasurementDependencies,
  input: AnalyticsRetentionOptions
): Promise<AnalyticsRetentionReport> {
  const environment = analyticsEnvironmentSchema.parse(deps.environment)
  const report: AnalyticsRetentionReport = {
    enabled: input.enabled === true,
    environment,
    generatedAt: null,
    batches: 0,
    requested: 0,
    removed: 0,
    remainingExpired: null,
    quotaExhausted: false,
    financialContractsTouched: false
  }
  // Acquisition and retention are different gates. Disabled maintenance never
  // inspects policy, crypto or D1; enabled retention still requires approval.
  if (input.enabled !== true) return report
  const options = analyticsChecked(optionsSchema, input),
    policy = analyticsAssertPolicy(deps),
    origin = deps.origin,
    fingerprint = await analyticsPolicyFingerprint(policy),
    database = analyticsDatabase(deps)
  async function unchanged() {
    if ((await analyticsPolicyFingerprint(analyticsAssertPolicy(deps))) !== fingerprint)
      throw new AnalyticsMeasurementError('configuration_unavailable')
    analyticsAssertCurrentPolicy(deps, policy, origin)
  }
  const expired = 'environment=?1 AND policy_reference=?2 AND expires_at<=?3'
  async function remaining(at: string) {
    const result = await database
      .prepare(`SELECT count(*) AS count FROM analytics_browser_events WHERE ${expired}`)
      .bind(environment, policy.reference, at)
      .first()
    await unchanged()
    return analyticsChecked(countSchema, result).count
  }
  for (let batch = 0; batch < options.maxBatches; batch++) {
    await unchanged()
    const at = analyticsClock(deps)
    report.generatedAt = at
    if ((await remaining(at)) === 0) {
      report.remainingExpired = 0
      break
    }
    const selected = analyticsChecked(
      z.array(z.object({ eventId: catalogPolicyUuidSchema }).strict()).max(100),
      (
        await database
          .prepare(
            `SELECT event_id AS eventId FROM analytics_browser_events WHERE ${expired}
        ORDER BY expires_at,event_id LIMIT ?4`
          )
          .bind(environment, policy.reference, at, options.limit)
          .all()
      ).results
    )
    // One frozen global selection. Both tables delete only these exact IDs;
    // a competing retention worker makes the transactional guard fail closed.
    const selectedIds = JSON.stringify(selected.map((row) => row.eventId))
    const windowStart = new Date(Date.parse(at) - options.quota.windowSeconds * 1000)
        .toISOString()
        .replace('.000Z', 'Z'),
      runId = crypto.randomUUID()
    await unchanged()
    analyticsAssertCurrentPolicy(deps, policy, origin)
    try {
      // Reservation, quota, deletion and exact postcondition share ONE batch.
      // Ledger precedes deletion so immutable evidence can record the intended
      // count. The final CHECK rolls back both if actual removals differ.
      const result = await database.batch([
        database
          .prepare(
            `INSERT INTO analytics_retention_runs(id,environment,policy_fingerprint,policy_reference,policy_version,cutoff_at,requested_limit,removed_count,created_at)
          SELECT ?1,?2,?3,?4,?5,?6,?7,json_array_length(?10),?6
          WHERE COALESCE((SELECT sum(requested_limit) FROM analytics_retention_runs
            WHERE environment=?2 AND created_at>=?8 AND created_at<=?6),0)+?7<=?9
          AND json_array_length(?10)>0 AND (SELECT count(*) FROM analytics_browser_events
            WHERE event_id IN(SELECT value FROM json_each(?10)) AND environment=?2 AND policy_reference=?4 AND expires_at<=?6)=json_array_length(?10)
          RETURNING removed_count AS count`
          )
          .bind(
            runId,
            environment,
            fingerprint,
            policy.reference,
            policy.version,
            at,
            options.limit,
            windowStart,
            options.quota.maximumRequestedEvents,
            selectedIds
          ),
        database
          .prepare(
            'INSERT INTO analytics_atomic_guards(id,passed) SELECT 1,0 WHERE NOT EXISTS(SELECT 1 FROM analytics_retention_runs WHERE id=?1)'
          )
          .bind(runId),
        database
          .prepare(
            `DELETE FROM analytics_client_events WHERE event_id IN(SELECT value FROM json_each(?1)) RETURNING event_id AS eventId`
          )
          .bind(selectedIds),
        database
          .prepare(
            'DELETE FROM analytics_promotional_events WHERE event_id IN(SELECT value FROM json_each(?1)) RETURNING event_id AS eventId'
          )
          .bind(selectedIds),
        database
          .prepare(
            'INSERT INTO analytics_atomic_guards(id,passed) SELECT 1,0 WHERE EXISTS(SELECT 1 FROM analytics_browser_events WHERE event_id IN(SELECT value FROM json_each(?1)))'
          )
          .bind(selectedIds)
      ])
      await unchanged()
      const recorded = analyticsChecked(countSchema, result[0]?.results[0]),
        removed = analyticsChecked(z.array(z.object({ eventId: catalogPolicyUuidSchema }).strict()).max(100), [
          ...(result[2]?.results ?? []),
          ...(result[3]?.results ?? [])
        ])
      if (
        recorded.count !== removed.length ||
        recorded.count !== selected.length ||
        new Set(removed.map((row) => row.eventId)).size !== removed.length
      )
        throw new AnalyticsMeasurementError('service_unavailable')
      report.batches++
      report.requested += options.limit
      report.removed += removed.length
    } catch (error) {
      // Never label an ambiguous committed batch as zero/complete or retry it.
      // A quota result needs a definite constraint failure AND confirmed absence
      // of this run, plus fresh durable quota accounting.
      if (!isD1CheckConstraintFailure(error))
        throw error instanceof AnalyticsMeasurementError ? error : new AnalyticsMeasurementError('service_unavailable')
      const [run, quota] = await Promise.all([
        database.prepare('SELECT id FROM analytics_retention_runs WHERE id=?').bind(runId).first(),
        database
          .prepare(
            'SELECT COALESCE(sum(requested_limit),0) AS count FROM analytics_retention_runs WHERE environment=?1 AND created_at>=?2 AND created_at<=?3'
          )
          .bind(environment, windowStart, at)
          .first()
      ])
      await unchanged()
      if (
        run !== null ||
        analyticsChecked(countSchema, quota).count + options.limit <= options.quota.maximumRequestedEvents
      )
        throw new AnalyticsMeasurementError('service_unavailable')
      report.quotaExhausted = true
      break
    }
  }
  const at = analyticsClock(deps)
  report.generatedAt = at
  report.remainingExpired = await remaining(at)
  analyticsAssertCurrentPolicy(deps, policy, origin)
  return report
}
