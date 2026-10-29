import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { type CurateGuideInput, assertSeoSafeAiResponse } from '../../shared/seo-semantic-search'
import { answerGroundedAiSearch, curateEditorialGuide, getCuratedGuideBySlug } from '../../workers/seo/ai-search'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const CLAIMS = { identityId: ADMIN_ID, sessionId: '20000000-0000-4000-8000-000000000001', sessionVersion: 1 }

async function setupAiSearchDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0117_seo_technical_bot_logs_ai_search.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  // Seed roles & admin identity for curation commands
  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol administrador');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Gestión general'),
      ('catalog.write', 'catalog', 'write', 'Edición catálogo');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('admin', 'catalog.write');
    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin-seo@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('20000000-0000-4000-8000-000000000001', '${ADMIN_ID}', 1, 1, '${NOW}', '2026-10-30T12:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}');
  `)

  // Seed tax & shipping & catalog
  sqlite.exec(`
    INSERT OR IGNORE INTO tax_classes (id, code, name, rate_basis_points, valid_from) VALUES
      ('tax_std', 'STD', 'Estándar', 2100, '2020-01-01T00:00:00Z');
    INSERT OR IGNORE INTO shipping_profiles (id, code, name, kind) VALUES
      ('ship_std', 'STD', 'Estándar', 'parcel');

    INSERT INTO categories (id, slug, name, description, status) VALUES
      ('c1000000-0000-4000-8000-000000000001', 'desengrasantes', 'Desengrasantes', 'Química industrial', 'published');

    INSERT INTO products (id, category_id, slug, name, description, status, created_at, updated_at) VALUES
      ('a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'desengrasante-alcalino-5l', 'Desengrasante Alcalino Potente 5L', 'Limpiador desengrasante para hornos y campanas industriales', 'published', '${NOW}', '${NOW}'),
      ('a1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'desengrasante-experimental', 'Desengrasante Experimental En Pruebas', 'No publicado todavia', 'draft', '${NOW}', '${NOW}'),
      ('a1000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000001', 'desincrustante-antical-profesional', 'Desincrustante Ácido Antical 5L', 'Elimina cal e incrustaciones en tuberias y griferia', 'published', '${NOW}', '${NOW}');

    INSERT INTO variants (id, product_id, tax_class_id, shipping_profile_id, sku, format, status, price_gross_cents, created_at, updated_at) VALUES
      ('b1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'tax_std', 'ship_std', 'NET-DES-005', 'Garrafa 5L', 'published', 2490, '${NOW}', '${NOW}'),
      ('b1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', 'tax_std', 'ship_std', 'NET-EXP-999', 'Envase 1L', 'draft', 1990, '${NOW}', '${NOW}'),
      ('b1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000003', 'tax_std', 'ship_std', 'NET-CAL-005', 'Garrafa 5L', 'published', 2150, '${NOW}', '${NOW}');
  `)

  return sqlite
}

describe('SEO-032: Búsqueda semántica/IA sin sacrificar SEO base', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  beforeEach(async () => {
    sqlite = await setupAiSearchDatabase()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('answers semantic query citing strictly active published catalog items', async () => {
    const response = await answerGroundedAiSearch(db, {
      query: 'desengrasante industrial para campana extractora y cocina',
      now: () => NOW
    })

    expect(response.citations.length).toBeGreaterThanOrEqual(1)
    const citedSkus = response.citations.map((c) => c.sku)

    // The published product must be cited
    expect(citedSkus).toContain('NET-DES-005')

    // The draft product MUST NEVER be cited!
    expect(citedSkus).not.toContain('NET-EXP-999')

    const firstCitation = response.citations[0]
    expect(firstCitation?.title).toBe('Desengrasante Alcalino Potente 5L')
    expect(firstCitation?.canonicalUrl).toBe('/producto/desengrasante-alcalino-5l')
    expect(firstCitation?.priceCents).toBe(2490)
    expect(firstCitation?.inStock).toBe(true)

    // Grounding score is high because citations exist
    expect(response.groundingScore).toBeGreaterThanOrEqual(0.7)
  })

  it('enforces strict SEO guardrails: noindex enforced and isIndexable is false', async () => {
    const response = await answerGroundedAiSearch(db, {
      query: 'como limpiar cal persistente en sanitarios',
      now: () => NOW
    })

    // Strict requirements:
    // 1. isIndexable MUST be false
    expect(response.isIndexable).toBe(false)

    // 2. noindexEnforced MUST be true
    expect(response.noindexEnforced).toBe(true)

    // 3. Canonical URL MUST point to canonical category or product, NEVER to /buscar or query string
    expect(response.canonicalUrl).not.toContain('/buscar')
    expect(response.canonicalUrl).not.toContain('?')

    // Verify guardrail assertion does not throw
    expect(() => assertSeoSafeAiResponse(response)).not.toThrow()
  })

  it('handles empty matches gracefully without hallucinating products', async () => {
    const response = await answerGroundedAiSearch(db, {
      query: 'repuestos para automoviles electricos tesla',
      now: () => NOW
    })

    expect(response.citations.length).toBe(0)
    expect(response.groundingScore).toBe(0)
    expect(response.answerText).toContain('no disponemos de productos')
    expect(response.isIndexable).toBe(false)
  })

  it('supports editorial curation of high-value guides with CAS and authorization', async () => {
    const guideInput: CurateGuideInput = {
      expectedVersion: 0,
      topicQuery: 'guia desengrase campanas extractoras industriales',
      slug: 'guia-desengrase-campanas-industriales',
      title: 'Guía técnica: Desengrase profesional de campanas extractoras',
      approvedContent:
        'El desengrase de sistemas de extracción industrial requiere un desengrasante alcalino de alta concentración formulado específicamente para disolver grasas carbonizadas sin dañar el acero inoxidable. Se recomienda dilución al 20% y tiempo de contacto de 15 minutos antes del aclarado con agua caliente a presión.',
      productIds: ['a1000000-0000-4000-8000-000000000001'],
      isIndexable: true,
      metaDescription:
        'Protocolo técnico para la limpieza y desengrase de campanas extractoras en cocinas industriales.'
    }

    const commandResult = await curateEditorialGuide(db, CLAIMS, guideInput, {
      idempotencyKey: 'idemp-curate-1',
      now: () => NOW
    })

    expect(commandResult.guideId).toBeDefined()
    expect(commandResult.version).toBe(1)
    expect(commandResult.status).toBe('approved')

    // Retrieve curated guide by slug
    const guide = await getCuratedGuideBySlug(db, 'guia-desengrase-campanas-industriales')
    expect(guide).toBeDefined()
    expect(guide?.title).toBe(guideInput.title)
    expect(guide?.isIndexable).toBe(true)
    expect(guide?.canonicalUrl).toBe('/guias/guia-desengrase-campanas-industriales')

    // Idempotency: replaying same command returns existing receipt
    const replay = await curateEditorialGuide(db, CLAIMS, guideInput, {
      idempotencyKey: 'idemp-curate-1',
      now: () => NOW
    })
    expect(replay.guideId).toBe(commandResult.guideId)

    // CAS conflict check: updating with wrong expectedVersion fails
    await expect(
      curateEditorialGuide(
        db,
        CLAIMS,
        { ...guideInput, guideId: commandResult.guideId, expectedVersion: 0 },
        { idempotencyKey: 'idemp-curate-2', now: () => NOW }
      )
    ).rejects.toThrow(/version_conflict/)
  })
})
