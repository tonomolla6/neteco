import { z } from 'zod'
import {
  analyticsRangeSchema,
  analyticsReconciliationSchema,
  analyticsCountSchema,
  type AnalyticsRange,
  type AnalyticsReconciliation
} from '../../shared/analytics-measurement'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  AnalyticsMeasurementError,
  analyticsAssertEnabled,
  analyticsAssertCurrentConfiguration,
  analyticsAssertUnchanged,
  analyticsAuthorizeAdmin,
  analyticsChecked,
  analyticsDatabase,
  analyticsPolicyFingerprint,
  analyticsAdminBinds,
  ANALYTICS_ADMIN_AUTHORITY_SQL,
  type AnalyticsMeasurementDependencies
} from './authority'
import { analyticsSourceClassificationSql } from './commerce-projection'

const summarySchema = z
  .object({
    sourceCount: analyticsCountSchema,
    missingCount: analyticsCountSchema,
    mismatchCount: analyticsCountSchema,
    unconfirmedCount: analyticsCountSchema,
    excludedCount: analyticsCountSchema,
    projectionLagSeconds: analyticsCountSchema.nullable()
  })
  .strict()
/** Compare local recorded authority, never provider APIs or browser revenue.
 * Unknown historical bank provenance is unconfirmed, not an observed zero. */
export async function readAnalyticsReconciliation(
  deps: AnalyticsMeasurementDependencies,
  claims: VerifiedSessionClaims,
  input: AnalyticsRange
): Promise<AnalyticsReconciliation> {
  const policy = analyticsAssertEnabled(deps),
    origin = deps.origin,
    range = analyticsChecked(analyticsRangeSchema, input)
  const database = analyticsDatabase(deps)
  await analyticsAuthorizeAdmin(deps, claims)
  const fingerprint = await analyticsPolicyFingerprint(policy)
  await analyticsAssertUnchanged(deps, fingerprint)
  await analyticsAuthorizeAdmin(deps, claims)
  const adminBinds = analyticsAdminBinds(deps, claims)
  const generatedAt = adminBinds[0]
  const binds = [...adminBinds, range.from, range.to, policy.environment]
  const cutoff = new Date(Date.parse(generatedAt) - policy.retentionDays * 86_400_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
  if (range.from <= cutoff) throw new AnalyticsMeasurementError('period_unavailable')
  const cte = `WITH sources AS (
    SELECT s.*,${analyticsSourceClassificationSql(policy.environment)} AS classification
    FROM analytics_commerce_sources s
    WHERE s.occurred_at>=?5 AND s.occurred_at<?6 AND s.occurred_at<=?1 AND (${ANALYTICS_ADMIN_AUTHORITY_SQL})
  ), compared AS (
    SELECT s.source_kind,s.source_id,s.occurred_at,s.classification,
      CASE WHEN s.classification='unconfirmed' THEN 'unconfirmed'
        WHEN s.classification='excluded' THEN NULL
        WHEN f.source_id IS NULL THEN 'missing'
        WHEN f.order_id<>s.order_id OR f.currency<>s.currency OR f.gross_cents<>s.gross_cents
          OR f.net_cents<>s.net_cents OR f.tax_cents<>s.tax_cents
          OR f.shipping_gross_cents<>s.shipping_gross_cents OR f.occurred_at<>s.occurred_at
          OR f.source_fingerprint<>s.source_fingerprint
          OR f.population<>CASE WHEN ?7='production' THEN 'real' ELSE 'validation' END
        THEN 'mismatch' ELSE NULL END AS code,
      CASE WHEN s.classification='eligible'
        THEN MAX(0,CAST(strftime('%s',?1) AS INTEGER)-CAST(strftime('%s',s.occurred_at) AS INTEGER))
        ELSE NULL END AS lag_seconds,
      CASE WHEN s.classification='unconfirmed' AND s.source_kind='capture_applied'
        AND s.provider_environment='unknown' THEN 'capture_provenance_unavailable'
        WHEN s.classification='unconfirmed' THEN 'source_proof_unavailable'
        ELSE NULL END AS unavailable_hint
    FROM sources s LEFT JOIN analytics_commerce_facts f
      ON f.environment=?7 AND f.source_kind=s.source_kind AND f.source_id=s.source_id AND f.expires_at>?1
  )`
  // Both statements share a native D1 snapshot. Global counts are not inferred
  // from this page, and no projection, audit insert or repair occurs on GET.
  const result = await database.batch([
    database
      .prepare(
        `${cte} SELECT count(*) AS sourceCount,
      COALESCE(sum(code='missing'),0) AS missingCount,COALESCE(sum(code='mismatch'),0) AS mismatchCount,
      COALESCE(sum(code='unconfirmed'),0) AS unconfirmedCount,
      COALESCE(sum(classification='excluded'),0) AS excludedCount,
      MAX(CASE WHEN code IN('missing','mismatch') THEN lag_seconds ELSE NULL END) AS projectionLagSeconds
      FROM compared`
      )
      .bind(...binds),
    database
      .prepare(
        `${cte} SELECT code,source_kind AS sourceKind,source_id AS sourceId,
      occurred_at AS occurredAt,lag_seconds AS lagSeconds,
      CASE WHEN code='missing' THEN 'projection_pending' WHEN code='mismatch' THEN 'projection_mismatch'
        ELSE unavailable_hint END AS hint FROM compared WHERE code IS NOT NULL
      ORDER BY occurred_at,source_kind,source_id LIMIT ?8 OFFSET ?9`
      )
      .bind(...binds, range.perPage, (range.page - 1) * range.perPage)
  ])
  await analyticsAssertUnchanged(deps, fingerprint)
  await analyticsAuthorizeAdmin(deps, claims)
  analyticsAssertCurrentConfiguration(deps, policy, origin)
  const summary = analyticsChecked(summarySchema, result[0]?.results[0])
  const total = summary.missingCount + summary.mismatchCount + summary.unconfirmedCount
  return analyticsChecked(analyticsReconciliationSchema, {
    schemaVersion: 'v1',
    source: 'cloudflare',
    generatedAt,
    policy: {
      reference: policy.reference,
      version: policy.version,
      purpose: policy.purpose,
      retentionDays: policy.retentionDays
    },
    period: { from: range.from, to: range.to },
    population: { environment: policy.environment, validationOnly: policy.environment !== 'production' },
    readOnly: true,
    settlementCertified: false,
    summary,
    issues: result[1]?.results,
    pagination: { page: range.page, perPage: range.perPage, total, pages: Math.ceil(total / range.perPage) }
  })
}
