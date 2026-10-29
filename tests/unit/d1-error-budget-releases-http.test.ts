import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  handleErrorBudgetHttp,
  ownsErrorBudgetNamespace,
  type ErrorBudgetHttpDependencies
} from '../../workers/observability/error-budget-http'

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
      ('${ADMIN_ID}', 'admin-sre@example.invalid', 'hash', 'active', '${NOW}', '${NOW}', '${NOW}'),
      ('${OPERATOR_NO_PERMS_ID}', 'operator@example.invalid', 'hash', 'active', '${NOW}', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_SESSION_ID}', '${ADMIN_ID}', 1, 1, '2026-10-29T11:00:00Z', '2026-11-29T12:00:00Z'),
      ('${NOPERMS_SESSION_ID}', '${OPERATOR_NO_PERMS_ID}', 1, 1, '2026-10-29T11:00:00Z', '2026-11-29T12:00:00Z');
  `)
  return sqlite
}

describe('OBS-025: Error budget HTTP endpoints', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  const fakeSessionConfig = {
    password: 'test-password-must-be-long-enough-32-chars',
    maxAgeSeconds: 3600
  }

  const baseDeps: ErrorBudgetHttpDependencies = {
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
  })

  afterEach(() => {
    sqlite.close()
  })

  it('detects route ownership for namespace', () => {
    expect(ownsErrorBudgetNamespace('/api/admin/observability/error-budget')).toBe(true)
    expect(ownsErrorBudgetNamespace('/api/admin/observability/error-budget/overview')).toBe(true)
    expect(ownsErrorBudgetNamespace('/api/admin/observability/error-budget/evaluate')).toBe(true)
    expect(ownsErrorBudgetNamespace('/api/admin/other')).toBe(false)
  })

  it('rejects unauthenticated requests with 401', async () => {
    const deps = { ...baseDeps, database: db as unknown as D1Database }
    const req = new Request('https://test.neteco.es/api/admin/observability/error-budget/overview', {
      method: 'GET'
    })
    const res = await handleErrorBudgetHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(401)
  })

  it('rejects unauthorized requests with 403', async () => {
    const deps = { ...baseDeps, database: db as unknown as D1Database }
    const req = new Request('https://test.neteco.es/api/admin/observability/error-budget/overview', {
      method: 'GET',
      headers: { 'x-test-session': 'noperms' }
    })
    const res = await handleErrorBudgetHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  it('evaluates release and returns transparent diagnostics via POST /evaluate', async () => {
    const deps = { ...baseDeps, database: db as unknown as D1Database }
    const req = new Request('https://test.neteco.es/api/admin/observability/error-budget/evaluate', {
      method: 'POST',
      headers: {
        'x-test-session': 'admin',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        commandId: '30000000-0000-4000-8000-000000000020',
        idempotencyKey: 'http-eval-1',
        releaseVersion: 'v2026.10.30-http-release',
        releaseType: 'feature',
        commitHash: 'deadbeef1234'
      })
    })

    const res = await handleErrorBudgetHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const data = (await res!.json()) as { decision: { status: string; releaseVersion: string } }
    expect(data.decision.status).toBe('approved')
    expect(data.decision.releaseVersion).toBe('v2026.10.30-http-release')
  })

  it('validates request bodies and returns 400 on malformed input', async () => {
    const deps = { ...baseDeps, database: db as unknown as D1Database }
    const req = new Request('https://test.neteco.es/api/admin/observability/error-budget/evaluate', {
      method: 'POST',
      headers: {
        'x-test-session': 'admin',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        releaseVersion: '', // Invalid empty version
        releaseType: 'invalid_type'
      })
    })

    const res = await handleErrorBudgetHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(400)
    const data = (await res!.json()) as { error: { code: string } }
    expect(data.error.code).toBe('invalid_input')
  })

  it('re-verifies live authorization before returning response and fails with 403 if revoked during call', async () => {
    let authCallCount = 0
    const deps: ErrorBudgetHttpDependencies = {
      ...baseDeps,
      database: db as unknown as D1Database,
      claimsResolver: async () => ({ identityId: ADMIN_ID, sessionId: ADMIN_SESSION_ID, sessionVersion: 1 }),
      now: () => {
        authCallCount++
        if (authCallCount > 1) {
          sqlite.exec(`DELETE FROM identity_roles WHERE identity_id = '${ADMIN_ID}'`)
        }
        return NOW
      }
    }
    const req = new Request('https://test.neteco.es/api/admin/observability/error-budget/overview', {
      method: 'GET'
    })
    const res = await handleErrorBudgetHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })
})
