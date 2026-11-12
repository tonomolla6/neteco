import { scryptSync } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openAccountSecurityDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { deterministicUuid, FIXED_TEST_INSTANT } from '../fixtures/deterministic'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { submitD1CompanyDetails } from '../../workers/auth/company'
import {
  publishEmailOutbox,
  receiveEmailDispatch,
  type EmailDispatchMessage
} from '../../workers/communications/email-outbox'
import {
  dispatchTransactionalEmails,
  type TransactionalEmailSender
} from '../../workers/communications/transactional-email-delivery'
import { updateD1DeliveryPreferences } from '../../workers/auth/delivery-preferences'
import { DELIVERY_PREFERENCES_POLICY_VERSION } from '../../shared/delivery-preferences'
import { testNow } from '../support/deterministic'

const identityId = deterministicUuid('company-security-owner')
const customerId = deterministicUuid('company-security-customer')
const sessionId = deterministicUuid('company-security-session')
const email = 'fiscal-owner@synthetic.invalid'
const password = 'Synthetic-fiscal-password-123'
const now = FIXED_TEST_INSTANT.replace('.000Z', 'Z')
const configuration = { password: 'synthetic-company-security-seal-password-over32', maxAgeSeconds: 3600 }
const salt = Buffer.from('company-security-fixed-salt')
const passwordHash = `$scrypt$n=16384,r=8,p=1$${salt.toString('base64').replace(/=+$/, '')}$${scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64').replace(/=+$/, '')}`
const details = {
  legalName: 'Fiscal privado SL',
  tradeName: 'Marca privada',
  taxId: 'B12345674',
  countryCode: 'ES',
  currentPassword: password
}

describe('fiscal submission security notices share the actual owner transaction', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let cookie: string
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(FIXED_TEST_INSTANT))
    sqlite = await openAccountSecurityDatabase()
    try {
      sqlite.prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)').run(customerId, now, now)
      sqlite
        .prepare(
          "INSERT INTO identities(id,email,password_hash,status,email_verified_at,customer_id,created_at,updated_at) VALUES(?,?,?,'active',?,?,?,?)"
        )
        .run(identityId, email, passwordHash, now, customerId, now, now)
      sqlite
        .prepare(
          "INSERT INTO auth_sessions(id,identity_id,session_version,created_at,expires_at) VALUES(?,?,1,?,'2099-01-01T00:00:00Z')"
        )
        .run(sessionId, identityId, now)
      database = d1OverSqlite(sqlite)
      cookie = (await issueD1SessionCookie(
        database,
        { identityId, sessionId, sessionVersion: 1 },
        configuration
      ))!.split(';')[0]!
    } catch (error) {
      sqlite.close()
      throw error
    }
  })
  afterEach(() => {
    if (sqlite?.isOpen) sqlite.close()
    vi.useRealTimers()
  })
  const request = (credential = cookie) =>
    new Request('https://neteco.invalid/api/account/company', { headers: { Cookie: credential } })
  const submit = (input = details, db = database, credential = cookie) =>
    submitD1CompanyDetails(db, request(credential), configuration, input)
  const count = (table: string) => Number(sqlite.prepare(`SELECT count(*) n FROM ${table}`).get()!.n)
  const instant = () => new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const sender = () => ({
    send: vi.fn<TransactionalEmailSender['send']>(async () => ({ messageId: 'synthetic-fiscal-notice' }))
  })
  async function transport() {
    const messages: EmailDispatchMessage[] = [],
      at = instant()
    await publishEmailOutbox(
      database,
      {
        send: async (message) => {
          messages.push(message)
        }
      },
      { now: at }
    )
    expect(messages).toHaveLength(1)
    expect(JSON.stringify(messages)).not.toContain(email)
    expect(await receiveEmailDispatch(database, messages[0], at)).toBe('stored')
    expect(await receiveEmailDispatch(database, messages[0], at)).toBe('replayed')
    return { enabled: true, from: 'security@synthetic.invalid', now: at, appEnvironment: 'local' as const }
  }

  it('enqueues one minimized security source and transport only for the confirmed submitted event', async () => {
    expect(await submit()).toMatchObject({ ok: true, status: 'pending' })
    expect(count('identity_account_security_events')).toBe(1)
    const event = sqlite.prepare('SELECT * FROM identity_account_security_events').get()!
    const domain = sqlite.prepare('SELECT id FROM company_review_events').get()!
    expect(event).toMatchObject({
      id: domain.id,
      identity_id: identityId,
      kind: 'fiscal_details_submitted',
      recipient: email,
      audience: 'current',
      session_version: 1,
      domain_event_id: domain.id,
      created_at: now
    })
    expect(
      sqlite.prepare('SELECT source_event_id,event_type,source_kind,source_id FROM email_outbox_events').get()
    ).toEqual({
      source_event_id: domain.id,
      event_type: 'identity.security.fiscal_changed',
      source_kind: 'identity',
      source_id: identityId
    })
    expect(count('email_outbox_delivery')).toBe(1)
    for (const secret of [details.legalName, details.tradeName, details.taxId, password, passwordHash])
      expect(JSON.stringify(event)).not.toContain(secret)
  })

  it.each(['---', 'A58818502'])(
    'rejects required or checksum-invalid fiscal ID %s before any company or security notice write',
    async (taxId) => {
      expect(await submit({ ...details, taxId })).toEqual({ ok: false, code: 'invalid_tax_id' })
      for (const table of [
        'companies',
        'company_review_events',
        'identity_account_security_events',
        'email_outbox_events'
      ])
        expect(count(table)).toBe(0)
    }
  )

  it.each(['anonymous', 'wrong_password', 'unverified', 'mfa'] as const)(
    'does not submit or notify for %s',
    async (reason) => {
      if (reason === 'unverified') sqlite.prepare('UPDATE identities SET email_verified_at=NULL').run()
      if (reason === 'mfa')
        sqlite
          .prepare('INSERT INTO identity_mfa(identity_id,encrypted_secret,verified_at,updated_at) VALUES(?,?,?,?)')
          .run(identityId, 'synthetic', now, now)
      const result = await submit(
        reason === 'wrong_password' ? { ...details, currentPassword: 'wrong' } : details,
        database,
        reason === 'anonymous' ? '' : cookie
      )
      expect(result).toMatchObject({
        ok: false,
        code: (
          {
            anonymous: 'unauthenticated',
            wrong_password: 'invalid_password',
            unverified: 'email_unverified',
            mfa: 'mfa_required'
          } as const
        )[reason]
      })
      for (const table of [
        'companies',
        'company_review_events',
        'identity_account_security_events',
        'email_outbox_events'
      ])
        expect(count(table)).toBe(0)
    }
  )

  it('rolls back company, domain event and source together if outbox insertion fails', async () => {
    sqlite.exec(
      "CREATE TRIGGER fixture_reject_fiscal_notice BEFORE INSERT ON email_outbox_events BEGIN SELECT RAISE(ABORT,'fixture_outbox_failure'); END"
    )
    await expect(submit()).rejects.toThrow('fixture_outbox_failure')
    for (const table of [
      'companies',
      'company_review_events',
      'identity_account_security_events',
      'email_outbox_events'
    ])
      expect(count(table)).toBe(0)
  })

  it('leaves no notice and returns unauthenticated when revocation makes the company write SQL match zero', async () => {
    const real = database
    const racing = Object.create(real) as D1Database
    racing.batch = async (statements) => {
      sqlite.prepare('UPDATE auth_sessions SET revoked_at=?').run(now)
      return real.batch(statements)
    }
    expect(await submit(details, racing)).toEqual({ ok: false, code: 'unauthenticated' })
    for (const table of [
      'companies',
      'company_review_events',
      'identity_account_security_events',
      'email_outbox_events'
    ])
      expect(count(table)).toBe(0)
  })

  it('records separate legitimate edits without treating presentation as fiscal approval', async () => {
    expect(await submit()).toMatchObject({ ok: true, status: 'pending' })
    expect(await submit({ ...details, legalName: 'Fiscal actualizado SL' })).toMatchObject({
      ok: true,
      status: 'pending'
    })
    expect(count('company_review_events')).toBe(2)
    expect(count('identity_account_security_events')).toBe(2)
    expect(count('email_outbox_events')).toBe(2)
    expect(sqlite.prepare('SELECT status FROM companies').get()).toEqual({ status: 'pending' })
  })

  it('fails closed on an unconfirmed domain event without disguising corruption as bad authentication', async () => {
    sqlite.exec(
      'CREATE TRIGGER fixture_skip_fiscal_domain BEFORE INSERT ON company_review_events BEGIN SELECT RAISE(IGNORE); END'
    )
    await expect(submit()).rejects.toThrow('account_security_notice_atomic_guard')
    for (const table of [
      'companies',
      'company_review_events',
      'identity_account_security_events',
      'email_outbox_events'
    ])
      expect(count(table)).toBe(0)
  })

  it('renders and sends once despite delivery opt-out, with presentation-not-approval wording and no fiscal payload', async () => {
    await updateD1DeliveryPreferences(
      database,
      { identityId, sessionId, sessionVersion: 1 },
      deterministicUuid('fiscal-security-optout'),
      { expectedVersion: 0, deliveryUpdates: false, policyVersion: DELIVERY_PREFERENCES_POLICY_VERSION }
    )
    expect(await submit()).toMatchObject({ ok: true, status: 'pending' })
    const config = await transport(),
      adapter = sender()
    expect(await dispatchTransactionalEmails(database, adapter, config)).toMatchObject({ sent: 1, manualReview: 0 })
    expect(adapter.send).toHaveBeenCalledTimes(1)
    const message = adapter.send.mock.calls[0]![0]
    expect(message.to).toBe(email)
    expect(message.text).toContain('Se han presentado')
    expect(message.text).toContain('no significa que se hayan aprobado')
    for (const secret of [
      details.taxId,
      details.legalName,
      details.tradeName,
      password,
      passwordHash,
      configuration.password
    ])
      expect(JSON.stringify(message)).not.toContain(secret)
    await dispatchTransactionalEmails(database, adapter, { ...config, now: instant() })
    expect(adapter.send).toHaveBeenCalledTimes(1)
    expect(count('operational_email_suppressions')).toBe(0)
  })

  it('keeps the durable notice pending without invoking the sender when sending is disabled', async () => {
    expect(await submit()).toMatchObject({ ok: true })
    const config = await transport(),
      adapter = sender()
    expect(await dispatchTransactionalEmails(database, adapter, { ...config, enabled: false })).toMatchObject({
      sent: 0,
      disabled: true
    })
    expect(adapter.send).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT status FROM transactional_email_deliveries').get()).toEqual({ status: 'pending' })
  })

  it('does not send a fiscal notice whose immutable domain proof was corrupted', async () => {
    expect(await submit()).toMatchObject({ ok: true })
    const config = await transport(),
      adapter = sender()
    sqlite.exec('DROP TRIGGER company_review_events_no_delete; DELETE FROM company_review_events')
    expect(await dispatchTransactionalEmails(database, adapter, config)).toMatchObject({ sent: 0, manualReview: 1 })
    expect(adapter.send).not.toHaveBeenCalled()
  })

  it('retries a source-read D1 outage before sending without losing or duplicating the durable notice', async () => {
    expect(await submit()).toMatchObject({ ok: true })
    const config = await transport(),
      adapter = sender(),
      real = database
    let failed = false
    const transient = Object.create(real) as D1Database
    transient.prepare = (sql) => {
      const statement = real.prepare(sql)
      if (!sql.includes('FROM email_outbox_events e JOIN identity_account_security_events s')) return statement
      const proxy: D1PreparedStatement = new Proxy(statement, {
        get(target, property) {
          if (property === 'bind')
            return (...values: unknown[]) => {
              target.bind(...values)
              return proxy
            }
          if (property === 'first')
            return (...values: unknown[]) => {
              if (!failed) {
                failed = true
                throw new Error('synthetic_source_read_outage')
              }
              return Reflect.apply(target.first, target, values)
            }
          return Reflect.get(target, property)
        }
      })
      return proxy
    }
    expect(await dispatchTransactionalEmails(transient, adapter, config)).toMatchObject({ sent: 0, retryable: 1 })
    expect(failed).toBe(true)
    expect(adapter.send).not.toHaveBeenCalled()
    const due = sqlite.prepare('SELECT available_at FROM transactional_email_deliveries').get()!.available_at as string
    expect(await dispatchTransactionalEmails(database, adapter, { ...config, now: due })).toMatchObject({ sent: 1 })
    expect(adapter.send).toHaveBeenCalledTimes(1)
    expect(count('identity_account_security_events')).toBe(1)
  })
})
