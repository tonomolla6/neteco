import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openAccountSecurityDatabase } from '../support/d1-sqlite'
import { handleIdentityLifecycleHttp } from '../../workers/auth/lifecycle-http'
import { registerD1Identity, requestD1PasswordReset } from '../../workers/auth/lifecycle'
import { decryptSecret, encryptSecret } from '../../server/utils/secrets'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { readD1UserSession } from '../../workers/auth/profile'
import * as passwords from '../../workers/auth/password'
import { testUuid, testNow } from '../support/deterministic'

const password = 'Synthetic-http-lifecycle-password-123'
const nextPassword = 'Synthetic-http-rotated-password-456'
const configuration = {
  password: randomBytes(32).toString('hex'),
  maxAgeSeconds: 3600,
  origin: 'https://neteco.invalid',
  tokenPepper: randomBytes(32).toString('hex'),
  encryptionKey: randomBytes(32).toString('base64'),
  newsletterSecrets: { hmacKey: randomBytes(32) }
}
const registration = {
  name: 'Cliente propio',
  email: 'fixture@example.invalid',
  password,
  termsAccepted: true as const,
  newsletter: false
}
const paths = [
  '/api/auth/register',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/verify-email',
  '/api/account/email-change'
]

describe('D1 identity lifecycle HTTP boundary', () => {
  let sqlite: DatabaseSync, database: D1Database
  const limiter = { limit: vi.fn(async () => ({ success: true })) }
  const handle = (request: Request, options = {}) =>
    handleIdentityLifecycleHttp(request, {
      database,
      edgeLimiter: limiter,
      configuration: () => configuration,
      ...options
    })
  function api(path = paths[0]!, body: unknown = registration, headers: Record<string, string> = {}) {
    return new Request(`${configuration.origin}${path}`, {
      method: 'POST',
      headers: {
        origin: configuration.origin,
        'cf-connecting-ip': '192.0.2.71',
        'content-type': 'application/json',
        ...headers
      },
      body: JSON.stringify(body)
    })
  }
  async function registered(email = registration.email) {
    const result = await registerD1Identity(database, { ...registration, email }, configuration)
    if (!result.ok) throw new Error('fixture_registration_failed')
    const issued = await issueD1SessionCookie(database, result, configuration)
    return { ...result, cookie: issued!.split(';')[0]! }
  }
  function token(purpose: string) {
    return decryptSecret(
      (
        sqlite
          .prepare(
            'SELECT token_envelope FROM identity_lifecycle_tokens WHERE purpose=? AND used_at IS NULL AND revoked_at IS NULL'
          )
          .get(purpose) as { token_envelope: string }
      ).token_envelope,
      configuration.encryptionKey
    )
  }
  beforeEach(async () => {
    testNow()
    limiter.limit.mockReset().mockResolvedValue({ success: true })
    sqlite = await openAccountSecurityDatabase()
    if (!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='identity_lifecycle_tokens'").get())
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0032_identity_lifecycle.sql', import.meta.url), 'utf8')
      )
    database = d1OverSqlite(sqlite)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    sqlite.close()
  })

  it('recognizes only the assigned POST routes and fails closed when disabled', async () => {
    expect(await handle(new Request(`${configuration.origin}/api/auth/login`))).toBeNull()
    for (const path of paths) {
      const method = (await handle(new Request(`${configuration.origin}${path}`)))!
      expect(method.status).toBe(405)
      expect(method.headers.get('allow')).toBe('POST')
      const disabled = (await handle(api(path), { configuration: () => null }))!
      expect(disabled.status).toBe(503)
      expect(disabled.headers.get('cache-control')).toBe('no-store')
    }
    expect(limiter.limit).not.toHaveBeenCalled()
  })

  it.each(paths)('requires exact origin before edge/quota/body processing for %s', async (path) => {
    const missing = api(path)
    missing.headers.delete('origin')
    const wrong = api(path, {}, { origin: 'https://attacker.invalid' })
    const cross = api(path, {}, { 'sec-fetch-site': 'cross-site' })
    const wrongUrl = new Request(`https://attacker.invalid${path}`, {
      method: 'POST',
      headers: api(path).headers,
      body: '{}'
    })
    for (const request of [missing, wrong, cross, wrongUrl]) expect((await handle(request))!.status).toBe(403)
    expect(limiter.limit).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT count(*) AS count FROM authentication_rate_limits').get()).toEqual({ count: 0 })
  })

  it('checks edge availability/rate before reading any body or hashing a password', async () => {
    let reads = 0
    const hashing = vi.spyOn(passwords, 'hashWorkerPassword')
    const streamRequest = () =>
      new Request(`${configuration.origin}${paths[0]}`, {
        method: 'POST',
        headers: { origin: configuration.origin, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.71' },
        body: new ReadableStream(
          {
            pull(controller) {
              reads++
              controller.enqueue(new TextEncoder().encode(JSON.stringify(registration)))
              controller.close()
            }
          },
          { highWaterMark: 0 }
        ),
        duplex: 'half'
      } as RequestInit)
    limiter.limit.mockResolvedValueOnce({ success: false })
    expect((await handle(streamRequest()))!.status).toBe(429)
    limiter.limit.mockRejectedValueOnce(new Error('synthetic-edge-down'))
    expect((await handle(streamRequest()))!.status).toBe(503)
    expect(reads).toBe(0)
    expect(hashing).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT count(*) AS count FROM authentication_rate_limits').get()).toEqual({ count: 0 })
  })

  it('rejects missing/untrusted IP and bad secret/origin configuration as unavailable', async () => {
    const noIp = api()
    noIp.headers.delete('cf-connecting-ip')
    expect((await handle(noIp))!.status).toBe(503)
    const invalidAddresses: Record<string, string>[] = [
      { 'cf-connecting-ip': '999.0.2.1' },
      { 'cf-connecting-ip': '', 'x-forwarded-for': '192.0.2.1' }
    ]
    for (const headers of invalidAddresses)
      expect((await handle(api(paths[0], registration, headers)))!.status).toBe(503)
    for (const override of [
      { tokenPepper: 'short' },
      { encryptionKey: 'A'.repeat(43) + '=' },
      { password: 'local-only-'.padEnd(64, 'x') },
      { origin: 'http://neteco.invalid' }
    ])
      expect((await handle(api(), { configuration: () => ({ ...configuration, ...override }) }))!.status).toBe(503)
    expect(sqlite.prepare('SELECT count(*) AS count FROM identities').get()).toEqual({ count: 0 })
  })

  it('returns 413 for declared and chunked oversized bodies before expensive password work', async () => {
    const hashing = vi.spyOn(passwords, 'hashWorkerPassword')
    expect((await handle(api(paths[0], registration, { 'content-length': '4097' })))!.status).toBe(413)
    const chunked = new Request(`${configuration.origin}${paths[0]}`, {
      method: 'POST',
      headers: { origin: configuration.origin, 'cf-connecting-ip': '192.0.2.72', 'content-type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"password":"'))
          controller.enqueue(new TextEncoder().encode('A'.repeat(5000)))
          controller.close()
        }
      }),
      duplex: 'half'
    } as RequestInit)
    expect((await handle(chunked))!.status).toBe(413)
    expect(hashing).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT count(*) AS count FROM identities').get()).toEqual({ count: 0 })
  })

  it('rejects invalid JSON/type and strict unexpected keys before hashing', async () => {
    const hashing = vi.spyOn(passwords, 'hashWorkerPassword')
    const invalidJson = new Request(`${configuration.origin}${paths[0]}`, {
      method: 'POST',
      headers: api().headers,
      body: '{'
    })
    expect((await handle(invalidJson))!.status).toBe(400)
    expect((await handle(api(paths[0], registration, { 'content-type': 'text/plain' })))!.status).toBe(415)
    expect((await handle(api(paths[0], { ...registration, roles: ['admin'], identityId: testUuid() })))!.status).toBe(
      400
    )
    expect(hashing).not.toHaveBeenCalled()
  })

  it('registers with the current frontend body but hides existence behind identical 202 without session/user/ID', async () => {
    const first = (await handle(api(paths[0], { ...registration, phone: '+34600111222', company: 'Empresa' })))!
    const second = (await handle(api(paths[0], { ...registration, phone: '+34600111222', company: 'Empresa' })))!
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(await first.json()).toEqual(await second.json())
    expect(first.headers.get('set-cookie')).toBeNull()
    expect(second.headers.get('set-cookie')).toBeNull()
    expect(first.headers.get('cache-control')).toBe('no-store')
    expect(sqlite.prepare('SELECT count(*) AS count FROM identities').get()).toEqual({ count: 1 })
    expect(sqlite.prepare('SELECT email_verified_at,status FROM identities').get()).toEqual({
      email_verified_at: null,
      status: 'pending'
    })
    expect(sqlite.prepare('SELECT count(*) AS count FROM companies').get()).toEqual({ count: 1 })
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM identity_lifecycle_events').all())).not.toContain(
      registration.email
    )
  })

  it('allows newsletter false without its secret but explicitly refuses true without any account effects', async () => {
    const config = { ...configuration, newsletterSecrets: undefined }
    const failed = (await handle(api(paths[0], { ...registration, newsletter: true }), {
      configuration: () => config
    }))!
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({ error: { code: 'newsletter_unavailable' } })
    expect(sqlite.prepare('SELECT count(*) AS count FROM identities').get()).toEqual({ count: 0 })
    expect((await handle(api(), { configuration: () => config }))!.status).toBe(202)
    expect(sqlite.prepare('SELECT count(*) AS count FROM newsletter_subscriptions').get()).toEqual({ count: 0 })
  })

  it('generic forgot responses are indistinguishable for unknown, active, disabled and blocked accounts', async () => {
    const created = await registered()
    const known = (await handle(api(paths[1], { email: registration.email })))!
    const unknown = (await handle(api(paths[1], { email: 'unknown@example.invalid' })))!
    sqlite.prepare("UPDATE identities SET status='disabled' WHERE id=?").run(created.identityId)
    const disabled = (await handle(api(paths[1], { email: registration.email }, { 'cf-connecting-ip': '192.0.2.72' })))!
    sqlite.prepare("UPDATE identities SET status='active' WHERE id=?").run(created.identityId)
    sqlite.exec("UPDATE customers SET status='blocked'")
    const blocked = (await handle(api(paths[1], { email: registration.email }, { 'cf-connecting-ip': '192.0.2.73' })))!
    const response = await known.json()
    for (const other of [unknown, disabled, blocked]) {
      expect(other.status).toBe(202)
      expect(await other.json()).toEqual(response)
      expect(other.headers.get('set-cookie')).toBeNull()
    }
    expect(
      sqlite.prepare("SELECT count(*) AS count FROM identity_lifecycle_tokens WHERE purpose='password_reset'").get()
    ).toEqual({ count: 1 })
  })

  it('exact D1 IP quota counts malformed requests before reading subsequent bodies', async () => {
    for (let n = 0; n < 3; n++) expect((await handle(api(paths[0], {})))!.status).toBe(400)
    let read = false
    const unread = new Request(`${configuration.origin}${paths[0]}`, {
      method: 'POST',
      headers: api().headers,
      body: new ReadableStream(
        {
          pull(controller) {
            read = true
            controller.close()
          }
        },
        { highWaterMark: 0 }
      ),
      duplex: 'half'
    } as RequestInit)
    const limited = (await handle(unread))!
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('3600')
    expect(read).toBe(false)
    const rows = JSON.stringify(sqlite.prepare('SELECT * FROM authentication_rate_limits').all())
    expect(rows).not.toContain('192.0.2.71')
    expect(rows).not.toContain(registration.email)
  })

  it('exact normalized email quota works across trusted source IPs', async () => {
    for (let n = 0; n < 3; n++)
      expect(
        (await handle(
          api(
            paths[1],
            { email: n % 2 ? ' UNKNOWN@Example.Invalid ' : 'unknown@example.invalid' },
            { 'cf-connecting-ip': `192.0.2.${80 + n}` }
          )
        ))!.status
      ).toBe(202)
    const limited = (await handle(
      api(paths[1], { email: 'unknown@example.invalid' }, { 'cf-connecting-ip': '192.0.2.84' })
    ))!
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('3600')
  })

  it('verification without a cookie proves only email and never creates a session or returns token/ID', async () => {
    await registered()
    const rawToken = token('verify_email')
    const response = (await handle(api(paths[3], { token: rawToken })))!
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(sqlite.prepare('SELECT count(*) AS count FROM auth_sessions').get()).toEqual({ count: 1 })
    expect((await handle(api(paths[3], { token: rawToken })))!.status).toBe(400)
  })

  it('verification refreshes only the appropriate already-live caller session, never another account', async () => {
    const a = await registered()
    const ownToken = token('verify_email')
    const b = await registered('other@example.invalid')
    const response = (await handle(api(paths[3], { token: ownToken }, { cookie: b.cookie })))!
    expect(await response.json()).toEqual({ ok: true })
    expect(response.headers.get('set-cookie')).toBeNull()
    const otherTokenRow = sqlite
      .prepare("SELECT token_envelope FROM identity_lifecycle_tokens WHERE identity_id=? AND purpose='verify_email'")
      .get(b.identityId) as { token_envelope: string }
    const own = (await handle(
      api(
        paths[3],
        { token: decryptSecret(otherTokenRow.token_envelope, configuration.encryptionKey) },
        { cookie: b.cookie }
      )
    ))!
    expect(await own.json()).toMatchObject({ ok: true, user: { id: b.identityId, emailVerified: true } })
    expect(
      await readD1UserSession(
        database,
        new Request(configuration.origin, { headers: { cookie: a.cookie } }),
        configuration
      )
    ).toMatchObject({ user: { id: a.identityId, emailVerified: true } })
  })

  it('reset accepts the current frontend token/password contract, clears cookie and revokes every session', async () => {
    const a = await registered()
    await requestD1PasswordReset(database, { email: registration.email }, configuration)
    const response = (await handle(
      api(paths[2], { token: token('password_reset'), password: nextPassword }, { cookie: a.cookie })
    ))!
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(
      await readD1UserSession(
        database,
        new Request(configuration.origin, { headers: { cookie: a.cookie } }),
        configuration
      )
    ).toEqual({})
  })

  it('email change requires password and MFA before durable queueing, and completion clears ALL sessions', async () => {
    const a = await registered()
    expect((await handle(api(paths[4], { email: 'new@example.invalid', currentPassword: password })))!.status).toBe(401)
    expect((await handle(api(paths[4], { email: 'new@example.invalid' }, { cookie: a.cookie })))!.status).toBe(400)
    const now = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    sqlite
      .prepare('INSERT INTO identity_mfa(identity_id,encrypted_secret,verified_at,updated_at) VALUES (?,?,?,?)')
      .run(a.identityId, encryptSecret('synthetic-mfa', configuration.encryptionKey), now, now)
    expect(
      (await handle(api(paths[4], { email: 'new@example.invalid', currentPassword: password }, { cookie: a.cookie })))!
        .status
    ).toBe(403)
    sqlite.exec('UPDATE auth_sessions SET mfa_verified=1')
    const queued = (await handle(
      api(
        paths[4],
        { email: 'new@example.invalid', currentPassword: password },
        { cookie: a.cookie, 'cf-connecting-ip': '192.0.2.75' }
      )
    ))!
    expect(queued.status).toBe(202)
    expect(await queued.json()).toMatchObject({ ok: true, message: expect.stringContaining('pendiente de envío') })
    const response = (await handle(api(paths[3], { token: token('email_change') }, { cookie: a.cookie })))!
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, emailChanged: true })
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(sqlite.prepare('SELECT email,session_version FROM identities').get()).toEqual({
      email: 'new@example.invalid',
      session_version: 2
    })
    expect(sqlite.prepare('SELECT count(*) AS count FROM auth_sessions WHERE revoked_at IS NULL').get()).toEqual({
      count: 0
    })
  })

  it.each(["o'hara@example.invalid", 'x'.repeat(65) + '@example.invalid', 'a@-example.invalid', 'a@example-.invalid'])(
    'rejects transport-ineligible mailbox %s at entry',
    async (email) => {
      expect((await handle(api(paths[0], { ...registration, email })))!.status).toBe(400)
      expect(sqlite.prepare('SELECT count(*) AS count FROM identities').get()).toEqual({ count: 0 })
    }
  )

  it('D1 and scrypt outages produce 503 without credential/token errors or secret exception data', async () => {
    const a = await registered()
    const events = vi.spyOn(console, 'error'),
      warning = vi.spyOn(console, 'warn')
    const unavailable = {
      prepare() {
        throw new Error(`synthetic-outage ${configuration.tokenPepper}`)
      }
    } as unknown as D1Database
    const failedQuota = (await handle(api(paths[1], { email: registration.email }), { database: unavailable }))!
    expect(failedQuota.status).toBe(503)
    expect(JSON.stringify(await failedQuota.json())).not.toContain(configuration.tokenPepper)
    vi.spyOn(passwords, 'verifyWorkerPassword').mockRejectedValueOnce(new Error(`synthetic-scrypt-outage ${password}`))
    const failedHash = (await handle(
      api(paths[4], { email: 'new@example.invalid', currentPassword: password }, { cookie: a.cookie })
    ))!
    expect(failedHash.status).toBe(503)
    expect(await failedHash.json()).toEqual({ error: { code: 'identity_lifecycle_unavailable' } })
    expect(events).not.toHaveBeenCalled()
    expect(warning).not.toHaveBeenCalled()
    expect(
      sqlite.prepare("SELECT count(*) AS count FROM identity_lifecycle_tokens WHERE purpose='email_change'").get()
    ).toEqual({ count: 0 })
  })
})
