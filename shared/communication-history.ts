import { z } from 'zod'
import { supportInstant, supportText, supportUuid } from './support-operations'

export const communicationEventIdSchema = z.string().regex(/^email:[a-f0-9]{64}$/)
export const communicationTypeSchema = z.enum([
  'order.created',
  'order.confirmed',
  'order.status.updated',
  'order.cancelled',
  'order.cancellation.requested',
  'order.reservation.expired',
  'order.shipped',
  'order.delivered',
  'refund.succeeded.email',
  'return.requested',
  'return.status.updated',
  'support.ticket.received',
  'support.ticket.reply',
  'invoice.issued'
])
export const communicationStatusSchema = z.enum([
  'queued',
  'pending',
  'leased',
  'sending',
  'sent',
  'manual_review',
  'suppressed'
])
export const communicationHistoryQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    perPage: z.coerce.number().int().min(1).max(25).default(25),
    status: communicationStatusSchema.optional(),
    eventType: communicationTypeSchema.optional(),
    eventId: communicationEventIdSchema.optional()
  })
  .strict()
export const communicationRetryInputSchema = z
  .object({
    expectedAttempts: z.number().int().min(0).max(9),
    expectedAvailableAt: supportInstant,
    reason: supportText(10, 500)
  })
  .strict()
export const communicationHistoryItemSchema = z
  .object({
    eventId: communicationEventIdSchema,
    eventType: communicationTypeSchema,
    status: communicationStatusSchema,
    createdAt: supportInstant,
    attempts: z.number().int().min(0),
    availableAt: supportInstant.nullable(),
    finishedAt: supportInstant.nullable(),
    errorCode: z
      .string()
      .regex(/^[a-z_]{1,64}$/)
      .nullable(),
    canRetry: z.boolean()
  })
  .strict()
export const communicationHistorySchema = z
  .object({
    source: z.literal('cloudflare'),
    evaluatedAt: supportInstant,
    page: z.number().int().min(1),
    perPage: z.number().int().min(1).max(25),
    total: z.number().int().min(0),
    items: z.array(communicationHistoryItemSchema).max(25)
  })
  .strict()
export const communicationRetryReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: supportUuid,
    eventId: communicationEventIdSchema,
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    previousAvailableAt: supportInstant,
    availableAt: supportInstant,
    attempts: z.number().int().min(0).max(9),
    recordedAt: supportInstant,
    senderInvoked: z.literal(false),
    attemptsReset: z.literal(false),
    preparation: z.literal('retry_requested')
  })
  .strict()
export const communicationRetryCommandSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      source: z.literal('cloudflare'),
      outcome: z.literal('applied'),
      receipt: communicationRetryReceiptSchema
    })
    .strict(),
  z.object({ source: z.literal('cloudflare'), outcome: z.literal('unknown'), receipt: z.null() }).strict()
])
export type CommunicationHistory = z.infer<typeof communicationHistorySchema>
export type CommunicationRetryInput = z.infer<typeof communicationRetryInputSchema>
export type CommunicationRetryReceipt = z.infer<typeof communicationRetryReceiptSchema>
export type CommunicationRetryCommand = z.infer<typeof communicationRetryCommandSchema>
export async function communicationRetryIntentHash(eventId: string, raw: unknown) {
  const input = communicationRetryInputSchema.parse(raw)
  communicationEventIdSchema.parse(eventId)
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        JSON.stringify({
          purpose: 'neteco:communication-preparation-retry:v1',
          eventId,
          ...input
        })
      )
    )
  )
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
