import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleBundlesHttp } from '../../workers/marketing/bundles-http'
import { handleReferralsHttp } from '../../workers/marketing/referrals-http'
import { handleEventsHttp } from '../../workers/marketing/events-http'

// SECFIX-3 finding 13: server-generated time-based or random idempotency keys defeat retries.
const NOW = '2026-10-29T12:00:00Z'
const ADMIN = { identity: '10000000-0000-4000-8000-000000000001', session: '20000000-0000-4000-8000-000000000001' }
const config = { password: 'i'.repeat(64), maxAgeSeconds: 3600 }
const BUNDLE_ID = 'b0000000-0000-4000-8000-000000000001'

let sqlite: DatabaseSync
let db: D1Database
let adminCookie: string

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
  sqlite = await openMigratedDatabase()
  sqlite.exec(await readFile('db/d1/migrations/0112_bundles_referrals_events.sql', 'utf8'))
  db = d1OverSqlite(sqlite)
  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES ('admin', 'Administrador', 'Fixture');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES ('administration.manage', 'administration', 'manage', 'Fixture');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES ('admin', 'administration.manage');
    INSERT INTO identities (id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at)
      VALUES ('${ADMIN.identity}', 'admin@neteco.test', 'hash', 'active', 1, '${NOW}', '${NOW}', '${NOW}');
    INSERT INTO identity_roles (identity_id, role_code, granted_at) VALUES ('${ADMIN.identity}', 'admin', '${NOW}');
    INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
      VALUES ('${ADMIN.session}', '${ADMIN.identity}', 1, 1, '${NOW}', '2026-10-30T12:00:00Z');
    INSERT INTO bundles (id, slug, title, description, sector, task, bundle_price_cents, status, version, created_at, updated_at)
      VALUES ('${BUNDLE_ID}', 'kit-cocina', 'Kit', 'Kit cocina', 'hosteleria', 'desengrase_profundo', 2000, 'active', 1, '${NOW}', '${NOW}');
    INSERT INTO events (id, slug, title, description, type, sector, location_type, location_details,
      scheduled_at, duration_minutes, max_attendees, status, version, created_at, updated_at)
      VALUES ('e0000000-0000-4000-8000-000000000001', 'webinar-higiene', 'Webinar', 'Desc', 'webinar', 'hosteleria',
      'online', 'https://conferencias.test', '2026-11-10T10:00:00Z', 45, 100, 'scheduled', 1, '${NOW}', '${NOW}');
  `)
  adminCookie = (await issueD1SessionCookie(
    db,
    { identityId: ADMIN.identity, sessionId: ADMIN.session, sessionVersion: 1 },
    config
  ))!
})

afterEach(() => {
  vi.useRealTimers()
  sqlite.close()
})

const request = (path: string, method: string, body: unknown, cookie?: string) =>
  new Request(`https://tienda.neteco.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  })

const expectMissingKey = async (response: Response | null) => {
  expect(response?.status).toBe(400)
  expect(((await response!.json()) as { error: { code: string } }).error.code).toBe('missing_idempotency_key')
}

describe('SECFIX-3 client-supplied idempotency keys are mandatory', () => {
  it('DELETE /api/admin/bundles/:id without keys is rejected and archives nothing', async () => {
    const response = await handleBundlesHttp(
      request(`/api/admin/bundles/${BUNDLE_ID}`, 'DELETE', { expectedVersion: 1 }, adminCookie),
      { database: db, sessionCookieConfiguration: config, now: NOW }
    )
    await expectMissingKey(response)
    expect(
      (sqlite.prepare('SELECT status FROM bundles WHERE id = ?').get(BUNDLE_ID) as { status: string }).status
    ).toBe('active')
  })

  it('POST /api/admin/referrals/settle without keys is rejected', async () => {
    const response = await handleReferralsHttp(request('/api/admin/referrals/settle', 'POST', {}, adminCookie), {
      database: db,
      sessionCookieConfiguration: config,
      now: NOW
    })
    await expectMissingKey(response)
  })

  it('POST /api/events/:slug/register without keys is rejected and registers nothing', async () => {
    const response = await handleEventsHttp(
      request('/api/events/webinar-higiene/register', 'POST', {
        attendeeName: 'Marta Hotel',
        attendeeEmail: 'marta@hotel.test',
        consentEmailReminder: true,
        consentTermsVersion: 'event-terms-v1'
      }),
      { database: db, now: NOW }
    )
    await expectMissingKey(response)
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM event_registrations').get() as { n: number }).n).toBe(0)
  })

  it('POST /api/events/:slug/questions without keys is rejected', async () => {
    const response = await handleEventsHttp(
      request('/api/events/webinar-higiene/questions', 'POST', { authorName: 'Pedro', questionText: '¿Sirve?' }),
      { database: db, now: NOW }
    )
    await expectMissingKey(response)
  })
})
