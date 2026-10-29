import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'

// Regression for the workers/canary.ts revert incident: every HTTP module that
// ships in the repository must be reachable through the Worker router, fail
// closed when AUTH is disabled and be rate limited at the edge.
const ADMIN_PATHS = [
  '/api/admin/support/copilot/sessions',
  '/api/admin/support/rca/cases',
  '/api/admin/audiences',
  '/api/admin/experiments',
  '/api/admin/growth/offers',
  '/api/admin/inventory/lots',
  '/api/admin/companies/c1/shipping-conditions',
  '/api/admin/delivery-routes',
  '/api/admin/b2b',
  '/api/admin/b2b/transfers',
  '/api/admin/b2b-public/metrics',
  '/api/admin/market-catalog/products/p1',
  '/api/admin/international-shipping/ES',
  '/api/admin/catalog-lots/expedition/locate-stock/l1',
  '/api/admin/product-recalls/p1',
  '/api/admin/customers/c1/high-value-consent/sms',
  '/api/admin/scoring/rules',
  '/api/admin/edi/partners',
  '/api/admin/security-controls/api-keys',
  '/api/admin/seo/crawls',
  '/api/admin/observability/capacity/plans',
  '/api/admin/observability/error-budget/status',
  '/api/admin/observability/b2b-slo/contracts',
  '/api/admin/reviews',
  '/api/admin/questions',
  '/api/admin/media/guides',
  '/api/admin/bundles',
  '/api/admin/events',
  '/api/admin/marketing-automations',
  '/api/admin/product-recalls/%70'
]
const ACCOUNT_PATHS = [
  '/api/account/b2b',
  '/api/account/recurring-lists',
  '/api/account/payment-tokens',
  '/api/account/company/shipping-conditions',
  '/api/account/referrals',
  '/api/account/marketing-preferences'
]

function env(authEnabled: 'true' | 'false') {
  const prepare = vi.fn(() => {
    throw new Error('database must not be touched before authentication')
  })
  const limiter = { limit: vi.fn(async () => ({ success: true })) }
  return {
    APP_ENV: 'canary',
    AUTH_ENABLED: authEnabled,
    B2B_PUBLIC_API_ENABLED: authEnabled,
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
const request = (path: string) =>
  new Request(`https://shop.example${path}`, { headers: { 'cf-connecting-ip': '203.0.113.9' } })

describe('restored canary mounts', () => {
  for (const path of [...ADMIN_PATHS, ...ACCOUNT_PATHS]) {
    it(`${path} fails closed when auth is disabled`, async () => {
      const res = await worker.fetch(request(path), env('false'))
      expect(res.status).toBe(503)
      expect(res.headers.get('cache-control')).toContain('no-store')
    })
    it(`${path} requires a session when auth is enabled`, async () => {
      const res = await worker.fetch(request(path), env('true'))
      expect(res.status).toBe(401)
      expect(res.headers.get('cache-control')).toContain('no-store')
    })
  }
  it('rate limits restored admin mounts at the edge', async () => {
    const limited = env('true')
    ;(limited.ADMIN_EDGE_LIMIT.limit as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false })
    for (const path of ['/api/admin/audiences', '/api/admin/seo/crawls', '/api/admin/support/rca/cases']) {
      expect((await worker.fetch(request(path), limited)).status).toBe(429)
    }
  })
  it('serves the public B2B OpenAPI contract and keeps /ping with the security module', async () => {
    const openapi = await worker.fetch(request('/api/b2b/v1/openapi.json'), env('true'))
    expect(openapi.status).toBe(200)
    expect(openapi.headers.get('cache-control')).toContain('no-store')
    const ping = await worker.fetch(request('/api/b2b/v1/ping'), env('true'))
    expect(ping.status).not.toBe(404)
  })
})
