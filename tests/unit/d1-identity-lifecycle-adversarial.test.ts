import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret } from '../../server/utils/secrets'
import { NEWSLETTER_CONSENT_TEXT, NEWSLETTER_POLICY_VERSION } from '../../shared/newsletter'
import {
  registerD1Identity,
  requestD1EmailChange,
  requestD1PasswordReset,
  resetD1Password,
  verifyD1Email,
  type IdentityLifecycleSecrets
} from '../../workers/auth/lifecycle'
import { hashWorkerPassword, verifyWorkerPassword } from '../../workers/auth/password'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  confirmNewsletterConsent,
  createNewsletterConfirmationToken,
  isNewsletterSendEligible,
  requestNewsletterConsent,
  suppressNewsletterEmail
} from '../../workers/marketing/newsletter'
import { d1OverSqlite, openAccountSecurityDatabase } from '../support/d1-sqlite'
import { testNow } from '../support/deterministic'

const PASSWORD = 'Original-password-123'
const NEW_PASSWORD = 'Replacement-password-456'
const EMAIL = 'adversarial@example.invalid'
const NOW = () => new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')

describe('D1 identity lifecycle adversarial atomicity and existing newsletter compatibility', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let secrets: IdentityLifecycleSecrets
  let instant: string
  beforeEach(async () => {
    sqlite = await openAccountSecurityDatabase()
    database = d1OverSqlite(sqlite)
    secrets = {
      tokenPepper: randomBytes(32).toString('hex'),
      encryptionKey: randomBytes(32).toString('base64'),
      newsletterSecrets: { hmacKey: new Uint8Array(randomBytes(32)) }
    }
    instant = NOW()
  })
  afterEach(() => sqlite.close())

  async function register(newsletter = false) {
    const result = await registerD1Identity(
      database,
      {
        name: 'Adversarial Customer',
        email: EMAIL,
        password: PASSWORD,
        termsAccepted: true,
        newsletter
      },
      secrets,
      instant
    )
    if (!result.ok) throw new Error('fixture_registration_failed')
    const cookie = (await issueD1SessionCookie(database, result, {
      password: secrets.tokenPepper,
      maxAgeSeconds: 3600
    }))!
    return { ...result, cookie: cookie.split(';')[0]! }
  }

  function token(purpose: 'verify_email' | 'password_reset' | 'email_change') {
    const row = sqlite
      .prepare('SELECT * FROM identity_lifecycle_tokens WHERE purpose=? AND used_at IS NULL AND revoked_at IS NULL')
      .get(purpose)!
    return { id: row.id as string, value: decryptSecret(row.token_envelope as string, secrets.encryptionKey) }
  }

  function readIdentity() {
    return sqlite
      .prepare('SELECT email,status,password_hash,session_version,email_verified_at FROM identities WHERE email=?')
      .get(EMAIL)!
  }

  function beforeBatch(mutate: () => void): D1Database {
    let once = false
    return {
      ...database,
      async batch<T>(statements: D1PreparedStatement[]) {
        if (!once) {
          once = true
          mutate()
        }
        return database.batch<T>(statements)
      }
    } as D1Database
  }

  // Both callers must finish their authoritative pre-read before either batch.
  // Queue only the actual SQLite batch because the shared adapter awaits between
  // statements, whereas D1 serializes each batch transaction as a whole. This
  // preserves real SQL/guards without pretending a fake SQL read proves races.
  function contendingBatches(): D1Database {
    let arrivals = 0
    let release!: () => void
    const bothRead = new Promise<void>((resolve) => {
      release = resolve
    })
    let tail = Promise.resolve()
    return {
      ...database,
      async batch<T>(statements: D1PreparedStatement[]) {
        arrivals++
        if (arrivals === 2) release()
        await bothRead
        const result = tail.then(() => database.batch<T>(statements))
        tail = result.then(
          () => undefined,
          () => undefined
        )
        return result
      }
    } as D1Database
  }

  function assertUnused(id: string) {
    expect(sqlite.prepare('SELECT used_at,revoked_at FROM identity_lifecycle_tokens WHERE id=?').get(id)).toEqual({
      used_at: null,
      revoked_at: null
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM identity_lifecycle_guards').get()?.n).toBe(0)
  }

  function enableMfa(identityId: string) {
    sqlite
      .prepare('INSERT INTO identity_mfa(identity_id,encrypted_secret,verified_at,updated_at) VALUES (?,?,?,?)')
      .run(identityId, encryptSecret('synthetic-totp-secret', secrets.encryptionKey), instant, instant)
  }

  it.each(['password', 'version'] as const)(
    'does not issue or revoke reset tokens after a %s race between eligibility read and batch',
    async (race) => {
      const owner = await register()
      await requestD1PasswordReset(database, { email: EMAIL }, secrets, instant)
      const existing = token('password_reset')
      const concurrentHash = await hashWorkerPassword(NEW_PASSWORD)
      const raced = beforeBatch(() => {
        if (race === 'password')
          sqlite
            .prepare('UPDATE identities SET password_hash=?,updated_at=? WHERE id=?')
            .run(concurrentHash, instant, owner.identityId)
        else sqlite.prepare('UPDATE identities SET session_version=session_version+1 WHERE id=?').run(owner.identityId)
      })
      const result = await requestD1PasswordReset(raced, { email: EMAIL }, secrets, instant)
      expect(result).toEqual({ accepted: true })
      assertUnused(existing.id)
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM identity_lifecycle_tokens WHERE purpose='password_reset'").get()?.n
      ).toBe(1)
      expect(
        sqlite
          .prepare("SELECT count(*) AS n FROM identity_lifecycle_events WHERE event_type='password_reset_requested'")
          .get()?.n
      ).toBe(1)
    }
  )

  it.each(['password', 'version', 'session_revoked', 'mfa_enabled'] as const)(
    'rejects email-change issuance after the %s authority changes during password proof',
    async (race) => {
      const owner = await register()
      const concurrentHash = await hashWorkerPassword(NEW_PASSWORD)
      const raced = beforeBatch(() => {
        if (race === 'password')
          sqlite
            .prepare('UPDATE identities SET password_hash=?,updated_at=? WHERE id=?')
            .run(concurrentHash, instant, owner.identityId)
        if (race === 'version')
          sqlite.prepare('UPDATE identities SET session_version=session_version+1 WHERE id=?').run(owner.identityId)
        if (race === 'session_revoked')
          sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(instant, owner.sessionId)
        if (race === 'mfa_enabled') enableMfa(owner.identityId)
      })
      const result = await requestD1EmailChange(
        raced,
        new Request('https://neteco.invalid/api/account/email', { headers: { cookie: owner.cookie } }),
        { ...secrets, password: secrets.tokenPepper, maxAgeSeconds: 3600 },
        { email: 'changed@example.invalid', currentPassword: PASSWORD },
        instant
      )
      expect(result).toEqual({ ok: false, code: 'conflict' })
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM identity_lifecycle_tokens WHERE purpose='email_change'").get()?.n
      ).toBe(0)
      expect(
        sqlite
          .prepare("SELECT count(*) AS n FROM identity_lifecycle_events WHERE event_type='email_change_requested'")
          .get()?.n
      ).toBe(0)
      expect(readIdentity().email).toBe(EMAIL)
    }
  )

  it.each(['source_revoked', 'mfa_enabled'] as const)(
    'rejects a valid email-change link when %s races its initial token read without a version bump',
    async (race) => {
      const owner = await register()
      const configuration = { ...secrets, password: secrets.tokenPepper, maxAgeSeconds: 3600 }
      expect(
        await requestD1EmailChange(
          database,
          new Request('https://neteco.invalid/', { headers: { cookie: owner.cookie } }),
          configuration,
          { email: 'changed@example.invalid', currentPassword: PASSWORD },
          instant
        )
      ).toEqual({ ok: true })
      const issued = token('email_change')
      const raced = beforeBatch(() => {
        if (race === 'source_revoked')
          sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(instant, owner.sessionId)
        else enableMfa(owner.identityId)
      })
      expect(await verifyD1Email(raced, { token: issued.value }, secrets, instant)).toEqual({
        ok: false,
        code: 'invalid_token'
      })
      assertUnused(issued.id)
      expect(readIdentity()).toMatchObject({
        email: EMAIL,
        session_version: 1,
        status: 'pending',
        email_verified_at: null
      })
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM identity_lifecycle_events WHERE event_type='email_changed'").get()?.n
      ).toBe(0)
    }
  )

  it('does not overwrite a newer password when a reset consumer loses its pre-read-to-batch race', async () => {
    const owner = await register()
    await requestD1PasswordReset(database, { email: EMAIL }, secrets, instant)
    const issued = token('password_reset')
    const newerHash = await hashWorkerPassword('Concurrent-password-789')
    const raced = beforeBatch(() =>
      sqlite
        .prepare('UPDATE identities SET password_hash=?,updated_at=? WHERE id=?')
        .run(newerHash, instant, owner.identityId)
    )
    expect(await resetD1Password(raced, { token: issued.value, password: NEW_PASSWORD }, secrets, instant)).toEqual({
      ok: false,
      code: 'invalid_token'
    })
    assertUnused(issued.id)
    expect(readIdentity().password_hash).toBe(newerHash)
    expect(readIdentity().session_version).toBe(1)
    expect(
      sqlite.prepare('SELECT revoked_at FROM auth_sessions WHERE id=?').get(owner.sessionId)?.revoked_at
    ).toBeNull()
  })

  it.each(['identity_disabled', 'identity_locked', 'customer_blocked', 'customer_anonymized'] as const)(
    'never activates a pending identity when %s races email confirmation',
    async (race) => {
      const owner = await register()
      const issued = token('verify_email')
      const raced = beforeBatch(() => {
        if (race.startsWith('identity_'))
          sqlite
            .prepare('UPDATE identities SET status=? WHERE id=?')
            .run(race === 'identity_disabled' ? 'disabled' : 'locked', owner.identityId)
        else
          sqlite
            .prepare('UPDATE customers SET status=? WHERE id=(SELECT customer_id FROM identities WHERE id=?)')
            .run(race === 'customer_blocked' ? 'blocked' : 'anonymized', owner.identityId)
      })
      expect(await verifyD1Email(raced, { token: issued.value }, secrets, instant)).toEqual({
        ok: false,
        code: 'invalid_token'
      })
      assertUnused(issued.id)
      expect(readIdentity().status).not.toBe('active')
      expect(readIdentity().email_verified_at).toBeNull()
    }
  )

  it('two consumers that both read the same live verification token commit exactly one activation', async () => {
    await register()
    const issued = token('verify_email')
    const contended = contendingBatches()
    const results = await Promise.all([
      verifyD1Email(contended, { token: issued.value }, secrets, instant),
      verifyD1Email(contended, { token: issued.value }, secrets, instant)
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: 'invalid_token' }])
    expect(readIdentity()).toMatchObject({ status: 'active', session_version: 1, email_verified_at: instant })
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM identity_lifecycle_events WHERE event_type='email_verified'").get()?.n
    ).toBe(1)
    expect(sqlite.prepare('SELECT count(*) AS n FROM identity_lifecycle_guards').get()?.n).toBe(0)
  })

  it('two password consumers that pre-read one reset token rotate once and preserve the winning password', async () => {
    const owner = await register()
    await requestD1PasswordReset(database, { email: EMAIL }, secrets, instant)
    const issued = token('password_reset')
    const contenders = [NEW_PASSWORD, 'Second-password-789']
    const contended = contendingBatches()
    const results = await Promise.all(
      contenders.map((password) => resetD1Password(contended, { token: issued.value, password }, secrets, instant))
    )
    const winner = results.findIndex((result) => result.ok)
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(await verifyWorkerPassword(readIdentity().password_hash as string, contenders[winner]!)).toBe(true)
    expect(readIdentity().session_version).toBe(2)
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM identity_lifecycle_events WHERE event_type='password_reset'").get()?.n
    ).toBe(1)
    expect(sqlite.prepare('SELECT revoked_at FROM auth_sessions WHERE id=?').get(owner.sessionId)?.revoked_at).toBe(
      instant
    )
  })

  it('a deliberate mid-registration failure rolls back identity, customer, legal evidence, both outboxes and marketing consent', async () => {
    sqlite.exec(
      "CREATE TRIGGER adversarial_abort_registration BEFORE INSERT ON auth_sessions BEGIN SELECT RAISE(ABORT, 'adversarial_abort'); END"
    )
    await expect(register(true)).rejects.toThrow('adversarial_abort')
    for (const table of [
      'identities',
      'customers',
      'identity_legal_acceptances',
      'identity_lifecycle_tokens',
      'identity_lifecycle_events',
      'identity_lifecycle_deliveries',
      'newsletter_subscriptions',
      'newsletter_consent_events',
      'newsletter_confirmation_deliveries',
      'identity_lifecycle_guards'
    ]) {
      expect(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0)
    }
  })

  it.each(['verify_email', 'password_reset'] as const)(
    'a mid-consumption database failure rolls back %s marking and every protected effect',
    async (purpose) => {
      const owner = await register()
      if (purpose === 'password_reset') await requestD1PasswordReset(database, { email: EMAIL }, secrets, instant)
      const issued = token(purpose)
      const before = readIdentity()
      sqlite.exec(
        "CREATE TRIGGER adversarial_abort_consumption BEFORE UPDATE ON identities BEGIN SELECT RAISE(ABORT, 'adversarial_abort'); END"
      )
      const action =
        purpose === 'verify_email'
          ? verifyD1Email(database, { token: issued.value }, secrets, instant)
          : resetD1Password(database, { token: issued.value, password: NEW_PASSWORD }, secrets, instant)
      await expect(action).rejects.toThrow('adversarial_abort')
      assertUnused(issued.id)
      expect(readIdentity()).toEqual(before)
      expect(
        sqlite.prepare('SELECT count(*) AS n FROM identity_lifecycle_events WHERE token_id=?').get(issued.id)?.n
      ).toBe(0)
      expect(
        sqlite.prepare('SELECT revoked_at FROM auth_sessions WHERE id=?').get(owner.sessionId)?.revoked_at
      ).toBeNull()
    }
  )

  it('registration newsletter consent interoperates with the real newsletter replay hash, immutable event and confirmation token', async () => {
    await register(true)
    const subscription = sqlite.prepare('SELECT * FROM newsletter_subscriptions').get()!
    const seconds = Date.parse(instant) / 1000
    expect(subscription).toMatchObject({
      status: 'pending',
      email_normalized: EMAIL,
      consent_source: 'registration',
      confirmed_at: null
    })
    const replay = await requestNewsletterConsent(
      database,
      {
        email: EMAIL,
        purpose: 'newsletter',
        consentText: NEWSLETTER_CONSENT_TEXT,
        consentVersion: NEWSLETTER_POLICY_VERSION,
        consentSource: 'registration',
        idempotencyKey: subscription.request_key as string,
        now: seconds
      },
      secrets.newsletterSecrets!
    )
    const token = await createNewsletterConfirmationToken(subscription.request_id as string, secrets.newsletterSecrets!)
    expect(replay.internalDelivery?.confirmationToken).toBe(token)
    expect(sqlite.prepare('SELECT count(*) AS n FROM newsletter_consent_events').get()?.n).toBe(1)
    expect(sqlite.prepare('SELECT count(*) AS n FROM newsletter_confirmation_deliveries').get()?.n).toBe(1)
    await confirmNewsletterConsent(database, token, secrets.newsletterSecrets!, seconds + 1)
    expect(await isNewsletterSendEligible(database, EMAIL, secrets.newsletterSecrets!)).toBe(true)
    expect(sqlite.prepare('SELECT status FROM newsletter_subscriptions').get()?.status).toBe('confirmed')
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM newsletter_consent_events WHERE event_type='confirmed'").get()?.n
    ).toBe(1)
  })

  it('registration never clears an existing newsletter suppression generated by the actual primitive', async () => {
    await suppressNewsletterEmail(
      database,
      EMAIL,
      'complaint',
      'adversarial_test',
      secrets.newsletterSecrets!,
      Date.parse(instant) / 1000
    )
    await register(true)
    expect(sqlite.prepare('SELECT count(*) AS n FROM newsletter_subscriptions').get()?.n).toBe(0)
    expect(sqlite.prepare('SELECT count(*) AS n FROM newsletter_confirmation_deliveries').get()?.n).toBe(0)
    expect(sqlite.prepare('SELECT reason FROM newsletter_suppressions').get()?.reason).toBe('complaint')
    expect(await isNewsletterSendEligible(database, EMAIL, secrets.newsletterSecrets!)).toBe(false)
  })
})
