import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  confirmNewsletterConsent,
  createNewsletterUnsubscribeToken,
  isNewsletterSendEligible,
  requestNewsletterConsent,
  suppressNewsletterEmail,
  unsubscribeNewsletterConsent,
  type NewsletterRequest
} from '../../workers/marketing/newsletter'

const migration = fileURLToPath(new URL('../../db/d1/migrations/0024_newsletter_consent.sql', import.meta.url))
const now = 1_787_000_000
const secrets = { hmacKey: randomBytes(32) }
const consent: NewsletterRequest = {
  email: ' First.Example@Example.Invalid ',
  purpose: 'newsletter',
  consentText: 'Acepto recibir la newsletter comercial de NETECO por correo electrónico.',
  consentVersion: '2026-09-v1',
  consentSource: 'footer',
  idempotencyKey: 'request_first_0001',
  now
}

function d1Fixture(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: unknown[] = []
      const statement = {
        bind(...parameters: unknown[]) {
          values = parameters
          return statement
        },
        async first<T>() {
          return (sqlite.prepare(sql).get(...values) ?? null) as T | null
        },
        async run() {
          sqlite.prepare(sql).run(...values)
          return { success: true }
        }
      }
      return statement
    }
  } as unknown as D1Database
}

describe('D1 newsletter consent and suppression', () => {
  let sqlite: DatabaseSync
  let database: D1Database

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.exec(await readFile(migration, 'utf8'))
    database = d1Fixture(sqlite)
  })
  afterEach(() => sqlite.close())

  it('records versioned, sourced consent but gates marketing until the signed double opt-in', async () => {
    const requested = await requestNewsletterConsent(database, consent, secrets)
    expect(requested.accepted).toBe(true)
    expect(requested.internalDelivery?.email).toBe('first.example@example.invalid')
    expect(requested.internalDelivery?.confirmationToken).toMatch(/^n1\.[0-9a-f-]+\.[0-9a-f]{64}$/)
    expect(await isNewsletterSendEligible(database, consent.email, secrets)).toBe(false)
    expect(
      sqlite
        .prepare('SELECT status, consent_text, consent_version, consent_source, purpose FROM newsletter_subscriptions')
        .get()
    ).toEqual({
      status: 'pending',
      consent_text: consent.consentText,
      consent_version: consent.consentVersion,
      consent_source: consent.consentSource,
      purpose: 'newsletter'
    })
    const token = requested.internalDelivery!.confirmationToken
    expect(await requestNewsletterConsent(database, consent, secrets)).toEqual(requested)
    expect(sqlite.prepare('SELECT count(*) AS count FROM newsletter_consent_events').get()).toEqual({ count: 1 })

    await confirmNewsletterConsent(database, token.slice(0, -1) + (token.endsWith('0') ? '1' : '0'), secrets, now + 1)
    expect(await isNewsletterSendEligible(database, consent.email, secrets)).toBe(false)
    await confirmNewsletterConsent(database, token, secrets, now + 1)
    await confirmNewsletterConsent(database, token, secrets, now + 2)
    expect(await isNewsletterSendEligible(database, consent.email, secrets)).toBe(true)
    expect(sqlite.prepare('SELECT event_type FROM newsletter_consent_events ORDER BY occurred_at').all()).toEqual([
      { event_type: 'requested' },
      { event_type: 'confirmed' }
    ])
    const audit = JSON.stringify(sqlite.prepare('SELECT * FROM newsletter_consent_events').all())
    expect(audit).not.toContain('first.example@example.invalid')
    expect(audit).not.toContain(token)
    expect(() => sqlite.exec("DELETE FROM newsletter_consent_events WHERE event_type = 'confirmed'")).toThrow(
      'newsletter_events_immutable'
    )
  })

  it('makes token-only unsubscribe immediate, idempotent and non-reversible by a confirmation replay', async () => {
    const requested = await requestNewsletterConsent(database, consent, secrets)
    await confirmNewsletterConsent(database, requested.internalDelivery!.confirmationToken, secrets, now + 1)
    const id = (sqlite.prepare('SELECT id FROM newsletter_subscriptions').get() as { id: string }).id
    const unsubscribeToken = await createNewsletterUnsubscribeToken(id, secrets)
    expect(await unsubscribeNewsletterConsent(database, unsubscribeToken, secrets, now + 2)).toEqual({ accepted: true })
    expect(await unsubscribeNewsletterConsent(database, unsubscribeToken, secrets, now + 3)).toEqual({ accepted: true })
    await confirmNewsletterConsent(database, requested.internalDelivery!.confirmationToken, secrets, now + 4)
    expect(await isNewsletterSendEligible(database, consent.email, secrets)).toBe(false)
    expect(sqlite.prepare('SELECT status, unsubscribed_at FROM newsletter_subscriptions').get()).toEqual({
      status: 'unsubscribed',
      unsubscribed_at: now + 2
    })
    expect(sqlite.prepare('SELECT reason, source FROM newsletter_suppressions').get()).toEqual({
      reason: 'unsubscribe',
      source: 'newsletter_link'
    })
    expect(
      sqlite.prepare("SELECT count(*) AS count FROM newsletter_consent_events WHERE event_type = 'unsubscribed'").get()
    ).toEqual({ count: 1 })
    expect(
      (await requestNewsletterConsent(database, { ...consent, idempotencyKey: 'request_second_0002' }, secrets))
        .internalDelivery
    ).toBeNull()
  })

  it('honours suppression before subscription and upgrades strong reasons without exposing address existence', async () => {
    await suppressNewsletterEmail(database, consent.email, 'hard_bounce', 'provider_webhook', secrets, now)
    expect(await requestNewsletterConsent(database, consent, secrets)).toEqual({
      accepted: true,
      internalDelivery: null
    })
    expect(sqlite.prepare('SELECT count(*) AS count FROM newsletter_subscriptions').get()).toEqual({ count: 0 })
    await suppressNewsletterEmail(database, consent.email, 'complaint', 'provider_webhook', secrets, now + 1)
    await suppressNewsletterEmail(database, consent.email, 'hard_bounce', 'provider_webhook', secrets, now + 2)
    expect(sqlite.prepare('SELECT reason FROM newsletter_suppressions').get()).toEqual({ reason: 'complaint' })
    expect(await confirmNewsletterConsent(database, 'bad-token', secrets, now + 2)).toEqual({ accepted: true })
    expect(await unsubscribeNewsletterConsent(database, 'bad-token', secrets, now + 2)).toEqual({ accepted: true })
  })

  it('suppresses a confirmed subscription and blocks all later sends and replay', async () => {
    const requested = await requestNewsletterConsent(database, consent, secrets)
    await confirmNewsletterConsent(database, requested.internalDelivery!.confirmationToken, secrets, now + 1)
    await suppressNewsletterEmail(database, consent.email, 'legal', 'privacy_team', secrets, now + 2)
    expect(sqlite.prepare('SELECT status FROM newsletter_subscriptions').get()).toEqual({ status: 'suppressed' })
    expect(
      sqlite
        .prepare("SELECT event_type, occurred_at FROM newsletter_consent_events WHERE event_type = 'suppressed'")
        .get()
    ).toEqual({ event_type: 'suppressed', occurred_at: now + 2 })
    expect(await isNewsletterSendEligible(database, consent.email, secrets)).toBe(false)
    await confirmNewsletterConsent(database, requested.internalDelivery!.confirmationToken, secrets, now + 3)
    expect(
      sqlite.prepare("SELECT count(*) AS count FROM newsletter_consent_events WHERE event_type = 'confirmed'").get()
    ).toEqual({ count: 1 })
    expect(
      (await requestNewsletterConsent(database, { ...consent, idempotencyKey: 'request_third_0003' }, secrets))
        .internalDelivery
    ).toBeNull()
  })

  it('expires confirmation and refreshes a pending request without reviving the old token', async () => {
    const first = await requestNewsletterConsent(database, consent, secrets)
    const expiry = first.internalDelivery!.confirmationExpiresAt
    await confirmNewsletterConsent(database, first.internalDelivery!.confirmationToken, secrets, expiry)
    expect(await isNewsletterSendEligible(database, consent.email, secrets)).toBe(false)
    const second = await requestNewsletterConsent(
      database,
      {
        ...consent,
        idempotencyKey: 'request_refresh_0004',
        consentVersion: '2026-09-v2',
        now: expiry
      },
      secrets
    )
    expect(second.internalDelivery?.confirmationToken).not.toBe(first.internalDelivery?.confirmationToken)
    expect((await requestNewsletterConsent(database, consent, secrets)).internalDelivery).toBeNull()
    await confirmNewsletterConsent(database, first.internalDelivery!.confirmationToken, secrets, expiry + 1)
    expect(await isNewsletterSendEligible(database, consent.email, secrets)).toBe(false)
    await confirmNewsletterConsent(database, second.internalDelivery!.confirmationToken, secrets, expiry + 1)
    expect(await isNewsletterSendEligible(database, consent.email, secrets)).toBe(true)
    expect(
      sqlite
        .prepare(
          "SELECT consent_version FROM newsletter_consent_events WHERE event_type = 'requested' ORDER BY occurred_at"
        )
        .all()
    ).toEqual([{ consent_version: '2026-09-v1' }, { consent_version: '2026-09-v2' }])
  })

  it('rejects conflicting replay and malformed consent before creating records', async () => {
    await requestNewsletterConsent(database, consent, secrets)
    await expect(
      requestNewsletterConsent(database, { ...consent, email: 'other@example.invalid' }, secrets)
    ).rejects.toThrow('newsletter_idempotency_conflict')
    await expect(requestNewsletterConsent(database, { ...consent, idempotencyKey: 'short' }, secrets)).rejects.toThrow(
      'invalid_newsletter_idempotency_key'
    )
    await expect(requestNewsletterConsent(database, { ...consent, consentText: ' ' }, secrets)).rejects.toThrow(
      'invalid_newsletter_consent'
    )
    expect(sqlite.prepare('SELECT count(*) AS count FROM newsletter_subscriptions').get()).toEqual({ count: 1 })
  })

  it('returns the same handoff token for racing retries of one request', async () => {
    const [first, second] = await Promise.all([
      requestNewsletterConsent(database, consent, secrets),
      requestNewsletterConsent(database, consent, secrets)
    ])
    expect(first.internalDelivery).toEqual(second.internalDelivery)
    expect(sqlite.prepare('SELECT count(*) AS count FROM newsletter_consent_events').get()).toEqual({ count: 1 })
  })

  it('rolls back the unsubscribe if suppression cannot be persisted', async () => {
    const requested = await requestNewsletterConsent(database, consent, secrets)
    await confirmNewsletterConsent(database, requested.internalDelivery!.confirmationToken, secrets, now + 1)
    const id = (sqlite.prepare('SELECT id FROM newsletter_subscriptions').get() as { id: string }).id
    const token = await createNewsletterUnsubscribeToken(id, secrets)
    sqlite.exec(`CREATE TRIGGER reject_suppression BEFORE INSERT ON newsletter_suppressions
      BEGIN SELECT RAISE(ABORT, 'synthetic_suppression_failure'); END`)
    await expect(unsubscribeNewsletterConsent(database, token, secrets, now + 2)).rejects.toThrow(
      'synthetic_suppression_failure'
    )
    expect(sqlite.prepare('SELECT status, unsubscribed_at FROM newsletter_subscriptions').get()).toEqual({
      status: 'confirmed',
      unsubscribed_at: null
    })
    expect(
      sqlite.prepare("SELECT count(*) AS count FROM newsletter_consent_events WHERE event_type = 'unsubscribed'").get()
    ).toEqual({ count: 0 })
  })
})
