import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import {
  analyticsRange,
  defaultAnalyticsDates,
  analyticsMoney,
  analyticsCount,
  analyticsInstant,
  analyticsLag,
  analyticsDenied,
  parseAnalyticsSnapshot,
  parseAnalyticsReconciliation,
  matchingAnalyticsPopulation,
  type AnalyticsQuery
} from '../../app/components/analytics/operations-ui'
import { ANALYTICS_DEFINITIONS, analyticsClientNameSchema } from '../../shared/analytics-measurement'

const query: AnalyticsQuery = { from: '2026-09-01T00:00:00Z', to: '2026-09-08T00:00:00Z', page: 1, perPage: 20 }
function snapshot() {
  return {
    schemaVersion: 'v1',
    source: 'cloudflare',
    generatedAt: query.to,
    policy: { reference: 'local-review', version: 'v1', purpose: 'first_party_measurement', retentionDays: 30 },
    period: { from: query.from, to: query.to },
    population: { environment: 'local', validationOnly: true },
    coverage: {
      status: 'complete',
      streams: ['capture_applied', 'refund_confirmed', 'fiscal_issued'].map((kind) => ({
        kind,
        sourceCount: 0,
        eligibleCount: 0,
        unconfirmedCount: 0,
        excludedCount: 0,
        projectedCount: 0,
        backlogCount: 0,
        oldestUnprojectedAt: null,
        provenance: 'persisted_contract'
      }))
    },
    metrics: {
      currency: 'EUR',
      grossCollectedCents: 0,
      capturedOrders: 0,
      refundedCents: 0,
      confirmedRefunds: 0,
      collectedAfterRefundsCents: 0,
      issuedFiscalCents: 0,
      issuedFiscalDocuments: 0,
      settlementCertified: false
    },
    browser: {
      eventCounts: analyticsClientNameSchema.options.map((name) => ({ name, count: 0 })),
      uniqueSessions: 0,
      financialAuthority: 'none'
    },
    definitions: ANALYTICS_DEFINITIONS.map((value) => ({ ...value })),
    facts: [],
    pagination: { page: 1, perPage: 20, total: 0, pages: 0 }
  }
}
function reconciliation() {
  return {
    schemaVersion: 'v1',
    source: 'cloudflare',
    generatedAt: query.to,
    policy: snapshot().policy,
    period: { from: query.from, to: query.to },
    population: { environment: 'local', validationOnly: true },
    readOnly: true,
    settlementCertified: false,
    summary: {
      sourceCount: 0,
      missingCount: 0,
      mismatchCount: 0,
      unconfirmedCount: 0,
      excludedCount: 0,
      projectionLagSeconds: null
    },
    issues: [],
    pagination: { page: 1, perPage: 20, total: 0, pages: 0 }
  }
}

describe('analytics UI explicit UTC, integer units and unavailable observations', () => {
  it('defaults to seven complete UTC days, independent of local timezone', () => {
    expect(defaultAnalyticsDates(new Date('2026-10-03T23:59:59-05:00'))).toEqual({
      from: '2026-09-27',
      to: '2026-10-04'
    })
  })
  it('makes the inclusive/exclusive range canonical and immutable', () => {
    const value = analyticsRange({ from: '2026-03-01', to: '2026-04-01' })
    expect(value).toEqual({ from: '2026-03-01T00:00:00Z', to: '2026-04-01T00:00:00Z' })
    expect(Object.isFrozen(value)).toBe(true)
  })
  it.each([
    { from: '2026-02-30', to: '2026-03-02' },
    { from: '2026-3-01', to: '2026-03-02' },
    { from: '2026-03-01T00:00:00Z', to: '2026-03-02' },
    { from: '2026-03-01', to: '2026-03-01' },
    { from: '2026-03-02', to: '2026-03-01' },
    { from: '2026-03-01', to: '2026-04-02' }
  ])('rejects invalid or overlong UTC ranges %j', (dates) => {
    expect(() => analyticsRange(dates)).toThrow()
  })
  it('distinguishes unavailable values from confirmed zeros', () => {
    expect(analyticsMoney(null)).toBe('No disponible')
    expect(analyticsCount(null)).toBe('No disponible')
    expect(analyticsMoney(0)).toContain('0,00')
    expect(analyticsCount(0)).toBe('0')
  })
  it('keeps cents exact, including a negative period difference and maximum safe amount', () => {
    expect(analyticsMoney(12345)).toContain('123,45')
    expect(analyticsMoney(-1)).toContain('-0,01')
    expect(analyticsMoney(Number.MAX_SAFE_INTEGER)).toContain('90.071.992.547.409,91')
  })
  it('does not coerce fractional or unsafe amounts/counts', () => {
    expect(() => analyticsMoney(1.1)).toThrow()
    expect(() => analyticsMoney(Number.MAX_SAFE_INTEGER + 1)).toThrow()
    expect(() => analyticsCount(-1)).toThrow()
    expect(() => analyticsCount(0.1)).toThrow()
  })
  it('shows timestamps explicitly in UTC', () => {
    expect(analyticsInstant('2026-10-03T23:00:01Z')).toContain('23:00:01 UTC')
    expect(() => analyticsInstant('2026-10-03T23:00:01+00:00')).toThrow()
  })
  it('measures lag against the server observation, preserving unknown and future cases', () => {
    expect(analyticsLag('2026-10-03T10:00:00Z', '2026-10-03T12:00:00Z')).toBe('2 h')
    expect(analyticsLag(null, '2026-10-03T12:00:00Z')).toBe('No disponible')
    expect(analyticsLag('2026-10-03T12:00:01Z', '2026-10-03T12:00:00Z')).toBe('No disponible')
  })
  it('recognizes current access denials without reading or exposing error-body accessors', () => {
    expect(analyticsDenied({ response: new Response(null, { status: 403 }) })).toBe(true)
    expect(analyticsDenied({ statusCode: 401 })).toBe(true)
    expect(analyticsDenied({ response: { status: 503 } })).toBe(false)
    let reads = 0
    expect(analyticsDenied(Object.defineProperty({}, 'statusCode', { get: () => ++reads }))).toBe(false)
    const forged = Object.create(Response.prototype)
    Object.defineProperty(forged, 'status', { get: () => ++reads })
    expect(analyticsDenied({ response: forged })).toBe(false)
    expect(reads).toBe(0)
  })
})

describe('analytics UI strict shared DTO binding', () => {
  it('keeps the owned panel and page syntactically valid without starting Nuxt or a component runner', () => {
    for (const relative of [
      '../../app/components/AnalyticsOperationsPanel.vue',
      '../../app/pages/admin/analitica.vue'
    ]) {
      const filename = new URL(relative, import.meta.url).pathname,
        source = readFileSync(filename, 'utf8'),
        result = parse(source, { filename })
      expect(result.errors).toEqual([])
      const script = compileScript(result.descriptor, { id: 'analytics-operations-local' })
      expect(script.content).toContain('setup')
      expect(
        compileTemplate({ source: result.descriptor.template!.content, filename, id: 'analytics-operations-local' })
          .errors
      ).toEqual([])
    }
  })
  it('accepts verified own DTOs only for the exact queried period and pagination', () => {
    expect(parseAnalyticsSnapshot(snapshot(), query).metrics.grossCollectedCents).toBe(0)
    expect(parseAnalyticsReconciliation(reconciliation(), query).pagination.total).toBe(0)
    expect(() => parseAnalyticsSnapshot(snapshot(), { ...query, from: '2026-09-02T00:00:00Z' })).toThrow()
    expect(() => parseAnalyticsReconciliation(reconciliation(), { ...query, page: 2 })).toThrow()
    expect(() => parseAnalyticsReconciliation(reconciliation(), { ...query, perPage: 25 })).toThrow()
  })
  it('does not execute snapshot accessors or accept inherited/sparse data', () => {
    let reads = 0
    const value = snapshot()
    Object.defineProperty(value, 'generatedAt', {
      enumerable: true,
      get: () => {
        reads++
        return query.to
      }
    })
    expect(() => parseAnalyticsSnapshot(value, query)).toThrow()
    expect(reads).toBe(0)
    expect(() => parseAnalyticsSnapshot(Object.create(snapshot()), query)).toThrow()
    const sparse = snapshot()
    delete sparse.definitions[0]
    expect(() => parseAnalyticsSnapshot(sparse, query)).toThrow()
  })
  it('rejects foreign runtime, unexpected PII and missing measurement definitions', () => {
    expect(() => parseAnalyticsSnapshot({ ...snapshot(), source: 'node' }, query)).toThrow()
    expect(() => parseAnalyticsReconciliation({ ...reconciliation(), email: 'private@example.test' }, query)).toThrow()
    const value = snapshot()
    value.definitions[0] = { ...value.definitions[1]! }
    expect(() => parseAnalyticsSnapshot(value, query)).toThrow()
  })
  it('does not coerce missing financial observations or manufacture certified settlement', () => {
    const value = snapshot()
    expect(() =>
      parseAnalyticsSnapshot({ ...value, metrics: { ...value.metrics, grossCollectedCents: undefined } }, query)
    ).toThrow()
    expect(() =>
      parseAnalyticsSnapshot({ ...value, metrics: { ...value.metrics, grossCollectedCents: '0' } }, query)
    ).toThrow()
    expect(() =>
      parseAnalyticsSnapshot({ ...value, metrics: { ...value.metrics, settlementCertified: true } }, query)
    ).toThrow()
    expect(
      parseAnalyticsSnapshot({ ...value, metrics: { ...value.metrics, grossCollectedCents: null } }, query).metrics
        .grossCollectedCents
    ).toBeNull()
  })
  it('binds reconciliation issue timestamps and disallows duplicate references on a page', () => {
    const issue = {
        code: 'unconfirmed',
        sourceKind: 'capture_applied',
        sourceId: '10000000-0000-4000-8000-000000000052',
        occurredAt: query.to,
        lagSeconds: null,
        hint: 'capture_provenance_unavailable'
      },
      base = reconciliation(),
      value = { ...base, issues: [issue], pagination: { ...base.pagination, total: 1, pages: 1 } }
    expect(() => parseAnalyticsReconciliation(value, query)).toThrow()
    const within = { ...issue, occurredAt: query.from }
    expect(() =>
      parseAnalyticsReconciliation(
        { ...value, issues: [within, within], pagination: { ...base.pagination, total: 2, pages: 1 } },
        query
      )
    ).toThrow()
    expect(parseAnalyticsReconciliation({ ...value, issues: [within] }, query).issues).toHaveLength(1)
  })
  it('keeps policy, version, retention and validation population consistent between reads', () => {
    const left = parseAnalyticsSnapshot(snapshot(), query),
      right = parseAnalyticsReconciliation(reconciliation(), query)
    expect(matchingAnalyticsPopulation(left, right)).toBe(true)
    expect(matchingAnalyticsPopulation(left, { ...right, policy: { ...right.policy, version: 'v2' } })).toBe(false)
    expect(matchingAnalyticsPopulation(left, { ...right, policy: { ...right.policy, retentionDays: 90 } })).toBe(false)
    expect(
      matchingAnalyticsPopulation(left, { ...right, population: { environment: 'preview', validationOnly: true } })
    ).toBe(false)
  })
})
