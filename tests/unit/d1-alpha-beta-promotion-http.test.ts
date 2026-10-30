import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  handleAlphaBetaPromotionHttp,
  ownsAlphaBetaPromotionNamespace,
  type AlphaBetaPromotionHttpDependencies
} from '../../workers/release/alpha-beta-promotion-http'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000001'
const BIZ_ID = '10000000-0000-4000-8000-000000000002'
const LEGAL_ID = '10000000-0000-4000-8000-000000000003'
const RM_ID = '10000000-0000-4000-8000-000000000004'

async function setupDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0134_release_gates_progressive_rollout_policy_campaigns.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Fixture admin'),
      ('business', 'Negocio', 'Fixture business'),
      ('legal', 'Legal', 'Fixture legal'),
      ('release_manager', 'Release Manager', 'Fixture RM');
    INSERT OR IGNORE INTO identities (id, email, password_hash, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin@example.invalid', 'hash', 'active', '${NOW}', '${NOW}'),
      ('${BIZ_ID}', 'biz@example.invalid', 'hash', 'active', '${NOW}', '${NOW}'),
      ('${LEGAL_ID}', 'legal@example.invalid', 'hash', 'active', '${NOW}', '${NOW}'),
      ('${RM_ID}', 'rm@example.invalid', 'hash', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}'),
      ('${BIZ_ID}', 'business', '${NOW}'),
      ('${LEGAL_ID}', 'legal', '${NOW}'),
      ('${RM_ID}', 'release_manager', '${NOW}');
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

const SAMPLE_BODY = {
  commandId: 'cmd-http-promo-1',
  releaseVersion: 'v2.5.0-beta.1',
  p0DefectsCount: 0,
  p1DefectsCount: 0,
  checklist: {
    sloVerified: true,
    alertsConfigured: true,
    runbooksPublished: true,
    restoreRehearsed: true,
    pentestCleared: true,
    uatPassed: true,
    notes: 'HTTP test checklist'
  },
  evidenceBundle: {
    releaseVersion: 'v2.5.0-beta.1',
    targetCommit: '1234567890abcdef1234567890abcdef12345678',
    sloDashboardRef: 'https://slo.neteco.es/release-2.5',
    alertsAuditRef: 'audit://alerts-2.5',
    runbookIndexRef: 'docs://runbooks-2.5',
    restoreDrillLogRef: 'logs://restore-2.5',
    pentestReportHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    uatReportRef: 'reports://uat-2.5'
  }
}

describe('CIC-028: HTTP endpoints de Alpha-to-Beta checklist', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  const baseDeps: AlphaBetaPromotionHttpDependencies = {
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

  it('reconoce el namespace HTTP correcto', () => {
    expect(ownsAlphaBetaPromotionNamespace('/api/admin/release/alpha-beta-promotions')).toBe(true)
    expect(ownsAlphaBetaPromotionNamespace('/api/admin/release/alpha-beta-promotions/create')).toBe(true)
    expect(ownsAlphaBetaPromotionNamespace('/api/admin/catalog')).toBe(false)
  })

  it('rechaza peticiones sin autenticación (401)', async () => {
    const req = new Request('https://test.neteco.es/api/admin/release/alpha-beta-promotions', {
      method: 'GET'
    })
    const res = await handleAlphaBetaPromotionHttp(req, baseDeps)
    expect(res?.status).toBe(401)
  })

  it('permite crear, consultar y listar promociones vía HTTP', async () => {
    const createReq = new Request('https://test.neteco.es/api/admin/release/alpha-beta-promotions/create', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-actor': ADMIN_ID,
        origin: 'https://test.neteco.es'
      },
      body: JSON.stringify(SAMPLE_BODY)
    })

    const createRes = await handleAlphaBetaPromotionHttp(createReq, baseDeps)
    expect(createRes?.status).toBe(201)
    const created = await createRes?.json()
    expect(created.id).toBeDefined()
    expect(created.status).toBe('draft')

    // Consulta por ID
    const getReq = new Request(`https://test.neteco.es/api/admin/release/alpha-beta-promotions/${created.id}`, {
      method: 'GET',
      headers: { 'x-test-actor': ADMIN_ID }
    })
    const getRes = await handleAlphaBetaPromotionHttp(getReq, baseDeps)
    expect(getRes?.status).toBe(200)
    const fetched = await getRes?.json()
    expect(fetched.releaseVersion).toBe('v2.5.0-beta.1')

    // Listado
    const listReq = new Request('https://test.neteco.es/api/admin/release/alpha-beta-promotions', {
      method: 'GET',
      headers: { 'x-test-actor': ADMIN_ID }
    })
    const listRes = await handleAlphaBetaPromotionHttp(listReq, baseDeps)
    expect(listRes?.status).toBe(200)
    const list = await listRes?.json()
    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBeGreaterThan(0)
  })
})
