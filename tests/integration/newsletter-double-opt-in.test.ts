import type { Sql } from 'postgres'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  confirmNewsletterSubscription,
  requestNewsletterSubscription,
  unsubscribeNewsletter
} from '../../server/services/newsletter'
import { decryptSecret } from '../../server/utils/secrets'
import { deterministicTestData, type DeterministicTestData } from '../fixtures/deterministic'
import { isolatedPostgresDatabase, type IsolatedPostgresDatabase } from '../fixtures/postgres'

const baseConnection = process.env.DATABASE_URL ?? 'postgres://neteco:neteco-local@localhost:56432/neteco'
let sql: Sql
let database: IsolatedPostgresDatabase
const secrets = {
  tokenPepper: 'integration-newsletter-token-pepper',
  encryptionKey: Buffer.alloc(32, 9).toString('base64')
}
let testData: DeterministicTestData
const randomUUID = () => testData.uuid()

beforeEach(async (context) => {
  testData = deterministicTestData(`integration:newsletter:${context.task.id}:${context.task.name}`)
  database = await isolatedPostgresDatabase(testData.namespace)
  process.env.DATABASE_URL = database.connection
  sql = database.sql
})

afterEach(async () => {
  try {
    await database.dispose()
  } finally {
    process.env.DATABASE_URL = baseConnection
  }
})

describe('newsletter double opt-in lifecycle', () => {
  it('keeps marketing disabled until confirmation and makes public unsubscribe immediate and idempotent', async () => {
    const rollback = new Error('ROLLBACK_NEWSLETTER_TEST')
    await expect(
      sql.begin(async (transaction) => {
        const email = testData.email('subscriber')
        const correlationId = randomUUID()
        const [customer] = await transaction<{ id: string }[]>`
          INSERT INTO customers (email, name) VALUES (${email}, 'Newsletter Integration') RETURNING id
        `
        if (!customer) throw new Error('Newsletter customer fixture unavailable')
        await transaction`
          INSERT INTO customer_preferences (customer_id, purpose, channel, enabled)
          VALUES (${customer.id}, 'newsletter', 'email', false)
        `

        const request = await requestNewsletterSubscription(transaction, {
          email,
          customerId: customer.id,
          source: 'integration_test',
          correlationId,
          secrets
        })
        expect(request.queued).toBe(true)
        const [pending] = await transaction<
          { id: string; status: string; enabled: boolean; consentCount: number; tokenEnvelope: string }[]
        >`
          SELECT subscription.id, subscription.status, preference.enabled,
            (SELECT count(*) FROM consent_events consent
             WHERE consent.customer_id = ${customer.id} AND consent.purpose = 'newsletter')::int AS "consentCount",
            event.payload ->> 'tokenEnvelope' AS "tokenEnvelope"
          FROM newsletter_subscriptions subscription
          JOIN customer_preferences preference ON preference.customer_id = subscription.customer_id
            AND preference.purpose = 'newsletter' AND preference.channel = 'email'
          JOIN outbox_events event ON event.aggregate_id = subscription.id
            AND event.event_type = 'newsletter.confirmation.requested'
          WHERE subscription.customer_id = ${customer.id}
        `
        expect(pending).toMatchObject({ status: 'pending', enabled: false, consentCount: 0 })

        const confirmationToken = decryptSecret(pending!.tokenEnvelope, secrets.encryptionKey)
        await expect(
          confirmNewsletterSubscription(transaction, {
            token: confirmationToken,
            tokenPepper: secrets.tokenPepper,
            correlationId
          })
        ).resolves.toEqual({ id: pending!.id })
        await expect(
          confirmNewsletterSubscription(transaction, {
            token: confirmationToken,
            tokenPepper: secrets.tokenPepper,
            correlationId
          })
        ).resolves.toBeNull()

        const [active] = await transaction<
          { status: string; enabled: boolean; grants: number; unsubscribeTokenEnvelope: string }[]
        >`
          SELECT subscription.status, preference.enabled,
            (SELECT count(*) FROM consent_events consent
             WHERE consent.customer_id = ${customer.id} AND consent.purpose = 'newsletter'
               AND consent.action = 'granted')::int AS grants,
            event.payload ->> 'unsubscribeTokenEnvelope' AS "unsubscribeTokenEnvelope"
          FROM newsletter_subscriptions subscription
          JOIN customer_preferences preference ON preference.customer_id = subscription.customer_id
            AND preference.purpose = 'newsletter' AND preference.channel = 'email'
          JOIN outbox_events event ON event.aggregate_id = subscription.id
            AND event.event_type = 'newsletter.welcome'
          WHERE subscription.id = ${pending!.id}
        `
        expect(active).toMatchObject({ status: 'active', enabled: true, grants: 1 })

        const unsubscribeToken = decryptSecret(active!.unsubscribeTokenEnvelope, secrets.encryptionKey)
        await unsubscribeNewsletter(transaction, {
          token: unsubscribeToken,
          tokenPepper: secrets.tokenPepper,
          source: 'public_unsubscribe',
          correlationId
        })
        await unsubscribeNewsletter(transaction, {
          token: unsubscribeToken,
          tokenPepper: secrets.tokenPepper,
          source: 'public_unsubscribe',
          correlationId
        })
        const [unsubscribed] = await transaction<
          { status: string; enabled: boolean; withdrawals: number; suppression: string }[]
        >`
          SELECT subscription.status, preference.enabled,
            (SELECT count(*) FROM consent_events consent
             WHERE consent.customer_id = ${customer.id} AND consent.purpose = 'newsletter'
               AND consent.action = 'withdrawn')::int AS withdrawals,
            suppression.reason AS suppression
          FROM newsletter_subscriptions subscription
          JOIN customer_preferences preference ON preference.customer_id = subscription.customer_id
            AND preference.purpose = 'newsletter' AND preference.channel = 'email'
          JOIN communication_suppressions suppression
            ON suppression.destination_hash = subscription.email_hash AND suppression.channel = 'email'
          WHERE subscription.id = ${pending!.id}
        `
        expect(unsubscribed).toEqual({
          status: 'unsubscribed',
          enabled: false,
          withdrawals: 1,
          suppression: 'unsubscribe'
        })
        throw rollback
      })
    ).rejects.toBe(rollback)
  })
})
