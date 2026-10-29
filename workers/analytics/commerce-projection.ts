import { z } from 'zod'
import {
  analyticsCountSchema,
  analyticsEnvironmentSchema,
  analyticsHashSchema,
  analyticsProjectionResultSchema,
  analyticsSourceKindSchema,
  type AnalyticsProjectionResult
} from '../../shared/analytics-measurement'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import {
  AnalyticsMeasurementError,
  analyticsAssertEnabled,
  analyticsAssertCurrentConfiguration,
  analyticsAssertUnchanged,
  analyticsChecked,
  analyticsClock,
  analyticsDatabase,
  analyticsPolicyFingerprint,
  type AnalyticsMeasurementDependencies
} from './authority'

/** Alias s is the durable server source view, never a client event. A current
 * APP_ENV cannot certify historical bank provenance. Local/preview remain
 * validation populations even when a source carries a production marker. */
export function analyticsSourceClassificationSql(environment: AnalyticsMeasurementDependencies['environment']): string {
  const checked = analyticsEnvironmentSchema.parse(environment)
  return `CASE ${checked === 'production' ? "WHEN s.validation_only=1 OR s.provider_environment IN('sandbox','local_validation') THEN 'excluded'" : ''}
    WHEN s.proof_valid IS NOT 1 OR s.provider_environment IS NULL
      OR s.provider_environment NOT IN('production','sandbox','local_validation') THEN 'unconfirmed'
    ELSE 'eligible' END`
}
const projectionInputSchema = z
  .object({
    limit: analyticsCountSchema.min(1).max(100).default(100),
    maxPages: analyticsCountSchema.min(1).max(10).default(5)
  })
  .strict()
const sourceIdentitySchema = z
  .object({
    sourceKind: analyticsSourceKindSchema,
    sourceId: catalogPolicyUuidSchema,
    sourceFingerprint: analyticsHashSchema,
    occurredAt: catalogPolicyInstantSchema
  })
  .strict()
const runSchema = z
  .object({ examined: analyticsCountSchema.max(100), projected: analyticsCountSchema.max(100) })
  .strict()
const remainingSchema = z.object({ remaining: analyticsCountSchema, sourceUnavailable: analyticsCountSchema }).strict()

/** Bounded keyset projection: no financial state, stock, email, browser event
 * or provider is read/written as a substitute for recorded server proof. */
export async function projectAnalyticsCommerceFacts(
  deps: AnalyticsMeasurementDependencies,
  input: { limit?: number; maxPages?: number } = {}
): Promise<AnalyticsProjectionResult> {
  if (deps.enabled !== true)
    return analyticsChecked(analyticsProjectionResultSchema, {
      enabled: false,
      environment: deps.environment,
      validationOnly: deps.environment !== 'production',
      examined: 0,
      projected: 0,
      pages: 0,
      remaining: 0,
      complete: false,
      sourceUnavailable: 0,
      generatedAt: analyticsClock(deps)
    })
  const policy = analyticsAssertEnabled(deps),
    origin = deps.origin,
    options = analyticsChecked(projectionInputSchema, input)
  const fingerprint = await analyticsPolicyFingerprint(policy),
    database = analyticsDatabase(deps)
  let examined = 0,
    projected = 0,
    pages = 0
  for (; pages < options.maxPages;) {
    const at = analyticsClock(deps),
      cutoff = new Date(Date.parse(at) - policy.retentionDays * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    await analyticsAssertUnchanged(deps, fingerprint)
    analyticsAssertCurrentConfiguration(deps, policy, origin)
    const pending = await database
      .prepare(
        `SELECT s.source_kind AS sourceKind,s.source_id AS sourceId,
      s.source_fingerprint AS sourceFingerprint,s.occurred_at AS occurredAt
      FROM analytics_commerce_sources s WHERE s.occurred_at>?1 AND s.occurred_at<=?2
      AND (${analyticsSourceClassificationSql(policy.environment)})='eligible'
      AND NOT EXISTS(SELECT 1 FROM analytics_commerce_facts f WHERE f.environment=?3 AND f.source_kind=s.source_kind AND f.source_id=s.source_id)
      ORDER BY s.occurred_at,s.source_kind,s.source_id LIMIT ?4`
      )
      .bind(cutoff, at, policy.environment, options.limit)
      .all()
    const sources = analyticsChecked(z.array(sourceIdentitySchema).max(100), pending.results)
    if (!sources.length) break
    await analyticsAssertUnchanged(deps, fingerprint)
    analyticsAssertCurrentConfiguration(deps, policy, origin)
    const runId = crypto.randomUUID(),
      fresh = analyticsClock(deps),
      freshCutoff = new Date(Date.parse(fresh) - policy.retentionDays * 86400000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z')
    const result = await database.batch([
      database
        .prepare(
          `INSERT INTO analytics_commerce_facts(environment,source_kind,source_id,order_id,population,currency,
        gross_cents,net_cents,tax_cents,shipping_gross_cents,source_fingerprint,policy_fingerprint,occurred_at,projected_at,expires_at)
        SELECT ?1,s.source_kind,s.source_id,s.order_id,CASE WHEN ?1='production' THEN 'real' ELSE 'validation' END,s.currency,
        s.gross_cents,s.net_cents,s.tax_cents,s.shipping_gross_cents,s.source_fingerprint,?2,s.occurred_at,?3,
        strftime('%Y-%m-%dT%H:%M:%SZ',s.occurred_at,'+'||?5||' days')
        FROM analytics_commerce_sources s JOIN json_each(?4) selected
          ON json_extract(selected.value,'$.sourceKind')=s.source_kind AND json_extract(selected.value,'$.sourceId')=s.source_id
          AND json_extract(selected.value,'$.sourceFingerprint')=s.source_fingerprint
          AND json_extract(selected.value,'$.occurredAt')=s.occurred_at
        WHERE s.occurred_at>?6 AND s.occurred_at<=?3 AND (${analyticsSourceClassificationSql(policy.environment)})='eligible'
        AND NOT EXISTS(SELECT 1 FROM analytics_commerce_facts f WHERE f.environment=?1 AND f.source_kind=s.source_kind AND f.source_id=s.source_id)`
        )
        .bind(policy.environment, fingerprint, fresh, JSON.stringify(sources), policy.retentionDays, freshCutoff),
      database
        .prepare(
          `INSERT INTO analytics_projection_runs(id,environment,policy_fingerprint,examined,projected,created_at)
        VALUES(?1,?2,?3,?4,changes(),?5)`
        )
        .bind(runId, policy.environment, fingerprint, sources.length, fresh),
      database.prepare('SELECT examined,projected FROM analytics_projection_runs WHERE id=?').bind(runId)
    ])
    const run = analyticsChecked(runSchema, result[2]?.results[0])
    if (run.examined !== sources.length || run.projected > run.examined)
      throw new AnalyticsMeasurementError('service_unavailable')
    examined += run.examined
    projected += run.projected
    pages++
    await analyticsAssertUnchanged(deps, fingerprint)
    if (run.projected === 0) break // A competing projection/source change cannot cause a busy retry loop.
  }
  const at = analyticsClock(deps),
    cutoff = new Date(Date.parse(at) - policy.retentionDays * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  await analyticsAssertUnchanged(deps, fingerprint)
  analyticsAssertCurrentConfiguration(deps, policy, origin)
  const remaining = analyticsChecked(
    remainingSchema,
    await database
      .prepare(
        `SELECT
    COALESCE(sum((${analyticsSourceClassificationSql(policy.environment)})='eligible' AND NOT EXISTS(
      SELECT 1 FROM analytics_commerce_facts f WHERE f.environment=?3 AND f.source_kind=s.source_kind AND f.source_id=s.source_id
      AND f.expires_at>?2 AND f.order_id=s.order_id AND f.currency=s.currency AND f.gross_cents=s.gross_cents
      AND f.net_cents=s.net_cents AND f.tax_cents=s.tax_cents AND f.shipping_gross_cents=s.shipping_gross_cents
      AND f.occurred_at=s.occurred_at AND f.source_fingerprint=s.source_fingerprint
      AND f.population=CASE WHEN ?3='production' THEN 'real' ELSE 'validation' END)),0) AS remaining,
    COALESCE(sum((${analyticsSourceClassificationSql(policy.environment)})='unconfirmed'),0) AS sourceUnavailable
    FROM analytics_commerce_sources s WHERE s.occurred_at>?1 AND s.occurred_at<=?2`
      )
      .bind(cutoff, at, policy.environment)
      .first()
  )
  await analyticsAssertUnchanged(deps, fingerprint)
  analyticsAssertCurrentConfiguration(deps, policy, origin)
  return analyticsChecked(analyticsProjectionResultSchema, {
    enabled: true,
    environment: policy.environment,
    validationOnly: policy.environment !== 'production',
    examined,
    projected,
    pages,
    remaining: remaining.remaining,
    complete: remaining.remaining === 0 && remaining.sourceUnavailable === 0,
    sourceUnavailable: remaining.sourceUnavailable,
    generatedAt: at
  })
}
