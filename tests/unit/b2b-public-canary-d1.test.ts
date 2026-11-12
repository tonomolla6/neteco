import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import canary from '../../workers/canary'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { testNow } from '../support/deterministic'

let now: string
let expires: string
const identity = '10000000-0000-4000-8000-000000000001'
const session = '20000000-0000-4000-8000-000000000001'
const password = 'p'.repeat(64)
let sqlite: DatabaseSync
let database: D1Database
let env: CloudflareEnv
let cookie: string
const ingress = { 'cf-connecting-ip': '203.0.113.9' }
describe('montaje completo B2B con D1 sintético', () => {
  beforeEach(async () => {
    const current = testNow()
    now = new Date(current).toISOString().replace(/\.\d{3}Z$/, 'Z')
    expires = new Date(current + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    vi.useFakeTimers()
    vi.setSystemTime(current)
    sqlite = await openMigratedDatabase()
    sqlite.exec(await readFile('db/d1/migrations/0121_b2b_public_api.sql', 'utf8'))
    database = d1OverSqlite(sqlite)
    sqlite
      .prepare(
        `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?, 'admin@test.invalid','x',?,'active',?,?)`
      )
      .run(identity, now, now, now)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)`
      )
      .run(session, identity, now, expires)
    sqlite.exec(
      `INSERT INTO roles VALUES ('b2b-admin','Admin','fixture'); INSERT INTO permissions VALUES ('administration.manage','administration','manage','fixture'); INSERT INTO role_permissions VALUES ('b2b-admin','administration.manage')`
    )
    sqlite
      .prepare(`INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'b2b-admin',?)`)
      .run(identity, now)
    cookie = (await issueD1SessionCookie(
      database,
      { identityId: identity, sessionId: session, sessionVersion: 1 },
      { password, maxAgeSeconds: 3600 }
    ))!
    const limiter = { limit: async () => ({ success: true }) }
    env = {
      DB: database,
      AUTH_ENABLED: 'true',
      B2B_PUBLIC_API_ENABLED: 'true',
      AUTH_ORIGIN: 'https://shop.invalid',
      NUXT_SESSION_PASSWORD: password,
      AUTH_RATE_LIMIT_PEPPER: 'x'.repeat(40),
      ADMIN_EDGE_LIMIT: limiter,
      CART_EDGE_LIMIT: limiter
    } as unknown as CloudflareEnv
  })
  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
  })
  it('emite clave, usa catálogo sintético, registra referencia y revoca en el router real', async () => {
    const adminRequest = (body: unknown, command: string) =>
      new Request('https://shop.invalid/api/admin/b2b-public/keys', {
        method: 'POST',
        headers: {
          ...ingress,
          cookie,
          origin: 'https://shop.invalid',
          'content-type': 'application/json',
          'idempotency-key': command
        },
        body: JSON.stringify(body)
      })
    const created = await canary.fetch(
      adminRequest(
        { action: 'create', environment: 'sandbox', scopes: ['requests.read', 'requests.write'], quotaDaily: 10 },
        '11111111-1111-4111-8111-111111111111'
      ),
      env
    )
    expect(created.status).toBe(201)
    const { id, key } = (await created.json()) as { id: string; key: string }
    const catalog = await canary.fetch(
      new Request('https://shop.invalid/api/b2b/v1/catalog', {
        headers: { ...ingress, authorization: `Bearer ${key}` }
      }),
      env
    )
    expect(await catalog.json()).toEqual({
      items: [{ id: 'synthetic-1', name: 'Producto de prueba', slug: 'producto-prueba', priceCents: 1200 }],
      total: 1
    })
    const saved = await canary.fetch(
      new Request('https://shop.invalid/api/b2b/v1/requests', {
        method: 'POST',
        headers: {
          ...ingress,
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'idempotency-key': 'client-command'
        },
        body: JSON.stringify({ reference: 'test-ref' })
      }),
      env
    )
    expect(saved.status).toBe(201)
    const revoked = await canary.fetch(
      adminRequest({ action: 'revoke', id, expectedVersion: 1 }, '22222222-2222-4222-8222-222222222222'),
      env
    )
    expect(revoked.status).toBe(200)
    const denied = await canary.fetch(
      new Request('https://shop.invalid/api/b2b/v1/requests', {
        headers: { ...ingress, authorization: `Bearer ${key}` }
      }),
      env
    )
    expect(denied.status).toBe(401)
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_admin_audit').get()).toMatchObject({ n: 2 })
  })
})
