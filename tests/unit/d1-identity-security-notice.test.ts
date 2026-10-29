import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openAccountSecurityDatabase } from '../support/d1-sqlite'
import {
  registerD1Identity,
  requestD1PasswordReset,
  resetD1Password,
  verifyD1Email
} from '../../workers/auth/lifecycle'
import { decryptSecret } from '../../server/utils/secrets'
import { verifyWorkerPassword } from '../../workers/auth/password'
import { publishEmailOutbox, receiveEmailDispatch } from '../../workers/communications/email-outbox'
import { dispatchTransactionalEmails } from '../../workers/communications/transactional-email-delivery'
import { updateD1DeliveryPreferences } from '../../workers/auth/delivery-preferences'
import { DELIVERY_PREFERENCES_POLICY_VERSION } from '../../shared/delivery-preferences'
import { suppressNewsletterEmail } from '../../workers/marketing/newsletter'

const EMAIL = 'security-notice@example.invalid'
const PASSWORD = 'Synthetic-original-password-123'
const NEXT = 'Synthetic-replacement-password-456'
const utc = () => new Date(Date.now() - 2000).toISOString().replace(/\.\d{3}Z$/, 'Z')

describe('password-reset security notice through real D1 lifecycle/outbox/dispatcher, fake provider only', () => {
  let sqlite: DatabaseSync, database: D1Database, now: string, token: string
  const secrets = {
    tokenPepper: randomBytes(32).toString('hex'),
    encryptionKey: randomBytes(32).toString('base64'),
    newsletterSecrets: { hmacKey: randomBytes(32) }
  }
  const sender = { send: vi.fn(async (_message: unknown) => ({ messageId: 'synthetic-security-receipt' })) }
  beforeEach(async () => {
    sqlite = await openAccountSecurityDatabase()
    database = d1OverSqlite(sqlite)
    now = utc()
    sender.send.mockReset().mockResolvedValue({ messageId: 'synthetic-security-receipt' })
    expect(
      (
        await registerD1Identity(
          database,
          { name: 'Synthetic Customer', email: EMAIL, password: PASSWORD, termsAccepted: true, newsletter: false },
          secrets,
          now
        )
      ).ok
    ).toBe(true)
    const verification = sqlite
      .prepare("SELECT token_envelope FROM identity_lifecycle_tokens WHERE purpose='verify_email'")
      .get()!
    expect(
      (
        await verifyD1Email(
          database,
          { token: decryptSecret(verification.token_envelope as string, secrets.encryptionKey) },
          secrets,
          now
        )
      ).ok
    ).toBe(true)
    await requestD1PasswordReset(database, { email: EMAIL }, secrets, now)
    const reset = sqlite
      .prepare(
        "SELECT token_envelope FROM identity_lifecycle_tokens WHERE purpose='password_reset' AND revoked_at IS NULL"
      )
      .get()!
    token = decryptSecret(reset.token_envelope as string, secrets.encryptionKey)
  })
  afterEach(() => sqlite.close())
  const reset = () => resetD1Password(database, { token, password: NEXT }, secrets, now)
  const dispatch = (enabled = true, db = database) =>
    dispatchTransactionalEmails(db, sender, { enabled, from: 'seguridad@neteco.es', now, appEnvironment: 'local' })
  async function deliverQueue() {
    const messages: unknown[] = []
    await publishEmailOutbox(
      database,
      {
        send: async (message) => {
          messages.push(message)
        }
      },
      { now }
    )
    expect(messages).toHaveLength(1)
    expect(JSON.stringify(messages)).not.toContain(EMAIL)
    expect(await receiveEmailDispatch(database, messages[0], now)).toBe('stored')
    expect(await receiveEmailDispatch(database, messages[0], now)).toBe('replayed')
    return messages[0]
  }
  it('atomically enqueues the confirmed reset and sends one secret-free security notice without marketing consent', async () => {
    expect((await reset()).ok).toBe(true)
    expect(
      sqlite
        .prepare(
          "SELECT e.event_type,e.source_kind,e.source_event_id=l.id AS same_event,e.source_id=l.identity_id AS same_identity FROM email_outbox_events e JOIN identity_lifecycle_events l ON l.id=e.source_event_id WHERE l.event_type='password_reset'"
        )
        .get()
    ).toEqual({
      event_type: 'identity.security.password_changed',
      source_kind: 'identity',
      same_event: 1,
      same_identity: 1
    })
    await deliverQueue()
    expect(await dispatch()).toMatchObject({ sent: 1, manualReview: 0 })
    const message = sender.send.mock.calls[0]![0] as { to: string; subject: string; text: string; html: string }
    expect(message.to).toBe(EMAIL)
    expect(message.subject).toMatch(/contraseña/i)
    expect(message.text).toContain('restablecido')
    for (const secret of [PASSWORD, NEXT, token, secrets.tokenPepper, secrets.encryptionKey])
      expect(JSON.stringify(message)).not.toContain(secret)
    expect(sqlite.prepare('SELECT count(*) n FROM newsletter_subscriptions').get()).toEqual({ n: 0 })
    expect((await dispatch()).sent).toBe(0)
    expect(sender.send).toHaveBeenCalledTimes(1)
  })
  it('rolls back password rotation, token consumption and domain evidence when outbox insertion fails', async () => {
    sqlite.exec(
      "CREATE TRIGGER synthetic_notice_failure BEFORE INSERT ON email_outbox_events BEGIN SELECT RAISE(ABORT,'synthetic_notice_failure'); END"
    )
    await expect(reset()).rejects.toThrow('synthetic_notice_failure')
    const identity = sqlite.prepare('SELECT password_hash,session_version FROM identities').get()!
    expect(await verifyWorkerPassword(identity.password_hash as string, PASSWORD)).toBe(true)
    expect(identity.session_version).toBe(1)
    expect(
      sqlite.prepare("SELECT used_at FROM identity_lifecycle_tokens WHERE purpose='password_reset'").get()
    ).toEqual({ used_at: null })
    expect(
      sqlite.prepare("SELECT count(*) n FROM identity_lifecycle_events WHERE event_type='password_reset'").get()
    ).toEqual({ n: 0 })
  })
  it('does not enqueue again when the consumed reset link is replayed', async () => {
    expect((await reset()).ok).toBe(true)
    expect(await reset()).toEqual({ ok: false, code: 'invalid_token' })
    expect(sqlite.prepare('SELECT count(*) n FROM email_outbox_events').get()).toEqual({ n: 1 })
  })
  it('delivers a reset whose authoritative input clock predates the actual batch by two seconds', async () => {
    // All setup primitives use this valid earlier clock; no forged token/event
    // timestamp or sleep is needed to reproduce a delayed password hash/batch.
    expect(Date.parse(now)).toBeLessThanOrEqual(Date.now() - 2000)
    expect((await reset()).ok).toBe(true)
    await deliverQueue()
    expect(await dispatch()).toMatchObject({ sent: 1, manualReview: 0 })
    expect(sender.send).toHaveBeenCalledTimes(1)
  })
  it('sends security independently of explicit delivery opt-out and marketing suppression', async () => {
    const session = sqlite
      .prepare('SELECT id,identity_id,session_version FROM auth_sessions WHERE revoked_at IS NULL')
      .get()!
    await updateD1DeliveryPreferences(
      database,
      {
        identityId: session.identity_id as string,
        sessionId: session.id as string,
        sessionVersion: session.session_version as number
      },
      crypto.randomUUID(),
      { expectedVersion: 0, deliveryUpdates: false, policyVersion: DELIVERY_PREFERENCES_POLICY_VERSION },
      { now: () => now }
    )
    await suppressNewsletterEmail(
      database,
      EMAIL,
      'manual',
      'synthetic-security-test',
      secrets.newsletterSecrets,
      Math.floor(Date.parse(now) / 1000)
    )
    await reset()
    await deliverQueue()
    const report = await dispatch()
    expect(report.sent).toBe(1)
    expect(report.suppressed).toBeUndefined()
    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sqlite.prepare('SELECT delivery_updates FROM delivery_preferences').get()).toEqual({ delivery_updates: 0 })
    expect(sqlite.prepare('SELECT count(*) n FROM operational_email_suppressions').get()).toEqual({ n: 0 })
  })
  it('keeps delivery durable without contacting a provider while dispatch is disabled', async () => {
    await reset()
    await deliverQueue()
    expect(await dispatch(false)).toMatchObject({ disabled: true, sent: 0 })
    expect(sender.send).not.toHaveBeenCalled()
    expect((await dispatch()).sent).toBe(1)
  })
  it('rejects a corrupted recipient instead of redirecting the security notice', async () => {
    await reset()
    await deliverQueue()
    sqlite.exec(
      "UPDATE identity_lifecycle_tokens SET recipient='foreign@example.invalid' WHERE purpose='password_reset'"
    )
    expect(await dispatch()).toMatchObject({ sent: 0, manualReview: 1 })
    expect(sender.send).not.toHaveBeenCalled()
  })
  it('keeps a transient source-query outage retryable before any provider marker', async () => {
    await reset()
    await deliverQueue()
    let sourceReads = 0
    const outage = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql)
        if (!sql.includes('SELECT l.id operation_id')) return statement
        return {
          ...statement,
          bind(...args: unknown[]) {
            const bound = statement.bind(...args)
            return {
              ...bound,
              async first() {
                sourceReads++
                throw new Error('synthetic transient D1 outage, do not persist')
              }
            }
          }
        }
      }
    } as D1Database
    expect(await dispatch(true, outage)).toMatchObject({ sent: 0, retryable: 1, manualReview: 0 })
    expect(sourceReads).toBe(1)
    expect(sender.send).not.toHaveBeenCalled()
    expect(
      sqlite.prepare('SELECT status,sending_at,last_error_code FROM transactional_email_deliveries').get()
    ).toEqual({ status: 'pending', sending_at: null, last_error_code: 'preparation_failed' })
  })
  it('revalidates recipient authority atomically before the sending marker', async () => {
    await reset()
    await deliverQueue()
    let changed = false
    const racing = {
      ...database,
      batch: async (statements: D1PreparedStatement[]) => {
        if (!changed) {
          changed = true
          sqlite.exec("UPDATE identities SET email='changed@example.invalid'")
        }
        return database.batch(statements)
      }
    } as D1Database
    expect(await dispatch(true, racing)).toMatchObject({ sent: 0, manualReview: 1 })
    expect(changed).toBe(true)
    expect(sender.send).not.toHaveBeenCalled()
  })
  it('never automatically resends a provider outcome lost after the sending marker', async () => {
    await reset()
    await deliverQueue()
    sender.send.mockRejectedValue(new Error('synthetic provider timeout, do not persist'))
    expect(await dispatch()).toMatchObject({ sent: 0, manualReview: 1 })
    await dispatch()
    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sqlite.prepare('SELECT status,last_error_code FROM transactional_email_deliveries').get()).toEqual({
      status: 'manual_review',
      last_error_code: 'provider_outcome_unknown'
    })
  })
})
