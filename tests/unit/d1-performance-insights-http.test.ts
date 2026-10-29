import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NOW, claimsResolver, get, post, setupPerformanceInsightsDb, uuid } from './performance-insights-fixture'
import {
  handlePerformanceInsightsHttp,
  ownsPerformanceInsightsNamespace
} from '../../workers/performance/performance-http'
import { D1CatalogCacheRecorder } from '../../workers/performance/b2b-catalog-cache'
import type { InsightsHttpDependencies } from '../../workers/performance/http-common'

const BASE = 'https://shop.example/api/admin/performance'
let sqlite: DatabaseSync
let deps: InsightsHttpDependencies
beforeEach(async () => {
  const f = await setupPerformanceInsightsDb()
  sqlite = f.sqlite
  deps = {
    database: f.db,
    sessionCookieConfiguration: { password: 'x'.repeat(40), maxAgeSeconds: 3600 },
    origin: 'https://shop.example',
    now: () => NOW,
    claimsResolver
  }
})
afterEach(() => sqlite.close())
const call = (r: Request) => handlePerformanceInsightsHttp(r, deps) as Promise<Response>
const cmd = () => ({ commandId: uuid(), idempotencyKey: uuid() })
const arm = (visitors: number, conversions: number, revenueCents: number, lcpMsP75: number) => ({
  visitors,
  conversions,
  revenueCents,
  lcpMsP75
})

describe('namespace and access control', () => {
  it('owns the three namespaces only', () => {
    for (const p of ['third-parties', 'b2b-cache/stats', 'edge-personalization/rules', '%65dge-personalization/rules'])
      expect(ownsPerformanceInsightsNamespace(`/api/admin/performance/${p}`)).toBe(true)
    expect(ownsPerformanceInsightsNamespace('/api/admin/performance/other')).toBe(false)
    expect(ownsPerformanceInsightsNamespace('/api/admin/performance/third-partiesX')).toBe(false)
  })
  it('returns null elsewhere and blocks anonymous, unprivileged, MFA-less and cross-origin callers', async () => {
    expect(await handlePerformanceInsightsHttp(get('https://shop.example/api/x'), deps)).toBeNull()
    expect((await call(new Request(`${BASE}/third-parties`))).status).toBe(401)
    expect((await call(get(`${BASE}/third-parties`, 'noperms'))).status).toBe(403)
    expect((await call(get(`${BASE}/b2b-cache/stats`, 'nomfa'))).status).toBe(403)
    const res = await call(
      post(
        `${BASE}/edge-personalization/rules`,
        { ...cmd(), slot: 'home_hero', segment: 'b2b', variantKey: 'bulk' },
        'admin',
        { origin: 'https://evil.example' }
      )
    )
    expect(res.status).toBe(403)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })
  it('404/405 for unknown routes and methods', async () => {
    expect((await call(get(`${BASE}/third-parties/zzz`))).status).toBe(404)
    expect(
      (await call(new Request(`${BASE}/b2b-cache/stats`, { method: 'PUT', headers: { 'x-test-session': 'admin' } })))
        .status
    ).toBe(405)
    expect((await call(post(`${BASE}/third-parties/scripts`, '{bad'))).status).toBe(400)
  })
})

describe('third parties flow', () => {
  it('registers, evaluates, lists recommendation, removes and updates the manifest', async () => {
    const reg = (await (
      await call(
        post(`${BASE}/third-parties/scripts`, {
          ...cmd(),
          vendor: 'Meta',
          name: 'Pixel',
          kind: 'pixel',
          monthlyCostCents: 5000,
          loadMsP75: 200
        })
      )
    ).json()) as { script: { id: string; version: number } }
    const exp = await call(
      post(`${BASE}/third-parties/experiments`, {
        ...cmd(),
        scriptId: reg.script.id,
        periodDays: 14,
        marginBps: 3000,
        control: arm(10000, 200, 2e6, 2400),
        treatment: arm(10000, 200, 2e6, 2450)
      })
    )
    expect(
      ((await exp.json()) as { experiment: { evaluation: { verdict: string } } }).experiment.evaluation.verdict
    ).toBe('remove')
    const list = (await (await call(get(`${BASE}/third-parties`))).json()) as {
      scripts: Array<{ latestVerdict: string }>
    }
    expect(list.scripts[0]!.latestVerdict).toBe('remove')
    expect(
      ((await (await call(get(`${BASE}/third-parties/manifest`))).json()) as { scripts: unknown[] }).scripts
    ).toHaveLength(1)
    const removed = await call(
      post(`${BASE}/third-parties/remove`, {
        ...cmd(),
        scriptId: reg.script.id,
        expectedVersion: 1,
        reason: 'Sin retorno en el A/B'
      })
    )
    expect(removed.status).toBe(200)
    expect(
      ((await (await call(get(`${BASE}/third-parties/manifest`))).json()) as { scripts: unknown[] }).scripts
    ).toHaveLength(0)
    const stale = await call(
      post(`${BASE}/third-parties/remove`, {
        ...cmd(),
        scriptId: reg.script.id,
        expectedVersion: 1,
        reason: 'Sin retorno en el A/B'
      })
    )
    expect(stale.status).toBe(409)
  })
  it('maps duplicates to 409 and unknown scripts to 404', async () => {
    const body = { vendor: 'Meta', name: 'Pixel', kind: 'pixel', monthlyCostCents: 0, loadMsP75: 1 }
    await call(post(`${BASE}/third-parties/scripts`, { ...cmd(), ...body }))
    expect((await call(post(`${BASE}/third-parties/scripts`, { ...cmd(), ...body }))).status).toBe(409)
    expect(
      (
        await call(
          post(`${BASE}/third-parties/experiments`, {
            ...cmd(),
            scriptId: uuid(),
            periodDays: 7,
            marginBps: 1,
            control: arm(1, 0, 0, 0),
            treatment: arm(1, 0, 0, 0)
          })
        )
      ).status
    ).toBe(404)
  })
})

describe('b2b cache stats', () => {
  it('returns per-scope hit rates', async () => {
    const rec = new D1CatalogCacheRecorder(deps.database, () => NOW)
    await rec.record('b2b', 'hit')
    await rec.record('b2b', 'miss')
    const body = (await (await call(get(`${BASE}/b2b-cache/stats?days=3`))).json()) as {
      stats: { totals: Array<{ scope: string; hitRate: number | null }> }
    }
    expect(body.stats.totals.find((t) => t.scope === 'b2b')!.hitRate).toBe(0.5)
  })
  it('rejects a malformed days parameter', async () => {
    expect((await call(get(`${BASE}/b2b-cache/stats?days=abc`))).status).toBe(400)
    expect((await call(get(`${BASE}/b2b-cache/stats?days=0`))).status).toBe(400)
  })
})

describe('edge personalization flow', () => {
  const good = {
    controlVisitors: 5000,
    controlConversions: 100,
    treatmentVisitors: 5000,
    treatmentConversions: 150,
    lcpDeltaMs: 10,
    cacheHitRateBps: 9000,
    baselineCacheHitRateBps: 9100
  }
  it('creates, gates on evidence, enables, previews with fallback and disables', async () => {
    const created = (await (
      await call(
        post(`${BASE}/edge-personalization/rules`, {
          ...cmd(),
          slot: 'home_hero',
          segment: 'b2b',
          variantKey: 'bulk_offer'
        })
      )
    ).json()) as { rule: { id: string; version: number } }
    const id = created.rule.id
    const early = await call(
      post(`${BASE}/edge-personalization/rules/enable`, { ...cmd(), ruleId: id, expectedVersion: 1 })
    )
    expect(early.status).toBe(409)
    expect(((await early.json()) as { error: { code: string } }).error.code).toBe('evidence_required')
    expect(
      (await call(post(`${BASE}/edge-personalization/rules/evidence`, { ...cmd(), ruleId: id, ...good }))).status
    ).toBe(200)
    expect(
      (await call(post(`${BASE}/edge-personalization/rules/enable`, { ...cmd(), ruleId: id, expectedVersion: 1 })))
        .status
    ).toBe(200)
    const preview = async (over: Record<string, unknown> = {}) =>
      (
        (await (
          await call(
            post(`${BASE}/edge-personalization/preview`, {
              slot: 'home_hero',
              isB2b: true,
              returning: false,
              consent: true,
              ...over
            })
          )
        ).json()) as { resolution: { variant: string; reason: string } }
      ).resolution
    expect(await preview()).toMatchObject({ variant: 'bulk_offer', reason: 'rule_match' })
    expect(await preview({ consent: false })).toMatchObject({ variant: 'default', reason: 'no_consent' })
    expect(await preview({ killSwitch: true })).toMatchObject({ reason: 'kill_switch' })
    expect(
      (await call(post(`${BASE}/edge-personalization/rules/disable`, { ...cmd(), ruleId: id, expectedVersion: 2 })))
        .status
    ).toBe(200)
    expect(await preview()).toMatchObject({ reason: 'no_rule' })
    const rules = (await (await call(get(`${BASE}/edge-personalization/rules`))).json()) as {
      rules: Array<{ status: string }>
    }
    expect(rules.rules[0]!.status).toBe('disabled')
  })
  it('rejects PII-like or unknown preview fields', async () => {
    const res = await call(
      post(`${BASE}/edge-personalization/preview`, {
        slot: 'home_hero',
        isB2b: true,
        returning: false,
        consent: true,
        email: 'a@b.es'
      })
    )
    expect(res.status).toBe(400)
  })
})
