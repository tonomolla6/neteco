import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleCommercialCampaignsHttp } from '../../workers/marketing/commercial-campaigns-http'
import { handleSeasonalCampaignsHttp } from '../../workers/marketing/seasonal-campaigns-http'
import { handleCustomerCaseStudiesHttp } from '../../workers/cms/customer-case-studies-http'
import { handleUgcReviewsHttp } from '../../workers/media/ugc-reviews-http'

const now = '2026-11-12T12:00:00Z'
const identityId = '17000000-0000-4000-8000-000000000001'
const sessionId = '27000000-0000-4000-8000-000000000001'
const otherSessionId = '27000000-0000-4000-8000-000000000002'
const origin = 'https://admin-session.neteco.invalid'
const configuration = { password: 'synthetic-admin-boundary-password-32-characters', maxAgeSeconds: 3600 }
let sqlite: Awaited<ReturnType<typeof openMigratedDatabase>>
let database: D1Database
let cookie: string

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  sqlite = await openMigratedDatabase()
  database = d1OverSqlite(sqlite)
  for (const migration of [
    '0124_ugc_reviews_customer_success_cases.sql',
    '0131_preview_diff_role_dashboards_campaign_manager.sql',
    '0143_seasonal_sector_campaigns.sql'
  ])
    sqlite.exec(await readFile(`db/d1/migrations/${migration}`, 'utf8'))
  sqlite
    .prepare(
      `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
    VALUES(?, 'admin-session@example.invalid', 'synthetic', ?, 'active', ?, ?)`
    )
    .run(identityId, now, now, now)
  sqlite.exec(`INSERT INTO roles VALUES('boundary-admin','Boundary admin','Synthetic');
    INSERT OR IGNORE INTO permissions VALUES('administration.manage','administration','manage','Synthetic');
    INSERT INTO role_permissions VALUES('boundary-admin','administration.manage');`)
  sqlite
    .prepare('INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,?,?)')
    .run(identityId, 'boundary-admin', now)
  for (const id of [sessionId, otherSessionId]) {
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
      VALUES(?,?,1,1,?,'2026-11-13T12:00:00Z')`
      )
      .run(id, identityId, now)
  }
  cookie = (await issueD1SessionCookie(database, { identityId, sessionId, sessionVersion: 1 }, configuration))!
})
afterEach(() => {
  sqlite?.close()
  vi.useRealTimers()
})

const routes = [
  { path: '/api/admin/campaigns', handle: handleCommercialCampaignsHttp },
  { path: '/api/admin/seasonal-campaigns', handle: handleSeasonalCampaignsHttp },
  { path: '/api/admin/case-studies', handle: handleCustomerCaseStudiesHttp },
  { path: '/api/admin/ugc-reviews', handle: handleUgcReviewsHttp }
] as const

describe.each(routes)('live session boundary for $path', ({ path, handle }) => {
  const call = (sessionCookie = cookie, db = database) =>
    handle(new Request(origin + path, { headers: sessionCookie ? { cookie: sessionCookie } : {} }), {
      database: db,
      origin,
      sessionCookieConfiguration: configuration,
      now: () => now
    })

  it('admits a live administrator with MFA and rejects anonymous access', async () => {
    expect((await call())?.status).toBe(200)
    expect((await call(''))?.status).toBe(401)
  })

  it('rejects a revoked cookie even when another session of the same identity remains live', async () => {
    sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(now, sessionId)
    expect((await call())?.status).toBe(401)
  })

  it('uses the MFA state of the cookie session rather than another live session', async () => {
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(sessionId)
    expect((await call())?.status).toBe(403)
  })

  it('rejects expired sessions, rotated session versions and removed role grants', async () => {
    sqlite
      .prepare("UPDATE auth_sessions SET created_at='2026-11-12T11:59:00Z', expires_at=? WHERE id=?")
      .run(now, sessionId)
    expect((await call())?.status).toBe(401)
    sqlite.prepare("UPDATE auth_sessions SET expires_at='2026-11-13T12:00:00Z' WHERE id=?").run(sessionId)
    sqlite.prepare('UPDATE identities SET session_version=2 WHERE id=?').run(identityId)
    expect((await call())?.status).toBe(401)
    sqlite.prepare('UPDATE identities SET session_version=1 WHERE id=?').run(identityId)
    sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(identityId)
    expect((await call())?.status).toBe(403)
  })

  it('fails closed with a stable unavailable error when session storage fails', async () => {
    const unavailable = {
      prepare() {
        throw new Error('synthetic-sensitive-database-error')
      }
    } as unknown as D1Database
    const response = await call(cookie, unavailable)
    expect(response?.status).toBe(503)
    expect(await response?.json()).toEqual({ error: { code: 'service_unavailable' } })
  })
})
