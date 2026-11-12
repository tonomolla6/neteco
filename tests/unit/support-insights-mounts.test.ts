import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { testUuid } from '../support/deterministic'

// Mounting regression for SUP-012/014/015/017: the modules must be reachable through the Worker
// router and fail closed before touching the database.
const ADMIN_PATHS = [
  '/api/admin/support/assistant/handoffs',
  '/api/admin/support/assistant/stats?from=2026-10-01&to=2026-11-01',
  '/api/admin/support/contact-analysis?from=2026-10-01&to=2026-11-01',
  '/api/admin/support/contact-analysis/backlog',
  '/api/admin/support/education/candidates',
  '/api/admin/support/b2b-requests'
]
function env(overrides: Record<string, unknown> = {}) {
  const limiter = { limit: vi.fn(async () => ({ success: true })) }
  return {
    APP_ENV: 'canary',
    AUTH_ENABLED: 'true',
    SUPPORT_ENABLED: 'true',
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
    CACHE: { get: vi.fn(), put: vi.fn() },
    ...overrides
  } as unknown as CloudflareEnv
}
const request = (path: string, init: RequestInit = {}) =>
  new Request(`https://shop.example${path}`, {
    ...init,
    headers: { 'cf-connecting-ip': '203.0.113.9', ...(init.headers as object) }
  })

describe('support insight mounts', () => {
  for (const path of ADMIN_PATHS) {
    it(`${path} fails closed when auth is disabled`, async () => {
      const res = await worker.fetch(request(path), env({ AUTH_ENABLED: 'false' }))
      expect(res.status).toBe(503)
    })
    it(`${path} requires a session`, async () => {
      const res = await worker.fetch(request(path), env())
      expect(res.status).toBe(401)
      expect(res.headers.get('cache-control')).toContain('no-store')
    })
  }
  it('B2B portal requires a session and is closed when support is disabled', async () => {
    expect((await worker.fetch(request('/api/account/b2b-requests'), env())).status).toBe(401)
    expect((await worker.fetch(request('/api/account/b2b-requests'), env({ SUPPORT_ENABLED: 'false' }))).status).toBe(
      503
    )
    expect((await worker.fetch(request('/api/account/b2b-requests'), env({ AUTH_ENABLED: 'false' }))).status).toBe(503)
  })
  it('assistant is reachable and fails closed while CMS knowledge is disabled', async () => {
    const res = await worker.fetch(
      request('/api/support/assistant/ask', {
        method: 'POST',
        headers: {
          origin: 'https://shop.example',
          'content-type': 'application/json',
          'idempotency-key': testUuid()
        },
        body: JSON.stringify({ question: '¿Cuánto tarda el envío?' })
      }),
      env()
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: 'knowledge_unavailable' } })
  })
  it('assistant rejects cross-origin writes before any work', async () => {
    const res = await worker.fetch(
      request('/api/support/assistant/ask', {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: '{}'
      }),
      env()
    )
    expect(res.status).toBe(403)
  })
})
