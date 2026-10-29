import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'

// CUS-015/016/019/028 must be reachable through the Worker router and fail closed.
const PATHS = [
  '/api/account/preference-center',
  '/api/account/replenishment',
  '/api/account/company/documents',
  '/api/admin/companies/30000000-0000-4000-8000-000000000001/documents',
  '/api/admin/support-impersonation/current'
]
function env(authEnabled: 'true' | 'false', allowed = true) {
  const prepare = vi.fn(() => {
    throw new Error('database must not be touched before authentication')
  })
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
    DB: { prepare },
    CACHE: { get: vi.fn(), put: vi.fn() }
  } as unknown as CloudflareEnv
}
const request = (path: string) =>
  new Request(`https://shop.example${path}`, { headers: { 'cf-connecting-ip': '203.0.113.9' } })

describe('account lifecycle canary mounts', () => {
  for (const path of PATHS) {
    it(`${path} fails closed when auth is disabled`, async () => {
      const res = await worker.fetch(request(path), env('false'))
      expect(res.status).toBe(503)
      expect(res.headers.get('cache-control')).toContain('no-store')
    })
    it(`${path} requires a session and never touches the database anonymously`, async () => {
      const res = await worker.fetch(request(path), env('true'))
      expect(res.status).toBe(401)
    })
    it(`${path} is rate limited at the edge`, async () => {
      expect((await worker.fetch(request(path), env('true', false))).status).toBe(429)
    })
  }
})
