import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  handleProgressiveRolloutHttp,
  ownsProgressiveRolloutNamespace,
  type ProgressiveRolloutHttpDependencies
} from '../../workers/release/progressive-rollout-http'

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

const SAMPLE_ROLLOUT = {
  commandId: 'cmd-http-ro-1',
  featureKey: 'b2b_pricing_v2',
  name: 'Precios B2B en Tiempo Real',
  trafficPercentage: 30,
  cohorts: ['b2b_beta'],
  zones: ['ES-MD'],
  guardrails: { maxErrorRatePercent: 1.0, maxP95LatencyMs: 500, minSampleCount: 10 },
  betaScopeNotice: {
    title: 'Precios B2B Beta',
    summary: 'Cálculo de tarifas dinámicas en fase Beta.',
    limitations: ['Tarifas sujetas a revisión']
  }
}

describe('CIC-029: HTTP endpoints de Despliegue Progresivo', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  const baseDeps: ProgressiveRolloutHttpDependencies = {
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

  it('reconoce los namespaces HTTP administrativo y de evaluación runtime', () => {
    expect(ownsProgressiveRolloutNamespace('/api/admin/release/progressive-rollouts')).toBe(true)
    expect(ownsProgressiveRolloutNamespace('/api/admin/release/progressive-rollouts/create')).toBe(true)
    expect(ownsProgressiveRolloutNamespace('/api/release/progressive-rollouts/eval')).toBe(true)
    expect(ownsProgressiveRolloutNamespace('/api/catalog')).toBe(false)
  })

  it('permite crear y evaluar un despliegue progresivo vía HTTP', async () => {
    // 1. Crear rollout
    const createReq = new Request('https://test.neteco.es/api/admin/release/progressive-rollouts/create', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-actor': ADMIN_ID,
        origin: 'https://test.neteco.es'
      },
      body: JSON.stringify(SAMPLE_ROLLOUT)
    })
    const createRes = await handleProgressiveRolloutHttp(createReq, baseDeps)
    expect(createRes?.status).toBe(201)
    const created = await createRes?.json()
    expect(created.featureKey).toBe('b2b_pricing_v2')

    // 2. Activar rollout
    const updateReq = new Request('https://test.neteco.es/api/admin/release/progressive-rollouts/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-actor': ADMIN_ID,
        origin: 'https://test.neteco.es'
      },
      body: JSON.stringify({
        commandId: 'cmd-http-act-1',
        rolloutId: created.id,
        expectedVersion: created.version,
        status: 'active'
      })
    })
    const updateRes = await handleProgressiveRolloutHttp(updateReq, baseDeps)
    expect(updateRes?.status).toBe(200)

    // 3. Evaluar sujeto desde endpoint público/runtime
    const evalReq = new Request('https://test.neteco.es/api/release/progressive-rollouts/eval', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        featureKey: 'b2b_pricing_v2',
        subjectId: 'user_cohort_test',
        cohort: 'b2b_beta'
      })
    })
    const evalRes = await handleProgressiveRolloutHttp(evalReq, baseDeps)
    expect(evalRes?.status).toBe(200)
    const evaluation = await evalRes?.json()
    expect(evaluation.enabled).toBe(true)
    expect(evaluation.reason).toBe('cohort_match')
    expect(evaluation.betaScopeNotice.title).toBe('Precios B2B Beta')
  })
})
