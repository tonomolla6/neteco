import { z } from 'zod'
import {
  ANALYTICS_DEFINITIONS,
  analyticsClientNameSchema,
  analyticsCountSchema,
  analyticsFactSchema,
  analyticsRangeSchema,
  analyticsSnapshotSchema,
  analyticsSourceKindSchema,
  analyticsStreamCoverageSchema,
  type AnalyticsRange,
  type AnalyticsSnapshot
} from '../../shared/analytics-measurement'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  AnalyticsMeasurementError,
  ANALYTICS_ADMIN_AUTHORITY_SQL,
  analyticsAdminBinds,
  analyticsAssertEnabled,
  analyticsAssertCurrentConfiguration,
  analyticsAssertUnchanged,
  analyticsAuthorizeAdmin,
  analyticsChecked,
  analyticsDatabase,
  analyticsPolicyFingerprint,
  type AnalyticsMeasurementDependencies
} from './authority'
import { analyticsSourceClassificationSql } from './commerce-projection'

const sumsSchema = z
  .object({ kind: analyticsSourceKindSchema, count: analyticsCountSchema, cents: analyticsCountSchema })
  .strict()
const browserSchema = z.object({ name: analyticsClientNameSchema, count: analyticsCountSchema }).strict()
const counterSchema = z.object({ total: analyticsCountSchema }).strict()
const KINDS = ['capture_applied', 'refund_confirmed', 'fiscal_issued'] as const
const CLIENT_NAMES = [
  'page_view',
  'catalog_viewed',
  'search_completed',
  'product_viewed',
  'cart_item_added',
  'cart_item_removed',
  'checkout_started',
  'web_vital',
  'promotional_impression',
  'promotional_click'
] as const

/** One native D1 read snapshot; no repair/projection/provider/audit writes on GET. */
export async function readAnalyticsSnapshot(
  deps: AnalyticsMeasurementDependencies,
  claims: VerifiedSessionClaims,
  input: AnalyticsRange
): Promise<AnalyticsSnapshot> {
  const policy = analyticsAssertEnabled(deps),
    origin = deps.origin,
    range = analyticsChecked(analyticsRangeSchema, input)
  const database = analyticsDatabase(deps),
    fingerprint = await analyticsPolicyFingerprint(policy)
  await analyticsAuthorizeAdmin(deps, claims)
  await analyticsAssertUnchanged(deps, fingerprint)
  const authorityBinds = analyticsAdminBinds(deps, claims),
    binds = [...authorityBinds, range.from, range.to, policy.environment]
  const generatedAt = authorityBinds[0],
    cutoff = new Date(Date.parse(generatedAt) - policy.retentionDays * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  // At the exact retention cutoff expires_at===now. Reject a period that
  // promises an inclusive observation of a row which is already expired.
  if (range.from <= cutoff) throw new AnalyticsMeasurementError('period_unavailable')
  const cte = `WITH sources AS (SELECT s.*,${analyticsSourceClassificationSql(policy.environment)} AS classification
    FROM analytics_commerce_sources s WHERE s.occurred_at>=?5 AND s.occurred_at<?6 AND s.occurred_at<=?1 AND (${ANALYTICS_ADMIN_AUTHORITY_SQL})),
    confirmed AS (SELECT f.* FROM analytics_commerce_facts f JOIN sources s
      ON f.source_kind=s.source_kind AND f.source_id=s.source_id AND s.classification='eligible'
      AND f.order_id=s.order_id AND f.currency=s.currency AND f.gross_cents=s.gross_cents AND f.net_cents=s.net_cents
      AND f.tax_cents=s.tax_cents AND f.shipping_gross_cents=s.shipping_gross_cents
      AND f.source_fingerprint=s.source_fingerprint AND f.occurred_at=s.occurred_at
      WHERE f.environment=?7 AND f.expires_at>?1 AND f.population=CASE WHEN ?7='production' THEN 'real' ELSE 'validation' END)`
  const browserWhere = `environment=?7 AND occurred_at>=?5 AND occurred_at<?6 AND occurred_at<=?1 AND expires_at>?1 AND (${ANALYTICS_ADMIN_AUTHORITY_SQL})`
  const result = await database.batch([
    database
      .prepare(
        `${cte} SELECT s.source_kind AS kind,count(*) AS sourceCount,
      sum(s.classification='eligible') AS eligibleCount,sum(s.classification='unconfirmed') AS unconfirmedCount,sum(s.classification='excluded') AS excludedCount,
      sum(f.source_id IS NOT NULL) AS projectedCount,sum(s.classification='eligible' AND f.source_id IS NULL) AS backlogCount,
      min(CASE WHEN s.classification='eligible' AND f.source_id IS NULL THEN s.occurred_at ELSE NULL END) AS oldestUnprojectedAt,
      CASE WHEN s.source_kind='capture_applied' AND sum(s.provider_environment='unknown')>0 THEN 'legacy_capture_unavailable'
        WHEN s.source_kind='capture_applied' THEN 'verified_capture' ELSE 'persisted_contract' END AS provenance
      FROM sources s LEFT JOIN confirmed f ON f.source_kind=s.source_kind AND f.source_id=s.source_id GROUP BY s.source_kind`
      )
      .bind(...binds),
    database
      .prepare(
        `${cte} SELECT source_kind AS kind,count(*) AS count,COALESCE(sum(gross_cents),0) AS cents FROM confirmed GROUP BY source_kind`
      )
      .bind(...binds),
    database.prepare(`${cte} SELECT count(*) AS total FROM confirmed`).bind(...binds),
    database
      .prepare(
        `${cte} SELECT source_kind AS sourceKind,source_id AS sourceId,order_id AS orderId,currency,gross_cents AS grossCents,
      net_cents AS netCents,tax_cents AS taxCents,shipping_gross_cents AS shippingGrossCents,occurred_at AS occurredAt,
      projected_at AS projectedAt,population,source_fingerprint AS sourceFingerprint FROM confirmed
      ORDER BY occurred_at,source_kind,source_id LIMIT ?8 OFFSET ?9`
      )
      .bind(...binds, range.perPage, (range.page - 1) * range.perPage),
    database
      .prepare(`SELECT name,count(*) AS count FROM analytics_browser_events WHERE ${browserWhere} GROUP BY name`)
      .bind(...binds),
    database
      .prepare(`SELECT count(DISTINCT session_hash) AS total FROM analytics_browser_events WHERE ${browserWhere}`)
      .bind(...binds)
  ])
  await analyticsAssertUnchanged(deps, fingerprint)
  await analyticsAuthorizeAdmin(deps, claims)
  analyticsAssertCurrentConfiguration(deps, policy, origin)
  const receivedStreams = analyticsChecked(z.array(analyticsStreamCoverageSchema).max(3), result[0]?.results)
  const streams = KINDS.map(
    (kind) =>
      receivedStreams.find((stream) => stream.kind === kind) ?? {
        kind,
        sourceCount: 0,
        eligibleCount: 0,
        unconfirmedCount: 0,
        excludedCount: 0,
        projectedCount: 0,
        backlogCount: 0,
        oldestUnprojectedAt: null,
        provenance: kind === 'capture_applied' ? 'verified_capture' : 'persisted_contract'
      }
  )
  const sums = analyticsChecked(z.array(sumsSchema).max(3), result[1]?.results)
  const amount = (kind: (typeof KINDS)[number]) => {
    const coverage = streams.find((stream) => stream.kind === kind)!
    if (coverage.unconfirmedCount || coverage.backlogCount) return { count: null, cents: null }
    const sum = sums.find((item) => item.kind === kind)
    return { count: sum?.count ?? 0, cents: sum?.cents ?? 0 }
  }
  const capture = amount('capture_applied'),
    refund = amount('refund_confirmed'),
    fiscal = amount('fiscal_issued')
  const total = analyticsChecked(counterSchema, result[2]?.results[0]).total
  const browser = analyticsChecked(z.array(browserSchema).max(10), result[4]?.results)
  const incomplete = streams.some((stream) => stream.unconfirmedCount || stream.backlogCount)
  const available = streams.some((stream) => stream.projectedCount > 0)
  return analyticsChecked(analyticsSnapshotSchema, {
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
    coverage: { status: incomplete ? (available ? 'partial' : 'unavailable') : 'complete', streams },
    metrics: {
      currency: 'EUR',
      grossCollectedCents: capture.cents,
      capturedOrders: capture.count,
      refundedCents: refund.cents,
      confirmedRefunds: refund.count,
      collectedAfterRefundsCents: capture.cents !== null && refund.cents !== null ? capture.cents - refund.cents : null,
      issuedFiscalCents: fiscal.cents,
      issuedFiscalDocuments: fiscal.count,
      settlementCertified: false
    },
    browser: {
      eventCounts: CLIENT_NAMES.map((name) => ({ name, count: browser.find((row) => row.name === name)?.count ?? 0 })),
      uniqueSessions: analyticsChecked(counterSchema, result[5]?.results[0]).total,
      financialAuthority: 'none'
    },
    definitions: ANALYTICS_DEFINITIONS,
    facts: analyticsChecked(z.array(analyticsFactSchema).max(50), result[3]?.results),
    pagination: { page: range.page, perPage: range.perPage, total, pages: Math.ceil(total / range.perPage) }
  })
}
