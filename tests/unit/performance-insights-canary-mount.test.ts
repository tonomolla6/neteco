import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'

const PATHS = [
  '/api/admin/observability/aiops/recommendations',
  '/api/admin/performance/third-parties',
  '/api/admin/performance/b2b-cache/stats',
  '/api/admin/performance/edge-personalization/rules'
]

function env(authEnabled: 'true' | 'false') {
  const prepare = vi.fn(() => {
    throw new Error('database must not be touched before authentication')
  })
  return {
    APP_ENV: 'canary',
    AUTH_ENABLED: authEnabled,
    AUTH_ORIGIN: 'https://shop.example',
    NUXT_SESSION_PASSWORD: 'x'.repeat(40),
    DB: { prepare },
    CACHE: { get: vi.fn(), put: vi.fn() }
  } as unknown as CloudflareEnv
}
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext

describe('OBS-030 / PER-022 / PER-023 / PER-025 worker mounts', () => {
  for (const path of PATHS) {
    it(`${path} is unavailable when auth is disabled (fail closed)`, async () => {
      const res = await worker.fetch(new Request(`https://shop.example${path}`), env('false'), ctx)
      expect(res.status).toBe(503)
      expect(res.headers.get('cache-control')).toContain('no-store')
    })
    it(`${path} requires a session when auth is enabled`, async () => {
      const res = await worker.fetch(new Request(`https://shop.example${path}`), env('true'), ctx)
      expect(res.status).toBe(401)
    })
  }
  it('encoded aliases cannot bypass the mount', async () => {
    const res = await worker.fetch(
      new Request('https://shop.example/api/admin/performance/%74hird-parties'),
      env('true'),
      ctx
    )
    expect(res.status).toBe(401)
  })
})
