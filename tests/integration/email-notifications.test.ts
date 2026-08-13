import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Sql } from 'postgres'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { transactionalEmailEventTypes } from '../../server/services/transactional-email'
import { encryptSecret } from '../../server/utils/secrets'
import { deterministicTestData, type DeterministicTestData } from '../fixtures/deterministic'
import { isolatedPostgresDatabase, type IsolatedPostgresDatabase } from '../fixtures/postgres'

const execFileAsync = promisify(execFile)
const encryptionKey = Buffer.alloc(32, 17).toString('base64')
let database: IsolatedPostgresDatabase
let sql: Sql
let testData: DeterministicTestData

beforeEach(async (context) => {
  testData = deterministicTestData(`integration:email-notifications:${context.task.id}:${context.task.name}`)
  database = await isolatedPostgresDatabase(testData.namespace)
  sql = database.sql
})

afterEach(async () => {
  await database.dispose()
})

async function runWorker() {
  return execFileAsync('node_modules/.bin/tsx', ['scripts/outbox-worker.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: database.connection,
      APP_ENV: 'test',
      APP_BASE_URL: 'http://127.0.0.1:3000',
      AUTH_ENCRYPTION_KEY: encryptionKey,
      EMAIL_PROVIDER: 'log',
      MARKETING_EMAIL_PROVIDER: 'log'
    },
    timeout: 20_000
  })
}

describe('email notification triggers and deduplication', () => {
  it('claims every supported event once, including an expired reservation', async () => {
    const tokenEnvelope = encryptSecret('integration-action-token', encryptionKey)
    for (const eventType of transactionalEmailEventTypes) {
      const aggregateId = testData.uuid(eventType)
      await sql`
        INSERT INTO outbox_events (
          aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
        ) VALUES (
          'email_test', ${aggregateId}, ${eventType}, ${sql.json({
            recipient: testData.email(eventType),
            locale: 'es-ES',
            name: 'Cliente integración',
            orderId: aggregateId,
            orderNumber: 'NE-2026-0001',
            totalCents: 12_345,
            statusLabel: 'en preparación',
            trackingNumber: 'TRACK-0001',
            refundCents: 2_500,
            returnNumber: 'DEV-2026-0001',
            ticketNumber: 'SUP-2026-0001',
            replyBody: 'Respuesta de soporte',
            invoiceId: testData.uuid(`${eventType}:invoice`),
            code: 'F-2026-0001',
            tokenEnvelope,
            expiresAt: '2026-08-20T12:00:00.000Z',
            unsubscribeTokenEnvelope: tokenEnvelope,
            unsubscribeExpiresAt: '2027-08-13T12:00:00.000Z'
          })}, ${testData.uuid(`${eventType}:correlation`)}, ${`email-test:${eventType}`}
        )
      `
    }

    const first = await runWorker()
    expect(first.stdout.match(/"event":"email.accepted"/g)).toHaveLength(transactionalEmailEventTypes.length)
    const [afterFirst] = await sql<{ completed: number; deliveries: number; duplicates: number }[]>`
      SELECT
        count(*) FILTER (WHERE event.status = 'completed')::int AS completed,
        count(delivery.id)::int AS deliveries,
        (count(delivery.id) - count(DISTINCT delivery.outbox_event_id))::int AS duplicates
      FROM outbox_events event
      LEFT JOIN communication_deliveries delivery ON delivery.outbox_event_id = event.id
      WHERE event.aggregate_type = 'email_test'
    `
    expect(afterFirst).toEqual({
      completed: transactionalEmailEventTypes.length,
      deliveries: transactionalEmailEventTypes.length,
      duplicates: 0
    })

    const second = await runWorker()
    expect(second.stdout).not.toContain('email.accepted')
    const [afterReplay] = await sql<{ events: number; deliveries: number }[]>`
      SELECT count(DISTINCT event.id)::int AS events, count(delivery.id)::int AS deliveries
      FROM outbox_events event
      LEFT JOIN communication_deliveries delivery ON delivery.outbox_event_id = event.id
      WHERE event.aggregate_type = 'email_test'
    `
    expect(afterReplay).toEqual({
      events: transactionalEmailEventTypes.length,
      deliveries: transactionalEmailEventTypes.length
    })
  })
})
