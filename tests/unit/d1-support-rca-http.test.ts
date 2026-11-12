import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleSupportRcaHttp,
  ownsSupportRcaNamespace,
  type SupportRcaHttpDependencies
} from '../../workers/support/rca-http'
import { testUuid } from '../support/deterministic'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000001'
const CLAIMS = { identityId: ADMIN_ID, sessionId: ADMIN_SESSION, sessionVersion: 1 }

const OPERATOR_NO_PERM_ID = '10000000-0000-4000-8000-000000000002'
const OPERATOR_NO_PERM_SESSION = '20000000-0000-4000-8000-000000000002'
const NO_PERM_CLAIMS = { identityId: OPERATOR_NO_PERM_ID, sessionId: OPERATOR_NO_PERM_SESSION, sessionVersion: 1 }

const CONFIG = { password: 'synthetic-rca-session-password-0123456789abcdef', maxAgeSeconds: 3600 }
const ORIGIN = 'https://admin.neteco.test'

async function setupHttpDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  sqlite.exec(await readFile(new URL('../../db/d1/migrations/0110_rca_copilot_audiences.sql', import.meta.url), 'utf8'))

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administración', 'Fixture admin'),
      ('operator', 'Operador', 'Fixture operator');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('support.manage', 'support', 'manage', 'Fixture support manage'),
      ('support.rca', 'support', 'rca', 'Fixture support rca');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'support.manage'),
      ('admin', 'support.rca');

    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, session_version, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin@example.invalid', 'hash', '${NOW}', 'active', 1, '${NOW}', '${NOW}'),
      ('${OPERATOR_NO_PERM_ID}', 'noperm@example.invalid', 'hash', '${NOW}', 'active', 1, '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_SESSION}', '${ADMIN_ID}', 1, 1, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'),
      ('${OPERATOR_NO_PERM_SESSION}', '${OPERATOR_NO_PERM_ID}', 1, 1, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}');
  `)
  return sqlite
}

describe('SUP-018: Support RCA HTTP endpoints', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>
  let adminCookie: string
  let noPermCookie: string
  let deps: SupportRcaHttpDependencies

  beforeEach(async () => {
    sqlite = await setupHttpDatabase()
    db = d1OverSqlite(sqlite)

    const cookieVal1 = await issueD1SessionCookie(db, CLAIMS, CONFIG)
    adminCookie = cookieVal1!.split(';')[0]!

    const cookieVal2 = await issueD1SessionCookie(db, NO_PERM_CLAIMS, CONFIG)
    noPermCookie = cookieVal2!.split(';')[0]!

    deps = {
      database: db as unknown as D1Database,
      sessionCookieConfiguration: CONFIG,
      origin: ORIGIN,
      edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
      rateLimitPepper: 'pepper-1234567890abcdef',
      now: () => NOW
    }
  })

  afterEach(() => {
    sqlite.close()
  })

  it('recognizes RCA namespace correctly', () => {
    expect(ownsSupportRcaNamespace('/api/admin/support/rca')).toBe(true)
    expect(ownsSupportRcaNamespace('/api/admin/support/rca/123')).toBe(true)
    expect(ownsSupportRcaNamespace('/api/admin/support/rca/123/verify')).toBe(true)
    expect(ownsSupportRcaNamespace('/api/admin/support/tickets')).toBe(false)
  })

  it('enforces authentication (401 when no cookie is sent)', async () => {
    const req = new Request(`${ORIGIN}/api/admin/support/rca`, {
      method: 'GET'
    })
    const res = await handleSupportRcaHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(401)
  })

  it('enforces permissions (403 when user lacks support.rca or support.manage)', async () => {
    const req = new Request(`${ORIGIN}/api/admin/support/rca`, {
      method: 'GET',
      headers: { Cookie: noPermCookie }
    })
    const res = await handleSupportRcaHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  it('allows authorized admin to list and create RCAs', async () => {
    // List initially empty
    const listReq = new Request(`${ORIGIN}/api/admin/support/rca`, {
      method: 'GET',
      headers: { Cookie: adminCookie }
    })
    const listRes = await handleSupportRcaHttp(listReq, deps)
    expect(listRes!.status).toBe(200)
    const listBody = (await listRes!.json()) as { items: unknown[] }
    expect(listBody.items).toEqual([])

    // Create RCA
    const createReq = new Request(`${ORIGIN}/api/admin/support/rca`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'http-idemp-1'
      },
      body: JSON.stringify({
        incidentCategory: 'documentation',
        title: 'Ficha de seguridad química desactualizada en pedido B2B',
        severity: 'high',
        rootCauseSummary: 'FDS no sincronizada con versión REACH 2026',
        fiveWhys: [
          'FDS antigua',
          'Sin alerta de caducidad documental',
          'Sin responsable asignado',
          'Migración documental previa',
          'Falta de auditoría periódica'
        ],
        preventiveActions: [
          {
            id: testUuid(),
            actionType: 'documentation_template',
            description: 'Implementar revisión periódica automatizada de FDS y anexos ADR',
            assignee: 'Responsable Reglamentario',
            targetDate: '2026-11-20T00:00:00Z',
            status: 'pending'
          }
        ]
      })
    })

    const createRes = await handleSupportRcaHttp(createReq, deps)
    expect(createRes!.status).toBe(201)
    const created = (await createRes!.json()) as { rcaId: string; publicRef: string }
    expect(created.rcaId).toBeDefined()
    expect(created.publicRef).toMatch(/^RCA-/)

    // Security headers verification
    expect(createRes!.headers.get('cache-control')).toBe('private, no-store')
    expect(createRes!.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('returns 400 for malformed payload', async () => {
    const badReq = new Request(`${ORIGIN}/api/admin/support/rca`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'http-idemp-bad'
      },
      body: JSON.stringify({
        title: 'Corto' // Missing incidentCategory, rootCauseSummary, etc.
      })
    })

    const res = await handleSupportRcaHttp(badReq, deps)
    expect(res!.status).toBe(400)
    const body = (await res!.json()) as { error: { code: string } }
    expect(body.error.code).toBe('invalid_input')
  })

  it('rejects access with 403 when session authorization expires mid-operation', async () => {
    let count = 0
    const req = new Request(`${ORIGIN}/api/admin/support/rca`, {
      method: 'GET',
      headers: { Cookie: adminCookie }
    })
    const proxyDeps = {
      ...deps,
      now: () => {
        count++
        if (count > 1) {
          return '2027-02-01T00:00:00Z'
        }
        return NOW
      }
    }
    const res = await handleSupportRcaHttp(req, proxyDeps)
    expect(res!.status).toBe(403)
    const body = (await res!.json()) as { error: { code: string } }
    expect(body.error.code).toBe('forbidden')
  })
})
