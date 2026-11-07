import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleSeoContentDashboardHttp,
  ownsSeoContentDashboardNamespace,
  type SeoContentDashboardHttpDependencies
} from '../../workers/seo/content-dashboard-http'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const NON_ADMIN_ID = '10000000-0000-4000-8000-000000000002'
const SESSION_PASSWORD = 'test-session-password-at-least-32-chars-long!!'
const ORIGIN = 'https://neteco.beply.es'

async function setupHttpDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0123_seo_b2b_metrics_cost_to_serve.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol administrador'),
      ('customer', 'Cliente', 'Rol cliente');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Gestión general');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage');

    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin-http@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
      ('${NON_ADMIN_ID}', 'user-http@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('20000000-0000-4000-8000-000000000001', '${ADMIN_ID}', 1, 1, '${NOW}', '2099-12-31T23:59:59Z'),
      ('20000000-0000-4000-8000-000000000002', '${NON_ADMIN_ID}', 1, 1, '${NOW}', '2099-12-31T23:59:59Z');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}'),
      ('${NON_ADMIN_ID}', 'customer', '${NOW}');
  `)

  return sqlite
}

async function makeCookie(db: D1Database, identityId: string, sessionId: string): Promise<string> {
  const cookie = await issueD1SessionCookie(
    db,
    { identityId, sessionId, sessionVersion: 1 },
    { password: SESSION_PASSWORD, maxAgeSeconds: 3600 }
  )
  return cookie?.split(';')[0] ?? ''
}

describe('DAT-019: SEO & Content Dashboard HTTP Endpoints', () => {
  let sqlite: DatabaseSync
  let db: D1Database
  let deps: SeoContentDashboardHttpDependencies
  let adminCookie: string
  let nonAdminCookie: string

  beforeEach(async () => {
    sqlite = await setupHttpDb()
    db = d1OverSqlite(sqlite)
    deps = {
      database: db,
      origin: ORIGIN,
      sessionCookieConfiguration: { password: SESSION_PASSWORD, maxAgeSeconds: 3600 },
      now: () => NOW
    }
    adminCookie = await makeCookie(db, ADMIN_ID, '20000000-0000-4000-8000-000000000001')
    nonAdminCookie = await makeCookie(db, NON_ADMIN_ID, '20000000-0000-4000-8000-000000000002')
  })

  afterEach(() => {
    sqlite.close()
  })

  it('correctly matches owned namespace paths and rejects external paths', () => {
    expect(ownsSeoContentDashboardNamespace('/api/admin/seo/dashboard')).toBe(true)
    expect(ownsSeoContentDashboardNamespace('/api/admin/seo/dashboard/sync')).toBe(true)
    expect(ownsSeoContentDashboardNamespace('/api/admin/seo/dashboard/costs')).toBe(true)
    expect(ownsSeoContentDashboardNamespace('/api/admin/seo/crawl')).toBe(false)
    expect(ownsSeoContentDashboardNamespace('/api/catalog')).toBe(false)
  })

  it('rejects unauthenticated requests with 401', async () => {
    const req = new Request(`${ORIGIN}/api/admin/seo/dashboard`, {
      method: 'GET',
      headers: { Origin: ORIGIN }
    })
    const res = await handleSeoContentDashboardHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res?.status).toBe(401)
  })

  it('rejects unauthorized non-admin session with 403', async () => {
    const req = new Request(`${ORIGIN}/api/admin/seo/dashboard`, {
      method: 'GET',
      headers: {
        Origin: ORIGIN,
        Cookie: nonAdminCookie
      }
    })
    const res = await handleSeoContentDashboardHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res?.status).toBe(403)
  })

  it('returns SEO dashboard metrics for authenticated admin', async () => {
    const req = new Request(`${ORIGIN}/api/admin/seo/dashboard?from=2026-10-01&to=2026-10-31`, {
      method: 'GET',
      headers: {
        Origin: ORIGIN,
        Cookie: adminCookie
      }
    })
    const res = await handleSeoContentDashboardHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res?.status).toBe(200)

    const data = await res?.json()
    expect(data.summary).toBeDefined()
    expect(data.summary.totalImpressions).toBe(0)
    expect(data.queries).toEqual([])
    expect(data.landingPages).toEqual([])
    expect(data.syncStatus).toBeDefined()
    expect(res?.headers.get('cache-control')).toContain('no-store')
  })

  it('syncs SEO metrics via POST /api/admin/seo/dashboard/sync', async () => {
    const req = new Request(`${ORIGIN}/api/admin/seo/dashboard/sync`, {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        Cookie: adminCookie,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'http-cmd-sync-1'
      },
      body: JSON.stringify({
        syncDate: '2026-10-28',
        dataThroughDate: '2026-10-28',
        source: 'google_search_console',
        metrics: [
          {
            landingPath: '/producto/desengrasante',
            query: 'desengrasante industrial potente',
            device: 'desktop',
            impressions: 1500,
            clicks: 150,
            avgPosition: 2.1,
            assistedOrdersCount: 6,
            assistedRevenueGrossCents: 60000,
            assistedRevenueNetCents: 49587
          }
        ]
      })
    })

    const res = await handleSeoContentDashboardHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res?.status).toBe(200)

    const data = await res?.json()
    expect(data.recordsProcessed).toBe(1)
  })

  it('rejects invalid inputs with 400', async () => {
    const req = new Request(`${ORIGIN}/api/admin/seo/dashboard/sync`, {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        Cookie: adminCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        syncDate: 'invalid-date',
        metrics: []
      })
    })

    const res = await handleSeoContentDashboardHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res?.status).toBe(400)
    const err = await res?.json()
    expect(err.error.code).toBe('invalid_input')
  })

  const syncBody = (clicks: number) =>
    JSON.stringify({
      syncDate: '2026-10-28',
      dataThroughDate: '2026-10-28',
      source: 'google_search_console',
      metrics: [
        {
          landingPath: '/producto/desengrasante',
          query: 'desengrasante industrial',
          device: 'desktop',
          impressions: 1500,
          clicks,
          avgPosition: 2.1,
          assistedOrdersCount: 0,
          assistedRevenueGrossCents: 0,
          assistedRevenueNetCents: 0
        }
      ]
    })
  const post = (headers: Record<string, string>, body = syncBody(150)) =>
    new Request(`${ORIGIN}/api/admin/seo/dashboard/sync`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json', ...headers },
      body
    })

  it('rejects state-changing requests without a matching Origin before touching data', async () => {
    for (const headers of [
      { 'Idempotency-Key': 'k-no-origin' },
      { Origin: 'https://evil.example', 'Idempotency-Key': 'k-bad' }
    ]) {
      const res = await handleSeoContentDashboardHttp(post(headers), deps)
      expect(res?.status).toBe(403)
      expect((await res!.json()).error.code).toBe('csrf_rejected')
    }
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM seo_content_performance_metrics').get()).toEqual({ n: 0 })
  })

  it('requires a client idempotency key instead of inventing a clock-based one', async () => {
    const res = await handleSeoContentDashboardHttp(post({ Origin: ORIGIN }), deps)
    expect(res?.status).toBe(400)
    expect((await res!.json()).error.code).toBe('invalid_input')
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM seo_content_sync_commands').get()).toEqual({ n: 0 })
  })

  it('replays the identical command and rejects a different payload under the same key with 409', async () => {
    const headers = { Origin: ORIGIN, 'Idempotency-Key': 'k-replay' }
    expect((await handleSeoContentDashboardHttp(post(headers), deps))?.status).toBe(200)
    const replay = await handleSeoContentDashboardHttp(post(headers), deps)
    expect(replay?.status).toBe(200)
    expect((await replay!.json()).idempotentReplay).toBe(true)
    const conflict = await handleSeoContentDashboardHttp(post(headers, syncBody(999)), deps)
    expect(conflict?.status).toBe(409)
    expect((await conflict!.json()).error.code).toBe('conflict')
    expect(sqlite.prepare('SELECT clicks FROM seo_content_performance_metrics').get()).toEqual({ clicks: 150 })
  })
})
