import { randomBytes } from 'node:crypto'
import { TOTP, Secret } from 'otpauth'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openAccountSecurityDatabase } from '../support/d1-sqlite'
import { handleAuthenticationHttp } from '../../workers/auth/http'
import { hashWorkerPassword } from '../../workers/auth/password'
import { decryptSecret } from '../../server/utils/secrets'
import { pruneD1MfaEnrollments } from '../../workers/auth/mfa-enrollment'
import { testNow } from '../support/deterministic'

const identityId = '10000000-0000-4000-8000-000000000073'
const customerId = '30000000-0000-4000-8000-000000000073'
const password = 'Synthetic-enrollment-password-123'
const configuration = {
  password: randomBytes(32).toString('hex'),
  maxAgeSeconds: 3600,
  origin: 'https://neteco.invalid',
  tokenPepper: randomBytes(32).toString('hex'),
  encryptionKey: randomBytes(32).toString('base64')
}

describe('D1 MFA enrollment', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  const limiter = { limit: vi.fn(async () => ({ success: true })) }
  function api(method: string, path: string, cookie = '', body?: unknown, origin = configuration.origin) {
    return new Request(`${configuration.origin}${path}`, {
      method,
      headers: {
        cookie,
        origin,
        'cf-connecting-ip': '192.0.2.73',
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  }
  const handle = (request: Request) =>
    handleAuthenticationHttp(request, { database, edgeLimiter: limiter, configuration: () => configuration })
  async function login() {
    const response = (await handle(
      api('POST', '/api/auth/login', '', { email: 'mfa-enrollment@example.invalid', password })
    ))!
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';')[0]!
  }
  async function setup(cookie: string, currentPassword = password) {
    return (await handle(api('POST', '/api/auth/mfa/setup', cookie, { currentPassword })))!
  }
  async function enrollment(cookie: string) {
    const response = await setup(cookie)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return (await response.json()) as {
      setupId: string
      uri: string
      manualKey: string
      recoveryCodes: string[]
    }
  }
  function code(secret: string) {
    return new TOTP({
      issuer: 'NETECO',
      label: 'account',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secret)
    }).generate()
  }
  async function verify(cookie: string, setupId: string, token: string) {
    return (await handle(api('POST', '/api/auth/mfa/verify-setup', cookie, { setupId, code: token })))!
  }

  beforeEach(async () => {
    limiter.limit.mockReset().mockResolvedValue({ success: true })
    sqlite = await openAccountSecurityDatabase()
    database = d1OverSqlite(sqlite)
    const now = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    sqlite
      .prepare('INSERT INTO customers(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(customerId, 'Cliente', now, now)
    sqlite
      .prepare(
        `INSERT INTO identities(id, email, password_hash, email_verified_at, status,
          customer_id, created_at, updated_at)
        VALUES (?, 'mfa-enrollment@example.invalid', ?, ?, 'active', ?, ?, ?)`
      )
      .run(identityId, await hashWorkerPassword(password), now, customerId, now, now)
  })
  afterEach(() => sqlite.close())

  it('requires a live session, exact origin, verified email and the current password', async () => {
    expect((await setup('')).status).toBe(401)
    const cookie = await login()
    expect((await setup(cookie, 'wrong-password')).status).toBe(401)
    expect(
      (await handle(api('POST', '/api/auth/mfa/setup', cookie, { currentPassword: password }, 'https://evil.invalid')))!
        .status
    ).toBe(403)
    expect(sqlite.prepare('SELECT count(*) AS n FROM mfa_enrollments').get()).toEqual({ n: 0 })
    sqlite.prepare('UPDATE identities SET email_verified_at = NULL WHERE id = ?').run(identityId)
    expect((await setup(cookie)).status).toBe(403)
    expect(sqlite.prepare('SELECT count(*) AS n FROM mfa_enrollments').get()).toEqual({ n: 0 })
  })

  it('stores only encrypted secret and recovery hashes, then activates MFA and closes other sessions', async () => {
    const cookie = await login()
    const otherCookie = await login()
    const pending = await enrollment(cookie)
    expect(pending.recoveryCodes).toHaveLength(8)
    const stored = sqlite.prepare('SELECT * FROM mfa_enrollments WHERE id = ?').get(pending.setupId) as {
      encrypted_secret: string
      recovery_code_hashes: string
    }
    expect(stored.encrypted_secret).not.toContain(pending.manualKey)
    expect(decryptSecret(stored.encrypted_secret, configuration.encryptionKey)).toBe(pending.manualKey)
    expect(stored.recovery_code_hashes).not.toContain(pending.recoveryCodes[0]!)
    expect(sqlite.prepare('SELECT count(*) AS n FROM identity_mfa').get()).toEqual({ n: 0 })
    const completed = await verify(cookie, pending.setupId, code(pending.manualKey))
    expect(completed.status).toBe(200)
    expect(completed.headers.get('cache-control')).toBe('no-store')
    expect(await completed.json()).toEqual({ ok: true })
    expect(sqlite.prepare('SELECT count(*) AS n FROM mfa_enrollments').get()).toEqual({ n: 0 })
    const factor = sqlite.prepare('SELECT verified_at, last_used_step FROM identity_mfa').get() as {
      verified_at: string
      last_used_step: number
    }
    expect(factor.verified_at).toMatch(/Z$/)
    expect(factor.last_used_step).toBeGreaterThan(0)
    expect((await (await handle(api('GET', '/api/_auth/session', cookie)))!.json()).user).toMatchObject({
      mfaVerified: true
    })
    expect((await handle(api('GET', '/api/account/sessions', otherCookie)))!.status).toBe(401)
    expect((await setup(cookie)).status).toBe(409)
    expect((await verify(cookie, pending.setupId, code(pending.manualKey))).status).toBe(401)
    expect(sqlite.prepare('SELECT count(*) AS n FROM identity_mfa').get()).toEqual({ n: 1 })
  })

  it('invalidates replaced setup IDs and rejects expired or repeatedly wrong codes', async () => {
    const cookie = await login()
    const first = await enrollment(cookie)
    const second = await enrollment(cookie)
    expect((await verify(cookie, first.setupId, code(first.manualKey))).status).toBe(401)
    for (let index = 0; index < 6; index++) expect((await verify(cookie, second.setupId, 'xxxxxx')).status).toBe(400)
    sqlite.prepare("DELETE FROM identity_rate_limits WHERE identity_id = ? AND scope = 'mfa-setup'").run(identityId)
    for (let index = 0; index < 6; index++) expect((await verify(cookie, second.setupId, '000000')).status).toBe(401)
    expect((await verify(cookie, second.setupId, code(second.manualKey))).status).toBe(429)
    expect(sqlite.prepare('SELECT count(*) AS n FROM identity_mfa').get()).toEqual({ n: 0 })
    sqlite.prepare("DELETE FROM identity_rate_limits WHERE identity_id = ? AND scope = 'mfa-setup'").run(identityId)
    expect((await verify(cookie, second.setupId, code(second.manualKey))).status).toBe(401)
  })

  it('rolls back activation if the current session cannot be elevated', async () => {
    const cookie = await login()
    const pending = await enrollment(cookie)
    sqlite.exec(`CREATE TRIGGER synthetic_mfa_failure BEFORE UPDATE OF mfa_verified ON auth_sessions
      WHEN NEW.mfa_verified = 1 BEGIN SELECT RAISE(ABORT, 'synthetic-failure'); END`)
    expect((await verify(cookie, pending.setupId, code(pending.manualKey))).status).toBe(500)
    expect(sqlite.prepare('SELECT count(*) AS n FROM identity_mfa').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT activation_id FROM mfa_enrollments WHERE id = ?').get(pending.setupId)).toEqual({
      activation_id: null
    })
    sqlite.exec('DROP TRIGGER synthetic_mfa_failure')
    expect((await verify(cookie, pending.setupId, code(pending.manualKey))).status).toBe(200)
  })

  it('activates exactly once under concurrent confirmation and rejects an expired setup', async () => {
    const cookie = await login()
    const expired = await enrollment(cookie)
    sqlite
      .prepare('UPDATE mfa_enrollments SET created_at = ?, expires_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00Z', '2026-01-01T00:10:00Z', expired.setupId)
    expect((await verify(cookie, expired.setupId, code(expired.manualKey))).status).toBe(401)
    const pending = await enrollment(cookie)
    const token = code(pending.manualKey)
    const results = await Promise.all([verify(cookie, pending.setupId, token), verify(cookie, pending.setupId, token)])
    expect(results.map((result) => result.status).sort()).toEqual([200, 401])
    expect(sqlite.prepare('SELECT count(*) AS n FROM identity_mfa WHERE verified_at IS NOT NULL').get()).toEqual({
      n: 1
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM mfa_enrollments').get()).toEqual({ n: 0 })
  })

  it('binds a pending setup to its exact session and session version', async () => {
    const ownerCookie = await login()
    const otherCookie = await login()
    const pending = await enrollment(ownerCookie)
    expect((await verify(otherCookie, pending.setupId, code(pending.manualKey))).status).toBe(401)
    expect(sqlite.prepare('SELECT count(*) AS n FROM identity_mfa').get()).toEqual({ n: 0 })
    sqlite.prepare('UPDATE identities SET session_version = session_version + 1 WHERE id = ?').run(identityId)
    sqlite
      .prepare('UPDATE auth_sessions SET session_version = session_version + 1 WHERE identity_id = ?')
      .run(identityId)
    expect((await verify(ownerCookie, pending.setupId, code(pending.manualKey))).status).toBe(401)
    expect(sqlite.prepare('SELECT count(*) AS n FROM identity_mfa').get()).toEqual({ n: 0 })
  })

  it('prunes expired pending secrets without removing a live setup', async () => {
    const cookie = await login()
    const pending = await enrollment(cookie)
    await pruneD1MfaEnrollments(database, '2026-01-01T00:00:00Z')
    expect(sqlite.prepare('SELECT count(*) AS n FROM mfa_enrollments').get()).toEqual({ n: 1 })
    sqlite
      .prepare('UPDATE mfa_enrollments SET created_at = ?, expires_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00Z', '2026-01-01T00:10:00Z', pending.setupId)
    await pruneD1MfaEnrollments(database, new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z'))
    expect(sqlite.prepare('SELECT count(*) AS n FROM mfa_enrollments').get()).toEqual({ n: 0 })
  })
})
