import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { handleEventsHttp, ownsEventsNamespace } from '../../workers/marketing/events-http'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const sql = await readFile(
    new URL('../../db/d1/migrations/0112_bundles_referrals_events.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(sql)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES ('admin', 'Administrador', 'Fixture');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES ('administration.manage', 'administration', 'manage', 'Fixture');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES ('admin', 'administration.manage');
    INSERT OR IGNORE INTO identities (id, customer_id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at) VALUES
      ('${ADMIN_ID}', NULL, 'admin@neteco.test', 'hash', 'active', 1, '${NOW}', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES ('${ADMIN_ID}', 'admin', '${NOW}');

    INSERT OR IGNORE INTO events (
      id, slug, title, description, type, sector, location_type, location_details,
      scheduled_at, duration_minutes, max_attendees, status, version, created_at, updated_at
    ) VALUES (
      'e0000000-0000-4000-8000-000000000001', 'webinar-higiene', 'Webinar Higiene', 'Desc', 'webinar',
      'hosteleria', 'online', 'https://conferencias.test', '${NOW}', 45, 100, 'scheduled', 1, '${NOW}', '${NOW}'
    );
  `)

  return sqlite
}

describe('Events HTTP Routing & API Contracts', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite?.close()
  })

  it('matches ownsEventsNamespace', () => {
    expect(ownsEventsNamespace('/api/events')).toBe(true)
    expect(ownsEventsNamespace('/api/events/webinar-higiene')).toBe(true)
    expect(ownsEventsNamespace('/api/events/webinar-higiene/register')).toBe(true)
    expect(ownsEventsNamespace('/api/events/webinar-higiene/questions')).toBe(true)
    expect(ownsEventsNamespace('/api/admin/events')).toBe(true)
    expect(ownsEventsNamespace('/api/orders')).toBe(false)
  })

  it('GET /api/events lists active events', async () => {
    const req = new Request('https://tienda.neteco.test/api/events')
    const res = await handleEventsHttp(req, { database: db, now: NOW })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.items).toHaveLength(1)
    expect(data.items[0].slug).toBe('webinar-higiene')
  })

  it('POST /api/events/:slug/register succeeds with valid channel consents', async () => {
    const req = new Request('https://tienda.neteco.test/api/events/webinar-higiene/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: 'e0000000-0000-4000-8000-000000000002',
        idempotencyKey: 'idem-reg-http-1',
        attendeeName: 'Marta Hotel',
        attendeeEmail: 'marta@hotel.test',
        consentEmailReminder: true,
        consentSmsReminder: false,
        consentFollowup: true,
        consentTermsVersion: 'event-terms-v1'
      })
    })

    const res = await handleEventsHttp(req, { database: db, now: NOW })
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.registration.attendeeEmail).toBe('marta@hotel.test')
  })

  it('POST /api/events/:slug/questions allows public questions', async () => {
    const req = new Request('https://tienda.neteco.test/api/events/webinar-higiene/questions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: 'e0000000-0000-4000-8000-000000000003',
        idempotencyKey: 'idem-q-http-1',
        authorName: 'Pedro Bar',
        questionText: '¿El producto sirve para planchas calientes?'
      })
    })

    const res = await handleEventsHttp(req, { database: db, now: NOW })
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.question.authorName).toBe('Pedro Bar')
  })
})
