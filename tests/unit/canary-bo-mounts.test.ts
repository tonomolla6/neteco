import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { adminNavigationGroups, canNavigateAdmin, type AdminCapabilities } from '../../shared/admin-navigation'
import worker from '../../workers/canary'

describe('Canary routing for ORD-020, ORD-021, and PAY-023 (Encargo BO)', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    const migration = await readFile(
      new URL('../../db/d1/migrations/0145_orders_procurement_split_contingency.sql', import.meta.url),
      'utf8'
    )
    sqlite.exec(migration)
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  function createEnv(overrides: Partial<CloudflareEnv> = {}): CloudflareEnv {
    return {
      APP_ENV: 'canary',
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: 'https://canary.neteco.invalid',
      NUXT_SESSION_PASSWORD: 'synthetic-canary-fulfillment-cookie-at-least-32-characters',
      AUTH_RATE_LIMIT_PEPPER: 'p'.repeat(40),
      DB: db,
      CACHE: { get: vi.fn(), put: vi.fn() },
      MEDIA: { get: vi.fn(), put: vi.fn() },
      ASYNC_JOBS: { send: vi.fn() },
      CATALOG_WORKFLOW: { create: vi.fn(), get: vi.fn() },
      COORDINATOR: { idFromName: vi.fn(), get: vi.fn() },
      INVENTORY: { idFromName: vi.fn(), get: vi.fn() },
      CARTS: { idFromName: vi.fn(), get: vi.fn() },
      CART_EDGE_LIMIT: { limit: vi.fn().mockResolvedValue({ success: true }) },
      ADMIN_EDGE_LIMIT: { limit: vi.fn().mockResolvedValue({ success: true }) },
      ...overrides
    } as unknown as CloudflareEnv
  }

  it('routes /api/orders/procurement/invoice-view through worker.fetch', async () => {
    const env = createEnv()
    const request = new Request(
      'https://canary.neteco.invalid/api/orders/procurement/invoice-view?orderId=11111111-1111-4111-8111-111111111111',
      {
        headers: { 'cf-connecting-ip': '192.0.2.1' }
      }
    )
    const response = await worker.fetch!(request, env)
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json).toEqual({})
  })

  it('routes /api/orders/split-preferences through worker.fetch', async () => {
    const env = createEnv()
    const request = new Request(
      'https://canary.neteco.invalid/api/orders/split-preferences?orderId=11111111-1111-4111-8111-111111111111',
      {
        headers: { 'cf-connecting-ip': '192.0.2.1' }
      }
    )
    const response = await worker.fetch!(request, env)
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json).toEqual({})
  })

  it('routes /api/payments/alternative/webhook through worker.fetch', async () => {
    const env = createEnv()
    const request = new Request('https://canary.neteco.invalid/api/payments/alternative/webhook', {
      method: 'POST',
      headers: {
        'cf-connecting-ip': '192.0.2.1',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ invalid: 'payload' })
    })
    const response = await worker.fetch!(request, env)
    expect(response.status).toBe(400) // Rejects invalid signature as expected from isolated provider
  })

  it('enforces 503 when AUTH_ENABLED is false and 401 when unauthenticated on admin BO mounts', async () => {
    const disabledEnv = createEnv({ AUTH_ENABLED: 'false' })
    const disabledRes = await worker.fetch!(
      new Request(
        'https://canary.neteco.invalid/api/admin/orders/procurement?orderId=11111111-1111-4111-8111-111111111111',
        { headers: { 'cf-connecting-ip': '192.0.2.1' } }
      ),
      disabledEnv
    )
    expect(disabledRes.status).toBe(503)

    const env = createEnv()
    const unauthRes = await worker.fetch!(
      new Request(
        'https://canary.neteco.invalid/api/admin/orders/procurement?orderId=11111111-1111-4111-8111-111111111111',
        { headers: { 'cf-connecting-ip': '192.0.2.1' } }
      ),
      env
    )
    expect(unauthRes.status).toBe(401)
  })

  it('registers /admin/operaciones-pedidos in shared admin navigation and splits 0145 migration cleanly', async () => {
    const capabilities: AdminCapabilities = {
      source: 'cloudflare',
      identityId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      sessionVersion: 1,
      state: 'ready',
      permissions: ['administration.manage']
    }
    const links = adminNavigationGroups(capabilities).flatMap((group) => group.links)
    const link = links.find((entry) => entry.to === '/admin/operaciones-pedidos')
    expect(link).toEqual({
      to: '/admin/operaciones-pedidos',
      label: 'Compras B2B y Contingencia',
      icon: 'i-lucide-boxes',
      permission: 'administration.manage'
    })
    expect(canNavigateAdmin('/admin/operaciones-pedidos', capabilities)).toBe(true)

    const migrationSql = await readFile(
      new URL('../../db/d1/migrations/0145_orders_procurement_split_contingency.sql', import.meta.url),
      'utf8'
    )
    const statements = splitDemoSql(migrationSql)
    expect(statements.length).toBeGreaterThanOrEqual(8)
  })
})
