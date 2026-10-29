import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { dispatchNewsletterConfirmations, type NewsletterSender } from '../../workers/marketing/newsletter-delivery'
import { handleNewsletterHttp } from '../../workers/marketing/newsletter-http'
import {
  confirmNewsletterConsent,
  isNewsletterSendEligible,
  requestNewsletterConsent,
  suppressNewsletterEmail,
  unsubscribeNewsletterConsent
} from '../../workers/marketing/newsletter'
import { NEWSLETTER_CONSENT_TEXT, NEWSLETTER_POLICY_VERSION } from '../../shared/newsletter'
import type { DatabaseSync } from 'node:sqlite'

const now = 1_790_000_000
const email = 'subscriber@example.test'
const publicOrigin = 'https://shop.neteco.test'
const secrets = { hmacKey: randomBytes(32) }
const configuration = { from: 'newsletter@neteco.test', publicOrigin, secrets, now }

describe('D1 newsletter confirmation delivery', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let sent: Array<{ to: string; from: string; subject: string; html: string; text: string }>
  let sender: NewsletterSender

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    database = d1OverSqlite(sqlite)
    sent = []
    sender = {
      async send(message) {
        sent.push(message)
        return { messageId: `provider-${sent.length}` }
      }
    }
  })
  afterEach(() => sqlite.close())

  async function subscribe(idempotencyKey = 'request_newsletter_0001', at = now) {
    return requestNewsletterConsent(
      database,
      {
        email,
        purpose: 'newsletter',
        consentText: NEWSLETTER_CONSENT_TEXT,
        consentVersion: NEWSLETTER_POLICY_VERSION,
        consentSource: 'footer',
        idempotencyKey,
        now: at
      },
      secrets
    )
  }

  it('commits the delivery job with the consent and sends one reconstructable DOI link', async () => {
    const requested = await subscribe()
    expect(sqlite.prepare('SELECT count(*) AS n FROM newsletter_confirmation_deliveries').get()).toEqual({ n: 1 })
    const job = JSON.stringify(sqlite.prepare('SELECT * FROM newsletter_confirmation_deliveries').get())
    expect(job).not.toContain(email)
    expect(job).not.toContain(requested.internalDelivery!.confirmationToken)
    expect(await isNewsletterSendEligible(database, email, secrets)).toBe(false)

    expect(await dispatchNewsletterConfirmations(database, sender, configuration)).toEqual({
      sent: 1,
      skipped: 0,
      manualReview: 0
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe(email)
    const link = /https:\/\/shop\.neteco\.test\/newsletter\/confirmar\?token=[^\s]+/.exec(sent[0]!.text)![0]
    expect(new URL(link).searchParams.get('token')).toBe(requested.internalDelivery!.confirmationToken)
    expect(await dispatchNewsletterConfirmations(database, sender, configuration)).toEqual({
      sent: 0,
      skipped: 0,
      manualReview: 0
    })
    expect(sent).toHaveLength(1)
    expect(sqlite.prepare('SELECT status, provider_message_id FROM newsletter_confirmation_deliveries').get()).toEqual({
      status: 'sent',
      provider_message_id: 'provider-1'
    })
    await confirmNewsletterConsent(database, requested.internalDelivery!.confirmationToken, secrets, now + 1)
    expect(await isNewsletterSendEligible(database, email, secrets)).toBe(true)
  })

  it('rolls back consent if its transactional delivery job cannot be written', async () => {
    sqlite.exec(`CREATE TRIGGER reject_newsletter_job BEFORE INSERT ON newsletter_confirmation_deliveries
      BEGIN SELECT RAISE(ABORT, 'job_unavailable'); END`)
    await expect(subscribe()).rejects.toThrow('job_unavailable')
    expect(sqlite.prepare('SELECT count(*) AS n FROM newsletter_subscriptions').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM newsletter_consent_events').get()).toEqual({ n: 0 })
  })

  it('skips obsolete and suppressed requests before calling the provider', async () => {
    await subscribe('request_newsletter_0001', now - 48 * 3600 - 1)
    await subscribe('request_newsletter_0002', now)
    expect(sqlite.prepare('SELECT count(*) AS n FROM newsletter_confirmation_deliveries').get()).toEqual({ n: 2 })
    await suppressNewsletterEmail(database, email, 'complaint', 'provider_webhook', secrets, now)
    expect(await dispatchNewsletterConfirmations(database, sender, configuration)).toEqual({
      sent: 0,
      skipped: 2,
      manualReview: 0
    })
    expect(sent).toHaveLength(0)
  })

  it('quarantines ambiguous provider errors and stale in-flight jobs without duplicate sends', async () => {
    await subscribe()
    const throwing: NewsletterSender = {
      async send() {
        throw new Error('timeout after provider acceptance')
      }
    }
    expect(await dispatchNewsletterConfirmations(database, throwing, configuration)).toEqual({
      sent: 0,
      skipped: 0,
      manualReview: 1
    })
    expect(await dispatchNewsletterConfirmations(database, sender, configuration)).toEqual({
      sent: 0,
      skipped: 0,
      manualReview: 0
    })
    expect(sent).toHaveLength(0)
    sqlite.exec(
      "UPDATE newsletter_confirmation_deliveries SET status='sending', claimed_at=1790000000, finished_at=NULL"
    )
    expect(await dispatchNewsletterConfirmations(database, sender, { ...configuration, now: now + 901 })).toEqual({
      sent: 0,
      skipped: 0,
      manualReview: 1
    })
  })

  it('waits for a job created after a delayed Cron schedule instead of claiming it before creation', async () => {
    await subscribe()
    expect(await dispatchNewsletterConfirmations(database, sender, { ...configuration, now: now - 1 })).toEqual({
      sent: 0,
      skipped: 0,
      manualReview: 0
    })
    expect(sqlite.prepare('SELECT status FROM newsletter_confirmation_deliveries').get()).toEqual({ status: 'pending' })
    expect(await dispatchNewsletterConfirmations(database, sender, configuration)).toEqual({
      sent: 1,
      skipped: 0,
      manualReview: 0
    })
  })

  it('exposes only generic, no-store same-origin HTTP responses and keeps unsubscribe immediate', async () => {
    const deps = {
      database,
      edgeLimiter: {
        async limit() {
          return { success: true }
        }
      } as unknown as RateLimit,
      rateLimitPepper: 'a-dedicated-local-test-pepper-at-least-32-bytes',
      configuration: () => ({ secrets, publicOrigin }),
      now: () => now
    }
    const request = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      new Request(`${publicOrigin}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: publicOrigin,
          'cf-connecting-ip': '203.0.113.21',
          ...headers
        },
        body: JSON.stringify(body)
      })
    const subscribePath = '/api/newsletter/subscribe'
    const first = await handleNewsletterHttp(request(subscribePath, { email, consent: true, source: 'footer' }), deps)
    expect(first?.status).toBe(202)
    expect(first?.headers.get('cache-control')).toBe('no-store')
    const publicBody = await first!.text()
    expect(publicBody).not.toContain(email)
    expect(publicBody).not.toContain('token')
    expect(sqlite.prepare('SELECT count(*) AS n FROM newsletter_confirmation_deliveries').get()).toEqual({ n: 1 })
    const second = await handleNewsletterHttp(request(subscribePath, { email, consent: true, source: 'footer' }), deps)
    expect(await second!.text()).toBe(publicBody)
    expect(sqlite.prepare('SELECT count(*) AS n FROM newsletter_confirmation_deliveries').get()).toEqual({ n: 1 })
    const trap = await handleNewsletterHttp(
      request(subscribePath, { email: 'trap@example.test', consent: true, website: 'bot' }),
      deps
    )
    expect(trap?.status).toBe(202)
    expect(sqlite.prepare('SELECT count(*) AS n FROM newsletter_subscriptions').get()).toEqual({ n: 1 })
    for (let index = 0; index < 3; index++) {
      const malformed = await handleNewsletterHttp(request(subscribePath, { email, consent: false }), deps)
      expect(malformed?.status).toBe(400)
    }
    const third = await handleNewsletterHttp(request(subscribePath, { email, consent: true }), deps)
    expect(third?.status).toBe(202)
    const limited = await handleNewsletterHttp(request(subscribePath, { email, consent: true }), deps)
    expect(limited?.status).toBe(429)
    const csrf = await handleNewsletterHttp(
      request(
        '/api/newsletter/confirm',
        { token: 'bad' },
        {
          origin: 'https://attacker.test'
        }
      ),
      deps
    )
    expect(csrf?.status).toBe(403)
    await dispatchNewsletterConfirmations(database, sender, configuration)
    const token = new URL(
      /https:\/\/shop\.neteco\.test\/newsletter\/confirmar\?token=[^\s]+/.exec(sent[0]!.text)![0]
    ).searchParams.get('token')!
    const confirmed = await handleNewsletterHttp(request('/api/newsletter/confirm', { token }), deps)
    expect(confirmed?.status).toBe(200)
    expect(await isNewsletterSendEligible(database, email, secrets)).toBe(true)
    const id = (sqlite.prepare('SELECT id FROM newsletter_subscriptions').get() as { id: string }).id
    const { createNewsletterUnsubscribeToken } = await import('../../workers/marketing/newsletter')
    const unsubscribeToken = await createNewsletterUnsubscribeToken(id, secrets)
    const unsubscribed = await handleNewsletterHttp(
      request('/api/newsletter/unsubscribe', {
        token: unsubscribeToken
      }),
      deps
    )
    expect(unsubscribed?.status).toBe(200)
    expect(await isNewsletterSendEligible(database, email, secrets)).toBe(false)
    expect(await unsubscribeNewsletterConsent(database, unsubscribeToken, secrets, now + 1)).toEqual({ accepted: true })
  })
})
