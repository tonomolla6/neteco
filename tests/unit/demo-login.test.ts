import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEMO_IDENTITIES, DEMO_ORIGIN } from '../../shared/demo-access'
import { handleDemoLoginRequest, type DemoLoginEnv } from '../../workers/demo/login'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie, verifySessionCookie } from '../../workers/auth/session-cookie'
import { readD1UserSession } from '../../workers/auth/profile'
import { authorizeD1Session } from '../../workers/catalog/authorization'
import { loginD1 } from '../../workers/auth/login'
import { hashWorkerPassword } from '../../workers/auth/password'

const opened: DatabaseSync[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const database of opened.splice(0)) database.close()
})
const instant = (offset = 0) => new Date(Date.now() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
async function fixture() {
  const sqlite = await openMigratedDatabase()
  opened.push(sqlite)
  sqlite.limits.exprDepth = 100
  sqlite.limits.variableNumber = 100
  const database = d1OverSqlite(sqlite),
    before = instant(-60000)
  sqlite.exec(`INSERT INTO roles VALUES('customer','Demo customer','Synthetic'),('admin','Demo admin','Synthetic');
    INSERT INTO permissions VALUES('administration.manage','administration','manage','Synthetic');
    INSERT INTO role_permissions VALUES('admin','administration.manage');`)
  for (const [role, identity] of Object.entries(DEMO_IDENTITIES)) {
    sqlite
      .prepare('INSERT INTO customers(id,name,status,created_at,updated_at) VALUES(?,?,?, ?,?)')
      .run(identity.customerId, 'Synthetic demo ' + role, 'active', before, before)
    sqlite
      .prepare(
        `INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at)
      VALUES(?,?,'synthetic-no-password-login',?,'active',?,?,?)`
      )
      .run(identity.identityId, identity.email, before, identity.customerId, before, before)
    sqlite
      .prepare('INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,?,?)')
      .run(identity.identityId, role, before)
  }
  const limiter = { limit: vi.fn(async () => ({ success: true })) }
  const env: DemoLoginEnv = {
    APP_ENV: 'preview',
    DEMO_ENABLED: 'true',
    AUTH_ENABLED: 'true',
    AUTH_ORIGIN: DEMO_ORIGIN,
    AUTH_EDGE_LIMIT: limiter,
    AUTH_RATE_LIMIT_PEPPER: 'synthetic-demo-edge-pepper-0123456789abcdef',
    NUXT_SESSION_PASSWORD: 'synthetic-demo-cookie-password-0123456789abcdef',
    DB: database
  }
  const configuration = { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 }
  const request = (
    payload: unknown = { role: 'customer' },
    options: {
      path?: string
      method?: string
      origin?: string
      headers?: Record<string, string | null>
      raw?: string | Uint8Array<ArrayBuffer>
    } = {}
  ) => {
    const method = options.method ?? 'POST'
    const headers = new Headers({
      Origin: DEMO_ORIGIN,
      'Sec-Fetch-Site': 'same-origin',
      'CF-Connecting-IP': '192.0.2.52',
      'Content-Type': 'application/json'
    })
    for (const [key, value] of Object.entries(options.headers ?? {}))
      if (value === null) headers.delete(key)
      else headers.set(key, value)
    return new Request((options.origin ?? DEMO_ORIGIN) + (options.path ?? '/api/demo/login'), {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: options.raw ?? JSON.stringify(payload) })
    })
  }
  const dispatch = (incoming: Request) => handleDemoLoginRequest(incoming, env)
  const sessionCount = () => Number(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get()!.n)
  const grantState = () =>
    JSON.stringify([
      sqlite.prepare('SELECT * FROM identities ORDER BY id').all(),
      sqlite.prepare('SELECT * FROM customers ORDER BY id').all(),
      sqlite.prepare('SELECT * FROM identity_roles ORDER BY identity_id,role_code').all(),
      sqlite.prepare('SELECT * FROM role_permissions ORDER BY role_code,permission_code').all(),
      sqlite.prepare('SELECT * FROM identity_mfa').all()
    ])
  function afterFirst(match: (sql: string) => boolean, effect: () => void) {
    let applied = false
    function wrapped(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
      return new Proxy(statement, {
        get(target, property, receiver) {
          if (property === 'bind') return (...values: unknown[]) => wrapped(target.bind(...values), sql)
          if (property === 'first')
            return async (...args: Parameters<D1PreparedStatement['first']>) => {
              const result = await target.first(...args)
              if (!applied && match(sql)) {
                expect(result).not.toBeNull()
                effect()
                applied = true
              }
              return result
            }
          return Reflect.get(target, property, receiver)
        }
      })
    }
    env.DB = new Proxy(database, {
      get(target, property, receiver) {
        return property === 'prepare'
          ? (sql: string) => wrapped(target.prepare(sql), sql)
          : Reflect.get(target, property, receiver)
      }
    })
    return () => expect(applied).toBe(true)
  }
  return { sqlite, database, limiter, env, configuration, request, dispatch, sessionCount, grantState, afterFirst }
}

describe('isolated preview demo login, real D1 session and private cookie', () => {
  it.each(['customer', 'admin'] as const)(
    'creates only the dedicated %s session with the exact response',
    async (role) => {
      const f = await fixture(),
        before = f.grantState(),
        fetch = vi.spyOn(globalThis, 'fetch')
      const response = await f.dispatch(f.request({ role }))
      expect(response?.status).toBe(200)
      expect(await response!.json()).toEqual({
        source: 'cloudflare',
        demo: true,
        role,
        identityId: DEMO_IDENTITIES[role].identityId
      })
      const cookie = response!.headers.get('set-cookie')!
      expect(cookie).toMatch(/^neteco-session=/)
      expect(cookie).toContain('; HttpOnly; Secure; SameSite=Lax')
      expect(cookie).not.toContain('Domain=')
      expect(response?.headers.get('cache-control')).toContain('no-store')
      const incoming = new Request(DEMO_ORIGIN + '/api/_auth/session', { headers: { Cookie: cookie.split(';')[0]! } })
      const claims = await verifySessionCookie(incoming, f.configuration)
      expect(claims?.identityId).toBe(DEMO_IDENTITIES[role].identityId)
      if (!claims) throw Error('demo_cookie_unconfirmed')
      expect(await readD1UserSession(f.database, incoming, f.configuration)).toMatchObject({
        user: {
          id: DEMO_IDENTITIES[role].identityId,
          role,
          roles: [role],
          emailVerified: true,
          mfaVerified: role === 'admin'
        }
      })
      expect(await authorizeD1Session(f.database, claims, 'administration.manage', { requireMfa: true })).toMatchObject(
        role === 'admin' ? { allowed: true } : { allowed: false, code: 'mfa_required' }
      )
      const stored = f.sqlite
        .prepare("SELECT *,strftime('%s',expires_at)-strftime('%s',created_at) AS ttl FROM auth_sessions")
        .get()!
      expect(stored).toMatchObject({
        identity_id: DEMO_IDENTITIES[role].identityId,
        mfa_verified: role === 'admin' ? 1 : 0,
        session_version: 1,
        ttl: 3600
      })
      expect(f.sessionCount()).toBe(1)
      expect(f.grantState()).toBe(before)
      expect(fetch).not.toHaveBeenCalled()
      expect(f.limiter.limit).toHaveBeenCalledWith({ key: expect.stringMatching(/^[0-9a-f]{64}$/) })
    }
  )

  it.each([
    { APP_ENV: 'production' },
    { APP_ENV: 'local' },
    { APP_ENV: 'canary' },
    { DEMO_ENABLED: undefined },
    { DEMO_ENABLED: 'false' },
    { DEMO_ENABLED: true },
    { AUTH_ENABLED: 'false' },
    { AUTH_ORIGIN: 'https://neteco.es' }
  ])('disabled or nonexact configuration %j touches neither body, DB nor secrets', async (change) => {
    const f = await fixture()
    Object.assign(f.env, change)
    const inspected = vi.fn(() => {
      throw Error('forbidden inspection')
    })
    for (const key of ['DB', 'NUXT_SESSION_PASSWORD', 'AUTH_EDGE_LIMIT', 'AUTH_RATE_LIMIT_PEPPER'])
      Object.defineProperty(f.env, key, { get: inspected })
    const incoming = f.request()
    Object.defineProperty(incoming, 'body', { get: inspected })
    expect((await f.dispatch(incoming))?.status).toBe(503)
    expect(inspected).not.toHaveBeenCalled()
    expect(f.sessionCount()).toBe(0)
  })
  it.each(['https://neteco.es', 'https://neteco.tonomolla.es.attacker.invalid', 'http://neteco.tonomolla.es'])(
    'rejects request origin %s before body, database and secrets',
    async (origin) => {
      const f = await fixture(),
        inspected = vi.fn(() => {
          throw Error('forbidden inspection')
        })
      for (const key of ['DB', 'NUXT_SESSION_PASSWORD', 'AUTH_EDGE_LIMIT', 'AUTH_RATE_LIMIT_PEPPER'])
        Object.defineProperty(f.env, key, { get: inspected })
      const incoming = f.request(undefined, { origin })
      Object.defineProperty(incoming, 'body', { get: inspected })
      expect((await f.dispatch(incoming))?.status).toBe(503)
      expect(inspected).not.toHaveBeenCalled()
    }
  )
  it.each([
    '/api/demo',
    '/api/demo/other',
    '/api/%64emo/login',
    '/api/demo/%6cogin',
    '/api/demo%2flogin',
    '/API/DEMO/login',
    '/api/%2564emo/login',
    '/api/demo/login?role=admin'
  ])('owns but never executes noncanonical demo namespace %s', async (path) => {
    const f = await fixture(),
      response = await f.dispatch(f.request(undefined, { path }))
    expect(response?.status).toBe(400)
    expect(f.limiter.limit).not.toHaveBeenCalled()
    expect(f.sessionCount()).toBe(0)
  })
  it.each(['/api/demo-other', '/api/auth/login', '/login'])('does not own %s', async (path) => {
    const f = await fixture()
    expect(await f.dispatch(f.request(undefined, { path }))).toBeNull()
    expect(f.sessionCount()).toBe(0)
  })
  it.each(['GET', 'PUT'])('never grants a session for %s', async (method) => {
    const f = await fixture(),
      response = await f.dispatch(f.request(undefined, { method }))
    expect(response?.status).toBe(405)
    expect(response?.headers.get('allow')).toBe('POST')
    expect(f.limiter.limit).not.toHaveBeenCalled()
    expect(f.sessionCount()).toBe(0)
  })
  it.each([
    { Origin: null },
    { Origin: 'https://other.invalid' },
    { 'Sec-Fetch-Site': null },
    { 'Sec-Fetch-Site': 'same-site' },
    { 'Sec-Fetch-Site': 'cross-site' }
  ])('rejects CSRF headers %j before edge/body/DB/private key', async (headers) => {
    const f = await fixture(),
      inspected = vi.fn(() => {
        throw Error('forbidden inspection')
      })
    Object.defineProperty(f.env, 'DB', { get: inspected })
    Object.defineProperty(f.env, 'NUXT_SESSION_PASSWORD', { get: inspected })
    const incoming = f.request(undefined, { headers })
    Object.defineProperty(incoming, 'body', { get: inspected })
    expect((await f.dispatch(incoming))?.status).toBe(403)
    expect(f.limiter.limit).not.toHaveBeenCalled()
    expect(inspected).not.toHaveBeenCalled()
  })
  it.each(['limited', 'unavailable', 'untrusted-ip'] as const)(
    'edge %s fails closed before body/DB/session secret',
    async (outcome) => {
      const f = await fixture(),
        inspected = vi.fn(() => {
          throw Error('forbidden inspection')
        })
      if (outcome === 'limited') f.limiter.limit.mockResolvedValue({ success: false })
      if (outcome === 'unavailable') f.limiter.limit.mockRejectedValue(Error('no edge service'))
      Object.defineProperty(f.env, 'DB', { get: inspected })
      Object.defineProperty(f.env, 'NUXT_SESSION_PASSWORD', { get: inspected })
      const incoming = f.request(undefined, {
        headers: outcome === 'untrusted-ip' ? { 'CF-Connecting-IP': null, 'X-Forwarded-For': '192.0.2.52' } : {}
      })
      Object.defineProperty(incoming, 'body', { get: inspected })
      const response = await f.dispatch(incoming)
      expect(response?.status).toBe(outcome === 'limited' ? 429 : 503)
      expect(await response!.json()).toEqual({
        error: { code: outcome === 'limited' ? 'rate_limited' : 'abuse_control_unavailable' }
      })
      expect(inspected).not.toHaveBeenCalled()
    }
  )
  it.each([
    {},
    null,
    [],
    { role: 'administrator' },
    { role: 'Admin' },
    { role: 'customer', identityId: DEMO_IDENTITIES.admin.identityId },
    { role: 'admin', mfaVerified: true },
    { role: 'admin', permissions: ['administration.manage'] }
  ])('rejects strict payload %j without accessing D1 or the signing key', async (payload) => {
    const f = await fixture(),
      inspected = vi.fn(() => {
        throw Error('forbidden inspection')
      })
    Object.defineProperty(f.env, 'DB', { get: inspected })
    Object.defineProperty(f.env, 'NUXT_SESSION_PASSWORD', { get: inspected })
    expect((await f.dispatch(f.request(payload)))?.status).toBe(400)
    expect(inspected).not.toHaveBeenCalled()
  })
  it.each(['{', '{"role":"admin","__proto__":{}}'])('rejects malformed or prototype JSON %s', async (raw) => {
    const f = await fixture()
    expect((await f.dispatch(f.request(undefined, { raw })))?.status).toBe(400)
    expect(f.sessionCount()).toBe(0)
  })
  it('enforces actual UTF-8 body bounds, even when content-length lies, and accepts exactly 256 bytes', async () => {
    const f = await fixture(),
      raw = JSON.stringify({ role: 'customer' })
    const oversized = raw + ' '.repeat(257 - raw.length)
    expect(
      (await f.dispatch(f.request(undefined, { raw: oversized, headers: { 'Content-Length': '1' } })))?.status
    ).toBe(413)
    expect((await f.dispatch(f.request(undefined, { headers: { 'Content-Length': '257' } })))?.status).toBe(413)
    expect((await f.dispatch(f.request(undefined, { raw: new Uint8Array([0xc3, 0x28]) })))?.status).toBe(400)
    expect((await f.dispatch(f.request(undefined, { headers: { 'Content-Type': 'text/plain' } })))?.status).toBe(415)
    expect(f.sessionCount()).toBe(0)
    expect((await f.dispatch(f.request(undefined, { raw: raw + ' '.repeat(256 - raw.length) })))?.status).toBe(200)
  })
  it.each([
    "UPDATE identities SET status='pending'",
    'UPDATE identities SET email_verified_at=NULL',
    "UPDATE identities SET email='not-demo@example.invalid' WHERE email='cliente@demo.invalid'",
    'UPDATE identities SET customer_id=NULL',
    "UPDATE customers SET status='blocked'",
    'DELETE FROM identity_roles',
    "UPDATE identity_roles SET granted_at='2999-01-01T00:00:00Z'",
    "UPDATE identity_roles SET granted_at='2019-01-01T00:00:00Z',expires_at='2020-01-01T00:00:00Z'"
  ])('never provisions or authenticates an ineligible customer: %s', async (sql) => {
    const f = await fixture()
    f.sqlite.exec(sql)
    const before = f.grantState(),
      response = await f.dispatch(f.request())
    expect(response?.status).toBe(403)
    expect(response?.headers.get('set-cookie')).toBeNull()
    expect(f.sessionCount()).toBe(0)
    expect(f.grantState()).toBe(before)
  })
  it('requires the admin live grant, rejects extra customer authority and never creates missing dummy accounts', async () => {
    const f = await fixture()
    f.sqlite.exec(
      "DELETE FROM role_permissions; INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES('" +
        DEMO_IDENTITIES.customer.identityId +
        "','admin','2020-01-01T00:00:00Z')"
    )
    expect((await f.dispatch(f.request({ role: 'admin' })))?.status).toBe(403)
    expect((await f.dispatch(f.request()))?.status).toBe(403)
    f.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(DEMO_IDENTITIES.admin.identityId)
    f.sqlite.prepare('DELETE FROM identities WHERE id=?').run(DEMO_IDENTITIES.admin.identityId)
    expect((await f.dispatch(f.request({ role: 'admin' })))?.status).toBe(403)
    expect(f.sessionCount()).toBe(0)
  })
  it.each(['DEMO_ENABLED', 'APP_ENV', 'AUTH_ORIGIN', 'NUXT_SESSION_PASSWORD'] as const)(
    'withdraws changed %s after the last real D1 row before delivering Set-Cookie',
    async (key) => {
      const f = await fixture(),
        assertApplied = f.afterFirst(
          (sql) => sql.startsWith('SELECT s.id AS sessionId'),
          () => {
            f.env[key] =
              key === 'DEMO_ENABLED'
                ? 'false'
                : key === 'APP_ENV'
                  ? 'production'
                  : key === 'AUTH_ORIGIN'
                    ? 'https://other.invalid'
                    : 'rotated-synthetic-password-0123456789abcdef'
          }
        )
      const response = await f.dispatch(f.request({ role: 'admin' }))
      assertApplied()
      expect(response?.status).toBe(503)
      expect(response?.headers.get('set-cookie')).toBeNull()
      expect(await response!.json()).toEqual({ error: { code: 'demo_unavailable' } })
    }
  )
  it.each([
    'UPDATE identities SET session_version=session_version+1',
    "UPDATE customers SET status='blocked'",
    'DELETE FROM identity_roles'
  ])('rechecks live eligibility after the profile await: %s', async (sql) => {
    const f = await fixture(),
      assertApplied = f.afterFirst(
        (query) => query.includes('SELECT i.id, i.email'),
        () => f.sqlite.exec(sql)
      )
    const response = await f.dispatch(f.request())
    assertApplied()
    expect(response?.status).toBe(403)
    expect(response?.headers.get('set-cookie')).toBeNull()
  })
  it('admin MFA revocation during its authorization await is caught by the final session read', async () => {
    const f = await fixture(),
      assertApplied = f.afterFirst(
        (sql) => sql.includes('AS permitted'),
        () => f.sqlite.exec('UPDATE auth_sessions SET mfa_verified=0')
      )
    const response = await f.dispatch(f.request({ role: 'admin' }))
    assertApplied()
    expect(response?.status).toBe(403)
    expect(response?.headers.get('set-cookie')).toBeNull()
  })
  it('ordinary password login retains MFA requirements; demo login never upgrades existing sessions or identity MFA', async () => {
    const f = await fixture(),
      password = 'Synthetic-normal-password-123'
    f.sqlite
      .prepare('UPDATE identities SET password_hash=? WHERE id=?')
      .run(await hashWorkerPassword(password), DEMO_IDENTITIES.admin.identityId)
    const normal = await loginD1(f.database, {
      email: DEMO_IDENTITIES.admin.email,
      password,
      tokenPepper: f.env.AUTH_RATE_LIMIT_PEPPER
    })
    expect(normal.ok && normal.kind).toBe('session')
    if (!normal.ok || normal.kind !== 'session') throw Error('normal_login_unconfirmed')
    const cookie = await issueD1SessionCookie(f.database, normal, f.configuration)
    expect(cookie).not.toBeNull()
    expect(await authorizeD1Session(f.database, normal, 'administration.manage', { requireMfa: true })).toMatchObject({
      allowed: false,
      code: 'mfa_required'
    })
    expect((await f.dispatch(f.request({ role: 'admin' })))?.status).toBe(200)
    expect(f.sqlite.prepare('SELECT mfa_verified FROM auth_sessions WHERE id=?').get(normal.sessionId)).toEqual({
      mfa_verified: 0
    })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM identity_mfa').get()).toEqual({ n: 0 })
  })
  it('returns bounded errors without logging SQL, profile data, provider data or cookie', async () => {
    const f = await fixture(),
      logs = vi.spyOn(console, 'error'),
      fetch = vi.spyOn(globalThis, 'fetch')
    f.env.DB = {
      prepare: () => {
        throw Error('private SQL and profile material must never escape')
      }
    } as unknown as D1Database
    const response = await f.dispatch(f.request({ role: 'admin' }))
    expect(response?.status).toBe(503)
    expect(await response!.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(response?.headers.get('set-cookie')).toBeNull()
    expect(logs).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
