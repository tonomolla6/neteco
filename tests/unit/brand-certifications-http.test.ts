import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { handleBrandCenterHttp, ownsBrandCenterNamespace } from '../../workers/brand/brand-center-http'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'

const ADMIN_CLAIMS: VerifiedSessionClaims = {
  identityId: '10000000-0000-4000-8000-000000000021',
  sessionId: '20000000-0000-4000-8000-000000000021',
  sessionVersion: 1
}

const NOW = '2026-10-29T12:00:00Z'
const VALID_UNTIL = '2028-10-29T12:00:00Z'

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
      ('catalog.publish', 'catalog', 'publish', 'Publicar catálogo');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('admin', 'catalog.publish');
    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'admin-brand@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_CLAIMS.sessionId}', '${ADMIN_CLAIMS.identityId}', 1, 1, '${NOW}', '2026-10-30T12:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'admin', '${NOW}');
  `)
  return sqlite
}

describe('MED-021: Brand Center HTTP Endpoints', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('correctly matches ownsBrandCenterNamespace', () => {
    expect(ownsBrandCenterNamespace('/api/brand-center')).toBe(true)
    expect(ownsBrandCenterNamespace('/api/brand-center/certifications')).toBe(true)
    expect(ownsBrandCenterNamespace('/api/brand-center/verify/ER-0428-2021')).toBe(true)
    expect(ownsBrandCenterNamespace('/api/admin/brand-center/certifications')).toBe(true)
    expect(ownsBrandCenterNamespace('/api/admin/brand-center/partners')).toBe(true)
    expect(ownsBrandCenterNamespace('/api/catalog')).toBe(false)
  })

  it('serves brand center view and verifies valid certification via public HTTP API', async () => {
    // 1. Post a new certification as admin
    const postReq = new Request('https://neteco.es/api/admin/brand-center/certifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId: 'c2000000-0000-4000-8000-000000000001',
        standardCode: 'ECOLABEL-EU',
        title: 'Etiqueta Ecológica Europea EU Ecolabel (Decisión CE 2017/1217)',
        issuer: 'Comisión Europea / Ministerio para la Transición Ecológica',
        certificateNumber: 'ES-MD/020/001',
        scope: 'Detergentes para lavavajillas y limpiadores generales de bajo impacto acuático.',
        validFrom: NOW,
        validUntil: VALID_UNTIL,
        verificationUrl: 'https://ec.europa.eu/ecat/product/es-md-020-001',
        documentUrl: '/media/certificados/eu-ecolabel-es-md.pdf',
        auditedBy: 'Organismo Competente Autonómico ENAC'
      })
    })

    const postRes = await handleBrandCenterHttp(postReq, { database: db, claims: ADMIN_CLAIMS, now: NOW })
    expect(postRes?.status).toBe(201)

    // 2. Query public brand center view GET /api/brand-center
    const getBcReq = new Request('https://neteco.es/api/brand-center', { method: 'GET' })
    const bcRes = await handleBrandCenterHttp(getBcReq, { database: db, now: NOW })
    expect(bcRes?.status).toBe(200)
    const bcBody = await bcRes?.json()
    expect(bcBody.certifications).toHaveLength(1)
    expect(bcBody.certifications[0].standardCode).toBe('ECOLABEL-EU')

    // 3. Query public verification GET /api/brand-center/verify/:certNumber
    const verifyReq = new Request('https://neteco.es/api/brand-center/verify/ES-MD/020/001', { method: 'GET' })
    const verifyRes = await handleBrandCenterHttp(verifyReq, { database: db, now: NOW })
    expect(verifyRes?.status).toBe(200)
    const verifyBody = await verifyRes?.json()
    expect(verifyBody.certificateNumber).toBe('ES-MD/020/001')
    expect(verifyBody.status).toBe('active')
  })

  it('returns 404 for non-existent certificate lookup', async () => {
    const req = new Request('https://neteco.es/api/brand-center/verify/INVENTADO-999', { method: 'GET' })
    const res = await handleBrandCenterHttp(req, { database: db, now: NOW })
    expect(res?.status).toBe(404)
  })

  it('rejects unauthenticated requests to admin brand endpoints with 401', async () => {
    const req = new Request('https://neteco.es/api/admin/brand-center/certifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ standardCode: 'ISO-9001' })
    })
    const res = await handleBrandCenterHttp(req, { database: db, now: NOW })
    expect(res?.status).toBe(401)
    const body = await res?.json()
    expect(body.error?.code).toBe('unauthenticated')
  })

  it('returns 400 for malformed certification input', async () => {
    const req = new Request('https://neteco.es/api/admin/brand-center/certifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId: 'invalid',
        standardCode: 'NOT-EXIST'
      })
    })
    const res = await handleBrandCenterHttp(req, { database: db, claims: ADMIN_CLAIMS, now: NOW })
    expect(res?.status).toBe(400)
    const body = await res?.json()
    expect(body.error?.code).toBe('invalid_input')
  })
})
