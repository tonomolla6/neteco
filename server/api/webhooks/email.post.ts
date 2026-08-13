import { createHash } from 'node:crypto'
import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { verifyWebhookSignature } from '../../utils/webhook-signature'

const schema = z
  .object({
    provider: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]{2,40}$/),
    eventId: z.string().trim().min(3).max(200),
    providerMessageId: z.string().trim().min(3).max(500),
    type: z.enum(['delivered', 'hard_bounce', 'complaint']),
    occurredAt: z.string().datetime()
  })
  .strict()

export default defineEventHandler(async (event) => {
  const secret = process.env.EMAIL_WEBHOOK_SECRET?.trim()
  if (!secret || secret.length < 24) {
    throw createError({ statusCode: 503, statusMessage: 'Webhook de correo no configurado' })
  }
  const rawBody = await readRawBody(event, 'utf8')
  if (!rawBody || !verifyWebhookSignature(rawBody, getHeader(event, 'x-neteco-email-signature'), secret)) {
    throw createError({ statusCode: 401, statusMessage: 'Firma de webhook inválida' })
  }
  const body = schema.parse(JSON.parse(rawBody))
  const payloadHash = createHash('sha256').update(rawBody).digest('hex')
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const sql = useDatabase()
  const result = await sql.begin(async (transaction) => {
    const [inbox] = await transaction<{ id: string }[]>`
      INSERT INTO webhook_inbox (
        provider, provider_event_id, payload_hash, sanitized_payload, signature_valid, status, correlation_id
      ) VALUES (
        ${`email:${body.provider}`}, ${body.eventId}, ${payloadHash},
        ${transaction.json({ type: body.type, occurredAt: body.occurredAt })}, true, 'processing', ${correlationId}
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `
    if (!inbox) return { duplicate: true }
    const [delivery] = await transaction<{ id: string; recipientHash: string }[]>`
      SELECT id, recipient_hash AS "recipientHash" FROM communication_deliveries
      WHERE provider = ${body.provider} AND provider_message_id = ${body.providerMessageId}
      FOR UPDATE
    `
    if (!delivery) {
      await transaction`
        UPDATE webhook_inbox SET status = 'failed', processed_at = now() WHERE id = ${inbox.id}
      `
      return { duplicate: false, missing: true }
    }
    const deliveryStatus =
      body.type === 'delivered' ? 'delivered' : body.type === 'hard_bounce' ? 'bounced' : 'complained'
    await transaction`
      INSERT INTO communication_delivery_events (
        delivery_id, provider_event_id, event_type, occurred_at, payload_hash
      ) VALUES (${delivery.id}, ${body.eventId}, ${body.type}, ${body.occurredAt}, ${payloadHash})
      ON CONFLICT (delivery_id, provider_event_id) DO NOTHING
    `
    await transaction`
      UPDATE communication_deliveries SET status = ${deliveryStatus}, updated_at = now()
      WHERE id = ${delivery.id}
    `
    if (body.type !== 'delivered') {
      await transaction`
        INSERT INTO communication_suppressions (channel, destination_hash, reason, source)
        VALUES (
          'email', ${delivery.recipientHash}, ${body.type === 'hard_bounce' ? 'hard_bounce' : 'complaint'},
          ${`webhook:${body.provider}`}
        )
        ON CONFLICT (channel, destination_hash) DO UPDATE SET
          reason = EXCLUDED.reason, source = EXCLUDED.source, created_at = now()
      `
    }
    await transaction`
      UPDATE webhook_inbox SET status = 'processed', processed_at = now() WHERE id = ${inbox.id}
    `
    return { duplicate: false, missing: false }
  })
  if ('missing' in result && result.missing) {
    throw createError({ statusCode: 404, statusMessage: 'Entrega de correo no encontrada' })
  }
  setResponseStatus(event, result.duplicate ? 200 : 202)
  return result
})
