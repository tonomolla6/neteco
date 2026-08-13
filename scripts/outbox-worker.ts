import postgres from 'postgres'
import { createHash } from 'node:crypto'
import {
  emailProviderFromEnvironment,
  marketingEmailProviderFromEnvironment
} from '../server/integrations/email-provider'
import {
  renderTransactionalEmail,
  transactionalEmailEventTypes,
  type TransactionalEmailEvent
} from '../server/services/transactional-email'
import { hashAccessToken } from '../server/utils/access-token'
import { validatedEmailBaseUrl } from '../server/utils/email-base-url'
import { encryptSecret, randomOpaqueToken } from '../server/utils/secrets'

interface OutboxEvent extends TransactionalEmailEvent {
  attempts: number
}

const connection = process.env.DATABASE_URL?.trim()
const encryptionKey = process.env.AUTH_ENCRYPTION_KEY?.trim()
const configuredBaseUrl = process.env.APP_BASE_URL?.trim()
if (!connection) throw new Error('DATABASE_URL is required')
if (!encryptionKey) throw new Error('AUTH_ENCRYPTION_KEY is required')
if (!configuredBaseUrl) throw new Error('APP_BASE_URL is required')
const baseUrl = validatedEmailBaseUrl(configuredBaseUrl, process.env.APP_ENV)

const sql = postgres(connection, { max: 2, connect_timeout: 10 })
const transactionalProvider = emailProviderFromEnvironment()
const marketingProvider = marketingEmailProviderFromEnvironment()
const workerId = `email-${process.pid}`
const aggregateFilter =
  process.argv.find((argument) => argument.startsWith('--aggregate-id='))?.split('=', 2)[1] ?? null
const supportedEventTypes = [...transactionalEmailEventTypes]

async function claim(): Promise<OutboxEvent | undefined> {
  return sql.begin(async (transaction) => {
    await transaction`
      UPDATE outbox_events
      SET status = 'retry', available_at = now(), locked_at = NULL, locked_by = NULL,
          last_error_code = 'stale_worker_lease', last_error_message = 'Recovered an expired email worker lease'
      WHERE status = 'processing' AND locked_at < now() - interval '15 minutes'
        AND event_type IN ${transaction(supportedEventTypes)}
    `
    const [event] = await transaction<OutboxEvent[]>`
      SELECT event.id, event.event_type AS "eventType",
             event.payload || CASE WHEN orders.id IS NOT NULL THEN jsonb_build_object(
               'recipient', orders.customer_snapshot ->> 'email',
               'name', orders.customer_snapshot ->> 'name',
               'orderNumber', orders.public_number,
               'totalCents', orders.total_gross_cents,
               'tokenEnvelope', COALESCE(
                 event.payload ->> 'tokenEnvelope',
                 (
                   SELECT created.payload ->> 'tokenEnvelope' FROM outbox_events created
                   WHERE created.aggregate_id = orders.id AND created.event_type = 'order.created'
                   ORDER BY created.created_at LIMIT 1
                 )
               )
             ) ELSE '{}'::jsonb END
             || CASE WHEN invoice_record.id IS NOT NULL THEN jsonb_build_object(
               'invoiceId', invoice_record.id
             ) ELSE '{}'::jsonb END AS payload,
             event.attempts
      FROM outbox_events event
      LEFT JOIN refunds ON event.aggregate_type = 'refund' AND refunds.id = event.aggregate_id
      LEFT JOIN returns return_record ON event.aggregate_type = 'return' AND return_record.id = event.aggregate_id
      LEFT JOIN invoices invoice_record ON event.aggregate_type = 'invoice' AND invoice_record.id = event.aggregate_id
      LEFT JOIN orders ON
        (event.aggregate_type = 'order' AND orders.id = event.aggregate_id)
        OR (event.aggregate_type = 'refund' AND orders.id = refunds.order_id)
        OR (event.aggregate_type = 'return' AND orders.id = return_record.order_id)
        OR (event.aggregate_type = 'invoice' AND orders.id = invoice_record.order_id)
      WHERE event.status IN ('pending', 'retry')
        AND event.available_at <= now()
        AND (${aggregateFilter}::uuid IS NULL OR event.aggregate_id = ${aggregateFilter}::uuid)
        AND event.event_type IN ${transaction(supportedEventTypes)}
      ORDER BY event.created_at
      FOR UPDATE OF event SKIP LOCKED
      LIMIT 1
    `
    if (!event) return undefined
    if (event.eventType === 'invoice.issued' && !event.payload.tokenEnvelope) {
      if (!event.payload.orderId) throw new Error('Invoice email event has no order ID')
      const accessToken = randomOpaqueToken()
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000)
      const tokenEnvelope = encryptSecret(accessToken, encryptionKey!)
      await transaction`
        INSERT INTO order_access_sessions (order_id, token_hash, expires_at)
        VALUES (${event.payload.orderId}, ${hashAccessToken(accessToken)}, ${expiresAt})
        ON CONFLICT (order_id, token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at, revoked_at = NULL
      `
      await transaction`
        UPDATE outbox_events SET payload = payload || ${transaction.json({
          tokenEnvelope,
          expiresAt: expiresAt.toISOString()
        })}
        WHERE id = ${event.id}
      `
      event.payload.tokenEnvelope = tokenEnvelope
      event.payload.expiresAt = expiresAt.toISOString()
    }
    await transaction`
      UPDATE outbox_events
      SET status = 'processing', attempts = attempts + 1, locked_at = now(), locked_by = ${workerId}
      WHERE id = ${event.id}
    `
    return { ...event, attempts: event.attempts + 1 }
  })
}

async function processOne(event: OutboxEvent) {
  try {
    const email = renderTransactionalEmail(event, {
      baseUrl: baseUrl!,
      encryptionKey: encryptionKey!
    })
    const marketing = event.eventType === 'newsletter.welcome'
    const provider = marketing ? marketingProvider : transactionalProvider
    const recipientHash = createHash('sha256').update(email.to.trim().toLowerCase()).digest('hex')
    const suppressionReasons = marketing
      ? ['unsubscribe', 'hard_bounce', 'complaint', 'manual', 'legal']
      : ['hard_bounce', 'complaint', 'manual', 'legal']
    const [suppression] = await sql<{ reason: string }[]>`
      SELECT reason FROM communication_suppressions
      WHERE channel = 'email' AND destination_hash = ${recipientHash}
        AND reason IN ${sql(suppressionReasons)}
    `
    if (suppression) {
      await sql.begin(async (transaction) => {
        await transaction`
          INSERT INTO communication_deliveries (
            outbox_event_id, provider, provider_message_id, channel, status, recipient_hash
          ) VALUES (
            ${event.id}, ${provider.name}, ${`suppressed:${event.id}`}, 'email', 'suppressed', ${recipientHash}
          ) ON CONFLICT (outbox_event_id) DO NOTHING
        `
        await transaction`
          UPDATE outbox_events
          SET status = 'completed', completed_at = now(), locked_at = NULL, locked_by = NULL,
              last_error_code = ${`email_suppressed_${suppression.reason}`},
              last_error_message = 'Delivery blocked by communication suppression'
          WHERE id = ${event.id} AND locked_by = ${workerId}
        `
      })
      return
    }
    const delivery = await provider.send(email)
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO communication_deliveries (
          outbox_event_id, provider, provider_message_id, channel, status, recipient_hash
        ) VALUES (
          ${event.id}, ${provider.name}, ${delivery.providerMessageId}, 'email', 'accepted',
          ${recipientHash}
        ) ON CONFLICT (outbox_event_id) DO NOTHING
      `
      await transaction`
        UPDATE outbox_events
        SET status = 'completed', completed_at = now(), locked_at = NULL, locked_by = NULL,
            last_error_code = NULL, last_error_message = NULL
        WHERE id = ${event.id} AND locked_by = ${workerId}
      `
    })
  } catch (error) {
    const terminal = event.attempts >= 10
    const delaySeconds = Math.min(2 ** event.attempts * 30, 3600)
    await sql`
      UPDATE outbox_events
      SET status = ${terminal ? 'dead' : 'retry'}, available_at = now() + (${delaySeconds} * interval '1 second'),
          locked_at = NULL, locked_by = NULL, last_error_code = 'email_delivery_failed',
          last_error_message = ${error instanceof Error ? error.message.slice(0, 500) : 'unknown'}
      WHERE id = ${event.id} AND locked_by = ${workerId}
    `
    if (terminal) process.exitCode = 1
  }
}

try {
  const once = process.argv.includes('--once')
  do {
    const event = await claim()
    if (!event) break
    await processOne(event)
  } while (!once)
} finally {
  await sql.end({ timeout: 5 })
}
