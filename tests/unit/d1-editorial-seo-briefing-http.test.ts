import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleEditorialBriefingHttp,
  ownsEditorialBriefingNamespace,
  type EditorialBriefingHttpDependencies
} from '../../workers/cms/editorial-seo-briefing-http'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000029'
const NON_ADMIN_ID = '10000000-0000-4000-8000-000000000099'
const SESSION_PASSWORD = 'test-session-password-at-least-32-chars-long!!'
const ORIGIN = 'https://neteco.beply.es'

async function setupHttpDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0132_editorial_seo_commercial_warehouse_scan.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol administrador'),
      ('customer', 'Cliente', 'Rol cliente');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Gestión general'),
      ('catalog.write', 'catalog', 'write', 'Edición catálogo');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('admin', 'catalog.write');

    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin-briefing@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
      ('${NON_ADMIN_ID}', 'user-briefing@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('20000000-0000-4000-8000-000000000029', '${ADMIN_ID}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z'),
      ('20000000-0000-4000-8000-000000000099', '${NON_ADMIN_ID}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}'),
      ('${NON_ADMIN_ID}', 'customer', '${NOW}');
  `)

  return sqlite
}

async function makeCookie(db: D1Database, identityId: string, sessionId: string): Promise<string> {
  const cookie = await issueD1SessionCookie(
    db,
    { identityId, sessionId, sessionVersion: 1 },
    { password: SESSION_PASSWORD, maxAgeSeconds: 3600 }
  )
  return cookie?.split(';')[0] ?? ''
}

describe('ADM-029: Editorial Briefing HTTP Endpoints', () => {
  let sqlite: DatabaseSync
  let db: D1Database
  let deps: EditorialBriefingHttpDependencies
  let adminCookie: string
  let nonAdminCookie: string

  beforeEach(async () => {
    sqlite = await setupHttpDb()
    db = d1OverSqlite(sqlite)
    adminCookie = await makeCookie(db, ADMIN_ID, '20000000-0000-4000-8000-000000000029')
    nonAdminCookie = await makeCookie(db, NON_ADMIN_ID, '20000000-0000-4000-8000-000000000099')
    deps = {
      database: db,
      origin: ORIGIN,
      sessionCookieConfiguration: { password: SESSION_PASSWORD, maxAgeSeconds: 3600 },
      now: () => NOW
    }
  })

  afterEach(() => {
    sqlite.close()
  })

  it('matches routing namespace', () => {
    expect(ownsEditorialBriefingNamespace('/api/admin/cms/briefings')).toBe(true)
    expect(ownsEditorialBriefingNamespace('/api/admin/cms/briefings/123')).toBe(true)
    expect(ownsEditorialBriefingNamespace('/api/admin/cms/editorial-calendar-briefings')).toBe(true)
    expect(ownsEditorialBriefingNamespace('/api/catalog/products')).toBe(false)
  })

  it('POST /api/admin/cms/briefings creates briefing for admin', async () => {
    const req = new Request(`${ORIGIN}/api/admin/cms/briefings`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie,
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        'X-Command-Id': '30000000-0000-4000-8000-000000000050'
      },
      body: JSON.stringify({
        topic: 'Desengrasantes biodegradables para industria alimentaria',
        searchIntent: 'commercial',
        targetKeyword: 'desengrasante biodegradable alimentario',
        secondaryKeywords: ['haccp limpieza', 'registro nsf a1'],
        expertAuthor: {
          name: 'Dr. Alejandro Peña',
          credentials: 'Ingeniero Químico, Auditor IFS/BRC'
        },
        sources: [
          {
            title: 'Norma UNE-EN 13697: Antisépticos y desinfectantes químicos',
            citation: 'AENOR 2015',
            verified: true
          }
        ],
        assets: [],
        targetPublishDate: '2026-11-20',
        updateCadenceMonths: 12,
        kpiTargets: {
          targetMonthlyVisits: 1200,
          targetSerpRank: 2,
          conversionGoal: 'Lead B2B alimentario'
        }
      })
    })

    const res = await handleEditorialBriefingHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(201)

    const data = (await res!.json()) as Record<string, unknown>
    expect(data.id).toBeDefined()
    expect(data.searchIntent).toBe('commercial')
  })

  it('GET /api/admin/cms/editorial-calendar-briefings returns calendar snapshot', async () => {
    const req = new Request(`${ORIGIN}/api/admin/cms/editorial-calendar-briefings?month=2026-11`, {
      method: 'GET',
      headers: {
        Cookie: adminCookie,
        Origin: ORIGIN
      }
    })

    const res = await handleEditorialBriefingHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)

    const data = (await res!.json()) as Record<string, unknown>
    expect(data.month).toBe('2026-11')
    expect(data.briefings).toBeInstanceOf(Array)
  })

  it('rejects unauthenticated and unauthorized requests', async () => {
    const reqNoAuth = new Request(`${ORIGIN}/api/admin/cms/briefings`, {
      method: 'GET',
      headers: { Origin: ORIGIN }
    })
    const resNoAuth = await handleEditorialBriefingHttp(reqNoAuth, deps)
    expect(resNoAuth!.status).toBe(401)

    const reqForbidden = new Request(`${ORIGIN}/api/admin/cms/briefings`, {
      method: 'GET',
      headers: { Cookie: nonAdminCookie, Origin: ORIGIN }
    })
    const resForbidden = await handleEditorialBriefingHttp(reqForbidden, deps)
    expect(resForbidden!.status).toBe(403)
  })
})
