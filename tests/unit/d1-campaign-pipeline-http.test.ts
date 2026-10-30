import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  handleCampaignPipelineHttp,
  ownsCampaignPipelineNamespace,
  type CampaignPipelineHttpDependencies
} from '../../workers/cms/campaign-pipeline-http'
import type { CampaignDocument } from '../../shared/campaign-pipeline'

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

const SAMPLE_DOC: CampaignDocument = {
  headline: 'Super Descuentos de Primavera',
  metaDescription: 'Descubre los mejores productos de limpieza y mantenimiento profesional.',
  sections: [
    {
      id: 'sec-hero',
      type: 'hero_banner',
      heading: 'Lotes Químicos al 15% Dto',
      headingLevel: 'h1',
      body: 'Ofertas exclusivas para profesionales.',
      ctaText: 'Ver oferta',
      ctaUrl: '/catalogo/primavera',
      ctaAriaLabel: 'Ver oferta de lotes químicos',
      imageUrl: 'https://cdn.neteco.es/spring.webp',
      imageAlt: 'Ofertas químicas de primavera',
      imageWidth: 800,
      imageHeight: 400,
      imageFormat: 'webp',
      imageBytesEstimate: 60000
    }
  ]
}

describe('CIC-031: HTTP endpoints del Pipeline de Campañas', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  const baseDeps: CampaignPipelineHttpDependencies = {
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

  it('reconoce el namespace HTTP administrativo y de preview', () => {
    expect(ownsCampaignPipelineNamespace('/api/admin/cms/campaign-pipeline')).toBe(true)
    expect(ownsCampaignPipelineNamespace('/api/admin/cms/campaign-pipeline/draft')).toBe(true)
    expect(ownsCampaignPipelineNamespace('/api/content/campaign-pipeline/preview')).toBe(true)
    expect(ownsCampaignPipelineNamespace('/api/admin/orders')).toBe(false)
  })

  it('permite previsualizar sin autenticación ni despliegue de código', async () => {
    const previewReq = new Request('https://test.neteco.es/api/content/campaign-pipeline/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document: SAMPLE_DOC, previewMode: true })
    })

    const previewRes = await handleCampaignPipelineHttp(previewReq, baseDeps)
    expect(previewRes?.status).toBe(200)
    const preview = await previewRes?.json()
    expect(preview.html).toContain('Lotes Químicos al 15% Dto')
    expect(preview.previewBanner).toBe(true)
  })

  it('permite guardar borrador y listar campañas vía HTTP para administradores', async () => {
    const draftReq = new Request('https://test.neteco.es/api/admin/cms/campaign-pipeline/draft', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-actor': ADMIN_ID,
        origin: 'https://test.neteco.es'
      },
      body: JSON.stringify({
        commandId: 'cmd-http-cmp-1',
        campaignSlug: 'primavera-2026',
        title: 'Campaña Primavera 2026',
        document: SAMPLE_DOC
      })
    })

    const draftRes = await handleCampaignPipelineHttp(draftReq, baseDeps)
    expect(draftRes?.status).toBe(201)
    const created = await draftRes?.json()
    expect(created.campaignSlug).toBe('primavera-2026')
    expect(created.status).toBe('draft')

    // Listado
    const listReq = new Request('https://test.neteco.es/api/admin/cms/campaign-pipeline', {
      method: 'GET',
      headers: { 'x-test-actor': ADMIN_ID }
    })
    const listRes = await handleCampaignPipelineHttp(listReq, baseDeps)
    expect(listRes?.status).toBe(200)
    const list = await listRes?.json()
    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBeGreaterThan(0)
  })
})
