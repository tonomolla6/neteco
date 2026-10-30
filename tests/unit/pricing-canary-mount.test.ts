import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'

const PATHS: Array<[string, string]> = [
  ['GET', '/api/admin/pricing/auto-discounts'],
  ['GET', '/api/admin/pricing/free-shipping-rules'],
  ['POST', '/api/admin/pricing/store-credit/issue'],
  ['POST', '/api/admin/pricing/payment-schedules'],
  ['GET', '/api/account/store-credit'],
  ['GET', '/api/account/payment-schedules/q-1']
]
function env(authEnabled: 'true' | 'false', allowed = true) {
  const limiter = { limit: vi.fn(async () => ({ success: allowed })) }
  return {
    APP_ENV: 'canary',
    AUTH_ENABLED: authEnabled,
    AUTH_ORIGIN: 'https://shop.example',
    AUTH_RATE_LIMIT_PEPPER: 'p'.repeat(40),
    NUXT_SESSION_PASSWORD: 'x'.repeat(40),
    ADMIN_EDGE_LIMIT: limiter,
    CART_EDGE_LIMIT: limiter,
    AUTH_EDGE_LIMIT: limiter,
    DB: {
      prepare: vi.fn(() => {
        throw new Error('database must not be touched before authentication')
      })
    },
    CACHE: { get: vi.fn(), put: vi.fn() }
  } as unknown as CloudflareEnv
}
const req = (method: string, path: string, origin = 'https://shop.example') =>
  new Request(`https://shop.example${path}`, { method, headers: { origin, 'cf-connecting-ip': '203.0.113.9' } })

describe('pricing canary mounts (PRI-014/017/018/021)', () => {
  for (const [method, path] of PATHS) {
    it(`${method} ${path} fails closed when auth is disabled`, async () => {
      expect((await worker.fetch(req(method, path), env('false'))).status).toBe(503)
    })
    it(`${method} ${path} requires a session before touching the database`, async () => {
      expect((await worker.fetch(req(method, path), env('true'))).status).toBe(401)
    })
    it(`${method} ${path} is rate limited`, async () => {
      expect((await worker.fetch(req(method, path), env('true', false))).status).toBe(429)
    })
  }
  it('rejects foreign-origin mutations', async () => {
    const res = await worker.fetch(
      req('POST', '/api/admin/pricing/store-credit/issue', 'https://evil.example'),
      env('true')
    )
    expect(res.status).toBe(403)
  })
})
