/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed doubles in tests */
import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'

const ADMIN_PATHS = [
  '/api/admin/ugc-reviews',
  '/api/admin/ugc-reviews/rev-1/moderate',
  '/api/admin/case-studies',
  '/api/admin/case-studies/cs-1/publish',
  '/api/admin/case-studies/cs-1/periodic-review'
]

function makeEnv(authEnabled: 'true' | 'false', allowed = true) {
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

const req = (path: string) =>
  new Request(`https://shop.example${path}`, { headers: { 'cf-connecting-ip': '203.0.113.15' } })

describe('MED-018, MED-020 & MKT-031 Canary Mounts', () => {
  for (const path of ADMIN_PATHS) {
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

  it('public case studies endpoint is accessible through canary worker', async () => {
    const dbMock = {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ success: true })
      }))
    }
    const env = {
      ...makeEnv('true'),
      DB: dbMock
    } as unknown as CloudflareEnv

    const res = await worker.fetch(req('/api/case-studies'), env)
    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.cases).toEqual([])
  })
})
