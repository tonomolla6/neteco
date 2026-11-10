import { z } from 'zod'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from './catalog-publication-policy'
import {
  fulfillmentActionSchema,
  fulfillmentCommandReceiptSchema,
  fulfillmentStateSchema,
  fulfillmentTransitionInputSchema
} from './order-fulfillment'

const version = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1)
export const adminOrderBulkHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const transitionFields = {
  action: fulfillmentActionSchema,
  reason: z.string(),
  evidence: z.string().optional()
}
function validateTransition(
  input: { action: z.infer<typeof fulfillmentActionSchema>; reason: string; evidence?: string },
  context: z.RefinementCtx
) {
  const result = fulfillmentTransitionInputSchema.safeParse({
    action: input.action,
    expectedVersion: 0,
    reason: input.reason,
    ...(input.evidence === undefined ? {} : { evidence: input.evidence })
  })
  if (!result.success) for (const issue of result.error.issues) context.addIssue({ ...issue })
}
export const adminOrderBulkPreviewInputSchema = z
  .object({
    ...transitionFields,
    orderIds: z
      .array(catalogPolicyUuidSchema)
      .min(1)
      .max(25)
      .refine((ids) => new Set(ids).size === ids.length)
  })
  .strict()
  .superRefine(validateTransition)
export const adminOrderBulkCreateInputSchema = z
  .object({
    ...transitionFields,
    orders: z
      .array(z.object({ orderId: catalogPolicyUuidSchema, expectedVersion: version }).strict())
      .min(1)
      .max(25)
      .refine((rows) => new Set(rows.map((row) => row.orderId)).size === rows.length),
    previewHash: adminOrderBulkHashSchema
  })
  .strict()
  .superRefine(validateTransition)
export const adminOrderBulkReasonSchema = z.enum([
  'not_found',
  'version_conflict',
  'invalid_transition',
  'order_cancelled',
  'payment_unconfirmed',
  'inventory_unconfirmed',
  'warehouse_unavailable',
  'shipping_mode_unavailable',
  'history_unconfirmed',
  'unauthenticated',
  'email_unverified',
  'mfa_required',
  'forbidden',
  'idempotency_conflict',
  'shipping_mode_mismatch',
  'conflict'
])
const previewRow = z
  .object({
    orderId: catalogPolicyUuidSchema,
    expectedVersion: version,
    currentVersion: version.nullable(),
    state: fulfillmentStateSchema.nullable(),
    eligible: z.boolean(),
    reason: adminOrderBulkReasonSchema.nullable()
  })
  .strict()
  .refine((row) => row.eligible === (row.reason === null))
export const adminOrderBulkPreviewSchema = z
  .object({
    source: z.literal('cloudflare'),
    action: fulfillmentActionSchema,
    previewHash: adminOrderBulkHashSchema,
    rows: z.array(previewRow).min(1).max(25),
    eligible: z.number().int().min(0).max(25),
    blocked: z.number().int().min(0).max(25),
    inventoryEffect: z.literal('none'),
    economicEffect: z.literal('none'),
    evaluatedAt: catalogPolicyInstantSchema
  })
  .strict()
  .refine(
    (value) =>
      value.eligible === value.rows.filter((row) => row.eligible).length &&
      value.blocked === value.rows.length - value.eligible
  )
export const adminOrderBulkReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: catalogPolicyUuidSchema,
    payloadHash: adminOrderBulkHashSchema,
    groupId: catalogPolicyUuidSchema,
    dispatchId: catalogPolicyUuidSchema,
    previewHash: adminOrderBulkHashSchema,
    selected: z.number().int().min(1).max(25),
    eligible: z.number().int().min(0).max(25),
    blocked: z.number().int().min(0).max(25),
    recordedAt: catalogPolicyInstantSchema
  })
  .strict()
  .refine((value) => value.selected === value.eligible + value.blocked)
export const adminOrderBulkGroupSchema = z
  .object({
    source: z.literal('cloudflare'),
    groupId: catalogPolicyUuidSchema,
    commandId: catalogPolicyUuidSchema,
    payloadHash: adminOrderBulkHashSchema,
    dispatchId: catalogPolicyUuidSchema,
    action: fulfillmentActionSchema,
    status: z.enum(['pending', 'completed', 'paused']),
    recordedAt: catalogPolicyInstantSchema,
    selected: z.number().int().min(1).max(25),
    completed: z.number().int().min(0).max(25),
    remaining: z.number().int().min(0).max(25),
    rows: z
      .array(
        z
          .object({
            orderId: catalogPolicyUuidSchema,
            expectedVersion: version,
            childKey: catalogPolicyUuidSchema,
            status: z.enum(['pending', 'unknown', 'applied', 'rejected', 'not_attempted']),
            reason: adminOrderBulkReasonSchema.nullable(),
            receipt: fulfillmentCommandReceiptSchema.nullable()
          })
          .strict()
      )
      .min(1)
      .max(25),
    inventoryEffect: z.literal('none'),
    economicEffect: z.literal('none')
  })
  .strict()
  .superRefine((value, context) => {
    const completed = value.rows.filter((row) => ['applied', 'rejected', 'not_attempted'].includes(row.status)).length
    if (
      value.selected !== value.rows.length ||
      value.completed !== completed ||
      value.remaining !== value.selected - completed ||
      new Set(value.rows.map((row) => row.orderId)).size !== value.rows.length ||
      value.rows.some((row) =>
        row.status === 'applied'
          ? !row.receipt ||
            row.reason !== null ||
            row.receipt.orderId !== row.orderId ||
            row.receipt.action !== value.action ||
            row.receipt.version !== row.expectedVersion + 1
          : row.receipt !== null ||
            (['rejected', 'not_attempted'].includes(row.status) ? row.reason === null : row.reason !== null)
      )
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unconfirmed bulk result' })
  })
export const adminOrderBulkCommandSchema = z.discriminatedUnion('outcome', [
  z
    .object({ source: z.literal('cloudflare'), outcome: z.literal('applied'), receipt: adminOrderBulkReceiptSchema })
    .strict(),
  z.object({ source: z.literal('cloudflare'), outcome: z.literal('unknown'), receipt: z.null() }).strict()
])
export type AdminOrderBulkPreviewInput = z.infer<typeof adminOrderBulkPreviewInputSchema>
export type AdminOrderBulkCreateInput = z.infer<typeof adminOrderBulkCreateInputSchema>
export type AdminOrderBulkPreview = z.infer<typeof adminOrderBulkPreviewSchema>
export type AdminOrderBulkReceipt = z.infer<typeof adminOrderBulkReceiptSchema>
export type AdminOrderBulkGroup = z.infer<typeof adminOrderBulkGroupSchema>
export type AdminOrderBulkCommand = z.infer<typeof adminOrderBulkCommandSchema>
export async function adminOrderBulkIntentHash(input: unknown): Promise<string> {
  const parsed = adminOrderBulkCreateInputSchema.parse(input)
  // Explicit canonical tuple: browser-compatible and independent of Workers,
  // object insertion order, absent properties, or private operational modules.
  const canonical = JSON.stringify([
    parsed.action,
    parsed.orders.map((row) => [row.orderId, row.expectedVersion]),
    parsed.reason,
    parsed.evidence ?? null,
    parsed.previewHash
  ])
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
