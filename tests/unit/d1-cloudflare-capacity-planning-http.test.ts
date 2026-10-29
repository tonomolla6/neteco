import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  handleCapacityPlanningHttp,
  ownsCapacityPlanningNamespace,
  type CapacityPlanningHttpDependencies
} from '../../workers/observability/capacity-planning-http'
import { initializeD1CapacityMetrics } from '../../workers/observability/capacity-planning'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const OPERATOR_NO_PERMS_ID = '10000000-0000-4000-8000-000000000002'
const ADMIN_SESSION_ID = '20000000-0000-4000-8000-000000000001'
const NOPERMS_SESSION_ID = '20000000-0000-4000-8000-000000000002'

async function setupDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0116_observability_sre_capacity_slo.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administración', 'Fixture admin'),
      ('operator', 'Operador', 'Fixture operator');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Fixture admin manage');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage');
    INSERT OR IGNORE INTO identities (id, email, password_hash, status, email_verified_at, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin-cap@example.invalid', 'hash', 'active', '${NOW}', '${NOW}', '${NOW}'),
      ('${OPERATOR_NO_PERMS_ID}', 'operator@example.invalid', 'hash', 'active', '${NOW}', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_SESSION_ID}', '${ADMIN_ID}', 1, 1, '2026-10-29T11:00:00Z', '2026-11-29T12:00:00Z'),
      ('${NOPERMS_SESSION_ID}', '${OPERATOR_NO_PERMS_ID}', 1, 1, '2026-10-29T11:00:00Z', '2026-11-29T12:00:00Z');
  `)
  return sqlite
}

describe('OBS-026: Capacity planning HTTP endpoints', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  const fakeSessionConfig = {
    password: 'test-password-must-be-long-enough-32-chars',
    maxAgeSeconds: 3600
  }

  const baseDeps: CapacityPlanningHttpDependencies = {
    database: null as unknown as D1Database,
    sessionCookieConfiguration: fakeSessionConfig,
    origin: 'https://test.neteco.es',
    now: () => NOW,
    claimsResolver: async (req: Request) => {
      const authHeader = req.headers.get('x-test-session')
      if (authHeader === 'admin') {
        return { identityId: ADMIN_ID, sessionId: ADMIN_SESSION_ID, sessionVersion: 1 }
      }
      if (authHeader === 'noperms') {
        return { identityId: OPERATOR_NO_PERMS_ID, sessionId: NOPERMS_SESSION_ID, sessionVersion: 1 }
      }
      return null
    }
  }

  beforeEach(async () => {
    sqlite = await setupDatabase()
    db = d1OverSqlite(sqlite)
    await initializeD1CapacityMetrics(
      db,
      { identityId: ADMIN_ID, sessionId: ADMIN_SESSION_ID, sessionVersion: 1 },
      { now: NOW }
    )
  })

  afterEach(() => {
    sqlite.close()
  })

  it('detects route ownership for namespace', () => {
    expect(ownsCapacityPlanningNamespace('/api/admin/observability/capacity')).toBe(true)
    expect(ownsCapacityPlanningNamespace('/api/admin/observability/capacity/metrics')).toBe(true)
    expect(ownsCapacityPlanningNamespace('/api/admin/observability/capacity/simulate')).toBe(true)
    expect(ownsCapacityPlanningNamespace('/api/admin/other')).toBe(false)
  })

  it('returns 401 for unauthenticated requests', async () => {
    const deps = { ...baseDeps, database: db as unknown as D1Database }
    const req = new Request('https://test.neteco.es/api/admin/observability/capacity/metrics', {
      method: 'GET'
    })
    const res = await handleCapacityPlanningHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(401)
  })

  it('lists capacity metrics via GET /metrics', async () => {
    const deps = { ...baseDeps, database: db as unknown as D1Database }
    const req = new Request('https://test.neteco.es/api/admin/observability/capacity/metrics', {
      method: 'GET',
      headers: { 'x-test-session': 'admin' }
    })
    const res = await handleCapacityPlanningHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const data = (await res!.json()) as { metrics: Array<{ resourceKey: string; quotaLimit: number }> }
    expect(data.metrics.length).toBeGreaterThan(0)
  })

  it('runs campaign simulation via POST /simulate', async () => {
    const deps = { ...baseDeps, database: db as unknown as D1Database }
    const req = new Request('https://test.neteco.es/api/admin/observability/capacity/simulate', {
      method: 'POST',
      headers: {
        'x-test-session': 'admin',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        commandId: '40000000-0000-4000-8000-000000000010',
        idempotencyKey: 'http-sim-1',
        campaignName: 'Test Sim HTTP',
        startTime: '2026-11-15T00:00:00Z',
        endTime: '2026-11-16T00:00:00Z',
        projectedPeakMultiplier: 2.2,
        projectedVisitorsPeak: 4000,
        projectedOrdersHour: 100
      })
    })

    const res = await handleCapacityPlanningHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const data = (await res!.json()) as { plan: { status: string; headroomVerdict: string } }
    expect(data.plan.headroomVerdict).toBe('healthy')
  })
})
