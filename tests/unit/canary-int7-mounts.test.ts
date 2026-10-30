import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'

// INT-7: every admin API shipped by batches AE, AF, AH, AI, AJ, AK, AM, AN and AO must be
// reachable through the Worker router, fail closed with AUTH disabled, require a live
// session before touching D1, and stay private/no-store. Encoded aliases must not bypass it.
const ADMIN_PATHS = [
  '/api/admin/ai/assistant/interactions',
  '/api/admin/catalog/ai-generate/generations',
  '/api/admin/media/ai-enrich/enrichments',
  '/api/admin/market-catalog/products/p1',
  '/api/admin/international-shipping/ES',
  '/api/admin/catalog-lots/expedition/locate-stock/l1',
  '/api/admin/operations/alerts',
  '/api/admin/marketing/send-time',
  '/api/admin/observability/telemetry/devices',
  '/api/admin/seo/dashboard',
  '/api/admin/b2b/metrics',
  '/api/admin/analytics/cost-to-serve',
  '/api/admin/learning/courses',
  '/api/admin/marketing/targeted-campaigns',
  '/api/admin/b2b/recurring-incentives/agreements',
  '/api/admin/marketing/predictive-campaigns/rules',
  '/api/admin/ai/models',
  '/api/admin/ai/evaluations',
  '/api/admin/observability/aiops/recommendations',
  '/api/admin/performance/third-parties',
  '/api/admin/delivery-app/report',
  '/api/admin/carrier-manifests',
  '/api/admin/packing-optimizer/boxes',
  '/api/admin/ai%2Fassistant/interactions',
  '/api/admin/%2561i/assistant/interactions'
]
// Customer/driver endpoints authenticate themselves: never a 5xx, never D1 before a verified session.
const SESSION_PATHS = [
  '/api/customer/personalization/preferences',
  '/api/customer/targeted-campaigns',
  '/api/b2b/recurring-incentives/my-overview',
  '/api/delivery/manifest'
]

function env(authEnabled: 'true' | 'false') {
  const prepare = vi.fn(() => {
    throw new Error('database must not be touched before authentication')
  })
  const limiter = { limit: vi.fn(async () => ({ success: true })) }
  return {
    APP_ENV: 'canary',
    AUTH_ENABLED: authEnabled,
    AUTH_ORIGIN: 'https://shop.example',
    AUTH_RATE_LIMIT_PEPPER: 'p'.repeat(40),
    NUXT_SESSION_PASSWORD: 'x'.repeat(40),
    ADMIN_EDGE_LIMIT: limiter,
    CART_EDGE_LIMIT: limiter,
    AUTH_EDGE_LIMIT: limiter,
    DB: { prepare },
    CACHE: { get: vi.fn(), put: vi.fn() }
  } as unknown as CloudflareEnv
}
const get = (path: string) =>
  new Request(`https://shop.example${path}`, { headers: { 'cf-connecting-ip': '203.0.113.9' } })
const post = (path: string) =>
  new Request(`https://shop.example${path}`, {
    method: 'POST',
    headers: {
      'cf-connecting-ip': '203.0.113.9',
      origin: 'https://shop.example',
      'content-type': 'application/json'
    },
    body: '{}'
  })

describe('INT-7 canary mounts', () => {
  for (const path of SESSION_PATHS) {
    it(`${path} answers 401 without a session and never reaches D1`, async () => {
      for (const authEnabled of ['true', 'false'] as const) {
        const res = await worker.fetch(get(path), env(authEnabled))
        expect([401, 503]).toContain(res.status)
        expect(res.headers.get('cache-control')).toContain('no-store')
      }
    })
  }
  it('UGC moderation queue is private and fails closed', async () => {
    expect((await worker.fetch(get('/api/admin/ugc-reviews'), env('false'))).status).toBe(503)
    expect((await worker.fetch(get('/api/admin/ugc-reviews'), env('true'))).status).toBe(401)
    expect((await worker.fetch(post('/api/admin/ugc-reviews/r1/moderate'), env('true'))).status).toBe(401)
  })
  it('cost-to-serve and personalization events are not shadowed by the generic analytics namespace', async () => {
    for (const make of [get, post]) {
      const res = await worker.fetch(make('/api/admin/analytics/cost-to-serve'), env('true'))
      expect(res.status).toBe(401)
    }
    // Anonymous visitors must not be able to feed the incrementality measurements.
    const res = await worker.fetch(post('/api/analytics/personalization/events'), env('true'))
    expect(res.status).toBe(401)
  })
  for (const path of ADMIN_PATHS) {
    it(`${path} fails closed when auth is disabled`, async () => {
      const res = await worker.fetch(get(path), env('false'))
      expect(res.status).toBe(503)
      expect(res.headers.get('cache-control')).toContain('no-store')
    })
    it(`${path} requires a session before D1 (GET and POST)`, async () => {
      for (const make of [get, post]) {
        const res = await worker.fetch(make(path), env('true'))
        expect(res.status).toBe(401)
        expect(res.headers.get('cache-control')).toContain('no-store')
      }
    })
  }

  // Defence in depth on top of SameSite=Lax: a mutating request from another origin is refused
  // at the mount, before any module (some of them do not check Origin themselves).
  const MUTATING = [
    '/api/admin/ai/assistant/propose',
    '/api/admin/catalog/ai-generate/propose',
    '/api/admin/media/ai-enrich/propose',
    '/api/admin/learning/courses',
    '/api/admin/marketing/targeted-campaigns',
    '/api/admin/b2b/recurring-incentives/agreements',
    '/api/admin/ai/models',
    '/api/admin/marketing/predictive-campaigns/rules',
    '/api/customer/personalization/preferences',
    '/api/admin/ugc-reviews/r1/moderate'
  ]
  for (const path of MUTATING) {
    it(`${path} rejects cross-origin mutations`, async () => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await worker.fetch(
          new Request(`https://shop.example${path}`, {
            method,
            headers: { 'cf-connecting-ip': '203.0.113.9', origin: 'https://evil.example' },
            body: '{}'
          }),
          env('true')
        )
        expect(res.status).toBe(403)
      }
    })
  }
})
