import { createHmac } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import postgres from 'postgres'
import { expect, test } from '../fixtures/playwright'

const connection = process.env.DATABASE_URL ?? 'postgres://neteco:neteco-local@localhost:56432/neteco'
const webhookSecret = 'test-email-webhook-secret-at-least-24-characters'

function signedWebhook(request: APIRequestContext, payload: Record<string, string>) {
  const rawBody = JSON.stringify(payload)
  const signature = createHmac('sha256', webhookSecret).update(rawBody).digest('hex')
  return request.post('/api/webhooks/email', {
    data: rawBody,
    headers: {
      'content-type': 'application/json',
      'x-neteco-email-signature': `sha256=${signature}`
    }
  })
}

test('email webhooks are retryable, idempotent and never downgrade permanent failure state', async ({
  request,
  deterministic
}) => {
  const sql = postgres(connection, { max: 1 })
  const randomUUID = () => deterministic.uuid()
  const provider = `e2e-${randomUUID().slice(0, 8)}`
  const providerMessageId = `message-${randomUUID()}`
  const recipientHash = randomUUID().replaceAll('-', '')
  const outboxId = randomUUID()
  const cleanup = async () => {
    await sql`DELETE FROM communication_suppressions WHERE channel = 'email' AND destination_hash = ${recipientHash}`
    await sql`DELETE FROM communication_delivery_events WHERE delivery_id IN (
      SELECT id FROM communication_deliveries WHERE outbox_event_id = ${outboxId}
    )`
    await sql`DELETE FROM communication_deliveries WHERE outbox_event_id = ${outboxId}`
    await sql`DELETE FROM outbox_events WHERE id = ${outboxId}`
    await sql`DELETE FROM webhook_inbox WHERE provider = ${`email:${provider}`}`
  }
  try {
    await cleanup()
    const earlyPayload = {
      provider,
      eventId: `early-${randomUUID()}`,
      providerMessageId,
      type: 'hard_bounce',
      occurredAt: deterministic.date().toISOString()
    }
    const early = await signedWebhook(request, earlyPayload)
    expect(early.status()).toBe(404)

    await sql`
      INSERT INTO outbox_events (
        id, aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key, status
      ) VALUES (
        ${outboxId}, 'e2e_email', ${randomUUID()}, 'e2e.email', ${sql.json({})}, ${randomUUID()},
        ${`e2e:${outboxId}`}, 'completed'
      )
    `
    await sql`
      INSERT INTO communication_deliveries (
        outbox_event_id, provider, provider_message_id, channel, status, recipient_hash
      ) VALUES (${outboxId}, ${provider}, ${providerMessageId}, 'email', 'accepted', ${recipientHash})
    `

    const recovered = await signedWebhook(request, earlyPayload)
    expect(recovered.status()).toBe(202)
    const duplicate = await signedWebhook(request, earlyPayload)
    expect(duplicate.status()).toBe(200)
    expect(await duplicate.json()).toMatchObject({ duplicate: true })

    const delivered = await signedWebhook(request, {
      ...earlyPayload,
      eventId: `delivered-${randomUUID()}`,
      type: 'delivered',
      occurredAt: deterministic.date(1000).toISOString()
    })
    expect(delivered.status()).toBe(202)
    const [state] = await sql<{ status: string; suppression: string; events: number }[]>`
      SELECT delivery.status, suppression.reason AS suppression,
        (SELECT count(*) FROM communication_delivery_events WHERE delivery_id = delivery.id)::int AS events
      FROM communication_deliveries delivery
      JOIN communication_suppressions suppression ON suppression.channel = 'email'
        AND suppression.destination_hash = delivery.recipient_hash
      WHERE delivery.outbox_event_id = ${outboxId}
    `
    expect(state).toEqual({ status: 'bounced', suppression: 'hard_bounce', events: 2 })

    await sql`
      UPDATE communication_suppressions SET reason = 'manual', source = 'e2e_manual'
      WHERE channel = 'email' AND destination_hash = ${recipientHash}
    `
    const complaint = await signedWebhook(request, {
      ...earlyPayload,
      eventId: `complaint-${randomUUID()}`,
      type: 'complaint',
      occurredAt: deterministic.date(2000).toISOString()
    })
    expect(complaint.status()).toBe(202)
    const [preserved] = await sql<{ status: string; reason: string; source: string }[]>`
      SELECT delivery.status, suppression.reason, suppression.source
      FROM communication_deliveries delivery
      JOIN communication_suppressions suppression ON suppression.channel = 'email'
        AND suppression.destination_hash = delivery.recipient_hash
      WHERE delivery.outbox_event_id = ${outboxId}
    `
    expect(preserved).toEqual({ status: 'complained', reason: 'manual', source: 'e2e_manual' })
  } finally {
    await cleanup()
    await sql.end({ timeout: 5 })
  }
})
