import { z } from 'zod'
import { supportInstant, supportRef, supportText, supportUuid } from './support-operations'

export const supportEscalationQueueSchema = z.enum(['payment', 'stock', 'transport', 'beply'])
export const supportEscalationSeveritySchema = z.enum(['normal', 'high', 'critical'])
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const reason = supportText(10, 500)
const runbookSelection = z.object({ id: supportUuid, version: version.min(1) }).strict()
const assignment = {
  queue: supportEscalationQueueSchema,
  ownerId: supportUuid,
  severity: supportEscalationSeveritySchema,
  runbook: runbookSelection,
  nextAction: supportText(10, 1000),
  nextActionAt: supportInstant
}
export const supportEscalationInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('handoff'),
      expectedVersion: version,
      expectedTicketVersion: version.min(1),
      ...assignment,
      reason
    })
    .strict(),
  z
    .object({
      action: z.literal('update'),
      expectedVersion: version.min(1),
      expectedTicketVersion: version.min(1),
      ...assignment,
      reason
    })
    .strict(),
  z
    .object({
      action: z.literal('resolve'),
      expectedVersion: version.min(1),
      expectedTicketVersion: version.min(1),
      resolution: supportText(10, 2000),
      reason
    })
    .strict()
])
export const supportRunbookInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('draft'),
      expectedVersion: version,
      queue: supportEscalationQueueSchema,
      title: supportText(3, 120),
      body: supportText(10, 4000),
      reason
    })
    .strict(),
  z
    .object({
      action: z.literal('approve'),
      expectedVersion: version.min(1),
      operationalReference: supportText(3, 200),
      reviewedAt: supportInstant,
      expiresAt: supportInstant,
      reason
    })
    .strict(),
  z.object({ action: z.literal('withdraw'), expectedVersion: version.min(1), reason }).strict()
])
export const supportRunbookSchema = z
  .object({
    source: z.literal('cloudflare'),
    id: supportUuid,
    version: version.min(1),
    queue: supportEscalationQueueSchema,
    state: z.enum(['draft', 'approved', 'withdrawn']),
    title: supportText(3, 120),
    body: supportText(10, 4000),
    operationalReference: supportText(3, 200).nullable(),
    reviewedAt: supportInstant.nullable(),
    expiresAt: supportInstant.nullable(),
    updatedAt: supportInstant
  })
  .strict()
export const supportRunbookLibrarySchema = z
  .object({ source: z.literal('cloudflare'), items: z.array(supportRunbookSchema).max(100) })
  .strict()
export const supportEscalationStateSchema = z
  .object({
    publicRef: supportRef,
    version: version.min(1),
    ticketVersion: version.min(1),
    state: z.enum(['open', 'resolved']),
    ...assignment,
    resolution: supportText(10, 2000).nullable(),
    createdAt: supportInstant,
    updatedAt: supportInstant
  })
  .strict()
export const supportEscalationReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: supportUuid,
    targetId: z.string().min(1).max(64),
    action: z.enum(['handoff', 'update', 'resolve', 'draft', 'approve', 'withdraw']),
    expectedVersion: version,
    version: version.min(1),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    recordedAt: supportInstant,
    inventoryEffect: z.literal('none'),
    economicEffect: z.literal('none'),
    communicationEffect: z.literal('none')
  })
  .strict()
export const supportEscalationCommandSchema = z.discriminatedUnion('outcome', [
  z
    .object({ source: z.literal('cloudflare'), outcome: z.literal('applied'), receipt: supportEscalationReceiptSchema })
    .strict(),
  z.object({ source: z.literal('cloudflare'), outcome: z.literal('unknown'), receipt: z.null() }).strict()
])
export const supportEscalationQuerySchema = z
  .object({
    queue: supportEscalationQueueSchema.optional(),
    state: z.enum(['open', 'resolved']).optional(),
    severity: supportEscalationSeveritySchema.optional(),
    owner: z.union([supportUuid, z.literal('me')]).optional(),
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    perPage: z.coerce.number().int().min(1).max(25).default(25)
  })
  .strict()
export const supportEscalationListSchema = z
  .object({
    source: z.literal('cloudflare'),
    items: z.array(supportEscalationStateSchema).max(25),
    page: version.min(1),
    perPage: version.min(1).max(25),
    total: version
  })
  .strict()
export const supportEscalationSnapshotSchema = z
  .object({
    source: z.literal('cloudflare'),
    publicRef: supportRef,
    ticketVersion: version.min(1),
    escalation: supportEscalationStateSchema.nullable(),
    history: z
      .array(
        z
          .object({
            receipt: supportEscalationReceiptSchema,
            actorId: supportUuid,
            reason,
            snapshot: supportEscalationStateSchema
          })
          .strict()
      )
      .max(25),
    page: version.min(1),
    perPage: version.min(1).max(25),
    total: version,
    staff: z.array(z.object({ id: supportUuid, label: z.string().min(1).max(200) }).strict()).max(100),
    runbooks: z.array(supportRunbookSchema).max(100)
  })
  .strict()
export type SupportEscalationInput = z.infer<typeof supportEscalationInputSchema>
export type SupportRunbookInput = z.infer<typeof supportRunbookInputSchema>
export type SupportEscalationReceipt = z.infer<typeof supportEscalationReceiptSchema>
export type SupportEscalationSnapshot = z.infer<typeof supportEscalationSnapshotSchema>
export type SupportEscalationList = z.infer<typeof supportEscalationListSchema>
export async function supportEscalationIntentHash(targetId: string, input: unknown) {
  const normalized = targetId.startsWith('SOP-')
    ? supportEscalationInputSchema.parse(input)
    : supportRunbookInputSchema.parse(input)
  const bytes = new TextEncoder().encode(JSON.stringify({ targetId, input: normalized }))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
