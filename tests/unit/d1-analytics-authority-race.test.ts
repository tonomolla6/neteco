import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyticsFixture, CLAIMS } from './d1-analytics-fixture'
import { analyticsMeasurementPolicySchema, type AnalyticsMeasurementPolicy } from '../../shared/analytics-measurement'
import { analyticsAssertUnchanged, analyticsPolicyFingerprint } from '../../workers/analytics/authority'
import { readAnalyticsSnapshot } from '../../workers/analytics/read-model'
import { readAnalyticsReconciliation } from '../../workers/analytics/reconciliation'
import { projectAnalyticsCommerceFacts } from '../../workers/analytics/commerce-projection'
import { configuredAnalyticsMeasurement, type AnalyticsRuntimeEnv } from '../../workers/runtime/analytics-config'
import { handleConfiguredAnalyticsHttp } from '../../workers/runtime/analytics-http'
import { authorizeD1Session } from '../../workers/catalog/authorization'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'

const opened: DatabaseSync[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const database of opened.splice(0)) database.close()
})

type MutableConfiguration = {
  APP_ENV: string
  AUTH_ENABLED: string
  AUTH_ORIGIN: string
  ANALYTICS_ENABLED: string
  ANALYTICS_POLICY: string
  AUTH_RATE_LIMIT_PEPPER: string
  NUXT_SESSION_PASSWORD: string
  ADMIN_EDGE_LIMIT: RateLimit
}
type ConfigurationChange = {
  name: string
  error: 'feature_unavailable' | 'configuration_unavailable'
  apply(configuration: MutableConfiguration, policy: AnalyticsMeasurementPolicy): void
}
const changes: ConfigurationChange[] = [
  {
    name: 'analytics OFF',
    error: 'feature_unavailable',
    apply(configuration) {
      configuration.ANALYTICS_ENABLED = 'false'
    }
  },
  {
    name: 'administrative AUTH OFF',
    error: 'feature_unavailable',
    apply(configuration) {
      configuration.AUTH_ENABLED = 'false'
    }
  },
  {
    name: 'local policy/environment changed to production',
    error: 'configuration_unavailable',
    apply(configuration, policy) {
      configuration.APP_ENV = 'production'
      configuration.ANALYTICS_POLICY = JSON.stringify({ ...policy, environment: 'production' })
    }
  },
  {
    name: 'origin changed',
    error: 'configuration_unavailable',
    apply(configuration) {
      configuration.AUTH_ORIGIN = 'https://different-analytics.neteco.test'
    }
  }
]

async function fixture() {
  // This maintained fixture owns genuine checkout, signed sandbox notification,
  // persisted capture authority and local-only fiscal completion. No payment,
  // financial fact, role result or authenticated response is fabricated here.
  const world = await analyticsFixture({ commerce: true })
  opened.push(world.sqlite)
  const initialPolicy = analyticsMeasurementPolicySchema.parse(world.deps.policy)
  const originalOrigin = world.deps.origin
  const configuration: MutableConfiguration = {
    APP_ENV: 'local',
    AUTH_ENABLED: 'true',
    AUTH_ORIGIN: originalOrigin,
    ANALYTICS_ENABLED: 'true',
    ANALYTICS_POLICY: JSON.stringify(initialPolicy),
    AUTH_RATE_LIMIT_PEPPER: 'synthetic-analytics-authority-edge-pepper-0123456789',
    NUXT_SESSION_PASSWORD: 'synthetic-analytics-authority-session-0123456789abcdef',
    ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) }
  }
  let armed: { change: ConfigurationChange; ordinal: number; applied: boolean } | null = null
  let readBatchObserved = false
  let afterBatchAuthorizations = 0
  let realAuthorizedRows = 0
  const rawDatabase = world.database

  function statementProxy(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, property, receiver) {
        if (property === 'bind') return (...parameters: unknown[]) => statementProxy(target.bind(...parameters), sql)
        if (property === 'first' && sql.includes('AS permitted'))
          return async (...parameters: Parameters<D1PreparedStatement['first']>) => {
            // Let SQLite execute the installed live-authority SQL before the
            // injected race. Never substitute an allowed authorization row.
            const result = await target.first(...parameters)
            expect(result).toEqual({ id: CLAIMS.identityId, mfa_verified: 1, email_verified: 1, permitted: 1 })
            realAuthorizedRows++
            if (armed && readBatchObserved && ++afterBatchAuthorizations === armed.ordinal) {
              armed.change.apply(configuration, initialPolicy)
              armed.applied = true
            }
            return result
          }
        return Reflect.get(target, property, receiver)
      }
    })
  }
  const database = new Proxy(rawDatabase, {
    get(target, property, receiver) {
      if (property === 'prepare') return (sql: string) => statementProxy(target.prepare(sql), sql)
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const result = await target.batch(statements)
          if (armed) readBatchObserved = true
          return result
        }
      return Reflect.get(target, property, receiver)
    }
  })
  // Runtime accessors must observe the mutable binding, not a spread/cached
  // configuration. Only DB is supplied through this test-local proxy getter.
  const env = new Proxy(configuration, {
    get(target, property, receiver) {
      return property === 'DB' ? database : Reflect.get(target, property, receiver)
    }
  }) as unknown as AnalyticsRuntimeEnv
  const deps = configuredAnalyticsMeasurement(env, { administrative: true, now: world.deps.now })
  await expect(
    authorizeD1Session(rawDatabase, CLAIMS, 'administration.manage', {
      now: world.deps.now!(),
      requireMfa: true
    })
  ).resolves.toMatchObject({ allowed: true, identityId: CLAIMS.identityId })
  await expect(projectAnalyticsCommerceFacts(deps)).resolves.toMatchObject({ projected: 2, complete: true })
  const cookieConfiguration = { password: configuration.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 }
  const issuedCookie = await issueD1SessionCookie(rawDatabase, CLAIMS, cookieConfiguration)
  if (!issuedCookie) throw new Error('synthetic_analytics_session_unconfirmed')
  const cookie = issuedCookie.split(';')[0]!
  // Both global monetary observations are positive, but this overflow page
  // has no fact row to incidentally catch a validation→real population change.
  const range = { ...world.range(), page: 2, perPage: 20 }
  const read = (kind: 'snapshot' | 'reconciliation') =>
    kind === 'snapshot' ? readAnalyticsSnapshot(deps, CLAIMS, range) : readAnalyticsReconciliation(deps, CLAIMS, range)
  const request = (kind: 'snapshot' | 'reconciliation') =>
    new Request(
      originalOrigin +
        '/api/admin/analytics' +
        (kind === 'reconciliation' ? '/reconciliation' : '') +
        '?' +
        new URLSearchParams({
          from: range.from,
          to: range.to,
          page: String(range.page),
          perPage: String(range.perPage)
        }),
      {
        headers: { Origin: originalOrigin, Cookie: cookie, 'CF-Connecting-IP': '192.0.2.52' }
      }
    )
  const http = (kind: 'snapshot' | 'reconciliation') =>
    handleConfiguredAnalyticsHttp(request(kind), env, { now: world.deps.now })
  return {
    ...world,
    configuration,
    initialPolicy,
    deps,
    read,
    http,
    arm(change: ConfigurationChange, ordinal: number) {
      readBatchObserved = false
      afterBatchAuthorizations = 0
      armed = { change, ordinal, applied: false }
    },
    assertInjectedAtLastAuthorization(ordinal: number) {
      expect(readBatchObserved).toBe(true)
      expect(armed?.applied).toBe(true)
      expect(afterBatchAuthorizations).toBe(ordinal)
      expect(realAuthorizedRows).toBeGreaterThan(ordinal)
    }
  }
}

describe('analytics current configuration after the final real D1 authorization await', () => {
  for (const kind of ['snapshot', 'reconciliation'] as const) {
    it.each(changes)(`${kind} rejects $name after its last authorized row, even on an empty page`, async (change) => {
      const f = await fixture()
      const baseline = await f.read(kind)
      expect(baseline.population).toEqual({ environment: 'local', validationOnly: true })
      expect(baseline.pagination).toMatchObject({ page: 2 })
      if ('facts' in baseline) {
        expect(baseline.facts).toEqual([])
        expect(baseline.metrics.grossCollectedCents).toBeGreaterThan(0)
        expect(baseline.metrics.issuedFiscalCents).toBeGreaterThan(0)
        expect(baseline.pagination.total).toBe(2)
      } else {
        expect(baseline.issues).toEqual([])
        expect(baseline.summary.sourceCount).toBe(2)
      }
      const before = f.financialDigest()
      f.arm(change, 1)
      await expect(f.read(kind)).rejects.toMatchObject({ code: change.error })
      f.assertInjectedAtLastAuthorization(1)
      expect(f.financialDigest()).toBe(before)
    })

    it.each(changes)(
      `HTTP ${kind} rejects $name after its outer last authorization, releasing no DTO`,
      async (change) => {
        const f = await fixture()
        const baseline = await f.http(kind)
        expect(baseline?.status).toBe(200)
        const confirmed = await baseline!.json()
        expect(confirmed.population).toEqual({ environment: 'local', validationOnly: true })
        expect(confirmed.pagination).toMatchObject({ page: 2 })
        expect(kind === 'snapshot' ? confirmed.facts : confirmed.issues).toEqual([])
        const before = f.financialDigest()
        // The reader's last post-batch authorization is #1; the HTTP boundary
        // owns another real authorization await (#2) before releasing its body.
        f.arm(change, 2)
        const response = await f.http(kind)
        expect(response?.status).toBe(503)
        expect(await response!.json()).toEqual({ error: { code: change.error } })
        expect(response?.headers.get('cache-control')).toContain('no-store')
        expect(response?.headers.get('set-cookie')).toBeNull()
        f.assertInjectedAtLastAuthorization(2)
        expect(f.financialDigest()).toBe(before)
      }
    )
  }

  it.each(changes)('policy digest observes $name after the original crypto operation settles', async (change) => {
    const f = await fixture()
    const expected = await analyticsPolicyFingerprint(f.initialPolicy)
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    let settled = 0
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...parameters) => {
      const result = await digest(...parameters)
      change.apply(f.configuration, f.initialPolicy)
      settled++
      return result
    })
    await expect(analyticsAssertUnchanged(f.deps, expected)).rejects.toMatchObject({ code: change.error })
    expect(settled).toBe(1)
  })
})
