import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { handleSeoHttp, ownsSeoNamespace } from '../../workers/seo/seo-http'
import { SEO_AI_SEARCH_ROBOTS_HEADER } from '../../shared/seo-semantic-search'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const SESSION_ID = '20000000-0000-4000-8000-000000000001'
const SESSION_PASSWORD = 'test-session-password-at-least-32-chars-long!!'

async function setupHttpDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0117_seo_technical_bot_logs_ai_search.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

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
      ('${ADMIN_ID}', 'admin-seo-http@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${SESSION_ID}', '${ADMIN_ID}', 1, 1, '${NOW}', '2026-10-30T12:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}');
  `)

  // Sample catalog item
  sqlite.exec(`
    INSERT OR IGNORE INTO tax_classes (id, code, name, rate_basis_points, valid_from) VALUES
      ('tax_std', 'STD', 'Estándar', 2100, '2020-01-01T00:00:00Z');
    INSERT OR IGNORE INTO shipping_profiles (id, code, name, kind) VALUES
      ('ship_std', 'STD', 'Estándar', 'parcel');

    INSERT INTO categories (id, slug, name, description, status) VALUES
      ('c1000000-0000-4000-8000-000000000001', 'desengrasantes', 'Desengrasantes', 'Desc', 'published');
    INSERT INTO products (id, category_id, slug, name, description, status, created_at, updated_at) VALUES
      ('a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'desengrasante-fuerte', 'Desengrasante Fuerte 5L', 'Para hornos', 'published', '${NOW}', '${NOW}');
    INSERT INTO variants (id, product_id, tax_class_id, shipping_profile_id, sku, format, status, price_gross_cents, created_at, updated_at) VALUES
      ('b1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'tax_std', 'ship_std', 'NET-DSG-001', 'Garrafa 5L', 'published', 2500, '${NOW}', '${NOW}');
  `)

  return sqlite
}

async function makeAdminCookie(database: D1Database): Promise<string> {
  const issued = await issueD1SessionCookie(
    database,
    {
      identityId: ADMIN_ID,
      sessionId: SESSION_ID,
      sessionVersion: 1
    },
    { password: SESSION_PASSWORD, maxAgeSeconds: 3600 }
  )
  return issued!.split(';')[0]!
}

describe('SEO HTTP Router & Dispatcher', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  beforeEach(async () => {
    sqlite = await setupHttpDatabase()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('matches SEO namespace correctly including encoded paths', () => {
    expect(ownsSeoNamespace('/api/admin/seo/crawl/run')).toBe(true)
    expect(ownsSeoNamespace('/api/admin/seo/bots/summary')).toBe(true)
    expect(ownsSeoNamespace('/api/search/ai')).toBe(true)
    expect(ownsSeoNamespace('/api%2Fsearch%2Fai')).toBe(true)
    expect(ownsSeoNamespace('/api/admin/catalogo')).toBe(false)
  })

  it('handles public POST /api/search/ai with strict SEO noindex headers', async () => {
    const request = new Request('https://neteco.beply.es/api/search/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'desengrasante hornos' })
    })

    const response = await handleSeoHttp(request, {
      database: db,
      origin: 'https://neteco.beply.es',
      sessionCookieConfiguration: { password: SESSION_PASSWORD, maxAgeSeconds: 3600 },
      now: () => NOW
    })

    expect(response).toBeDefined()
    expect(response?.status).toBe(200)

    // Verify strict SEO protection headers
    expect(response?.headers.get('x-robots-tag')).toBe(SEO_AI_SEARCH_ROBOTS_HEADER)
    expect(response?.headers.get('cache-control')).toContain('private, no-store')

    const body = (await response?.json()) as {
      query: string
      isIndexable: boolean
      noindexEnforced: boolean
      citations: unknown[]
    }
    expect(body.query).toBe('desengrasante hornos')
    expect(body.isIndexable).toBe(false)
    expect(body.noindexEnforced).toBe(true)
    expect(body.citations.length).toBeGreaterThanOrEqual(1)
  })

  it('handles admin crawl endpoints with authentication', async () => {
    const cookie = await makeAdminCookie(db)

    // 1. Trigger crawl
    const runReq = new Request('https://neteco.beply.es/api/admin/seo/crawl/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ triggerType: 'manual', seedUrls: ['/'] })
    })

    const runRes = await handleSeoHttp(runReq, {
      database: db,
      origin: 'https://neteco.beply.es',
      sessionCookieConfiguration: { password: SESSION_PASSWORD, maxAgeSeconds: 3600 },
      now: () => NOW
    })

    expect(runRes?.status).toBe(200)
    const runJson = (await runRes?.json()) as { id: string; status: string }
    expect(runJson.id).toBeDefined()
    expect(runJson.status).toBe('completed')

    // 2. List crawls
    const listReq = new Request('https://neteco.beply.es/api/admin/seo/crawl/runs', {
      headers: { Cookie: cookie }
    })
    const listRes = await handleSeoHttp(listReq, {
      database: db,
      origin: 'https://neteco.beply.es',
      sessionCookieConfiguration: { password: SESSION_PASSWORD, maxAgeSeconds: 3600 },
      now: () => NOW
    })
    expect(listRes?.status).toBe(200)
    const listJson = (await listRes?.json()) as unknown[]
    expect(listJson.length).toBeGreaterThanOrEqual(1)
  })

  it('handles bot log ingestion and waste summary', async () => {
    const cookie = await makeAdminCookie(db)

    // 1. Ingest bot log
    const logReq = new Request('https://neteco.beply.es/api/admin/seo/bots/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        userAgent: 'Googlebot/2.1',
        ip: '66.249.66.1',
        path: '/producto/desengrasante-fuerte',
        statusCode: 200,
        isVerifiedBotHeader: true
      })
    })

    const logRes = await handleSeoHttp(logReq, {
      database: db,
      origin: 'https://neteco.beply.es',
      sessionCookieConfiguration: { password: SESSION_PASSWORD, maxAgeSeconds: 3600 },
      now: () => NOW
    })
    expect(logRes?.status).toBe(200)

    // 2. Summary
    const sumReq = new Request('https://neteco.beply.es/api/admin/seo/bots/summary', {
      headers: { Cookie: cookie }
    })
    const sumRes = await handleSeoHttp(sumReq, {
      database: db,
      origin: 'https://neteco.beply.es',
      sessionCookieConfiguration: { password: SESSION_PASSWORD, maxAgeSeconds: 3600 },
      now: () => NOW
    })
    expect(sumRes?.status).toBe(200)
    const sumJson = (await sumRes?.json()) as { totalCrawls: number; verifiedBotCrawls: number }
    expect(sumJson.totalCrawls).toBeGreaterThanOrEqual(1)
    expect(sumJson.verifiedBotCrawls).toBeGreaterThanOrEqual(1)
  })

  it('blocks unauthenticated requests to admin endpoints', async () => {
    const req = new Request('https://neteco.beply.es/api/admin/seo/crawl/runs')
    const res = await handleSeoHttp(req, {
      database: db,
      origin: 'https://neteco.beply.es',
      sessionCookieConfiguration: { password: SESSION_PASSWORD, maxAgeSeconds: 3600 },
      now: () => NOW
    })
    expect(res?.status).toBe(401)
  })
})
