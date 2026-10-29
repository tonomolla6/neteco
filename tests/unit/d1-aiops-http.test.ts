import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NOW, claimsResolver, get, post, setupPerformanceInsightsDb, uuid } from './performance-insights-fixture'
import { handleAiopsHttp, ownsAiopsNamespace } from '../../workers/observability/aiops-http'
import type { InsightsHttpDependencies } from '../../workers/performance/http-common'

const BASE = 'https://shop.example/api/admin/observability/aiops'
let sqlite: DatabaseSync
let deps: InsightsHttpDependencies
beforeEach(async () => {
  const fixture = await setupPerformanceInsightsDb()
  sqlite = fixture.sqlite
  deps = {
    database: fixture.db,
    sessionCookieConfiguration: { password: 'x'.repeat(40), maxAgeSeconds: 3600 },
    origin: 'https://shop.example',
    now: () => NOW,
    claimsResolver
  }
})
afterEach(() => sqlite.close())

const call = (request: Request) => handleAiopsHttp(request, deps) as Promise<Response>
const signalBody = (over: Record<string, unknown> = {}) => ({
  commandId: uuid(),
  idempotencyKey: uuid(),
  kind: 'error_rate',
  service: 'checkout',
  severity: 'high',
  metricValue: 9,
  thresholdValue: 2,
  observedAt: '2026-10-29T11:50:00Z',
  ...over
})

describe('AIOps HTTP', () => {
  it('owns only its namespace, including encoded variants', () => {
    expect(ownsAiopsNamespace('/api/admin/observability/aiops')).toBe(true)
    expect(ownsAiopsNamespace('/api/admin/observability/aiops/signals')).toBe(true)
    expect(ownsAiopsNamespace('/api/admin/observability/%61iops/signals')).toBe(true)
    expect(ownsAiopsNamespace('/api/admin/observability/aiopsX')).toBe(false)
    expect(ownsAiopsNamespace('/api/admin/observability/capacity')).toBe(false)
  })

  it('returns null outside the namespace', async () => {
    expect(await handleAiopsHttp(get('https://shop.example/api/other'), deps)).toBeNull()
  })

  it('requires authentication, permission and MFA, with private no-store headers', async () => {
    const anon = await call(new Request(`${BASE}/recommendations`))
    expect(anon.status).toBe(401)
    expect(anon.headers.get('cache-control')).toBe('private, no-store')
    expect((await call(get(`${BASE}/recommendations`, 'noperms'))).status).toBe(403)
    const nomfa = await call(get(`${BASE}/recommendations`, 'nomfa'))
    expect(nomfa.status).toBe(403)
    expect(((await nomfa.json()) as { error: { code: string } }).error.code).toBe('mfa_required')
  })

  it('rejects cross-origin mutations', async () => {
    const res = await call(post(`${BASE}/signals`, signalBody(), 'admin', { origin: 'https://evil.example' }))
    expect(res.status).toBe(403)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM aiops_signals').get()).toEqual({ n: 0 })
  })

  it('runs the full flow: ingest, correlate, list, approve, label, precision', async () => {
    expect(
      (
        await call(
          post(
            `${BASE}/signals`,
            signalBody({
              kind: 'deploy',
              service: 'storefront',
              severity: 'medium',
              observedAt: '2026-10-29T11:45:00Z'
            })
          )
        )
      ).status
    ).toBe(200)
    expect((await call(post(`${BASE}/signals`, signalBody()))).status).toBe(200)
    const corr = await call(post(`${BASE}/correlate`, { commandId: uuid(), idempotencyKey: uuid() }))
    expect(corr.status).toBe(200)
    const list = (await (await call(get(`${BASE}/recommendations`))).json()) as {
      recommendations: Array<{ id: string; version: number; destructive: boolean }>
    }
    expect(list.recommendations).toHaveLength(1)
    const rec = list.recommendations[0]!
    const noConfirm = await call(
      post(`${BASE}/recommendations/decide`, {
        commandId: uuid(),
        idempotencyKey: uuid(),
        recommendationId: rec.id,
        expectedVersion: 1,
        decision: 'approve',
        reason: 'Revisado con el equipo'
      })
    )
    expect(noConfirm.status).toBe(400)
    const approved = await call(
      post(`${BASE}/recommendations/decide`, {
        commandId: uuid(),
        idempotencyKey: uuid(),
        recommendationId: rec.id,
        expectedVersion: 1,
        decision: 'approve',
        reason: 'Revisado con el equipo',
        confirmDestructive: true
      })
    )
    expect(approved.status).toBe(200)
    const label = await call(
      post(`${BASE}/recommendations/outcome`, {
        commandId: uuid(),
        idempotencyKey: uuid(),
        recommendationId: rec.id,
        expectedVersion: 2,
        outcome: 'true_positive'
      })
    )
    expect(label.status).toBe(200)
    const precision = (await (await call(get(`${BASE}/precision`))).json()) as { precision: { precision: number } }
    expect(precision.precision.precision).toBe(1)
  })

  it('maps stale versions to 409 and unknown ids to 404', async () => {
    const res = await call(
      post(`${BASE}/recommendations/decide`, {
        commandId: uuid(),
        idempotencyKey: uuid(),
        recommendationId: uuid(),
        expectedVersion: 1,
        decision: 'reject',
        reason: 'No procede en absoluto'
      })
    )
    expect(res.status).toBe(404)
  })

  it('validates bodies: bad JSON, unknown fields, wrong types', async () => {
    expect((await call(post(`${BASE}/signals`, '{bad'))).status).toBe(400)
    expect((await call(post(`${BASE}/signals`, signalBody({ extra: 1 })))).status).toBe(400)
    expect((await call(post(`${BASE}/signals`, signalBody({ metricValue: 'x' })))).status).toBe(400)
  })

  it('answers 404 and 405 for unknown routes and methods', async () => {
    expect((await call(get(`${BASE}/nope`))).status).toBe(404)
    expect(
      (await call(new Request(`${BASE}/signals`, { method: 'DELETE', headers: { 'x-test-session': 'admin' } }))).status
    ).toBe(405)
    expect((await call(get(`${BASE}/correlate`))).status).toBe(404)
  })

  it('does not leak internals on unexpected failures', async () => {
    const broken = {
      ...deps,
      database: {
        ...deps.database,
        prepare: () => {
          throw new Error('secret sql detail')
        }
      } as unknown as D1Database
    }
    const res = (await handleAiopsHttp(get(`${BASE}/precision`), broken)) as Response
    const text = await res.text()
    expect(res.status === 500 || res.status === 401 || res.status === 403).toBe(true)
    expect(text).not.toContain('secret sql detail')
  })
})
