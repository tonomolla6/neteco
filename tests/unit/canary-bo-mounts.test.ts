import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { adminNavigationGroups, canNavigateAdmin, type AdminCapabilities } from '../../shared/admin-navigation'
import worker from '../../workers/canary'
import { AlternativeMarketPaymentProvider } from '../../workers/payments/alternative-contingency-provider'

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
    // SECFIX-3 (findings 4/5): anonymous callers must not read order data; previously 200 {}.
    expect(response.status).toBe(401)
    const json = await response.json()
    expect(json).toEqual({ error: { code: 'unauthenticated' } })
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
    // SECFIX-3 (findings 4/5): anonymous callers must not read order data; previously 200 {}.
    expect(response.status).toBe(401)
    const json = await response.json()
    expect(json).toEqual({ error: { code: 'unauthenticated' } })
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
    // SECFIX-3 (finding 8): without PAYMENT_CONTINGENCY_* configuration the webhook fails closed.
    // Previously 400 because a hardcoded, publicly known secret was used to verify signatures.
    expect(response.status).toBe(503)
  })

  it('verifies alternative webhook signatures with the provider configured from env secrets', async () => {
    const env = createEnv({
      PAYMENT_CONTINGENCY_ENABLED: 'true',
      PAYMENT_CONTINGENCY_SECRET_KEY: 'Zq3v9Kx2Lr8Tn4Wp6Ys1Ud7Hb5Jc0Mf2Ag9Ek3Qw',
      PAYMENT_CONTINGENCY_MERCHANT_ID: 'merchant-alt-01',
      PAYMENT_CONTINGENCY_ENDPOINT_URL: 'https://contingency.payments.example/pay'
    } as unknown as Partial<CloudflareEnv>)
    const payload: Record<string, string> = {
      provider_event_id: 'evt-canary-1',
      provider_reference: 'ref-canary-1',
      order_reference: '99999999-9999-4999-8999-999999999999',
      amount_cents: '100',
      currency: 'EUR',
      status: 'captured',
      response_code: '0000'
    }
    payload.signature = await new AlternativeMarketPaymentProvider({
      secretKey: 'Zq3v9Kx2Lr8Tn4Wp6Ys1Ud7Hb5Jc0Mf2Ag9Ek3Qw',
      merchantId: 'merchant-alt-01',
      endpointUrl: 'https://contingency.payments.example/pay'
    }).signPayload(payload)
    const post = (body: Record<string, string>) =>
      worker.fetch!(
        new Request('https://canary.neteco.invalid/api/payments/alternative/webhook', {
          method: 'POST',
          headers: { 'cf-connecting-ip': '192.0.2.1', 'content-type': 'application/json' },
          body: JSON.stringify(body)
        }),
        env
      )
    // Signed with the configured secret: signature accepted, unknown order reported.
    const accepted = await post(payload)
    expect(accepted.status).toBe(404)
    expect(await accepted.json()).toEqual({ error: { code: 'order_not_found' } })
    // Tampered signature is rejected.
    const forged = await post({ ...payload, signature: 'deadbeef'.repeat(8) })
    expect(forged.status).toBe(400)
    expect(await forged.json()).toEqual({ error: { code: 'invalid_signature' } })
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
