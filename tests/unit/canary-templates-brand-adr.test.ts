import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import worker from '../../workers/canary'

describe('Canary routing for MED-019, MED-021, and MED-022', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    const migration = await readFile(
      new URL('../../db/d1/migrations/0141_templates_brand_warehouse_adr.sql', import.meta.url),
      'utf8'
    )
    sqlite.exec(migration)
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  function createEnv(): CloudflareEnv {
    return {
      APP_ENV: 'canary',
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: 'https://canary.neteco.invalid',
      NUXT_SESSION_PASSWORD: 'synthetic-canary-fulfillment-cookie-at-least-32-characters',
      AUTH_RATE_LIMIT_PEPPER: 'canary-pepper-1234567890',
      DB: db,
      CACHE: { get: vi.fn(), put: vi.fn() },
      MEDIA: { get: vi.fn(), put: vi.fn() },
      ASYNC_JOBS: { send: vi.fn() },
      CATALOG_WORKFLOW: { create: vi.fn(), get: vi.fn() },
      COORDINATOR: { idFromName: vi.fn(), get: vi.fn() },
      INVENTORY: { idFromName: vi.fn(), get: vi.fn() },
      CARTS: { idFromName: vi.fn(), get: vi.fn() },
      CART_EDGE_LIMIT: { limit: vi.fn().mockResolvedValue({ success: true }) },
      ADMIN_EDGE_LIMIT: { limit: vi.fn().mockResolvedValue({ success: true }) }
    } as unknown as CloudflareEnv
  }

  it('dispatches storefront GET /api/templates through worker.fetch', async () => {
    const env = createEnv()
    const request = new Request('https://canary.neteco.invalid/api/templates', {
      headers: { 'cf-connecting-ip': '192.0.2.1' }
    })
    const response = await worker.fetch!(request, env)
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json.source).toBe('cloudflare')
    expect(json.canonicalPath).toBe('/plantillas')
    expect(json.items).toEqual([])
  })

  it('dispatches storefront GET /api/brand-center through worker.fetch', async () => {
    const env = createEnv()
    const request = new Request('https://canary.neteco.invalid/api/brand-center', {
      headers: { 'cf-connecting-ip': '192.0.2.1' }
    })
    const response = await worker.fetch!(request, env)
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json.source).toBe('cloudflare')
    expect(json.usageGuidelines.generalRules.length).toBeGreaterThan(0)
  })

  it('dispatches GET /api/warehouse/operational-assets/variant/:id to handler (returning 404 for unknown)', async () => {
    const env = createEnv()
    const request = new Request('https://canary.neteco.invalid/api/warehouse/operational-assets/variant/var-unknown', {
      headers: { 'cf-connecting-ip': '192.0.2.1' }
    })
    const response = await worker.fetch!(request, env)
    expect(response.status).toBe(404)
    const json = await response.json()
    expect(json.error?.code).toBe('not_found')
  })
})
