import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleAudiencesHttp,
  ownsAudiencesNamespace,
  type AudiencesHttpDependencies
} from '../../workers/marketing/audiences-http'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000001'
const CLAIMS = { identityId: ADMIN_ID, sessionId: ADMIN_SESSION, sessionVersion: 1 }

const CONFIG = { password: 'synthetic-audiences-session-password-0123456789abcdef', maxAgeSeconds: 3600 }
const ORIGIN = 'https://admin.neteco.test'

async function setupHttpDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  sqlite.exec(await readFile(new URL('../../db/d1/migrations/0110_rca_copilot_audiences.sql', import.meta.url), 'utf8'))

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administración', 'Fixture admin');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Fixture admin'),
      ('audiences.manage', 'audiences', 'manage', 'Fixture audiences manage');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('admin', 'audiences.manage');

    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, session_version, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'audiences-http-admin@example.invalid', 'hash', '2026-01-01T00:00:00Z', 'active', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_SESSION}', '${ADMIN_ID}', 1, 1, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '2026-01-01T00:00:00Z');
  `)
  return sqlite
}

describe('ADM-027: Audiences HTTP endpoints', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>
  let adminCookie: string
  let deps: AudiencesHttpDependencies

  beforeEach(async () => {
    sqlite = await setupHttpDatabase()
    db = d1OverSqlite(sqlite)

    const cookieVal = await issueD1SessionCookie(db, CLAIMS, CONFIG)
    adminCookie = cookieVal!.split(';')[0]!

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

  it('recognizes audiences namespace correctly', () => {
    expect(ownsAudiencesNamespace('/api/admin/audiences')).toBe(true)
    expect(ownsAudiencesNamespace('/api/admin/audiences/123')).toBe(true)
    expect(ownsAudiencesNamespace('/api/admin/audiences/123/estimate')).toBe(true)
    expect(ownsAudiencesNamespace('/api/admin/audiences/123/preview')).toBe(true)
    expect(ownsAudiencesNamespace('/api/admin/audiences/123/versions')).toBe(true)
    expect(ownsAudiencesNamespace('/api/admin/newsletter')).toBe(false)
  })

  it('creates and reads an audience segment via HTTP', async () => {
    const createReq = new Request(`${ORIGIN}/api/admin/audiences`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'http-aud-1'
      },
      body: JSON.stringify({
        slug: 'quimicos-hosteleria',
        name: 'Químicos Hostelería Valencia',
        targetType: 'b2b',
        rules: {
          logic: 'AND',
          conditions: [{ field: 'customer_type', operator: 'eq', value: 'b2b' }]
        }
      })
    })

    const createRes = await handleAudiencesHttp(createReq, deps)
    expect(createRes!.status).toBe(201)
    const { segmentId } = (await createRes!.json()) as { segmentId: string }

    const readReq = new Request(`${ORIGIN}/api/admin/audiences/${segmentId}`, {
      method: 'GET',
      headers: { Cookie: adminCookie }
    })
    const readRes = await handleAudiencesHttp(readReq, deps)
    expect(readRes!.status).toBe(200)
    const seg = (await readRes!.json()) as { slug: string; name: string }
    expect(seg.slug).toBe('quimicos-hosteleria')
  })

  it('runs estimation and preview via HTTP', async () => {
    // Create segment
    const createReq = new Request(`${ORIGIN}/api/admin/audiences`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'http-aud-est'
      },
      body: JSON.stringify({
        slug: 'est-preview-segment',
        name: 'Segmento Estimación',
        targetType: 'all',
        rules: {
          logic: 'AND',
          conditions: []
        }
      })
    })
    const createRes = await handleAudiencesHttp(createReq, deps)
    const { segmentId } = (await createRes!.json()) as { segmentId: string }

    // Estimate
    const estReq = new Request(`${ORIGIN}/api/admin/audiences/${segmentId}/estimate`, {
      method: 'POST',
      headers: { Cookie: adminCookie }
    })
    const estRes = await handleAudiencesHttp(estReq, deps)
    expect(estRes!.status).toBe(200)
    const estBody = (await estRes!.json()) as { totalMatchingUsers: number; consentPercentage: number }
    expect(typeof estBody.totalMatchingUsers).toBe('number')

    // Preview
    const prevReq = new Request(`${ORIGIN}/api/admin/audiences/${segmentId}/preview?limit=5`, {
      method: 'GET',
      headers: { Cookie: adminCookie }
    })
    const prevRes = await handleAudiencesHttp(prevReq, deps)
    expect(prevRes!.status).toBe(200)
    const prevBody = (await prevRes!.json()) as { items: unknown[] }
    expect(Array.isArray(prevBody.items)).toBe(true)
  })

  it('rejects access when session authorization expires mid-flight', async () => {
    let count = 0
    const req = new Request(`${ORIGIN}/api/admin/audiences`, {
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
    const res = await handleAudiencesHttp(req, proxyDeps)
    expect(res!.status).toBe(403)
    const data = (await res!.json()) as { error: { code: string } }
    expect(data.error.code).toBe('forbidden')
  })
})
