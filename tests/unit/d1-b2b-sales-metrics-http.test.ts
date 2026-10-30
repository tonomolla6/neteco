import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleB2bSalesMetricsHttp,
  ownsB2bSalesMetricsNamespace,
  type B2bSalesMetricsHttpDependencies
} from '../../workers/b2b/metrics-http'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const NON_ADMIN_ID = '10000000-0000-4000-8000-000000000002'
const SESSION_PASSWORD = 'test-session-password-at-least-32-chars-long!!'
const ORIGIN = 'https://neteco.beply.es'

async function setupHttpDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration0101 = await readFile(
    new URL('../../db/d1/migrations/0101_b2b_price_lists_credit.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration0101)

  const migration0105 = await readFile(
    new URL('../../db/d1/migrations/0105_b2b_credit_terms.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration0105)

  const migration0123 = await readFile(
    new URL('../../db/d1/migrations/0123_seo_b2b_metrics_cost_to_serve.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration0123)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol admin'),
      ('customer', 'Cliente', 'Rol cliente');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Admin manage');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage');

    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin-b2b-http@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
      ('${NON_ADMIN_ID}', 'user-b2b-http@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('20000000-0000-4000-8000-000000000001', '${ADMIN_ID}', 1, 1, '${NOW}', '2026-10-30T12:00:00Z'),
      ('20000000-0000-4000-8000-000000000002', '${NON_ADMIN_ID}', 1, 1, '${NOW}', '2026-10-30T12:00:00Z');

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

describe('DAT-020: B2B Sales Metrics HTTP Endpoints', () => {
  let sqlite: DatabaseSync
  let db: D1Database
  let deps: B2bSalesMetricsHttpDependencies
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

  it('matches owned namespace paths', () => {
    expect(ownsB2bSalesMetricsNamespace('/api/admin/b2b/metrics')).toBe(true)
    expect(ownsB2bSalesMetricsNamespace('/api/admin/b2b/metrics/snapshot')).toBe(true)
    expect(ownsB2bSalesMetricsNamespace('/api/admin/b2b/other')).toBe(false)
  })

  it('rejects unauthenticated requests with 401', async () => {
    const req = new Request(`${ORIGIN}/api/admin/b2b/metrics`, {
      method: 'GET',
      headers: { Origin: ORIGIN }
    })
    const res = await handleB2bSalesMetricsHttp(req, deps)
    expect(res?.status).toBe(401)
  })

  it('rejects non-admin requests with 403', async () => {
    const req = new Request(`${ORIGIN}/api/admin/b2b/metrics`, {
      method: 'GET',
      headers: { Origin: ORIGIN, Cookie: nonAdminCookie }
    })
    const res = await handleB2bSalesMetricsHttp(req, deps)
    expect(res?.status).toBe(403)
  })

  it('retrieves B2B metrics via GET /api/admin/b2b/metrics for authenticated admin', async () => {
    const req = new Request(`${ORIGIN}/api/admin/b2b/metrics?from=2026-01-01&to=2026-10-29`, {
      method: 'GET',
      headers: { Origin: ORIGIN, Cookie: adminCookie }
    })
    const res = await handleB2bSalesMetricsHttp(req, deps)
    expect(res?.status).toBe(200)
    const data = await res?.json()
    expect(data.activation).toBeDefined()
    expect(data.conversion).toBeDefined()
    expect(data.recurrence).toBeDefined()
    expect(data.commercialTerms).toBeDefined()
  })
})
