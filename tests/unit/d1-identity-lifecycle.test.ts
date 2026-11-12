import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openAccountSecurityDatabase } from '../support/d1-sqlite'
import {
  ACCOUNT_TERMS_CONSENT_TEXT,
  ACCOUNT_TERMS_POLICY_VERSION,
  registerD1Identity,
  requestD1EmailChange,
  requestD1PasswordReset,
  resetD1Password,
  verifyD1Email
} from '../../workers/auth/lifecycle'
import { decryptSecret, encryptSecret, hashOpaqueToken } from '../../server/utils/secrets'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { verifyWorkerPassword } from '../../workers/auth/password'
import * as passwords from '../../workers/auth/password'
import {
  confirmNewsletterConsent,
  createNewsletterConfirmationToken,
  isNewsletterSendEligible,
  requestNewsletterConsent
} from '../../workers/marketing/newsletter'
import { NEWSLETTER_CONSENT_TEXT, NEWSLETTER_POLICY_VERSION } from '../../shared/newsletter'
import { testUuid, testNow } from '../support/deterministic'

const password = 'Synthetic-lifecycle-password-123'
const nextPassword = 'Synthetic-rotated-password-456'
const configuration = {
  password: randomBytes(32).toString('hex'),
  maxAgeSeconds: 3600,
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
function utc(value = testNow()) {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

describe('D1 identity lifecycle atomic primitives', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    sqlite = await openAccountSecurityDatabase()
    // The local helper applies the new migration until the root extends the
    // global fixture; the table check prevents accidentally applying it twice.
    if (!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='identity_lifecycle_tokens'").get())
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0032_identity_lifecycle.sql', import.meta.url), 'utf8')
      )
    const adapter = d1OverSqlite(sqlite)
    let tail: Promise<unknown> = Promise.resolve()
    database = {
      ...adapter,
      batch: (statements) => {
        const result = tail.then(() => adapter.batch(statements))
        tail = result.catch(() => undefined)
        return result
      }
    } as D1Database
  })
  afterEach(() => {
    vi.restoreAllMocks()
    sqlite.close()
  })
  const account = (email = registration.email, overrides = {}) =>
    registerD1Identity(database, { ...registration, email, ...overrides }, configuration)
  function identity() {
    return sqlite.prepare('SELECT * FROM identities ORDER BY created_at LIMIT 1').get() as {
      id: string
      customer_id: string
      password_hash: string
      email: string
      session_version: number
      status: string
      email_verified_at: string | null
    }
  }
  function link(purpose: string) {
    const row = sqlite
      .prepare('SELECT * FROM identity_lifecycle_tokens WHERE purpose = ? AND used_at IS NULL AND revoked_at IS NULL')
      .get(purpose) as { id: string; token_envelope: string; token_hash: string; recipient: string; expires_at: string }
    return { ...row, token: decryptSecret(row.token_envelope, configuration.encryptionKey) }
  }
  async function requestCookie() {
    const row = sqlite
      .prepare('SELECT id, identity_id, session_version FROM auth_sessions WHERE revoked_at IS NULL LIMIT 1')
      .get() as { id: string; identity_id: string; session_version: number }
    const cookie = await issueD1SessionCookie(
      database,
      { sessionId: row.id, identityId: row.identity_id, sessionVersion: row.session_version },
      configuration
    )
    expect(cookie).not.toBeNull()
    return new Request('https://neteco.invalid/api/account/email-change', {
      headers: { cookie: cookie!.split(';')[0]! }
    })
  }
  function interleaveBeforeBatch(change: () => void) {
    let once = true
    return {
      ...database,
      batch: async (statements: D1PreparedStatement[]) => {
        if (once) {
          once = false
          change()
        }
        return database.batch(statements)
      }
    } as D1Database
  }

  it('creates a fresh pending customer identity, optional single pending company, server-owned legal evidence and encrypted delivery', async () => {
    const now = utc()
    sqlite
      .prepare('INSERT INTO customers(id,name,created_at,updated_at) VALUES (?,?,?,?)')
      .run('unrelated', 'No cambiar', now, now)
    const result = await account(' Fixture@Example.Invalid ', { company: 'Empresa SL', phone: '+34600111222' })
    expect(result.ok).toBe(true)
    expect(identity()).toMatchObject({
      email: 'fixture@example.invalid',
      status: 'pending',
      email_verified_at: null,
      session_version: 1
    })
    expect(identity().customer_id).not.toBe('unrelated')
    expect(sqlite.prepare('SELECT name FROM customers WHERE id=?').get('unrelated')).toEqual({ name: 'No cambiar' })
    expect(sqlite.prepare('SELECT legal_name,status FROM companies').all()).toEqual([
      { legal_name: 'Empresa SL', status: 'pending' }
    ])
    expect(sqlite.prepare('SELECT role_code FROM identity_roles').all()).toEqual([{ role_code: 'customer' }])
    expect(sqlite.prepare('SELECT mfa_verified FROM auth_sessions').all()).toEqual([{ mfa_verified: 0 }])
    const evidence = sqlite.prepare('SELECT policy_version,consent_text,source FROM identity_legal_acceptances').get()
    expect(evidence).toEqual({
      policy_version: ACCOUNT_TERMS_POLICY_VERSION,
      consent_text: ACCOUNT_TERMS_CONSENT_TEXT,
      source: 'registration'
    })
    expect(() => sqlite.exec("UPDATE identity_legal_acceptances SET policy_version='client-value'")).toThrow(
      'immutable'
    )
    expect(() => sqlite.exec('DELETE FROM identity_legal_acceptances')).toThrow('immutable')
    const token = link('verify_email')
    expect(token.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(token.token_hash).toBe(hashOpaqueToken(token.token, configuration.tokenPepper))
    expect(token.recipient).toBe(identity().email)
    expect(JSON.stringify(result)).not.toContain(token.token)
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM identity_lifecycle_deliveries').all())).not.toContain(
      token.token
    )
    expect(sqlite.prepare('SELECT state,attempts FROM identity_lifecycle_deliveries').all()).toEqual([
      { state: 'pending', attempts: 0 }
    ])
    expect(sqlite.prepare('SELECT count(*) AS count FROM identity_lifecycle_guards').get()).toEqual({ count: 0 })
  })

  it('concurrent duplicate registration cannot take ownership or leave an orphan customer/session', async () => {
    const results = await Promise.all([account(), account()])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toMatchObject({ code: 'email_unavailable' })
    for (const table of [
      'identities',
      'customers',
      'auth_sessions',
      'identity_legal_acceptances',
      'identity_lifecycle_tokens'
    ])
      expect(sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 1 })
  })

  it('newsletter true requires configured secrets before password work or any account write', async () => {
    const hashing = vi.spyOn(passwords, 'hashWorkerPassword')
    const secrets = { tokenPepper: configuration.tokenPepper, encryptionKey: configuration.encryptionKey }
    await expect(registerD1Identity(database, { ...registration, newsletter: true }, secrets)).rejects.toThrow(
      'newsletter_configuration_unavailable'
    )
    expect(hashing).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT count(*) AS count FROM identities').get()).toEqual({ count: 0 })
  })

  it('reuses the existing newsletter ledger, exact HMAC namespace and double-opt-in, not the authentication token', async () => {
    await account(registration.email, { newsletter: true })
    const subscription = sqlite.prepare('SELECT * FROM newsletter_subscriptions').get() as {
      request_id: string
      email_hash: string
      status: string
      requested_at: number
    }
    expect(subscription.status).toBe('pending')
    expect(
      sqlite.prepare('SELECT consent_text,consent_version,consent_source FROM newsletter_subscriptions').get()
    ).toEqual({
      consent_text: NEWSLETTER_CONSENT_TEXT,
      consent_version: NEWSLETTER_POLICY_VERSION,
      consent_source: 'registration'
    })
    expect(sqlite.prepare('SELECT status FROM newsletter_confirmation_deliveries').all()).toEqual([
      { status: 'pending' }
    ])
    expect(await isNewsletterSendEligible(database, registration.email, configuration.newsletterSecrets)).toBe(false)
    const newsletterToken = await createNewsletterConfirmationToken(
      subscription.request_id,
      configuration.newsletterSecrets
    )
    expect(newsletterToken).not.toBe(link('verify_email').token)
    await confirmNewsletterConsent(
      database,
      newsletterToken,
      configuration.newsletterSecrets,
      subscription.requested_at + 1
    )
    expect(await isNewsletterSendEligible(database, registration.email, configuration.newsletterSecrets)).toBe(true)
    const replay = await requestNewsletterConsent(
      database,
      {
        email: registration.email,
        purpose: 'newsletter',
        consentText: NEWSLETTER_CONSENT_TEXT,
        consentVersion: NEWSLETTER_POLICY_VERSION,
        consentSource: 'registration',
        idempotencyKey: testUuid()
      },
      configuration.newsletterSecrets
    )
    expect(replay).toEqual({ accepted: true, internalDelivery: null })
    expect(sqlite.prepare('SELECT email_hash FROM newsletter_subscriptions').get()).toEqual({
      email_hash: subscription.email_hash
    })
    expect(identity().email_verified_at).toBeNull()
  })

  it('a failure after all account/consent/token statements rolls back the entire registration', async () => {
    const failed = {
      ...database,
      batch: (statements: D1PreparedStatement[]) =>
        database.batch([...statements, database.prepare('SELECT missing_identity_lifecycle_column')])
    } as D1Database
    await expect(
      registerD1Identity(failed, { ...registration, newsletter: true, company: 'Empresa' }, configuration)
    ).rejects.toThrow()
    for (const table of [
      'identities',
      'customers',
      'companies',
      'auth_sessions',
      'identity_legal_acceptances',
      'newsletter_subscriptions',
      'newsletter_consent_events',
      'newsletter_confirmation_deliveries',
      'identity_lifecycle_tokens',
      'identity_lifecycle_deliveries',
      'identity_lifecycle_events'
    ])
      expect(sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
  })

  it('email verification is single-use and does not grant a new password/MFA session', async () => {
    await account()
    const token = link('verify_email').token
    const results = await Promise.all([
      verifyD1Email(database, { token }, configuration),
      verifyD1Email(database, { token }, configuration)
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toMatchObject({ code: 'invalid_token' })
    expect(identity()).toMatchObject({ status: 'active', session_version: 1, email_verified_at: expect.any(String) })
    expect(sqlite.prepare('SELECT count(*) AS count FROM auth_sessions').get()).toEqual({ count: 1 })
    expect(
      sqlite.prepare("SELECT count(*) AS count FROM identity_lifecycle_events WHERE event_type='email_verified'").get()
    ).toEqual({ count: 1 })
    expect(() => sqlite.exec("UPDATE identity_lifecycle_events SET event_type='registered'")).toThrow('immutable')
  })

  it.each(['locked', 'disabled', 'blocked'])(
    'verification and recovery never reactivate %s accounts',
    async (status) => {
      await account()
      const token = link('verify_email').token
      if (status === 'blocked') sqlite.exec("UPDATE customers SET status='blocked'")
      else sqlite.prepare('UPDATE identities SET status=?').run(status)
      expect(await verifyD1Email(database, { token }, configuration)).toEqual({ ok: false, code: 'invalid_token' })
      expect(await requestD1PasswordReset(database, { email: registration.email }, configuration)).toEqual({
        accepted: true
      })
      expect(
        sqlite.prepare("SELECT count(*) AS count FROM identity_lifecycle_tokens WHERE purpose='password_reset'").get()
      ).toEqual({ count: 0 })
      expect(identity().email_verified_at).toBeNull()
      expect(identity().status).toBe(status === 'blocked' ? 'pending' : status)
    }
  )

  it('reset issuance is generic and invalidates the prior token; exact expiry rejects before scrypt', async () => {
    expect(await requestD1PasswordReset(database, { email: 'unknown@example.invalid' }, configuration)).toEqual({
      accepted: true
    })
    await account()
    await requestD1PasswordReset(database, { email: registration.email }, configuration)
    const first = link('password_reset')
    await requestD1PasswordReset(database, { email: registration.email }, configuration)
    const second = link('password_reset')
    expect(second.token).not.toBe(first.token)
    expect(await resetD1Password(database, { token: first.token, password: nextPassword }, configuration)).toEqual({
      ok: false,
      code: 'invalid_token'
    })
    const hashing = vi.spyOn(passwords, 'hashWorkerPassword')
    expect(
      await resetD1Password(database, { token: second.token, password: nextPassword }, configuration, second.expires_at)
    ).toEqual({ ok: false, code: 'invalid_token' })
    expect(hashing).not.toHaveBeenCalled()
  })

  it('exactly one concurrent reset rotates the password/version, revokes ALL active and expired sessions plus other tokens', async () => {
    await account()
    const own = identity()
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,0,?,?)`
      )
      .run(testUuid(), own.id, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,0,?,?)`
      )
      .run(testUuid(), own.id, utc(), utc(testNow() + 600_000))
    await requestD1PasswordReset(database, { email: own.email }, configuration)
    const token = link('password_reset').token
    const results = await Promise.all([
      resetD1Password(database, { token, password: nextPassword }, configuration),
      resetD1Password(database, { token, password: nextPassword }, configuration)
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(await verifyWorkerPassword(identity().password_hash, nextPassword)).toBe(true)
    expect(identity().session_version).toBe(2)
    expect(identity().status).toBe('pending')
    expect(sqlite.prepare('SELECT count(*) AS count FROM auth_sessions WHERE revoked_at IS NULL').get()).toEqual({
      count: 0
    })
    expect(
      sqlite
        .prepare(
          'SELECT purpose,session_version FROM identity_lifecycle_tokens WHERE used_at IS NULL AND revoked_at IS NULL'
        )
        .all()
    ).toEqual([{ purpose: 'verify_email', session_version: 2 }])
    expect(
      sqlite.prepare("SELECT count(*) AS count FROM identity_lifecycle_events WHERE event_type='password_reset'").get()
    ).toEqual({ count: 1 })
  })

  it.each(['session', 'password', 'version', 'mfa', 'blocked'])(
    'email-change revalidates %s after password verification inside the same batch',
    async (change) => {
      await account()
      const req = await requestCookie()
      const own = identity()
      const raced = interleaveBeforeBatch(() => {
        if (change === 'session') sqlite.prepare('UPDATE auth_sessions SET revoked_at=?').run(utc())
        if (change === 'password') sqlite.prepare('UPDATE identities SET password_hash=?').run('changed-synthetic-hash')
        if (change === 'version') sqlite.exec('UPDATE identities SET session_version=session_version+1')
        if (change === 'blocked') sqlite.exec("UPDATE customers SET status='blocked'")
        if (change === 'mfa')
          sqlite
            .prepare('INSERT INTO identity_mfa(identity_id,encrypted_secret,verified_at,updated_at) VALUES (?,?,?,?)')
            .run(own.id, encryptSecret('synthetic-mfa', configuration.encryptionKey), utc(), utc())
      })
      expect(
        await requestD1EmailChange(raced, req, configuration, {
          email: 'new@example.invalid',
          currentPassword: password
        })
      ).toEqual({ ok: false, code: 'conflict' })
      expect(
        sqlite.prepare("SELECT count(*) AS count FROM identity_lifecycle_tokens WHERE purpose='email_change'").get()
      ).toEqual({ count: 0 })
      expect(
        sqlite
          .prepare("SELECT count(*) AS count FROM identity_lifecycle_events WHERE event_type='email_change_requested'")
          .get()
      ).toEqual({ count: 0 })
      expect(identity().email).toBe(own.email)
    }
  )

  it('email-change requires the current password, supersedes prior links and preserves the authoritative new recipient', async () => {
    await account()
    const request = await requestCookie()
    expect(
      await requestD1EmailChange(database, request, configuration, {
        email: 'new@example.invalid',
        currentPassword: 'incorrect-password'
      })
    ).toEqual({ ok: false, code: 'invalid_password' })
    expect(
      await requestD1EmailChange(database, request, configuration, {
        email: 'one@example.invalid',
        currentPassword: password
      })
    ).toEqual({ ok: true })
    const first = link('email_change')
    expect(
      await requestD1EmailChange(database, request, configuration, {
        email: ' Two@Example.Invalid ',
        currentPassword: password
      })
    ).toEqual({ ok: true })
    const second = link('email_change')
    expect(second.recipient).toBe('two@example.invalid')
    expect(identity().email).toBe(registration.email)
    expect(await verifyD1Email(database, { token: first.token }, configuration)).toEqual({
      ok: false,
      code: 'invalid_token'
    })
    expect(await verifyD1Email(database, { token: second.token }, configuration)).toMatchObject({
      ok: true,
      emailChanged: true
    })
    expect(identity()).toMatchObject({
      email: 'two@example.invalid',
      status: 'active',
      session_version: 2,
      email_verified_at: expect.any(String)
    })
    expect(sqlite.prepare('SELECT count(*) AS count FROM auth_sessions WHERE revoked_at IS NULL').get()).toEqual({
      count: 0
    })
  })

  it('a token source-session revocation or new MFA enrollment makes the email-change proof stale', async () => {
    await account()
    const req = await requestCookie()
    await requestD1EmailChange(database, req, configuration, {
      email: 'new@example.invalid',
      currentPassword: password
    })
    const token = link('email_change').token
    sqlite
      .prepare('INSERT INTO identity_mfa(identity_id,encrypted_secret,verified_at,updated_at) VALUES (?,?,?,?)')
      .run(identity().id, encryptSecret('synthetic-factor', configuration.encryptionKey), utc(), utc())
    sqlite.exec('UPDATE auth_sessions SET mfa_verified=1')
    expect(await verifyD1Email(database, { token }, configuration)).toEqual({ ok: false, code: 'invalid_token' })
    sqlite.exec('DELETE FROM identity_mfa')
    sqlite.prepare('UPDATE auth_sessions SET revoked_at=?').run(utc())
    expect(await verifyD1Email(database, { token }, configuration)).toEqual({ ok: false, code: 'invalid_token' })
    expect(identity().email).toBe(registration.email)
  })

  it('email collision between issuance and consumption leaves token/account/sessions untouched', async () => {
    await account()
    const req = await requestCookie()
    await requestD1EmailChange(database, req, configuration, {
      email: 'occupied@example.invalid',
      currentPassword: password
    })
    const token = link('email_change')
    await account('occupied@example.invalid')
    expect(await verifyD1Email(database, { token: token.token }, configuration)).toEqual({
      ok: false,
      code: 'email_unavailable'
    })
    expect(sqlite.prepare('SELECT used_at,revoked_at FROM identity_lifecycle_tokens WHERE id=?').get(token.id)).toEqual(
      { used_at: null, revoked_at: null }
    )
    expect(sqlite.prepare('SELECT count(*) AS count FROM auth_sessions WHERE revoked_at IS NULL').get()).toEqual({
      count: 2
    })
  })

  it('a lost reset race rolls back its event, token consumption and password/session mutations', async () => {
    await account()
    await requestD1PasswordReset(database, { email: registration.email }, configuration)
    const token = link('password_reset'),
      oldHash = identity().password_hash
    const raced = interleaveBeforeBatch(() => {
      sqlite.exec('UPDATE identities SET session_version=2')
    })
    expect(await resetD1Password(raced, { token: token.token, password: nextPassword }, configuration)).toEqual({
      ok: false,
      code: 'invalid_token'
    })
    expect(identity().password_hash).toBe(oldHash)
    expect(sqlite.prepare('SELECT used_at FROM identity_lifecycle_tokens WHERE id=?').get(token.id)).toEqual({
      used_at: null
    })
    expect(
      sqlite.prepare("SELECT count(*) AS count FROM identity_lifecycle_events WHERE event_type='password_reset'").get()
    ).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT count(*) AS count FROM auth_sessions WHERE revoked_at IS NULL').get()).toEqual({
      count: 1
    })
  })

  it('a crash after reset mutations atomically restores token, password, sessions and audit', async () => {
    await account()
    await requestD1PasswordReset(database, { email: registration.email }, configuration)
    const token = link('password_reset'),
      before = identity()
    const failed = {
      ...database,
      batch: (statements: D1PreparedStatement[]) =>
        database.batch([...statements, database.prepare('SELECT missing_identity_lifecycle_column')])
    } as D1Database
    await expect(
      resetD1Password(failed, { token: token.token, password: nextPassword }, configuration)
    ).rejects.toThrow()
    expect(identity()).toEqual(before)
    expect(sqlite.prepare('SELECT used_at FROM identity_lifecycle_tokens WHERE id=?').get(token.id)).toEqual({
      used_at: null
    })
    expect(sqlite.prepare('SELECT count(*) AS count FROM identity_security_events').get()).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT count(*) AS count FROM auth_sessions WHERE revoked_at IS NULL').get()).toEqual({
      count: 1
    })
  })

  it('a pending account recovers then verifies with a fresh versioned proof without being stranded', async () => {
    await account()
    const original = link('verify_email').token
    await requestD1PasswordReset(database, { email: registration.email }, configuration)
    expect(
      await resetD1Password(database, { token: link('password_reset').token, password: nextPassword }, configuration)
    ).toMatchObject({ ok: true })
    expect(identity()).toMatchObject({ status: 'pending', email_verified_at: null, session_version: 2 })
    expect(await verifyD1Email(database, { token: original }, configuration)).toEqual({
      ok: false,
      code: 'invalid_token'
    })
    const renewed = link('verify_email')
    expect(renewed.token).not.toBe(original)
    expect(sqlite.prepare('SELECT state FROM identity_lifecycle_deliveries WHERE token_id=?').get(renewed.id)).toEqual({
      state: 'pending'
    })
    expect(await verifyD1Email(database, { token: renewed.token }, configuration)).toMatchObject({
      ok: true,
      emailChanged: false
    })
    expect(identity()).toMatchObject({ status: 'active', session_version: 2, email_verified_at: expect.any(String) })
    expect(sqlite.prepare('SELECT count(*) AS count FROM auth_sessions WHERE revoked_at IS NULL').get()).toEqual({
      count: 0
    })
  })

  it('resetting an already verified account does not request another verification email', async () => {
    await account()
    await verifyD1Email(database, { token: link('verify_email').token }, configuration)
    await requestD1PasswordReset(database, { email: registration.email }, configuration)
    expect(
      await resetD1Password(database, { token: link('password_reset').token, password: nextPassword }, configuration)
    ).toMatchObject({ ok: true })
    expect(
      sqlite.prepare("SELECT count(*) AS count FROM identity_lifecycle_tokens WHERE purpose='verify_email'").get()
    ).toEqual({ count: 1 })
    expect(identity()).toMatchObject({ status: 'active', session_version: 2 })
  })

  it('rejects forged/body-owned legal data and weak/oversized passwords before hashing', async () => {
    const hashing = vi.spyOn(passwords, 'hashWorkerPassword')
    for (const candidate of ['', 'short1', 'a'.repeat(12), '1'.repeat(12), 'A1'.repeat(65)])
      await expect(
        registerD1Identity(database, { ...registration, password: candidate }, configuration)
      ).rejects.toThrow()
    await expect(
      registerD1Identity(database, { ...registration, termsAccepted: false } as never, configuration)
    ).rejects.toThrow()
    await expect(
      registerD1Identity(database, { ...registration, policyVersion: 'client-forged' } as never, configuration)
    ).rejects.toThrow()
    expect(hashing).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT count(*) AS count FROM identities').get()).toEqual({ count: 0 })
  })
})
