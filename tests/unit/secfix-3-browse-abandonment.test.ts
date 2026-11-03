import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleBrowseAbandonmentHttp } from '../../workers/marketing/browse-abandonment-http'

// SECFIX-3 finding 15: browse events/evaluation attributed to arbitrary client-supplied customers.
const now = '2026-10-29T12:00:00Z'
const origin = 'https://tienda.neteco.invalid'
const config = { password: 'b'.repeat(64), maxAgeSeconds: 3600 }
const shopper = { identity: '10000000-0000-4000-8000-0000000001a1', session: '20000000-0000-4000-8000-0000000001a1' }
const admin = { identity: '10000000-0000-4000-8000-0000000001b1', session: '20000000-0000-4000-8000-0000000001b1' }
const victim = '30000000-0000-4000-8000-0000000001c1'

let sqlite: DatabaseSync
let database: D1Database
let shopperCookie: string
let adminCookie: string

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(now))
  sqlite = await openMigratedDatabase()
  sqlite.exec('PRAGMA foreign_keys = OFF')
  sqlite.exec(await readFile('db/d1/migrations/0142_browse_recovery_welcome_coupon_recommendations.sql', 'utf8'))
  database = d1OverSqlite(sqlite)
  const t = '2026-10-20T12:00:00Z'
  sqlite.exec(`
    INSERT INTO customers(id, name, phone, status, created_at, updated_at) VALUES('cust-shopper','S',NULL,'active','${t}','${t}');
    INSERT INTO customers(id, name, phone, status, created_at, updated_at) VALUES('${victim}','V',NULL,'active','${t}','${t}');
    INSERT INTO identities(id, email, customer_id, password_hash, email_verified_at, status, created_at, updated_at)
      VALUES('${shopper.identity}','s@cliente.es','cust-shopper','x','${t}','active','${t}','${t}');
    INSERT INTO identities(id, email, customer_id, password_hash, email_verified_at, status, created_at, updated_at)
      VALUES('${admin.identity}','a@neteco.es',NULL,'x','${t}','active','${t}','${t}');
    INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
      VALUES('${shopper.session}','${shopper.identity}',1,0,'${t}','2026-10-30T12:00:00Z');
    INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
      VALUES('${admin.session}','${admin.identity}',1,1,'${t}','2026-10-30T12:00:00Z');
    INSERT OR IGNORE INTO roles(code, name, description) VALUES('admin','Admin','S');
    INSERT OR IGNORE INTO permissions(code, resource, action, description) VALUES('administration.manage','administration','manage','S');
    INSERT OR IGNORE INTO role_permissions(role_code, permission_code) VALUES('admin','administration.manage');
    INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES('${admin.identity}','admin','${t}');
  `)
  shopperCookie = (await issueD1SessionCookie(
    database,
    { identityId: shopper.identity, sessionId: shopper.session, sessionVersion: 1 },
    config
  ))!
  adminCookie = (await issueD1SessionCookie(
    database,
    { identityId: admin.identity, sessionId: admin.session, sessionVersion: 1 },
    config
  ))!
})

afterEach(() => {
  vi.useRealTimers()
  sqlite.close()
})

const post = (path: string, headers: Record<string, string>, body: unknown) =>
  handleBrowseAbandonmentHttp(
    new Request(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    }),
    { database, sessionCookieConfiguration: config, origin, now: () => now }
  )

const eventRows = () =>
  sqlite.prepare('SELECT customer_id FROM marketing_browse_events').all() as { customer_id: string }[]

describe('SECFIX-3 POST /api/marketing/browse-abandonment/events', () => {
  const event = { productId: 'prod-1', categoryId: 'cat-1', viewDurationSeconds: 45 }

  it('rejects anonymous events attributed to a victim customer (401, nothing written)', async () => {
    const response = await post(
      '/api/marketing/browse-abandonment/events',
      { origin },
      { ...event, customerId: victim }
    )
    expect(response?.status).toBe(401)
    expect(eventRows()).toEqual([])
  })

  it('rejects cross-origin and origin-less events', async () => {
    const path = '/api/marketing/browse-abandonment/events'
    expect((await post(path, { cookie: shopperCookie, origin: 'https://evil.example' }, event))?.status).toBe(403)
    expect((await post(path, { cookie: shopperCookie }, event))?.status).toBe(403)
    expect(eventRows()).toEqual([])
  })

  it('attributes the event to the session customer, ignoring a body customerId', async () => {
    const response = await post(
      '/api/marketing/browse-abandonment/events',
      { cookie: shopperCookie, origin },
      { ...event, customerId: victim }
    )
    expect(response?.status).toBe(201)
    expect(eventRows()).toEqual([{ customer_id: 'cust-shopper' }])
  })
})

describe('SECFIX-3 POST /api/marketing/browse-abandonment/evaluate', () => {
  const body = { customerId: victim, productId: 'prod-1' }

  it('rejects anonymous and non-admin evaluation of arbitrary customers', async () => {
    const path = '/api/marketing/browse-abandonment/evaluate'
    expect((await post(path, { origin }, body))?.status).toBe(401)
    expect((await post(path, { cookie: shopperCookie, origin }, body))?.status).toBe(403)
  })

  it('allows an administrator (internal trigger)', async () => {
    const response = await post('/api/marketing/browse-abandonment/evaluate', { cookie: adminCookie, origin }, body)
    expect(response?.status).toBe(200)
  })
})
