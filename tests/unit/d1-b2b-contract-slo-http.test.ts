import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  handleB2BContractSloHttp,
  ownsB2BContractSloNamespace,
  type B2BContractSloHttpDependencies
} from '../../workers/observability/b2b-slo-http'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_SESSION_ID = '20000000-0000-4000-8000-000000000001'
const CUSTOMER_ID = '50000000-0000-4000-8000-000000000001'

async function setupDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0116_observability_sre_capacity_slo.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administración', 'Fixture admin');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Fixture admin manage');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage');
    INSERT OR IGNORE INTO identities (id, email, password_hash, status, email_verified_at, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin-b2bslo-http@example.invalid', 'hash', 'active', '${NOW}', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_SESSION_ID}', '${ADMIN_ID}', 1, 1, '2026-10-29T11:00:00Z', '2026-11-29T12:00:00Z');
    INSERT OR IGNORE INTO customers (id, name, phone, status, created_at, updated_at) VALUES
      ('${CUSTOMER_ID}', 'Hospital Central Lavandería SL', '+34912345678', 'active', '${NOW}', '${NOW}');
  `)
  return sqlite
}

describe('OBS-028: B2B Contract SLO HTTP endpoints', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  const fakeSessionConfig = {
    password: 'test-password-must-be-long-enough-32-chars',
    maxAgeSeconds: 3600
  }

  const baseDeps: B2BContractSloHttpDependencies = {
    database: null as unknown as D1Database,
    sessionCookieConfiguration: fakeSessionConfig,
    origin: 'https://test.neteco.es',
    now: () => NOW,
    claimsResolver: async (req: Request) => {
      const authHeader = req.headers.get('x-test-session')
      if (authHeader === 'admin') {
        return { identityId: ADMIN_ID, sessionId: ADMIN_SESSION_ID, sessionVersion: 1 }
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
    expect(ownsB2BContractSloNamespace('/api/admin/observability/b2b-slo')).toBe(true)
    expect(ownsB2BContractSloNamespace('/api/admin/observability/b2b-slo/contracts')).toBe(true)
    expect(ownsB2BContractSloNamespace('/api/admin/other')).toBe(false)
  })

  it('creates and lists B2B contract SLOs via HTTP', async () => {
    const deps = { ...baseDeps, database: db as unknown as D1Database }
    const createReq = new Request('https://test.neteco.es/api/admin/observability/b2b-slo/contracts', {
      method: 'POST',
      headers: {
        'x-test-session': 'admin',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        commandId: '60000000-0000-4000-8000-000000000020',
        idempotencyKey: 'http-contract-1',
        customerId: CUSTOMER_ID,
        companyName: 'Hospital Central Lavandería SL',
        contractRef: 'CTR-HTTP-01',
        tierCode: 'premium_b2b',
        billingPeriodStart: '2026-10-01T00:00:00Z',
        billingPeriodEnd: '2026-10-31T23:59:59Z'
      })
    })

    const res = await handleB2BContractSloHttp(createReq, deps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)

    const listReq = new Request('https://test.neteco.es/api/admin/observability/b2b-slo/contracts', {
      method: 'GET',
      headers: { 'x-test-session': 'admin' }
    })
    const listRes = await handleB2BContractSloHttp(listReq, deps)
    expect(listRes).not.toBeNull()
    expect(listRes!.status).toBe(200)
    const listData = (await listRes!.json()) as { contracts: Array<{ contractRef: string }> }
    expect(listData.contracts.length).toBe(1)
    expect(listData.contracts[0].contractRef).toBe('CTR-HTTP-01')
  })
})
