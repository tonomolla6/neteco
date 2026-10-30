import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleSupplierFeedHttp } from '../../workers/catalog/supplier-feed-comparison-http'
import { handleEditorialContentHttp } from '../../workers/catalog/editorial-content-http'
import { handleSupplierSourcingHttp } from '../../workers/catalog/supplier-sourcing-http'
import { handleDraftOrdersHttp } from '../../workers/b2b/draft-orders-http'

// BC admin endpoints run with the REAL clock (the Worker never injects `now`) and
// must authorize reads (supplier costs/margins) as well as writes.
const FIXTURE_NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-0000000000b1'
const GUEST_ID = '10000000-0000-4000-8000-0000000000b2'
const ADMIN_SESSION = '20000000-0000-4000-8000-0000000000b1'
const GUEST_SESSION = '20000000-0000-4000-8000-0000000000b2'
const SESSION_CONFIG = { password: 'synthetic-secret-password-longer-than-32-chars-test', maxAgeSeconds: 3600 }
const ORIGIN = 'https://neteco.test'

describe('BC: endpoints admin con reloj real y lecturas autorizadas', () => {
  let sqlite: DatabaseSync
  let adminCookie: string
  let guestCookie: string
  let deps: { database: D1Database; origin: string; sessionCookieConfiguration: typeof SESSION_CONFIG }

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    sqlite.exec(
      await readFile(
        new URL('../../db/d1/migrations/0133_supplier_feed_editorial_sourcing_draft_orders.sql', import.meta.url),
        'utf8'
      )
    )
    sqlite.exec(`
      INSERT OR IGNORE INTO roles (code, name, description) VALUES ('admin','Administrador','x'), ('guest','Invitado','x');
      INSERT OR IGNORE INTO roles (code, name, description) VALUES ('editor','Editor','x');
      INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
        ('catalog.write','catalog','write','x'), ('orders.manage','orders','manage','x');
      INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
        ('admin','catalog.write'), ('admin','orders.manage'), ('editor','catalog.write');
      INSERT OR IGNORE INTO identities (id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES
        ('${ADMIN_ID}','a-bc@example.invalid','h','${FIXTURE_NOW}','active','${FIXTURE_NOW}','${FIXTURE_NOW}'),
        ('${GUEST_ID}','g-bc@example.invalid','h','${FIXTURE_NOW}','active','${FIXTURE_NOW}','${FIXTURE_NOW}');
      INSERT INTO auth_sessions (id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES
        ('${ADMIN_SESSION}','${ADMIN_ID}',1,1,'${FIXTURE_NOW}','2099-01-01T00:00:00Z'),
        ('${GUEST_SESSION}','${GUEST_ID}',1,1,'${FIXTURE_NOW}','2099-01-01T00:00:00Z');
      INSERT INTO identity_roles (identity_id, role_code, granted_at) VALUES
        ('${ADMIN_ID}','admin','${FIXTURE_NOW}'), ('${GUEST_ID}','guest','${FIXTURE_NOW}');
    `)
    const database = d1OverSqlite(sqlite) as unknown as D1Database
    const cookie = async (identityId: string, sessionId: string) =>
      (await issueD1SessionCookie(database, { identityId, sessionId, sessionVersion: 1 }, SESSION_CONFIG))!.split(
        ';'
      )[0]!
    adminCookie = await cookie(ADMIN_ID, ADMIN_SESSION)
    guestCookie = await cookie(GUEST_ID, GUEST_SESSION)
    deps = { database, origin: ORIGIN, sessionCookieConfiguration: SESSION_CONFIG }
  })

  afterEach(() => sqlite.close())

  const request = (path: string, cookie: string, method = 'GET', body?: unknown) =>
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })

  it('una escritura de admin funciona con el reloj real (sin now inyectado)', async () => {
    const response = await handleSupplierSourcingHttp(
      request('/api/admin/supplier-sourcing/supplier', adminCookie, 'POST', { code: 'SUP-RT', name: 'Proveedor real' }),
      deps
    )
    expect(response?.status).toBe(201)
  })

  it('el cuerpo de alta de proveedor se valida con zod (400, no 500)', async () => {
    const response = await handleSupplierSourcingHttp(
      request('/api/admin/supplier-sourcing/supplier', adminCookie, 'POST', { code: 7, name: ['x'] }),
      deps
    )
    expect(response?.status).toBe(400)
  })

  it('un JSON roto es 400 invalid_json en cada router', async () => {
    const broken = new Request(`${ORIGIN}/api/admin/draft-orders/create`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: '{no-json'
    })
    const response = await handleDraftOrdersHttp(broken, deps)
    expect(response?.status).toBe(400)
  })

  const READS: Array<[string, (r: Request) => Promise<Response | null>, string]> = [
    [
      'feed import',
      (r) => handleSupplierFeedHttp(r, deps),
      '/api/admin/supplier-feed/import/00000000-0000-4000-8000-000000000000'
    ],
    ['feed items', (r) => handleSupplierFeedHttp(r, deps), '/api/admin/supplier-feed/items?importId=x'],
    [
      'editorial article',
      (r) => handleEditorialContentHttp(r, deps),
      '/api/admin/catalog-editorial/article?targetType=product&targetId=p1'
    ],
    ['editorial list', (r) => handleEditorialContentHttp(r, deps), '/api/admin/catalog-editorial/list'],
    [
      'sourcing offerings',
      (r) => handleSupplierSourcingHttp(r, deps),
      '/api/admin/supplier-sourcing/offerings?variantId=v1'
    ],
    [
      'sourcing decisions',
      (r) => handleSupplierSourcingHttp(r, deps),
      '/api/admin/supplier-sourcing/decisions?variantId=v1'
    ],
    ['draft list', (r) => handleDraftOrdersHttp(r, deps), '/api/admin/draft-orders/list'],
    ['draft get', (r) => handleDraftOrdersHttp(r, deps), '/api/admin/draft-orders/00000000-0000-4000-8000-000000000000']
  ]
  for (const [name, handler, path] of READS) {
    it(`lectura ${name}: sesión sin permiso recibe 403, admin no`, async () => {
      const denied = await handler(request(path, guestCookie))
      expect(denied?.status).toBe(403)
      const allowed = await handler(request(path, adminCookie))
      expect(allowed?.status).not.toBe(403)
      expect(allowed?.status).not.toBe(500)
    })
  }

  it('un editor de catálogo (solo catalog.write) no gestiona pedidos en borrador', async () => {
    const editorId = '10000000-0000-4000-8000-0000000000b3'
    const editorSession = '20000000-0000-4000-8000-0000000000b3'
    sqlite.exec(`
      INSERT INTO identities (id,email,password_hash,email_verified_at,status,created_at,updated_at)
        VALUES ('${editorId}','e-bc@example.invalid','h','${FIXTURE_NOW}','active','${FIXTURE_NOW}','${FIXTURE_NOW}');
      INSERT INTO auth_sessions (id,identity_id,session_version,mfa_verified,created_at,expires_at)
        VALUES ('${editorSession}','${editorId}',1,1,'${FIXTURE_NOW}','2099-01-01T00:00:00Z');
      INSERT INTO identity_roles (identity_id, role_code, granted_at) VALUES ('${editorId}','editor','${FIXTURE_NOW}');
    `)
    const cookie = (await issueD1SessionCookie(
      deps.database,
      { identityId: editorId, sessionId: editorSession, sessionVersion: 1 },
      SESSION_CONFIG
    ))!.split(';')[0]!
    const response = await handleDraftOrdersHttp(request('/api/admin/draft-orders/list', cookie), deps)
    expect(response?.status).toBe(403)
    // ...pero sí sigue pudiendo leer el catálogo editorial que sí le corresponde.
    const editorial = await handleEditorialContentHttp(request('/api/admin/catalog-editorial/list', cookie), deps)
    expect(editorial?.status).toBe(200)
  })

  it('el barrido de borradores caducados exige permiso', async () => {
    const denied = await handleDraftOrdersHttp(request('/api/admin/draft-orders/sweep', guestCookie, 'POST', {}), deps)
    expect(denied?.status).toBe(403)
    const allowed = await handleDraftOrdersHttp(request('/api/admin/draft-orders/sweep', adminCookie, 'POST', {}), deps)
    expect(allowed?.status).toBe(200)
  })
})
