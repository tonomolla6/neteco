import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { handleAlphaBetaPromotionHttp } from '../../workers/release/alpha-beta-promotion-http'
import { handleProgressiveRolloutHttp } from '../../workers/release/progressive-rollout-http'
import { handleCloudflarePolicyHttp } from '../../workers/release/cloudflare-policy-http'
import { handleCampaignPipelineHttp } from '../../workers/cms/campaign-pipeline-http'

// Live authorization of the CIC-028..031 admin endpoints: a signed-in storefront
// customer (no admin role) or an admin without MFA must never reach the modules.
const NOW = '2026-10-29T12:00:00Z'
const EXPIRES = '2026-10-30T12:00:00Z'
const ADMIN = { identityId: '10000000-0000-4000-8000-0000000000a1', sessionId: '20000000-0000-4000-8000-0000000000a1' }
const NOMFA = { identityId: '10000000-0000-4000-8000-0000000000a2', sessionId: '20000000-0000-4000-8000-0000000000a2' }
const CUSTOMER = {
  identityId: '10000000-0000-4000-8000-0000000000a3',
  sessionId: '20000000-0000-4000-8000-0000000000a3'
}
const REVOKED = {
  identityId: '10000000-0000-4000-8000-0000000000a4',
  sessionId: '20000000-0000-4000-8000-0000000000a4'
}
const ACTORS = [ADMIN, NOMFA, CUSTOMER, REVOKED]

const MODULES = [
  { name: 'alpha-beta', handler: handleAlphaBetaPromotionHttp, list: '/api/admin/release/alpha-beta-promotions' },
  { name: 'rollout', handler: handleProgressiveRolloutHttp, list: '/api/admin/release/progressive-rollouts' },
  { name: 'cloudflare', handler: handleCloudflarePolicyHttp, list: '/api/admin/release/cloudflare-policies' },
  { name: 'campaign', handler: handleCampaignPipelineHttp, list: '/api/admin/cms/campaign-pipeline' }
] as const

describe('CIC-028..031 autorización viva en los endpoints admin', () => {
  let sqlite: DatabaseSync
  let deps: Parameters<typeof handleCloudflarePolicyHttp>[1]

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    sqlite.exec(
      await readFile(
        new URL('../../db/d1/migrations/0134_release_gates_progressive_rollout_policy_campaigns.sql', import.meta.url),
        'utf8'
      )
    )
    sqlite.exec(`
      INSERT OR IGNORE INTO roles (code, name, description) VALUES ('admin', 'Administrador', 'Fixture admin');
      INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
        ('administration.manage', 'administration', 'manage', 'x'), ('catalog.write', 'catalog', 'write', 'x');
      INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
        ('admin', 'administration.manage'), ('admin', 'catalog.write');
    `)
    for (const [index, actor] of ACTORS.entries()) {
      sqlite
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES(?,?, 'x', ?, 'active', ?, ?)"
        )
        .run(actor.identityId, `actor${index}@example.invalid`, NOW, NOW, NOW)
      sqlite
        .prepare(
          'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at,revoked_at) VALUES(?,?,1,?,?,?,?)'
        )
        .run(actor.sessionId, actor.identityId, actor === NOMFA ? 0 : 1, NOW, EXPIRES, actor === REVOKED ? NOW : null)
    }
    for (const actor of [ADMIN, NOMFA, REVOKED]) {
      sqlite
        .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?, 'admin', ?)")
        .run(actor.identityId, NOW)
    }
    deps = {
      database: d1OverSqlite(sqlite) as unknown as D1Database,
      origin: 'https://test.neteco.es',
      now: () => NOW,
      claimsResolver: async (request: Request) => {
        const actor = ACTORS.find((candidate) => candidate.identityId === request.headers.get('x-test-actor'))
        return actor ? { identityId: actor.identityId, sessionId: actor.sessionId, sessionVersion: 1 } : null
      }
    }
  })

  afterEach(() => sqlite.close())

  for (const module of MODULES) {
    describe(module.name, () => {
      const call = (actor: { identityId: string }, method: 'GET' | 'POST', path = module.list) =>
        module.handler(
          new Request(`https://test.neteco.es${path}`, {
            method,
            headers: { 'x-test-actor': actor.identityId, 'content-type': 'application/json' },
            body: method === 'POST' ? JSON.stringify({}) : undefined
          }),
          deps
        )

      it('un cliente sin rol recibe 403 forbidden en lectura y escritura', async () => {
        const read = await call(CUSTOMER, 'GET')
        expect(read?.status).toBe(403)
        expect(await read?.json()).toMatchObject({ error: { code: 'forbidden' } })
        const write = await call(CUSTOMER, 'POST', `${module.list}/create`)
        expect(write?.status).toBe(403)
      })

      it('un admin sin MFA o con sesión revocada no entra', async () => {
        expect((await call(NOMFA, 'GET'))?.status).toBe(403)
        expect((await call(REVOKED, 'GET'))?.status).toBe(401)
      })

      it('un admin con MFA lee el listado', async () => {
        const read = await call(ADMIN, 'GET')
        expect(read?.status).toBe(200)
      })
    })
  }

  it('la evaluación runtime pública sigue sin sesión (solo lectura de alcance)', async () => {
    const response = await handleProgressiveRolloutHttp(
      new Request('https://test.neteco.es/api/release/progressive-rollouts/eval', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ featureKey: 'nada_configurado', customerId: 'x', cohorts: [], zone: 'ES-MD' })
      }),
      deps
    )
    expect(response?.status).not.toBe(401)
    expect(response?.status).not.toBe(403)
  })
})
