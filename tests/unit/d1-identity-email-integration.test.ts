import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptSecret, hashOpaqueToken } from '../../server/utils/secrets'
import { handleAuthenticationHttp } from '../../workers/auth/http'
import { handleIdentityLifecycleHttp } from '../../workers/auth/lifecycle-http'
import { dispatchIdentityEmailDeliveries } from '../../workers/communications/identity-email-delivery'
import type { TransactionalEmailSender } from '../../workers/communications/transactional-email-delivery'
import { d1OverSqlite, openAccountSecurityDatabase } from '../support/d1-sqlite'

const NOW = '2026-09-30T12:00:00Z'
const EMAIL = 'integration@example.test'
const PASSWORD = 'Synthetic-integration-original-123'
const NEXT_PASSWORD = 'Synthetic-integration-replacement-456'
const registration = {
  name: 'Cliente integrado',
  email: EMAIL,
  password: PASSWORD,
  termsAccepted: true,
  newsletter: false
}
const configuration = {
  origin: 'https://shop.neteco.test',
  password: randomBytes(32).toString('hex'),
  maxAgeSeconds: 3600,
  tokenPepper: randomBytes(32).toString('hex'),
  encryptionKey: randomBytes(32).toString('base64')
}

type LifecycleToken = {
  id: string
  purpose: string
  token_hash: string
  token_envelope: string
  recipient: string
  session_version: number
  expires_at: string
  used_at: string | null
  revoked_at: string | null
}
type Message = Parameters<TransactionalEmailSender['send']>[0]

function clockInstant() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

describe('D1 HTTP / durable identity-email integration', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  const edgeLimiter = { limit: vi.fn(async () => ({ success: true })) }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW))
    sqlite = await openAccountSecurityDatabase()
    database = d1OverSqlite(sqlite)
    edgeLimiter.limit.mockClear()
  })
  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
  })

  function request(path: string, body?: unknown, cookie?: string, method = 'POST') {
    return new Request(`${configuration.origin}${path}`, {
      method,
      headers: {
        origin: configuration.origin,
        'cf-connecting-ip': '192.0.2.143',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  }
  async function lifecycle(path: string, body: unknown, cookie?: string, override = {}) {
    const response = await handleIdentityLifecycleHttp(request(path, body, cookie), {
      database,
      edgeLimiter,
      configuration: () => ({ ...configuration, ...override }),
      now: clockInstant
    })
    expect(response).not.toBeNull()
    expect(response!.headers.get('cache-control')).toBe('no-store')
    return response!
  }
  async function authentication(path: string, body?: unknown, cookie?: string, method = 'POST') {
    const response = await handleAuthenticationHttp(request(path, body, cookie, method), {
      database,
      edgeLimiter,
      configuration: () => configuration
    })
    expect(response).not.toBeNull()
    return response!
  }
  function token(purpose: string) {
    const row = sqlite
      .prepare(
        `SELECT * FROM identity_lifecycle_tokens
      WHERE purpose=? AND used_at IS NULL AND revoked_at IS NULL`
      )
      .get(purpose) as LifecycleToken
    expect(row).toBeDefined()
    return { ...row, value: decryptSecret(row.token_envelope, configuration.encryptionKey) }
  }
  function identity() {
    return sqlite.prepare('SELECT status,email,email_verified_at,session_version,password_hash FROM identities').get()!
  }
  function job(id: string) {
    return sqlite
      .prepare(
        'SELECT state,attempts,last_error_code,provider_message_id FROM identity_lifecycle_deliveries WHERE token_id=?'
      )
      .get(id)!
  }
  function dispatch(sender: TransactionalEmailSender, override = {}) {
    return dispatchIdentityEmailDeliveries(database, sender, {
      ...configuration,
      enabled: true,
      from: 'orders@neteco.es',
      publicOrigin: configuration.origin,
      now: clockInstant(),
      ...override
    })
  }
  function transport() {
    const messages: Message[] = []
    const sender = {
      send: vi.fn(async (message: Message) => {
        messages.push(message)
        return { messageId: `synthetic-accepted-${messages.length}` }
      })
    }
    return { sender, messages }
  }
  function deliveredToken(message: Message) {
    const line = message.text.split('\n').find((part) => part.startsWith('https://'))!
    const link = new URL(line)
    expect(link.origin).toBe(configuration.origin)
    const value = link.searchParams.get('token')!
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/)
    return { value, link }
  }
  async function register() {
    const response = await lifecycle('/api/auth/register', registration)
    expect(response.status).toBe(202)
    expect(response.headers.get('set-cookie')).toBeNull()
    return response
  }

  it('recovers an unverified account with a fresh atomic version-2 verification, then completes an email change through actual delivered links', async () => {
    const registered = await register()
    const genericRegistration = await registered.text()
    const originalVerification = token('verify_email')
    const originalLogin = await authentication('/api/auth/login', { email: EMAIL, password: PASSWORD })
    expect(originalLogin.status).toBe(200)
    const originalCookie = originalLogin.headers.get('set-cookie')!.split(';')[0]!

    expect((await lifecycle('/api/auth/forgot-password', { email: EMAIL })).status).toBe(202)
    const reset = token('password_reset')
    const changedPassword = await lifecycle(
      '/api/auth/reset-password',
      { token: reset.value, password: NEXT_PASSWORD },
      originalCookie
    )
    expect(changedPassword.status).toBe(200)
    expect(await changedPassword.json()).toEqual({ ok: true })
    expect(changedPassword.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(identity()).toMatchObject({ status: 'pending', email: EMAIL, email_verified_at: null, session_version: 2 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions WHERE revoked_at IS NULL').get()?.n).toBe(0)
    const replacement = token('verify_email')
    expect(replacement.id).not.toBe(originalVerification.id)
    expect(replacement.session_version).toBe(2)
    expect(replacement.recipient).toBe(EMAIL)
    expect(replacement.token_hash).toBe(hashOpaqueToken(replacement.value, configuration.tokenPepper))
    expect(job(replacement.id)).toMatchObject({ state: 'pending', attempts: 0 })
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM identity_lifecycle_deliveries').all())).not.toContain(
      replacement.value
    )
    expect((await lifecycle('/api/auth/verify-email', { token: originalVerification.value })).status).toBe(400)

    const countsBeforeReplay = sqlite.prepare('SELECT count(*) AS n FROM identity_lifecycle_tokens').get()?.n
    const duplicate = await lifecycle('/api/auth/register', registration)
    expect(duplicate.status).toBe(202)
    expect(await duplicate.text()).toBe(genericRegistration)
    expect(duplicate.headers.get('set-cookie')).toBeNull()
    expect(sqlite.prepare('SELECT count(*) AS n FROM identity_lifecycle_tokens').get()?.n).toBe(countsBeforeReplay)
    expect(sqlite.prepare('SELECT count(*) AS n FROM identities').get()?.n).toBe(1)

    const { sender, messages } = transport()
    expect(await dispatch(sender)).toMatchObject({ sent: 1, cancelled: 2 })
    expect(sender.send).toHaveBeenCalledOnce()
    expect(messages[0]!.to).toBe(EMAIL)
    const delivered = deliveredToken(messages[0]!)
    expect(delivered.link.pathname).toBe('/verificar-email')
    expect(hashOpaqueToken(delivered.value, configuration.tokenPepper)).toBe(replacement.token_hash)
    const verified = await lifecycle('/api/auth/verify-email', { token: delivered.value })
    expect(verified.status).toBe(200)
    expect(await verified.json()).toEqual({ ok: true })
    expect(verified.headers.get('set-cookie')).toBeNull()
    expect(identity()).toMatchObject({ status: 'active', email_verified_at: NOW, session_version: 2 })
    expect(await (await authentication('/api/_auth/session', undefined, originalCookie, 'GET')).json()).toEqual({})
    expect((await authentication('/api/auth/login', { email: EMAIL, password: PASSWORD })).status).toBe(401)
    const login = await authentication('/api/auth/login', { email: EMAIL, password: NEXT_PASSWORD })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!

    expect(
      (
        await lifecycle(
          '/api/account/email-change',
          { email: 'changed@example.test', currentPassword: NEXT_PASSWORD },
          cookie
        )
      ).status
    ).toBe(202)
    expect(identity().email).toBe(EMAIL)
    expect(await dispatch(sender)).toMatchObject({ sent: 1 })
    expect(messages).toHaveLength(2)
    expect(messages[1]!.to).toBe('changed@example.test')
    const change = deliveredToken(messages[1]!)
    expect(change.link.pathname).toBe('/verificar-email')
    const confirmed = await lifecycle('/api/auth/verify-email', { token: change.value })
    expect(confirmed.status).toBe(200)
    expect(await confirmed.json()).toEqual({ ok: true, emailChanged: true })
    expect(confirmed.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(identity()).toMatchObject({ email: 'changed@example.test', status: 'active', session_version: 3 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions WHERE revoked_at IS NULL').get()?.n).toBe(0)
    expect(await (await authentication('/api/_auth/session', undefined, cookie, 'GET')).json()).toEqual({})
    expect((await lifecycle('/api/auth/verify-email', { token: change.value })).status).toBe(400)
    expect(await dispatch(sender)).toMatchObject({ sent: 0 })
    expect(sender.send).toHaveBeenCalledTimes(2)
    expect(sqlite.prepare('SELECT count(*) AS n FROM newsletter_subscriptions').get()?.n).toBe(0)
  }, 20_000)

  it('rolls back password/session/token consumption when inserting the reset replacement verification job fails', async () => {
    await register()
    await lifecycle('/api/auth/forgot-password', { email: EMAIL })
    const reset = token('password_reset')
    const before = identity()
    sqlite.exec(`CREATE TRIGGER reject_replacement_verification_job BEFORE INSERT ON identity_lifecycle_deliveries
      WHEN EXISTS (SELECT 1 FROM identity_lifecycle_tokens t WHERE t.id=NEW.token_id
        AND t.purpose='verify_email' AND t.session_version=2)
      BEGIN SELECT RAISE(ABORT, 'replacement_job_unavailable'); END`)
    const failed = await lifecycle('/api/auth/reset-password', { token: reset.value, password: NEXT_PASSWORD })
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({ error: { code: 'identity_lifecycle_unavailable' } })
    expect(identity()).toEqual(before)
    expect(sqlite.prepare('SELECT used_at,revoked_at FROM identity_lifecycle_tokens WHERE id=?').get(reset.id)).toEqual(
      { used_at: null, revoked_at: null }
    )
    expect(sqlite.prepare('SELECT count(*) AS n FROM identity_lifecycle_tokens').get()?.n).toBe(2)
    expect(sqlite.prepare('SELECT count(*) AS n FROM identity_lifecycle_deliveries').get()?.n).toBe(2)
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM identity_lifecycle_events WHERE event_type=?').get('password_reset')?.n
    ).toBe(0)
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions WHERE revoked_at IS NULL').get()?.n).toBe(1)
    sqlite.exec('DROP TRIGGER reject_replacement_verification_job')
    expect((await lifecycle('/api/auth/reset-password', { token: reset.value, password: NEXT_PASSWORD })).status).toBe(
      200
    )
    expect(job(token('verify_email').id)).toMatchObject({ state: 'pending', attempts: 0 })
  })

  it('does not issue an unnecessary replacement verification when an already-verified account resets', async () => {
    await register()
    expect((await lifecycle('/api/auth/verify-email', { token: token('verify_email').value })).status).toBe(200)
    await lifecycle('/api/auth/forgot-password', { email: EMAIL })
    expect(
      (await lifecycle('/api/auth/reset-password', { token: token('password_reset').value, password: NEXT_PASSWORD }))
        .status
    ).toBe(200)
    expect(identity()).toMatchObject({ status: 'active', email_verified_at: NOW, session_version: 2 })
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM identity_lifecycle_tokens WHERE purpose='verify_email'").get()?.n
    ).toBe(1)
    const { sender } = transport()
    expect(await dispatch(sender)).toMatchObject({ sent: 0, cancelled: 2 })
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('lets an accepted-but-ambiguous verification link be consumed without replaying its provider call', async () => {
    await register()
    const original = token('verify_email')
    let accepted: Message | undefined
    const sender = {
      send: vi.fn(async (message: Message) => {
        accepted = message
        throw new Error('synthetic timeout after acceptance')
      })
    }
    expect(await dispatch(sender)).toMatchObject({ manualReview: 1, sent: 0 })
    expect(job(original.id)).toMatchObject({ state: 'manual_review', last_error_code: 'provider_outcome_unknown' })
    const received = deliveredToken(accepted!)
    const response = await lifecycle('/api/auth/verify-email', { token: received.value })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.json()).toEqual({ ok: true })
    expect(identity().status).toBe('active')
    expect(await dispatch(sender)).toMatchObject({ sent: 0, manualReview: 0 })
    expect(sender.send).toHaveBeenCalledOnce()
    expect(job(original.id).state).toBe('manual_review')
  })

  it('keeps a previously delivered link usable across AES key rotation while quarantining unsent old-key envelopes', async () => {
    await register()
    const issued = token('verify_email')
    const rotatedKey = randomBytes(32).toString('base64')
    const { sender } = transport()
    expect(await dispatch(sender, { encryptionKey: rotatedKey })).toMatchObject({ manualReview: 1 })
    expect(sender.send).not.toHaveBeenCalled()
    expect(job(issued.id)).toMatchObject({ state: 'manual_review', last_error_code: 'token_integrity_failed' })
    const response = await lifecycle('/api/auth/verify-email', { token: issued.value }, undefined, {
      encryptionKey: rotatedKey
    })
    expect(response.status).toBe(200)
    expect(identity().status).toBe('active')
    expect(job(issued.id).state).toBe('manual_review')
  })

  it('issues reset replacement verification with the current AES key after rotation without trusting the old envelope', async () => {
    await register()
    const original = token('verify_email')
    await lifecycle('/api/auth/forgot-password', { email: EMAIL })
    const reset = token('password_reset')
    const rotatedKey = randomBytes(32).toString('base64')
    const response = await lifecycle(
      '/api/auth/reset-password',
      { token: reset.value, password: NEXT_PASSWORD },
      undefined,
      { encryptionKey: rotatedKey }
    )
    expect(response.status).toBe(200)
    const replacement = sqlite
      .prepare(
        `SELECT * FROM identity_lifecycle_tokens
      WHERE purpose='verify_email' AND used_at IS NULL AND revoked_at IS NULL`
      )
      .get() as LifecycleToken
    expect(replacement.id).not.toBe(original.id)
    expect(() => decryptSecret(replacement.token_envelope, configuration.encryptionKey)).toThrow()
    const { sender, messages } = transport()
    expect(await dispatch(sender, { encryptionKey: rotatedKey })).toMatchObject({ sent: 1, cancelled: 2 })
    const delivered = deliveredToken(messages[0]!)
    expect(hashOpaqueToken(delivered.value, configuration.tokenPepper)).toBe(replacement.token_hash)
    expect(
      (await lifecycle('/api/auth/verify-email', { token: delivered.value }, undefined, { encryptionKey: rotatedKey }))
        .status
    ).toBe(200)
    expect(identity()).toMatchObject({ status: 'active', session_version: 2 })
  })

  it('fails closed after HMAC pepper rotation without consuming a token or exposing errors, while delivery cannot blind-resend', async () => {
    await register()
    const issued = token('verify_email')
    const rotatedPepper = randomBytes(32).toString('hex')
    const { sender } = transport()
    expect(await dispatch(sender, { tokenPepper: rotatedPepper })).toMatchObject({ manualReview: 1 })
    expect(sender.send).not.toHaveBeenCalled()
    const rejected = await lifecycle('/api/auth/verify-email', { token: issued.value }, undefined, {
      tokenPepper: rotatedPepper
    })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({ error: { code: 'invalid_token' } })
    expect(identity()).toMatchObject({ status: 'pending', email_verified_at: null })
    expect(
      sqlite.prepare('SELECT used_at,revoked_at FROM identity_lifecycle_tokens WHERE id=?').get(issued.id)
    ).toEqual({ used_at: null, revoked_at: null })
    expect((await lifecycle('/api/auth/verify-email', { token: issued.value })).status).toBe(200)
    expect(await dispatch(sender)).toMatchObject({ sent: 0 })
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('recovers after HMAC pepper rotation by issuing fresh reset and verification links with the new pepper', async () => {
    await register()
    const original = token('verify_email')
    const rotatedPepper = randomBytes(32).toString('hex')
    expect(
      (await lifecycle('/api/auth/verify-email', { token: original.value }, undefined, { tokenPepper: rotatedPepper }))
        .status
    ).toBe(400)
    expect(
      (await lifecycle('/api/auth/forgot-password', { email: EMAIL }, undefined, { tokenPepper: rotatedPepper })).status
    ).toBe(202)
    const reset = token('password_reset')
    expect(reset.token_hash).toBe(hashOpaqueToken(reset.value, rotatedPepper))
    expect(
      (
        await lifecycle('/api/auth/reset-password', { token: reset.value, password: NEXT_PASSWORD }, undefined, {
          tokenPepper: rotatedPepper
        })
      ).status
    ).toBe(200)
    const replacement = token('verify_email')
    const { sender, messages } = transport()
    expect(await dispatch(sender, { tokenPepper: rotatedPepper })).toMatchObject({ sent: 1, cancelled: 2 })
    const delivered = deliveredToken(messages[0]!)
    expect(hashOpaqueToken(delivered.value, rotatedPepper)).toBe(replacement.token_hash)
    expect(
      (await lifecycle('/api/auth/verify-email', { token: delivered.value }, undefined, { tokenPepper: rotatedPepper }))
        .status
    ).toBe(200)
    expect(identity()).toMatchObject({ status: 'active', email_verified_at: NOW, session_version: 2 })
  })

  it('rejects an exactly expired link in HTTP and cancels its unsent durable delivery using the same trusted clock', async () => {
    await register()
    const issued = token('verify_email')
    vi.setSystemTime(new Date(issued.expires_at))
    const rejected = await lifecycle('/api/auth/verify-email', { token: issued.value })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({ error: { code: 'invalid_token' } })
    const { sender } = transport()
    expect(await dispatch(sender)).toMatchObject({ cancelled: 1, sent: 0 })
    expect(sender.send).not.toHaveBeenCalled()
    expect(job(issued.id)).toMatchObject({ state: 'cancelled', last_error_code: 'token_unavailable' })
    expect(identity()).toMatchObject({ status: 'pending', email_verified_at: null, session_version: 1 })
  })

  it.each(['Cliente\u0001control', 'Cliente\u007fcontrol'])(
    'rejects display names that the email renderer cannot safely deliver before registration commits',
    async (name) => {
      const response = await lifecycle('/api/auth/register', { ...registration, name })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: { code: 'invalid_body' } })
      for (const table of [
        'identities',
        'customers',
        'auth_sessions',
        'identity_lifecycle_tokens',
        'identity_lifecycle_deliveries'
      ])
        expect(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0)
    }
  )
})
