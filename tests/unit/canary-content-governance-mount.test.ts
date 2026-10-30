import { describe, expect, it } from 'vitest'
import canary from '../../workers/canary'

const env = {
  AUTH_ENABLED: 'true',
  DB: {} as D1Database,
  AUTH_ORIGIN: 'https://shop.invalid',
  AUTH_RATE_LIMIT_PEPPER: 'a'.repeat(32),
  ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
  NUXT_SESSION_PASSWORD: 'p'.repeat(64)
} as unknown as CloudflareEnv
const call = (path: string, init: RequestInit = {}) =>
  canary.fetch(
    new Request(`https://shop.invalid${path}`, {
      ...init,
      headers: { 'cf-connecting-ip': '203.0.113.9', ...(init.headers as Record<string, string> | undefined) }
    }),
    env
  )

describe('SEO-029/030/031 canary mount', () => {
  it('routes the admin namespace to its own handler (401 without session, not shadowed by another router)', async () => {
    const response = await call('/api/admin/content-governance')
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('unauthenticated')
  })
  it('rejects foreign-Origin mutations before reaching the module', async () => {
    const response = await call('/api/admin/content-governance', {
      method: 'POST',
      headers: { origin: 'https://evil.invalid', 'content-type': 'application/json', 'idempotency-key': 'k' },
      body: '{}'
    })
    expect(response.status).toBe(403)
  })
  it('routes the public namespaces to the governance handler (404 JSON from the module, never an HTML shadow)', async () => {
    const trust = await call('/api/content-trust/NO_VALIDO')
    expect(trust.status).toBe(404)
    expect((await trust.json()).error.code).toBe('not_found')
    expect((await call('/api/content-assets', { method: 'POST' })).status).toBe(405)
  })
})
