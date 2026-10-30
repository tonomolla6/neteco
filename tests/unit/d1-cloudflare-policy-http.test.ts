import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  handleCloudflarePolicyHttp,
  ownsCloudflarePolicyNamespace,
  type CloudflarePolicyHttpDependencies
} from '../../workers/release/cloudflare-policy-http'
import type { CloudflareManifest } from '../../shared/cloudflare-policy'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000001'

async function setupDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0134_release_gates_progressive_rollout_policy_campaigns.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO identities (id, email, password_hash, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin@example.invalid', 'hash', 'active', '${NOW}', '${NOW}');
  `)
  // Live authorization: the admin actor needs a real MFA session and a role granting the permission.
  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES ('admin', 'Administrador', 'Fixture admin');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Fixture'), ('catalog.write', 'catalog', 'write', 'Fixture');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'), ('admin', 'catalog.write');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES ('${ADMIN_ID}', 'admin', '${NOW}');
    UPDATE identities SET email_verified_at = '${NOW}' WHERE id = '${ADMIN_ID}';
    INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
      VALUES ('${ADMIN_SESSION}', '${ADMIN_ID}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z');
  `)
  return sqlite
}

const SAMPLE_MANIFEST: CloudflareManifest = {
  environment: 'production',
  policyVersion: 'v2026.10',
  r2Buckets: [{ bucketName: 'neteco-media', publicAccess: false }],
  bindings: [{ bindingName: 'DB', type: 'd1', targetResource: 'neteco-d1', targetEnvironment: 'production' }],
  d1Databases: [
    {
      databaseName: 'neteco-d1',
      databaseId: 'd1-uuid',
      timeTravelEnabled: true,
      isolatedNamespace: true,
      backupScheduleConfigured: true
    }
  ],
  durableObjects: [{ className: 'Coordinator', isolatedNamespace: true }],
  vars: { NODE_ENV: 'production', PUBLIC_STORE: 'Neteco' },
  edgeSecurity: {
    minTlsVersion: '1.2',
    sslMode: 'strict',
    wafEnabled: true,
    managedRulesetsActive: true,
    backupExportConfigured: true
  }
}

describe('CIC-030: HTTP endpoints de Policy-as-code para Cloudflare', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  const baseDeps: CloudflarePolicyHttpDependencies = {
    database: null as unknown as D1Database,
    origin: 'https://test.neteco.es',
    now: () => NOW,
    claimsResolver: async (req: Request) => {
      const actor = req.headers.get('x-test-actor')
      if (!actor) return null
      return { identityId: actor, sessionId: ADMIN_SESSION, sessionVersion: 1 }
    }
  }

  beforeEach(async () => {
    sqlite = await setupDatabase()
    db = d1OverSqlite(sqlite)
    baseDeps.database = db as unknown as D1Database
  })

  afterEach(() => {
    sqlite.close()
  })

  it('reconoce el namespace HTTP administrativo de políticas', () => {
    expect(ownsCloudflarePolicyNamespace('/api/admin/release/cloudflare-policies')).toBe(true)
    expect(ownsCloudflarePolicyNamespace('/api/admin/release/cloudflare-policies/audit')).toBe(true)
    expect(ownsCloudflarePolicyNamespace('/api/admin/release/cloudflare-policies/drift')).toBe(true)
    expect(ownsCloudflarePolicyNamespace('/api/admin/other')).toBe(false)
  })

  it('ejecuta auditoría de política vía HTTP y retorna resultado y violaciones', async () => {
    const auditReq = new Request('https://test.neteco.es/api/admin/release/cloudflare-policies/audit', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-actor': ADMIN_ID,
        origin: 'https://test.neteco.es'
      },
      body: JSON.stringify({
        commandId: 'cmd-http-audit-1',
        environment: 'production',
        manifest: SAMPLE_MANIFEST
      })
    })

    const auditRes = await handleCloudflarePolicyHttp(auditReq, baseDeps)
    expect(auditRes?.status).toBe(201)
    const audit = await auditRes?.json()
    expect(audit.passed).toBe(true)
    expect(audit.blockersCount).toBe(0)
  })
})
