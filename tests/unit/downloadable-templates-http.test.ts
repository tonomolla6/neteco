import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  handleDownloadableTemplatesHttp,
  ownsDownloadableTemplatesNamespace
} from '../../workers/content/downloadable-templates-http'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'

const ADMIN_CLAIMS: VerifiedSessionClaims = {
  identityId: '10000000-0000-4000-8000-000000000019',
  sessionId: '20000000-0000-4000-8000-000000000019',
  sessionVersion: 1
}

const NOW = '2026-10-29T12:00:00Z'
const REVIEW_DUE = '2027-10-29T12:00:00Z'

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0141_templates_brand_warehouse_adr.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol administrador');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Gestión general'),
      ('catalog.publish', 'catalog', 'publish', 'Publicar catálogo/contenido');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('admin', 'catalog.publish');
    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'admin-templates@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_CLAIMS.sessionId}', '${ADMIN_CLAIMS.identityId}', 1, 1, '${NOW}', '2026-10-30T12:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'admin', '${NOW}');
  `)
  return sqlite
}

describe('MED-019: Downloadable Templates HTTP Endpoints', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('correctly matches ownsDownloadableTemplatesNamespace', () => {
    expect(ownsDownloadableTemplatesNamespace('/api/templates')).toBe(true)
    expect(ownsDownloadableTemplatesNamespace('/api/templates/checklist-appcc')).toBe(true)
    expect(ownsDownloadableTemplatesNamespace('/api/templates/checklist-appcc/pdf')).toBe(true)
    expect(ownsDownloadableTemplatesNamespace('/api/admin/templates')).toBe(true)
    expect(ownsDownloadableTemplatesNamespace('/api/products')).toBe(false)
  })

  it('handles template creation via POST /api/admin/templates and public GET retrieval', async () => {
    const postReq = new Request('https://neteco.es/api/admin/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId: 'b1000000-0000-4000-8000-000000000001',
        slug: 'guia-higienizacion-superficies',
        title: 'Guía Práctica de Higienización de Superficies Alimentarias',
        description: 'Requisitos de desinfección y tiempos de contacto según norma UNE.',
        templateType: 'guide',
        category: 'alimentaria',
        targetAudience: 'Industria cárnica y conservera',
        sections: [
          {
            id: 'sec-1',
            title: 'Tiempos de Contacto',
            items: [
              { id: 'item-1', label: 'Respetar 5 minutos de tiempo de actuación antes del aclarado', mandatory: true }
            ]
          }
        ],
        reviewedAt: NOW,
        reviewDueAt: REVIEW_DUE
      })
    })

    const postRes = await handleDownloadableTemplatesHttp(postReq, { database: db, claims: ADMIN_CLAIMS, now: NOW })
    expect(postRes?.status).toBe(201)
    const postBody = await postRes?.json()
    expect(postBody.slug).toBe('guia-higienizacion-superficies')

    // Publish it
    const pubReq = new Request('https://neteco.es/api/admin/templates/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId: 'b1000000-0000-4000-8000-000000000002',
        templateId: postBody.id,
        expectedVersion: 1
      })
    })
    const pubRes = await handleDownloadableTemplatesHttp(pubReq, { database: db, claims: ADMIN_CLAIMS, now: NOW })
    expect(pubRes?.status).toBe(200)

    // Public list GET /api/templates
    const getListReq = new Request('https://neteco.es/api/templates?category=alimentaria', { method: 'GET' })
    const listRes = await handleDownloadableTemplatesHttp(getListReq, { database: db, now: NOW })
    expect(listRes?.status).toBe(200)
    const listBody = await listRes?.json()
    expect(listBody.items).toHaveLength(1)
    expect(listBody.items[0].slug).toBe('guia-higienizacion-superficies')

    // Public detail GET /api/templates/guia-higienizacion-superficies
    const getDetailReq = new Request('https://neteco.es/api/templates/guia-higienizacion-superficies', {
      method: 'GET'
    })
    const detailRes = await handleDownloadableTemplatesHttp(getDetailReq, { database: db, now: NOW })
    expect(detailRes?.status).toBe(200)
    const detailBody = await detailRes?.json()
    expect(detailBody.title).toBe('Guía Práctica de Higienización de Superficies Alimentarias')
    expect(detailBody.indexable).toBe(true)

    // PDF download GET /api/templates/guia-higienizacion-superficies/pdf
    const getPdfReq = new Request('https://neteco.es/api/templates/guia-higienizacion-superficies/pdf', {
      method: 'GET'
    })
    const pdfRes = await handleDownloadableTemplatesHttp(getPdfReq, { database: db, now: NOW })
    expect(pdfRes?.status).toBe(200)
    expect(pdfRes?.headers.get('Content-Type')).toBe('application/pdf')
    expect(pdfRes?.headers.get('Content-Disposition')).toContain(
      'attachment; filename="guia-higienizacion-superficies.pdf"'
    )
    const pdfBytes = new Uint8Array(await pdfRes!.arrayBuffer())
    expect(pdfBytes.length).toBeGreaterThan(100)
  })

  it('returns 404 for non-existent template slug', async () => {
    const req = new Request('https://neteco.es/api/templates/inexistente-1234', { method: 'GET' })
    const res = await handleDownloadableTemplatesHttp(req, { database: db, now: NOW })
    expect(res?.status).toBe(404)
  })

  it('rejects unauthenticated requests to admin endpoints with 401', async () => {
    const req = new Request('https://neteco.es/api/admin/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test' })
    })
    const res = await handleDownloadableTemplatesHttp(req, { database: db, now: NOW })
    expect(res?.status).toBe(401)
    const body = await res?.json()
    expect(body.error?.code).toBe('unauthenticated')
  })

  it('returns 400 for malformed input on admin template creation', async () => {
    const req = new Request('https://neteco.es/api/admin/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId: 'not-a-uuid',
        slug: 'INVALID SLUG',
        title: 'X'
      })
    })
    const res = await handleDownloadableTemplatesHttp(req, { database: db, claims: ADMIN_CLAIMS, now: NOW })
    expect(res?.status).toBe(400)
    const body = await res?.json()
    expect(body.error?.code).toBe('invalid_input')
  })
})
