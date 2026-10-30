import { describe, expect, it } from 'vitest'
import canary from '../../workers/canary'

const env = {
  AUTH_ENABLED: 'true',
  DB: {} as D1Database,
  AUTH_ORIGIN: 'https://shop.invalid',
  AUTH_RATE_LIMIT_PEPPER: 'a'.repeat(32),
  ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
  AUTH_EDGE_LIMIT: { limit: async () => ({ success: true }) },
  CART_EDGE_LIMIT: { limit: async () => ({ success: true }) },
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

describe('SEO-033 / SEO-034 / SHP-029 canary mount', () => {
  it.each([
    '/api/admin/channel-feeds/google_merchant',
    '/api/admin/adr-limited-quantity/carrier-restrictions?carrier=seur',
    '/api/admin/seo-international/translation-reviews/p-1'
  ])('answers %s from its own handler with 401 JSON when there is no session', async (path) => {
    const response = await call(path)
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('unauthenticated')
  })

  it('rejects foreign-Origin mutations before they reach the module', async () => {
    const response = await call('/api/admin/adr-limited-quantity/specialist-validations', {
      method: 'POST',
      headers: { origin: 'https://evil.invalid', 'content-type': 'application/json', 'idempotency-key': 'k' },
      body: '{}'
    })
    expect(response.status).toBe(403)
  })

  it('serves public routes as JSON from the module, never an HTML shadow', async () => {
    const hazard = await call('/api/storefront/adr/hazard-info')
    expect(hazard.status).toBe(400)
    expect((await hazard.json()).error.code).toBe('invalid_input')
    expect((await call('/api/feeds/channels/amazon.json')).status).toBe(404)
    expect((await call('/api/shipping/adr/evaluate')).status).toBe(405)
    expect((await call('/api/storefront/seo/hreflang')).status).toBe(400)
  })
})
