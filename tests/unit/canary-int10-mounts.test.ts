import { describe, expect, it } from 'vitest'
import canary from '../../workers/canary'

// INT-10: every admin route of the BB..BW batches must reach its own module (not be shadowed by an
// earlier router) and must be refused for a foreign Origin before any module runs.
const env = {
  AUTH_ENABLED: 'true',
  DB: {} as D1Database,
  AUTH_ORIGIN: 'https://shop.invalid',
  AUTH_RATE_LIMIT_PEPPER: 'a'.repeat(32),
  ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
  CART_EDGE_LIMIT: { limit: async () => ({ success: true }) },
  NUXT_SESSION_PASSWORD: 'p'.repeat(64)
} as unknown as CloudflareEnv

const MUTATIONS = [
  '/api/admin/cms/briefings',
  '/api/admin/commercial/next-actions',
  '/api/admin/warehouse/scan',
  '/api/admin/supplier-feed/stage',
  '/api/admin/catalog-editorial/upsert',
  '/api/admin/supplier-sourcing/supplier',
  '/api/admin/draft-orders/create',
  '/api/admin/release/alpha-beta-promotions/create',
  '/api/admin/release/progressive-rollouts/create',
  '/api/admin/release/cloudflare-policies/audit',
  '/api/admin/cms/campaign-pipeline/draft'
]
const READS = [
  '/api/admin/cms/briefings',
  '/api/admin/cms/editorial-calendar-briefings',
  '/api/admin/commercial/pipeline',
  '/api/admin/warehouse/queues',
  '/api/admin/supplier-feed/items?importId=x',
  '/api/admin/catalog-editorial/list',
  '/api/admin/supplier-sourcing/offerings?variantId=v',
  '/api/admin/draft-orders/list',
  '/api/admin/release/alpha-beta-promotions',
  '/api/admin/release/progressive-rollouts',
  '/api/admin/release/cloudflare-policies',
  '/api/admin/cms/campaign-pipeline'
]
const call = (path: string, init: RequestInit = {}) =>
  canary.fetch(
    new Request(`https://shop.invalid${path}`, {
      ...init,
      headers: { 'cf-connecting-ip': '203.0.113.9', 'content-type': 'application/json', ...init.headers }
    }),
    env
  )

describe('INT-10: montajes de los lotes BB-BW', () => {
  for (const path of READS) {
    it(`GET ${path} llega al módulo y exige sesión (401, nunca 404)`, async () => {
      const response = await call(path)
      expect(response.status).toBe(401)
    })
  }
  for (const path of MUTATIONS) {
    it(`POST ${path} con Origin ajeno se rechaza antes del módulo`, async () => {
      const response = await call(path, {
        method: 'POST',
        headers: { origin: 'https://evil.invalid' },
        body: '{}'
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: { code: 'csrf_rejected' } })
    })
  }
})
