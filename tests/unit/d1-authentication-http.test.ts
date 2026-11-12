import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { d1OverSqlite, openAccountSecurityDatabase } from '../support/d1-sqlite'
import { handleAuthenticationHttp } from '../../workers/auth/http'
import { hashWorkerPassword } from '../../workers/auth/password'
import { encryptSecret } from '../../server/utils/secrets'
import { recoveryCodeHashes } from '../../server/domain/mfa'
import { consumeAuthenticationQuota, pruneAuthenticationQuotas } from '../../workers/auth/anonymous-quota'
import { testUuid, testNow } from '../support/deterministic'

const identityId = '10000000-0000-4000-8000-000000000001'
const password = 'Synthetic-password-123'
const configuration = {
  password: randomBytes(32).toString('hex'),
  maxAgeSeconds: 3600,
  origin: 'https://neteco.invalid',
  tokenPepper: randomBytes(32).toString('hex'),
  encryptionKey: randomBytes(32).toString('base64')
}
describe('D1 authentication HTTP boundary', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  const limiter = { limit: vi.fn(async () => ({ success: true })) }
  function request(
    path = '/api/auth/login',
    body: unknown = { email: 'fixture@example.invalid', password },
    headers: Record<string, string> = {}
  ) {
    return new Request(`https://neteco.invalid${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        origin: configuration.origin,
        'cf-connecting-ip': '192.0.2.1',
        'content-type': 'application/json',
        ...headers
      }
    })
  }
  const handle = (req: Request) =>
    handleAuthenticationHttp(req, { database, edgeLimiter: limiter, configuration: () => configuration })
  beforeEach(async () => {
    limiter.limit.mockReset().mockResolvedValue({ success: true })
    sqlite = await openAccountSecurityDatabase()
    database = d1OverSqlite(sqlite)
    const now = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    sqlite
      .prepare(
        `INSERT INTO identities(id, email, password_hash, status, created_at, updated_at) VALUES (?, 'fixture@example.invalid', ?, 'active', ?, ?)`
      )
      .run(identityId, await hashWorkerPassword(password), now, now)
  })
  afterEach(() => sqlite.close())

  it('projects only the linked customer and company, reflecting edits and anonymization', async () => {
    const instant = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const own = '30000000-0000-4000-8000-000000000001'
    const other = '30000000-0000-4000-8000-000000000002'
    const insertCustomer = sqlite.prepare(
      'INSERT INTO customers(id, name, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    insertCustomer.run(own, 'Cliente propio', '+34600111222', instant, instant)
    insertCustomer.run(other, 'Cliente ajeno', '+34600999888', instant, instant)
    const insertCompany = sqlite.prepare(
      'INSERT INTO companies(id, customer_id, legal_name, tax_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    insertCompany.run('40000000-0000-4000-8000-000000000001', own, 'Empresa propia SL', 'B12345678', instant, instant)
    insertCompany.run('40000000-0000-4000-8000-000000000002', other, 'Empresa ajena SL', 'B87654321', instant, instant)
    sqlite.prepare('UPDATE identities SET customer_id = ? WHERE id = ?').run(own, identityId)

    const login = (await handle(request()))!
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const read = async () => {
      const response = await handle(
        new Request('https://neteco.invalid/api/_auth/session', {
          headers: { cookie, 'cf-connecting-ip': '192.0.2.1' }
        })
      )
      expect(response!.status).toBe(200)
      return response!.json() as Promise<{
        user: { name: string | null; phone: string | null; company: string | null }
      }>
    }
    expect((await read()).user).toMatchObject({
      name: 'Cliente propio',
      phone: '+34600111222',
      company: 'Empresa propia SL'
    })
    sqlite
      .prepare('UPDATE companies SET legal_name = ?, updated_at = ? WHERE customer_id = ?')
      .run('Empresa actualizada SL', instant, own)
    expect((await read()).user.company).toBe('Empresa actualizada SL')
    expect(JSON.stringify(await read())).not.toContain('Empresa ajena')
    sqlite.prepare("UPDATE customers SET status = 'anonymized' WHERE id = ?").run(own)
    expect((await read()).user).toMatchObject({ name: null, phone: null, company: null })
  })

  it('reads and updates only the authenticated account profile through the existing UI routes', async () => {
    const instant = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const own = '30000000-0000-4000-8000-000000000011'
    const other = '30000000-0000-4000-8000-000000000012'
    sqlite
      .prepare('INSERT INTO customers(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(own, 'Original', instant, instant)
    sqlite
      .prepare('INSERT INTO customers(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(other, 'Ajeno', instant, instant)
    sqlite.prepare('UPDATE identities SET customer_id = ? WHERE id = ?').run(own, identityId)
    sqlite
      .prepare(
        `INSERT INTO companies(id, customer_id, legal_name, tax_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(testUuid(), own, 'Empresa propia', 'B12345678', instant, instant)
    const login = (await handle(request()))!
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const account = await handle(
      new Request('https://neteco.invalid/api/account', {
        headers: { cookie, 'cf-connecting-ip': '192.0.2.1' }
      })
    )
    expect(await account!.json()).toEqual({
      profile: {
        name: 'Original',
        phone: null,
        email: 'fixture@example.invalid',
        companyId: expect.any(String),
        company: 'Empresa propia',
        tradeName: null,
        taxId: 'B12345678',
        countryCode: 'ES',
        companyStatus: 'pending',
        companyRole: null
      }
    })
    expect(
      (await handle(
        request('/api/account/profile', { name: 'Nuevo', phone: '+34600111222', customerId: other }, { cookie })
      ))!.status
    ).toBe(405)
    const update = await handle(
      new Request('https://neteco.invalid/api/account/profile', {
        method: 'PUT',
        body: JSON.stringify({ name: 'Nuevo', phone: '+34600111222' }),
        headers: {
          cookie,
          origin: configuration.origin,
          'cf-connecting-ip': '192.0.2.1',
          'content-type': 'application/json'
        }
      })
    )
    expect(update!.status).toBe(200)
    expect(await update!.json()).toMatchObject({ user: { name: 'Nuevo', phone: '+34600111222' } })
    expect(sqlite.prepare('SELECT name FROM customers WHERE id = ?').get(own)).toEqual({ name: 'Nuevo' })
    expect(sqlite.prepare('SELECT name FROM customers WHERE id = ?').get(other)).toEqual({ name: 'Ajeno' })
    const tampered = await handle(
      new Request('https://neteco.invalid/api/account/profile', {
        method: 'PUT',
        body: JSON.stringify({ name: 'Intruso', phone: '', customerId: other }),
        headers: {
          cookie,
          origin: configuration.origin,
          'cf-connecting-ip': '192.0.2.1',
          'content-type': 'application/json'
        }
      })
    )
    expect(tampered!.status).toBe(400)
    sqlite.prepare('UPDATE auth_sessions SET revoked_at = ?').run(instant)
    const denied = await handle(
      new Request('https://neteco.invalid/api/account/profile', {
        method: 'PUT',
        body: JSON.stringify({ name: 'Otro', phone: '' }),
        headers: {
          cookie,
          origin: configuration.origin,
          'cf-connecting-ip': '192.0.2.1',
          'content-type': 'application/json'
        }
      })
    )
    expect(denied!.status).toBe(401)
    expect(sqlite.prepare('SELECT name FROM customers WHERE id = ?').get(own)).toEqual({ name: 'Nuevo' })
  })

  it('enforces one identity and one company per customer, with unique fiscal identity', async () => {
    const instant = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const customer = '30000000-0000-4000-8000-000000000003'
    sqlite.prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)').run(customer, instant, instant)
    sqlite.prepare('UPDATE identities SET customer_id = ? WHERE id = ?').run(customer, identityId)
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO identities(id, email, password_hash, status, customer_id, created_at, updated_at)
      VALUES (?, 'other@example.invalid', 'fixture', 'active', ?, ?, ?)`
        )
        .run(testUuid(), customer, instant, instant)
    ).toThrow()
    sqlite
      .prepare(
        `INSERT INTO companies(id, customer_id, legal_name, country_code, tax_id, created_at, updated_at)
      VALUES (?, ?, 'Empresa', 'ES', 'B12345678', ?, ?)`
      )
      .run(testUuid(), customer, instant, instant)
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO companies(id, customer_id, legal_name, country_code, tax_id, created_at, updated_at)
      VALUES (?, ?, 'Empresa duplicada', 'ES', 'B12345678', ?, ?)`
        )
        .run(testUuid(), customer, instant, instant)
    ).toThrow()
  })

  it('requires password and verified email for fiscal changes, then records redacted pending review', async () => {
    const instant = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const customer = '30000000-0000-4000-8000-000000000021'
    sqlite.prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)').run(customer, instant, instant)
    sqlite
      .prepare('UPDATE identities SET customer_id = ?, email_verified_at = ? WHERE id = ?')
      .run(customer, instant, identityId)
    const cookie = (await handle(request()))!.headers.get('set-cookie')!.split(';')[0]!
    const submit = (body: Record<string, unknown>) =>
      handle(
        new Request('https://neteco.invalid/api/account/company', {
          method: 'PUT',
          body: JSON.stringify(body),
          headers: {
            cookie,
            origin: configuration.origin,
            'cf-connecting-ip': '192.0.2.1',
            'content-type': 'application/json'
          }
        })
      )
    const details = {
      legalName: 'Empresa Ejemplo SL',
      tradeName: 'Ejemplo',
      taxId: 'B12345674',
      countryCode: 'ES',
      currentPassword: password
    }
    expect((await submit({ ...details, currentPassword: 'wrong' }))!.status).toBe(401)
    expect(sqlite.prepare('SELECT count(*) AS n FROM companies').get()).toEqual({ n: 0 })
    const first = (await submit(details))!
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ status: 'pending', user: { company: 'Empresa Ejemplo SL' } })
    expect(sqlite.prepare('SELECT legal_name, tax_id, status FROM companies').get()).toEqual({
      legal_name: 'Empresa Ejemplo SL',
      tax_id: 'B12345674',
      status: 'pending'
    })
    expect(sqlite.prepare('SELECT event_type, tax_id_suffix FROM company_review_events').get()).toEqual({
      event_type: 'submitted',
      tax_id_suffix: '5674'
    })
    expect(() => sqlite.exec("UPDATE company_review_events SET event_type = 'submitted'")).toThrow()
    const otherCustomer = '30000000-0000-4000-8000-000000000023'
    sqlite
      .prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)')
      .run(otherCustomer, instant, instant)
    sqlite
      .prepare(
        `INSERT INTO companies(id, customer_id, legal_name, tax_id, created_at, updated_at)
      VALUES (?, ?, 'Empresa ajena', 'A58818501', ?, ?)`
      )
      .run(testUuid(), otherCustomer, instant, instant)
    const duplicate = (await submit({ ...details, taxId: 'A58818501' }))!
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({ error: { code: 'duplicate_tax_id' } })
    expect(sqlite.prepare('SELECT tax_id FROM companies WHERE customer_id = ?').get(customer)).toEqual({
      tax_id: 'B12345674'
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM company_review_events').get()).toEqual({ n: 1 })
    sqlite.exec("UPDATE companies SET status = 'approved'")
    expect((await submit({ ...details, tradeName: 'Nuevo nombre comercial' }))!.status).toBe(200)
    expect(sqlite.prepare('SELECT status FROM companies').get()).toEqual({ status: 'approved' })
    const changed = (await submit({ ...details, legalName: 'Empresa Nueva SL' }))!
    expect(changed.status).toBe(200)
    expect(sqlite.prepare('SELECT status FROM companies').get()).toEqual({ status: 'pending' })
    expect(sqlite.prepare('SELECT count(*) AS n FROM company_review_events').get()).toEqual({ n: 3 })
    expect((await submit({ ...details, taxId: 'invalid-tax' }))!.status).toBe(429)
  })

  it('denies fiscal writes after password verification if the session was revoked meanwhile', async () => {
    const instant = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const customer = '30000000-0000-4000-8000-000000000022'
    sqlite.prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)').run(customer, instant, instant)
    sqlite
      .prepare('UPDATE identities SET customer_id = ?, email_verified_at = ? WHERE id = ?')
      .run(customer, instant, identityId)
    const cookie = (await handle(request()))!.headers.get('set-cookie')!.split(';')[0]!
    const real = database
    const racing = Object.create(real) as D1Database
    racing.batch = async (statements) => {
      sqlite.prepare('UPDATE auth_sessions SET revoked_at = ?').run(instant)
      return real.batch(statements)
    }
    database = racing
    const response = await handle(
      new Request('https://neteco.invalid/api/account/company', {
        method: 'PUT',
        body: JSON.stringify({
          legalName: 'Empresa Nueva SL',
          taxId: 'B12345674',
          countryCode: 'ES',
          currentPassword: password
        }),
        headers: {
          cookie,
          origin: configuration.origin,
          'cf-connecting-ip': '192.0.2.1',
          'content-type': 'application/json'
        }
      })
    )
    expect(response!.status).toBe(401)
    expect(sqlite.prepare('SELECT count(*) AS n FROM companies').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM company_review_events').get()).toEqual({ n: 0 })
  })

  it('rejects malformed fiscal identifiers before writing a company', async () => {
    const instant = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const customer = '30000000-0000-4000-8000-000000000024'
    sqlite.prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)').run(customer, instant, instant)
    sqlite
      .prepare('UPDATE identities SET customer_id = ?, email_verified_at = ? WHERE id = ?')
      .run(customer, instant, identityId)
    const cookie = (await handle(request()))!.headers.get('set-cookie')!.split(';')[0]!
    const response = await handle(
      new Request('https://neteco.invalid/api/account/company', {
        method: 'PUT',
        body: JSON.stringify({
          legalName: 'Empresa Nueva SL',
          taxId: 'invalid-tax',
          countryCode: 'ES',
          currentPassword: password
        }),
        headers: {
          cookie,
          origin: configuration.origin,
          'cf-connecting-ip': '192.0.2.1',
          'content-type': 'application/json'
        }
      })
    )
    expect(response!.status).toBe(400)
    expect(sqlite.prepare('SELECT count(*) AS n FROM companies').get()).toEqual({ n: 0 })
  })

  it('serves the Nuxt session contract from current D1 grants and clears it with DELETE', async () => {
    const login = (await handle(request()))!
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const sessionRequest = (headers: Record<string, string> = { cookie }) =>
      new Request('https://neteco.invalid/api/_auth/session', {
        headers: { 'cf-connecting-ip': '192.0.2.1', ...headers }
      })
    const read = async () => (await handle(sessionRequest()))!.json()
    expect(await (await handle(sessionRequest({})))!.json()).toEqual({})
    expect(await read()).toMatchObject({
      user: {
        id: identityId,
        email: 'fixture@example.invalid',
        role: 'customer',
        roles: ['customer'],
        mfaVerified: false
      }
    })
    sqlite.exec(
      "INSERT INTO roles VALUES ('admin', 'Admin', 'Test'); INSERT INTO roles VALUES ('finance', 'Finance', 'Test')"
    )
    sqlite
      .prepare(
        "INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES (?, 'admin', '2020-01-01T00:00:00Z')"
      )
      .run(identityId)
    sqlite
      .prepare(
        "INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES (?, 'finance', '2099-01-01T00:00:00Z')"
      )
      .run(identityId)
    expect(await read()).toMatchObject({ user: { role: 'admin', roles: ['admin'], mfaVerified: false } })
    sqlite.exec('DELETE FROM identity_roles')
    expect(await read()).toMatchObject({ user: { role: 'customer', roles: ['customer'] } })
    const deleted = await handle(
      new Request('https://neteco.invalid/api/_auth/session', {
        method: 'DELETE',
        headers: { cookie, origin: configuration.origin, 'cf-connecting-ip': '192.0.2.1' }
      })
    )
    expect(deleted!.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(await read()).toEqual({})
  })

  it('rejects cross-site session reads and session clearing without an origin', async () => {
    for (const [method, headers] of [
      ['GET', { 'sec-fetch-site': 'cross-site' }],
      ['GET', { origin: 'https://evil.invalid' }],
      ['DELETE', {}]
    ] as const) {
      const response = await handle(
        new Request('https://neteco.invalid/api/_auth/session', {
          method,
          headers: { 'cf-connecting-ip': '192.0.2.1', ...headers }
        })
      )
      expect(response!.status).toBe(403)
      expect(response!.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('does not refresh a disabled identity even with an intact signed cookie', async () => {
    const login = (await handle(request()))!
    sqlite.exec("UPDATE identities SET status = 'disabled'")
    const response = await handle(
      new Request('https://neteco.invalid/api/_auth/session', {
        headers: { cookie: login.headers.get('set-cookie')!.split(';')[0]!, 'cf-connecting-ip': '192.0.2.1' }
      })
    )
    expect(await response!.json()).toEqual({})
  })

  it('logs in with a secure cookie, checks logout CSRF, and revokes server-side', async () => {
    const response = (await handle(request()))!
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const cookie = response.headers.get('set-cookie')!
    expect(cookie).toContain('HttpOnly; Secure; SameSite=Lax')
    expect(await response.json()).toEqual({ authenticated: true })
    expect((await handle(request('/api/auth/logout', {}, { cookie, origin: 'https://evil.invalid' })))!.status).toBe(
      403
    )
    expect(sqlite.prepare('SELECT revoked_at FROM auth_sessions').get()).toEqual({ revoked_at: null })
    const logout = (await handle(request('/api/auth/logout', {}, { cookie })))!
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(sqlite.prepare('SELECT revoked_at FROM auth_sessions').get()!.revoked_at).not.toBeNull()
  })

  it('only grants a cookie after password plus a single-use MFA recovery code', async () => {
    const now = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const code = 'ABCD-1234-EFAB-5678'
    sqlite
      .prepare(
        'INSERT INTO identity_mfa(identity_id, encrypted_secret, recovery_code_hashes, verified_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        identityId,
        encryptSecret('JBSWY3DPEHPK3PXP', configuration.encryptionKey),
        JSON.stringify(recoveryCodeHashes([code], configuration.tokenPepper)),
        now,
        now
      )
    const login = (await handle(request()))!
    expect(login.headers.has('set-cookie')).toBe(false)
    const body = (await login.json()) as { mfaRequired: boolean; challenge: string }
    expect(body.mfaRequired).toBe(true)
    const completion = (await handle(request('/api/auth/mfa/complete', { challenge: body.challenge, code })))!
    expect(completion.status).toBe(200)
    expect(completion.headers.has('set-cookie')).toBe(true)
    expect((await handle(request('/api/auth/mfa/complete', { challenge: body.challenge, code })))!.status).toBe(401)
    expect(sqlite.prepare('SELECT count(*) AS n, mfa_verified FROM auth_sessions').get()).toEqual({
      n: 1,
      mfa_verified: 1
    })
  })

  it('denies edge-limited traffic before reading the body or touching D1', async () => {
    limiter.limit.mockResolvedValue({ success: false })
    const req = request()
    const response = (await handle(req))!
    expect(response.status).toBe(429)
    expect(req.bodyUsed).toBe(false)
    expect(sqlite.prepare('SELECT count(*) AS n FROM authentication_rate_limits').get()).toEqual({ n: 0 })
  })

  it.each([
    [{ email: 'fixture@example.invalid', password, role: 'admin' }, {}, 400],
    ['x'.repeat(4097), {}, 413],
    [{}, { 'content-type': 'text/plain' }, 415],
    [{}, { 'sec-fetch-site': 'cross-site' }, 403]
  ])('rejects hostile request fields and envelopes', async (body, headers, status) => {
    expect((await handle(request('/api/auth/login', body, headers as Record<string, string>)))!.status).toBe(status)
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get()).toEqual({ n: 0 })
  })

  it('does not enumerate unknown accounts, and enforces the shared five-attempt policy', async () => {
    const wrong = (email: string) => handle(request('/api/auth/login', { email, password: 'wrong' }))
    const known = (await wrong('fixture@example.invalid'))!
    const absent = (await wrong('absent@example.invalid'))!
    expect(known.status).toBe(401)
    expect(absent.status).toBe(401)
    expect(await known.json()).toEqual(await absent.json())
    const results = await Promise.all(Array.from({ length: 8 }, () => wrong('absent@example.invalid')))
    expect(results.filter((response) => response!.status === 401)).toHaveLength(3)
    expect(results.filter((response) => response!.status === 429)).toHaveLength(5)
    const rows = sqlite.prepare('SELECT subject_hash FROM authentication_rate_limits').all()
    expect(rows.every((row) => /^[a-f0-9]{64}$/.test(String(row.subject_hash)))).toBe(true)
  })

  it('fails closed when quota persistence fails, without exposing SQL', async () => {
    sqlite.exec(
      "CREATE TRIGGER quota_outage BEFORE INSERT ON authentication_rate_limits BEGIN SELECT RAISE(ABORT, 'private_sql_failure'); END"
    )
    const response = (await handle(request()))!
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'abuse_control_unavailable' } })
  })

  it('resets at the exact quota boundary and prunes only expired rows', async () => {
    const input = {
      subject: 'fixture@example.invalid',
      kind: 'email' as const,
      scope: 'login' as const,
      pepper: configuration.tokenPepper
    }
    for (let attempt = 0; attempt < 6; attempt++) await consumeAuthenticationQuota(database, { ...input, now: 100 })
    expect((await consumeAuthenticationQuota(database, { ...input, now: 999 })).allowed).toBe(false)
    expect((await consumeAuthenticationQuota(database, { ...input, now: 1000 })).allowed).toBe(true)
    await consumeAuthenticationQuota(database, { ...input, subject: 'fresh@example.invalid' })
    await pruneAuthenticationQuotas(database)
    expect(sqlite.prepare('SELECT count(*) AS n FROM authentication_rate_limits').get()).toEqual({ n: 1 })
  })
})
