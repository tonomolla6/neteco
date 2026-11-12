import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openAccountSecurityDatabase } from '../support/d1-sqlite'
import { handleAuthenticationHttp } from '../../workers/auth/http'
import { hashWorkerPassword, verifyWorkerPassword } from '../../workers/auth/password'
import { testUuid, testNow } from '../support/deterministic'

const identityId = '10000000-0000-4000-8000-000000000061'
const customerId = '30000000-0000-4000-8000-000000000061'
const password = 'Synthetic-security-password-123'
const changedPassword = 'Synthetic-updated-password-456'
const configuration = {
  password: randomBytes(32).toString('hex'),
  maxAgeSeconds: 3600,
  origin: 'https://neteco.invalid',
  tokenPepper: randomBytes(32).toString('hex'),
  encryptionKey: randomBytes(32).toString('base64')
}

describe('D1 account sessions and password rotation', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  const limiter = { limit: vi.fn(async () => ({ success: true })) }
  const handle = (request: Request) =>
    handleAuthenticationHttp(request, { database, edgeLimiter: limiter, configuration: () => configuration })
  function api(method: string, path: string, cookie = '', body?: unknown, origin = configuration.origin) {
    return new Request(`${configuration.origin}${path}`, {
      method,
      headers: {
        cookie,
        origin,
        'cf-connecting-ip': '192.0.2.61',
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  }
  async function login(value = password) {
    const response = (await handle(
      api('POST', '/api/auth/login', '', { email: 'security@example.invalid', password: value })
    ))!
    return response
  }
  async function cookie() {
    const response = await login()
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';')[0]!
  }
  function addSession(id = testUuid(), overrides: Record<string, unknown> = {}) {
    const now = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const expires = new Date(testNow() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified,
        created_at, expires_at, last_seen_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        overrides.identityId ?? identityId,
        overrides.version ?? 1,
        overrides.mfa ?? 0,
        overrides.created ?? now,
        overrides.expires ?? expires,
        overrides.lastSeen ?? now,
        overrides.revoked ?? null
      )
    return id
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(testNow() + 1000)
    limiter.limit.mockReset().mockResolvedValue({ success: true })
    sqlite = await openAccountSecurityDatabase()
    database = d1OverSqlite(sqlite)
    const now = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    sqlite
      .prepare('INSERT INTO customers(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(customerId, 'Cliente', now, now)
    sqlite
      .prepare(
        `INSERT INTO identities(id, email, password_hash, email_verified_at, status, customer_id, created_at, updated_at)
        VALUES (?, 'security@example.invalid', ?, ?, 'active', ?, ?, ?)`
      )
      .run(identityId, await hashWorkerPassword(password), now, customerId, now, now)
  })
  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
  })

  it('lists only live own sessions and revokes another device without revealing foreign IDs', async () => {
    const currentCookie = await cookie()
    const other = addSession()
    const expired = addSession(testUuid(), {
      created: '2026-01-01T00:00:00Z',
      expires: '2026-01-02T00:00:00Z',
      lastSeen: '2026-01-01T00:00:00Z'
    })
    const stranger = testUuid()
    const now = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    sqlite
      .prepare(
        `INSERT INTO identities(id, email, password_hash, status, created_at, updated_at)
        VALUES (?, 'stranger@example.invalid', 'fixture-hash', 'active', ?, ?)`
      )
      .run(stranger, now, now)
    const strangerSession = addSession(testUuid(), { identityId: stranger })
    const listed = (await handle(api('GET', '/api/account/sessions', currentCookie)))!
    expect(listed.status).toBe(200)
    expect(listed.headers.get('cache-control')).toBe('no-store')
    const payload = (await listed.json()) as { sessions: Array<{ id: string; current: boolean; lastSeenAt: string }> }
    expect(payload.sessions).toHaveLength(2)
    expect(payload.sessions.find((session) => session.id === other)).toMatchObject({ current: false })
    expect(payload.sessions.find((session) => session.current)).toBeDefined()
    expect(payload.sessions.some((session) => session.id === expired || session.id === strangerSession)).toBe(false)
    expect(
      (await handle(
        api('DELETE', `/api/account/sessions/${payload.sessions.find((s) => s.current)!.id}`, currentCookie)
      ))!.status
    ).toBe(409)
    expect((await handle(api('DELETE', `/api/account/sessions/${strangerSession}`, currentCookie)))!.status).toBe(404)
    expect((await handle(api('DELETE', `/api/account/sessions/${other}`, currentCookie)))!.status).toBe(200)
    expect((await handle(api('DELETE', `/api/account/sessions/${other}`, currentCookie)))!.status).toBe(404)
    expect(
      sqlite.prepare('SELECT revoked_at IS NOT NULL AS revoked FROM auth_sessions WHERE id = ?').get(other)
    ).toEqual({ revoked: 1 })
    expect(
      sqlite
        .prepare(
          "SELECT event_type, target_session_id FROM identity_security_events WHERE event_type = 'session_revoked'"
        )
        .all()
    ).toEqual([{ event_type: 'session_revoked', target_session_id: other }])
  })

  it('rotates the cookie and version, revokes other devices, and logs only redacted events', async () => {
    const oldCookie = await cookie()
    const other = addSession()
    const change = (await handle(
      api('PUT', '/api/account/password', oldCookie, { currentPassword: password, newPassword: changedPassword })
    ))!
    expect(change.status).toBe(200)
    expect(change.headers.get('cache-control')).toBe('no-store')
    const newCookie = change.headers.get('set-cookie')!.split(';')[0]!
    expect(newCookie).not.toBe(oldCookie)
    expect(await change.json()).toMatchObject({ ok: true, sessionVersion: 2, user: { id: identityId } })
    expect((await handle(api('GET', '/api/account/sessions', oldCookie)))!.status).toBe(401)
    const listed = (await (await handle(api('GET', '/api/account/sessions', newCookie)))!.json()) as {
      sessions: Array<{ id: string; current: boolean }>
    }
    expect(listed.sessions).toHaveLength(1)
    expect(listed.sessions[0]?.current).toBe(true)
    expect(
      sqlite.prepare('SELECT revoked_at IS NOT NULL AS revoked FROM auth_sessions WHERE id = ?').get(other)
    ).toEqual({ revoked: 1 })
    const stored = sqlite
      .prepare('SELECT password_hash, session_version FROM identities WHERE id = ?')
      .get(identityId) as {
      password_hash: string
      session_version: number
    }
    expect(stored.session_version).toBe(2)
    expect(await verifyWorkerPassword(stored.password_hash, changedPassword)).toBe(true)
    expect((await login(password)).status).toBe(401)
    expect((await login(changedPassword)).status).toBe(200)
    const events = sqlite.prepare('SELECT event_type FROM identity_security_events ORDER BY rowid').all()
    expect(events).toEqual([{ event_type: 'password_changed' }, { event_type: 'session_revoked' }])
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM identity_security_events').all())).not.toContain('Synthetic-')
    expect(() => sqlite.exec("UPDATE identity_security_events SET event_type = 'password_changed'")).toThrow()
  })

  it('rejects wrong, reused and weak passwords without changing identity state', async () => {
    const currentCookie = await cookie()
    const initial = sqlite.prepare('SELECT password_hash FROM identities WHERE id = ?').get(identityId)
    expect(
      (await handle(
        api('PUT', '/api/account/password', currentCookie, { currentPassword: 'wrong', newPassword: changedPassword })
      ))!.status
    ).toBe(401)
    expect(
      (await handle(
        api('PUT', '/api/account/password', currentCookie, { currentPassword: password, newPassword: password })
      ))!.status
    ).toBe(400)
    expect(
      (await handle(
        api('PUT', '/api/account/password', currentCookie, { currentPassword: password, newPassword: 'weak' })
      ))!.status
    ).toBe(400)
    expect(
      (await handle(
        api(
          'PUT',
          '/api/account/password',
          currentCookie,
          { currentPassword: password, newPassword: changedPassword },
          'https://evil.invalid'
        )
      ))!.status
    ).toBe(403)
    expect(sqlite.prepare('SELECT password_hash FROM identities WHERE id = ?').get(identityId)).toEqual(initial)
    expect(sqlite.prepare('SELECT count(*) AS n FROM identity_security_events').get()).toEqual({ n: 0 })
  })

  it('throttles password guesses and requires the enrolled MFA factor', async () => {
    const currentCookie = await cookie()
    const body = { currentPassword: 'wrong', newPassword: changedPassword }
    for (let attempt = 0; attempt < 5; attempt++)
      expect((await handle(api('PUT', '/api/account/password', currentCookie, body)))!.status).toBe(401)
    const limited = (await handle(api('PUT', '/api/account/password', currentCookie, body)))!
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(sqlite.prepare('SELECT session_version FROM identities WHERE id = ?').get(identityId)).toEqual({
      session_version: 1
    })
  })

  it('records a bounded session heartbeat without extending expiry', async () => {
    const currentCookie = await cookie()
    const session = sqlite
      .prepare('SELECT id, expires_at FROM auth_sessions WHERE identity_id = ?')
      .get(identityId) as {
      id: string
      expires_at: string
    }
    sqlite
      .prepare('UPDATE auth_sessions SET created_at = ?, last_seen_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', session.id)
    const refreshed = (await handle(api('GET', '/api/_auth/session', currentCookie)))!
    expect(refreshed.status).toBe(200)
    expect(await refreshed.json()).toMatchObject({ user: { id: identityId } })
    const after = sqlite.prepare('SELECT last_seen_at, expires_at FROM auth_sessions WHERE id = ?').get(session.id) as {
      last_seen_at: string
      expires_at: string
    }
    expect(Date.parse(after.last_seen_at)).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'))
    expect(after.expires_at).toBe(session.expires_at)
  })

  it('requires MFA before password rotation when MFA is enrolled', async () => {
    const currentCookie = await cookie()
    const now = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    sqlite
      .prepare(
        `INSERT INTO identity_mfa(identity_id, encrypted_secret, recovery_code_hashes, verified_at, updated_at)
        VALUES (?, 'synthetic-encrypted', '[]', ?, ?)`
      )
      .run(identityId, now, now)
    const response = (await handle(
      api('PUT', '/api/account/password', currentCookie, {
        currentPassword: password,
        newPassword: changedPassword
      })
    ))!
    expect(response.status).toBe(403)
    expect(sqlite.prepare('SELECT session_version FROM identities WHERE id = ?').get(identityId)).toEqual({
      session_version: 1
    })
  })

  it('rolls back identity, session and audit changes when the batch fails after hashing', async () => {
    const currentCookie = await cookie()
    sqlite.exec(
      "CREATE TRIGGER fail_rotation BEFORE UPDATE OF session_version ON auth_sessions BEGIN SELECT RAISE(ABORT, 'synthetic'); END"
    )
    const response = (await handle(
      api('PUT', '/api/account/password', currentCookie, { currentPassword: password, newPassword: changedPassword })
    ))!
    expect(response.status).toBe(500)
    expect(sqlite.prepare('SELECT session_version FROM identities WHERE id = ?').get(identityId)).toEqual({
      session_version: 1
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM identity_security_events').get()).toEqual({ n: 0 })
    expect((await handle(api('GET', '/api/account/sessions', currentCookie)))!.status).toBe(200)
  })

  it('denies stale cookies and a revoked session racing the password write', async () => {
    const currentCookie = await cookie()
    const real = database
    const racing = Object.create(real) as D1Database
    racing.batch = async (statements) => {
      sqlite
        .prepare('UPDATE auth_sessions SET revoked_at = ?')
        .run(new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z'))
      return real.batch(statements)
    }
    database = racing
    const response = (await handle(
      api('PUT', '/api/account/password', currentCookie, { currentPassword: password, newPassword: changedPassword })
    ))!
    expect(response.status).toBe(401)
    expect(sqlite.prepare('SELECT session_version FROM identities WHERE id = ?').get(identityId)).toEqual({
      session_version: 1
    })
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM identity_security_events WHERE event_type = 'password_changed'").get()
    ).toEqual({ n: 0 })
    expect((await handle(api('GET', '/api/account/sessions', currentCookie)))!.status).toBe(401)
  })
})
