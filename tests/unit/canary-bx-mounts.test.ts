import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'
import worker from '../../workers/canary'
import { ownsPromotionsAutomationMatrixNamespace } from '../../workers/marketing/promotions-automation-matrix-http'
import { ownsAccountIsolationNamespace } from '../../workers/security/account-isolation-http'
import { ownsWarehouseRouteOfflineNamespace } from '../../workers/fulfillment/warehouse-route-offline-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'

const ACTOR = '10000000-0000-4000-8000-000000000043'
const SESSION = '20000000-0000-4000-8000-000000000043'
const CLAIMS = { identityId: ACTOR, sessionId: SESSION, sessionVersion: 1 }

describe('Canary routing for BX: TST-041, TST-042, and TST-043', () => {
  let sqlite: DatabaseSync
  let db: D1Database
  let adminCookie: string

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    db = d1OverSqlite(sqlite)
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    const expires = new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    sqlite.exec(`
      INSERT OR IGNORE INTO roles VALUES('operator','Operator','Synthetic');
      INSERT OR IGNORE INTO permissions VALUES('administration.manage','administration','manage','Synthetic');
      INSERT OR IGNORE INTO role_permissions VALUES('operator','administration.manage');
      INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
        VALUES('${ACTOR}','operator@example.invalid','synthetic','${now}','active','${now}','${now}');
      INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
        VALUES('${SESSION}','${ACTOR}',1,1,'${now}','${expires}');
      INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES('${ACTOR}','operator','${now}');
    `)

    const issued = await issueD1SessionCookie(db, CLAIMS, {
      password: 'synthetic-canary-fulfillment-cookie-at-least-32-characters',
      maxAgeSeconds: 3600
    })
    adminCookie = issued!.split(';')[0]!
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

  it('identifies namespace ownership correctly for all three BX endpoints', () => {
    expect(ownsPromotionsAutomationMatrixNamespace('/api/admin/qa/promotions-matrix')).toBe(true)
    expect(ownsPromotionsAutomationMatrixNamespace('/api/admin/qa/promotions-matrix/run')).toBe(true)
    expect(ownsPromotionsAutomationMatrixNamespace('/api/admin/other')).toBe(false)

    expect(ownsAccountIsolationNamespace('/api/admin/qa/account-isolation')).toBe(true)
    expect(ownsAccountIsolationNamespace('/api/admin/qa/account-isolation/verify')).toBe(true)
    expect(ownsAccountIsolationNamespace('/api/admin/other')).toBe(false)

    expect(ownsWarehouseRouteOfflineNamespace('/api/admin/qa/warehouse-offline')).toBe(true)
    expect(ownsWarehouseRouteOfflineNamespace('/api/admin/qa/warehouse-offline/verify')).toBe(true)
    expect(ownsWarehouseRouteOfflineNamespace('/api/admin/other')).toBe(false)
  })

  it('responds with 503 authUnavailable when AUTH_ENABLED is false', async () => {
    const env = createEnv({ AUTH_ENABLED: 'false' })
    const res = await worker.fetch!(
      new Request('https://canary.neteco.invalid/api/admin/qa/promotions-matrix', {
        headers: { 'cf-connecting-ip': '192.0.2.1' }
      }),
      env
    )
    expect(res.status).toBe(503)
  })

  it('responds with 401 unauthenticated when missing session cookie', async () => {
    const env = createEnv()
    const res = await worker.fetch!(
      new Request('https://canary.neteco.invalid/api/admin/qa/promotions-matrix', {
        headers: { 'cf-connecting-ip': '192.0.2.1' }
      }),
      env
    )
    expect(res.status).toBe(401)
  })

  it('TST-041: dispatches GET /api/admin/qa/promotions-matrix through worker.fetch with admin session', async () => {
    const env = createEnv()
    const request = new Request('https://canary.neteco.invalid/api/admin/qa/promotions-matrix', {
      headers: {
        'cf-connecting-ip': '192.0.2.1',
        cookie: adminCookie
      }
    })
    const response = await worker.fetch!(request, env)
    expect(response.status).toBe(200)
    const json = (await response.json()) as {
      success: boolean
      summary: { passedCases: number; coverage: { combinations: string } }
    }
    expect(json.success).toBe(true)
    expect(json.summary.passedCases).toBeGreaterThanOrEqual(18)
    expect(json.summary.coverage.combinations).toBe('100%')
  })

  it('TST-042: dispatches GET /api/admin/qa/account-isolation through worker.fetch with admin session', async () => {
    const env = createEnv()
    const request = new Request('https://canary.neteco.invalid/api/admin/qa/account-isolation', {
      headers: {
        'cf-connecting-ip': '192.0.2.1',
        cookie: adminCookie
      }
    })
    const response = await worker.fetch!(request, env)
    expect(response.status).toBe(200)
    const json = (await response.json()) as {
      success: boolean
      status: { singleSiteConfirmed: boolean; pricingIsolationEnforced: boolean }
    }
    expect(json.success).toBe(true)
    expect(json.status.singleSiteConfirmed).toBe(true)
    expect(json.status.pricingIsolationEnforced).toBe(true)
  })

  it('TST-043: dispatches GET /api/admin/qa/warehouse-offline through worker.fetch with admin session', async () => {
    const env = createEnv()
    const request = new Request('https://canary.neteco.invalid/api/admin/qa/warehouse-offline', {
      headers: {
        'cf-connecting-ip': '192.0.2.1',
        cookie: adminCookie
      }
    })
    const response = await worker.fetch!(request, env)
    expect(response.status).toBe(200)
    const json = (await response.json()) as {
      success: boolean
      status: { scanOperationsActive: boolean; reconciliationConsistent: boolean }
    }
    expect(json.success).toBe(true)
    expect(json.status.scanOperationsActive).toBe(true)
    expect(json.status.reconciliationConsistent).toBe(true)
  })
})
