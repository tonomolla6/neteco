import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleCommercialQuotesAccountsHttp,
  ownsCommercialQuotesAccountsNamespace,
  type CommercialQuotesAccountsHttpDependencies
} from '../../workers/catalog/commercial-quotes-accounts-http'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000030'
const NON_ADMIN_ID = '10000000-0000-4000-8000-000000000099'
const CUSTOMER_ID = '40000000-0000-4000-8000-000000000001'
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
      ('sales', 'Comercial', 'Rol comercial'),
      ('customer', 'Cliente', 'Rol cliente');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Gestión general'),
      ('sales.manage', 'sales', 'manage', 'Gestión comercial');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('admin', 'sales.manage'),
      ('sales', 'sales.manage');

    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'sales-http@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
      ('${NON_ADMIN_ID}', 'user-comm@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('20000000-0000-4000-8000-000000000030', '${ADMIN_ID}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z'),
      ('20000000-0000-4000-8000-000000000099', '${NON_ADMIN_ID}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}'),
      ('${NON_ADMIN_ID}', 'customer', '${NOW}');

    INSERT OR IGNORE INTO customers (id, name, status, created_at, updated_at) VALUES
      ('${CUSTOMER_ID}', 'Jaime Ortiz', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO companies (id, customer_id, legal_name, status, created_at, updated_at) VALUES
      ('comp-002', '${CUSTOMER_ID}', 'Químicas de Levante', 'approved', '${NOW}', '${NOW}');
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

describe('ADM-030: Commercial Quotes & Accounts HTTP Endpoints', () => {
  let sqlite: DatabaseSync
  let db: D1Database
  let deps: CommercialQuotesAccountsHttpDependencies
  let adminCookie: string
  let nonAdminCookie: string

  beforeEach(async () => {
    sqlite = await setupHttpDb()
    db = d1OverSqlite(sqlite)
    adminCookie = await makeCookie(db, ADMIN_ID, '20000000-0000-4000-8000-000000000030')
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
    expect(ownsCommercialQuotesAccountsNamespace('/api/admin/commercial/pipeline')).toBe(true)
    expect(ownsCommercialQuotesAccountsNamespace('/api/admin/commercial/next-actions')).toBe(true)
    expect(ownsCommercialQuotesAccountsNamespace('/api/admin/commercial/quotes/margins')).toBe(true)
    expect(ownsCommercialQuotesAccountsNamespace('/api/public/store')).toBe(false)
  })

  it('GET /api/admin/commercial/pipeline returns pipeline with ERP disclaimer', async () => {
    const req = new Request(`${ORIGIN}/api/admin/commercial/pipeline`, {
      method: 'GET',
      headers: {
        Cookie: adminCookie,
        Origin: ORIGIN
      }
    })

    const res = await handleCommercialQuotesAccountsHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)

    const data = (await res!.json()) as Record<string, unknown>
    expect(data.erpDisclaimer).toBeDefined()
    expect(data.stages).toBeDefined()
  })

  it('POST /api/admin/commercial/next-actions creates action with validation', async () => {
    const req = new Request(`${ORIGIN}/api/admin/commercial/next-actions`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie,
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        'X-Command-Id': '30000000-0000-4000-8000-000000000055'
      },
      body: JSON.stringify({
        customerId: CUSTOMER_ID,
        actionDescription: 'Llamada de seguimiento tras envío de muestra de abrillantador',
        dueDate: '2026-11-03',
        priority: 'urgent',
        assignedIdentityId: ADMIN_ID
      })
    })

    const res = await handleCommercialQuotesAccountsHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(201)

    const data = (await res!.json()) as Record<string, unknown>
    expect(data.id).toBeDefined()
    expect(data.priority).toBe('urgent')
  })

  it('rejects unauthorized access for commercial endpoints', async () => {
    const req = new Request(`${ORIGIN}/api/admin/commercial/pipeline`, {
      method: 'GET',
      headers: {
        Cookie: nonAdminCookie,
        Origin: ORIGIN
      }
    })

    const res = await handleCommercialQuotesAccountsHttp(req, deps)
    expect(res!.status).toBe(403)
  })
})
