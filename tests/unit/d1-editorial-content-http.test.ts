import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleEditorialContentHttp,
  ownsEditorialContentNamespace,
  type EditorialContentHttpDependencies
} from '../../workers/catalog/editorial-content-http'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000019'
const GUEST_ID = '90000000-0000-4000-8000-000000000099'
const SESSION_CONFIG = { password: 'synthetic-secret-password-longer-than-32-chars-test', maxAgeSeconds: 3600 }

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0133_supplier_feed_editorial_sourcing_draft_orders.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol admin'),
      ('guest', 'Invitado', 'Sin permisos');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('catalog.write', 'catalog', 'write', 'Edición catálogo');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'catalog.write');
    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin-editorial-http@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
      ('${GUEST_ID}', 'guest-editorial-http@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('20000000-0000-4000-8000-000000000019', '${ADMIN_ID}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z'),
      ('20000000-0000-4000-8000-000000000099', '${GUEST_ID}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}'),
      ('${GUEST_ID}', 'guest', '${NOW}');
  `)

  return sqlite
}

describe('CAT-019: Editorial Content HTTP Handlers', () => {
  let sqlite: DatabaseSync
  let d1: ReturnType<typeof d1OverSqlite>
  let adminCookie: string
  let guestCookie: string

  beforeEach(async () => {
    sqlite = await setupTestDb()
    d1 = d1OverSqlite(sqlite)

    const rawAdmin = await issueD1SessionCookie(
      d1,
      { identityId: ADMIN_ID, sessionId: '20000000-0000-4000-8000-000000000019', sessionVersion: 1 },
      SESSION_CONFIG
    )
    adminCookie = rawAdmin!.split(';')[0]!

    const rawGuest = await issueD1SessionCookie(
      d1,
      { identityId: GUEST_ID, sessionId: '20000000-0000-4000-8000-000000000099', sessionVersion: 1 },
      SESSION_CONFIG
    )
    guestCookie = rawGuest!.split(';')[0]!
  })

  afterEach(() => {
    sqlite?.close()
  })

  const deps = (): EditorialContentHttpDependencies => ({
    database: d1,
    origin: 'https://neteco.test',
    sessionCookieConfiguration: SESSION_CONFIG,
    now: () => NOW
  })

  it('recognizes namespace correctly', () => {
    expect(ownsEditorialContentNamespace('/api/admin/catalog-editorial/upsert')).toBe(true)
    expect(ownsEditorialContentNamespace('/api/admin/catalog-editorial/article')).toBe(true)
    expect(ownsEditorialContentNamespace('/api/public/editorial')).toBe(false)
  })

  it('rejects unauthenticated requests with 401', async () => {
    const req = new Request('https://neteco.test/api/admin/catalog-editorial/upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType: 'product', targetId: 'p1' })
    })

    const res = await handleEditorialContentHttp(req, deps())
    expect(res?.status).toBe(401)
  })

  it('rejects requests from users without catalog.write with 403', async () => {
    const req = new Request('https://neteco.test/api/admin/catalog-editorial/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: guestCookie
      },
      body: JSON.stringify({
        targetType: 'product',
        targetId: 'p-guest',
        title: 'Guía Guest',
        summary: 'Resumen técnico para pruebas de autorización.',
        bodyMarkdown: 'Contenido técnico que supera al proveedor en todos los aspectos.',
        applicationScope: 'Hostelería',
        surfaceCompatibility: { compatible: ['Gres'], incompatible: [] },
        dilutionDosageGuide: 'Diluir al 5% en agua',
        safetyAndPpe: { requiredPpe: ['Guantes'], hazardWarnings: ['Irritante'] }
      })
    })

    const res = await handleEditorialContentHttp(req, deps())
    expect(res?.status).toBe(403)
  })

  it('rejects editorial content that duplicates supplier raw feed text (422)', async () => {
    const supplierText = 'Detergente clorado espumante concentrado para limpieza de suelos y paredes en mataderos.'
    const req = new Request('https://neteco.test/api/admin/catalog-editorial/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: adminCookie
      },
      body: JSON.stringify({
        targetType: 'product',
        targetId: 'prod-cloro-dupe',
        title: 'Detergente Clorado Espumante',
        summary: 'Resumen descriptivo del producto para pruebas.',
        bodyMarkdown:
          'Detergente clorado espumante concentrado para limpieza de suelos y paredes en mataderos de pollos.',
        applicationScope: 'Industria cárnica',
        surfaceCompatibility: { compatible: ['Inox'], incompatible: [] },
        dilutionDosageGuide: 'Dilución al 3%',
        safetyAndPpe: { requiredPpe: ['Guantes'], hazardWarnings: ['Corrosivo'] },
        supplierReferenceText: supplierText
      })
    })

    const res = await handleEditorialContentHttp(req, deps())
    expect(res?.status).toBe(422)
    const body = await res?.json()
    expect(body).toEqual({ error: { code: 'supplier_content_duplicated' } })
  })

  it('handles full lifecycle: upsert product editorial, retrieve, review/publish with CAS, and list', async () => {
    // 1. Upsert product editorial
    const upsertReq = new Request('https://neteco.test/api/admin/catalog-editorial/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: adminCookie
      },
      body: JSON.stringify({
        targetType: 'product',
        targetId: 'prod-biocida-pro',
        title: 'Protocolo de Desinfección Terminal en Quirófanos y Salas Blancas',
        summary: 'Procedimiento técnico exhaustivo para desinfección ambiental y de superficies de alto contacto.',
        bodyMarkdown:
          'Protocolo para aplicación del biocida de amplio espectro en áreas de aislamiento y quirófanos. Actividad bactericida y virucida certificada UNE-EN 14476 y UNE-EN 13697. Despejar la sala, aplicar nebulización en frío a 15 ml/m3 manteniendo tiempo de contacto de 30 minutos. Tras la desinfección, ventilar durante 20 minutos antes de la entrada del personal sanitario. Compatible con policarbonato, metacrilato e inox AISI 316L.',
        applicationScope: 'Salas blancas y bloques quirúrgicos hospitalarios',
        surfaceCompatibility: {
          compatible: ['Policarbonato', 'Metacrilato', 'Acero inoxidable AISI 316L'],
          incompatible: ['Goma natural sin tratar']
        },
        dilutionDosageGuide: 'Uso directo mediante cañón nebulizador en frío (15 ml por m3 cúbico)',
        safetyAndPpe: {
          requiredPpe: ['Máscara facial completa con filtros A2P3', 'Mono de protección química Tipo 4B'],
          hazardWarnings: [
            'Peligro de inhalación en fase aérea',
            'Mantener precintada la sala durante el plazo de seguridad'
          ]
        },
        technicalStandards: ['UNE-EN 14476', 'UNE-EN 13697', 'Directiva Biocidas UE 528/2012'],
        supplierReferenceText: 'Biocida para quirófanos.'
      })
    })

    const upsertRes = await handleEditorialContentHttp(upsertReq, deps())
    expect(upsertRes?.status).toBe(200)
    const article = (await upsertRes?.json()) as { id: string; targetId: string; status: string; version: number }
    expect(article.id).toBeDefined()
    expect(article.targetId).toBe('prod-biocida-pro')
    expect(article.status).toBe('draft')

    // 2. Retrieve via GET
    const getReq = new Request(
      'https://neteco.test/api/admin/catalog-editorial/article?targetType=product&targetId=prod-biocida-pro',
      {
        method: 'GET',
        headers: { cookie: adminCookie }
      }
    )
    const getRes = await handleEditorialContentHttp(getReq, deps())
    expect(getRes?.status).toBe(200)
    const fetched = (await getRes?.json()) as { title: string }
    expect(fetched.title).toContain('Protocolo de Desinfección Terminal')

    // 3. Review / Publish with CAS
    const reviewReq = new Request('https://neteco.test/api/admin/catalog-editorial/review', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: adminCookie
      },
      body: JSON.stringify({
        articleId: article.id,
        decision: 'published',
        expectedVersion: article.version,
        reviewNotes: 'Validado por comision de bioseguridad'
      })
    })

    const reviewRes = await handleEditorialContentHttp(reviewReq, deps())
    expect(reviewRes?.status).toBe(200)
    const published = (await reviewRes?.json()) as { status: string; version: number }
    expect(published.status).toBe('published')
    expect(published.version).toBe(2)

    // 4. List articles
    const listReq = new Request(
      'https://neteco.test/api/admin/catalog-editorial/list?targetType=product&status=published',
      {
        method: 'GET',
        headers: { cookie: adminCookie }
      }
    )
    const listRes = await handleEditorialContentHttp(listReq, deps())
    expect(listRes?.status).toBe(200)
    const listData = (await listRes?.json()) as Array<{ id: string }>
    expect(listData).toHaveLength(1)
  })
})
