import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'

const BM_ADMIN_PATHS = ['/api/admin/seasonal-campaigns', '/api/admin/seasonal-campaigns/calendar']

function makeEnv(authEnabled: 'true' | 'false', allowed = true) {
  const prepare = vi.fn(() => {
    throw new Error('database must not be touched before authentication')
  })
  const limiter = { limit: vi.fn(async () => ({ success: allowed })) }
  return {
    APP_ENV: 'canary',
    AUTH_ENABLED: authEnabled,
    AUTH_ORIGIN: 'https://shop.neteco.invalid',
    AUTH_RATE_LIMIT_PEPPER: 'p'.repeat(40),
    NUXT_SESSION_PASSWORD: 'x'.repeat(40),
    ADMIN_EDGE_LIMIT: limiter,
    CART_EDGE_LIMIT: limiter,
    AUTH_EDGE_LIMIT: limiter,
    DB: { prepare },
    CACHE: { get: vi.fn(), put: vi.fn() }
  } as unknown as CloudflareEnv
}

const req = (path: string) =>
  new Request(`https://shop.neteco.invalid${path}`, { headers: { 'cf-connecting-ip': '203.0.113.15' } })

describe('BM Canary Mounts: MKT-032 Seasonal Sector Campaigns', () => {
  for (const path of BM_ADMIN_PATHS) {
    it(`${path} fails closed with 503 when auth is disabled`, async () => {
      const res = await worker.fetch(req(path), makeEnv('false'))
      expect(res.status).toBe(503)
      expect(res.headers.get('cache-control')).toContain('no-store')
    })

    it(`${path} is edge rate limited when limiter returns false`, async () => {
      const res = await worker.fetch(req(path), makeEnv('true', false))
      expect(res.status).toBe(429)
    })
  }
})
