import { z } from 'zod'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from './catalog-publication-policy'

const integer = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1)
const positive = integer.min(1)
const printable = (value: string) =>
  [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
const reason = z.string().trim().min(10).max(500).refine(printable)
export const inventoryAlertKindSchema = z.enum(['low', 'out_of_stock', 'anomaly'])
export const inventoryAlertStateSchema = z.enum(['open', 'acknowledged', 'resolved'])
export const inventoryAlertsQuerySchema = z
  .object({
    state: z.enum(['open', 'acknowledged', 'resolved', 'all']).default('open'),
    kind: inventoryAlertKindSchema.optional(),
    alertId: catalogPolicyUuidSchema.optional(),
    q: z
      .string()
      .max(100)
      .refine(printable)
      .transform((s) => s.normalize('NFC').trim())
      .default(''),
    page: positive.max(1_000_000).default(1),
    perPage: positive.max(25).default(25)
  })
  .strict()
export const inventoryAlertThresholdInputSchema = z
  .object({ expectedVersion: integer, threshold: integer.nullable(), reason })
  .strict()
export const inventoryAlertAckInputSchema = z.object({ expectedVersion: positive, reason }).strict()
export const inventoryAlertEvaluationInputSchema = z
  .object({ afterVariantId: positive.optional(), limit: positive.max(100).default(50) })
  .strict()
export const inventoryAlertActionSchema = z.enum(['threshold', 'ack', 'evaluate'])
export type InventoryAlertAction = z.infer<typeof inventoryAlertActionSchema>
export function parseInventoryAlertInput(action: InventoryAlertAction, input: unknown) {
  return action === 'threshold'
    ? inventoryAlertThresholdInputSchema.parse(input)
    : action === 'ack'
      ? inventoryAlertAckInputSchema.parse(input)
      : inventoryAlertEvaluationInputSchema.parse(input)
}
export async function inventoryAlertIntentHash(action: InventoryAlertAction, targetId: string, input: unknown) {
  const bytes = new TextEncoder().encode(
    JSON.stringify(['inventory-alert:v1', action, targetId, parseInventoryAlertInput(action, input)])
  )
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}
const capabilities = z.object({ inventoryRead: z.literal(true), inventoryWrite: z.boolean() }).strict()
export const inventoryAlertPolicyResponseSchema = z
  .object({
    source: z.literal('cloudflare'),
    variantId: positive,
    version: integer,
    threshold: integer.nullable(),
    updatedAt: catalogPolicyInstantSchema.nullable(),
    capabilities
  })
  .strict()
export const inventoryAlertItemSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    variantId: positive,
    sku: z.string().min(1).max(200),
    kind: inventoryAlertKindSchema,
    state: inventoryAlertStateSchema,
    version: positive,
    threshold: integer.nullable(),
    sellableQuantity: integer.nullable(),
    currentKind: inventoryAlertKindSchema.nullable(),
    createdAt: catalogPolicyInstantSchema,
    updatedAt: catalogPolicyInstantSchema,
    to: z.string().regex(/^\/admin\/inventario\?variantId=[1-9][0-9]*$/)
  })
  .strict()
  .superRefine((v, c) => {
    if (v.to !== `/admin/inventario?variantId=${v.variantId}`)
      c.addIssue({ code: 'custom', message: 'Invalid destination' })
  })
export const inventoryAlertsResponseSchema = z
  .object({
    source: z.literal('cloudflare'),
    evaluatedAt: catalogPolicyInstantSchema,
    lastEvaluationAt: catalogPolicyInstantSchema.nullable(),
    warehouse: z
      .object({ id: z.string().min(1).max(200), code: z.string().min(1).max(200), name: z.string().min(1).max(200) })
      .strict(),
    capabilities,
    items: z.array(inventoryAlertItemSchema).max(25),
    pagination: z.object({ page: positive, perPage: positive.max(25), total: integer, pages: integer }).strict()
  })
  .strict()
export const inventoryAlertCommandReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: catalogPolicyUuidSchema,
    action: inventoryAlertActionSchema,
    targetId: z.string().min(1).max(200),
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    version: positive.nullable(),
    processed: integer.max(100),
    opened: integer.max(100),
    updated: integer.max(100),
    resolved: integer.max(100),
    nextAfterVariantId: positive.nullable()
  })
  .strict()
  .superRefine((v, c) => {
    if ((v.action === 'evaluate') !== (v.version === null) || v.opened + v.updated + v.resolved > v.processed)
      c.addIssue({ code: 'custom', message: 'Invalid command result' })
    if (
      v.action === 'threshold'
        ? !/^[1-9][0-9]*$/.test(v.targetId) || !Number.isSafeInteger(Number(v.targetId))
        : v.action === 'ack'
          ? !catalogPolicyUuidSchema.safeParse(v.targetId).success
          : v.targetId !== 'warehouse'
    )
      c.addIssue({ code: 'custom', message: 'Invalid command target' })
    if (v.action !== 'evaluate' && v.nextAfterVariantId !== null)
      c.addIssue({ code: 'custom', message: 'Invalid command cursor' })
    if (v.action === 'ack' && (v.processed !== 0 || v.opened + v.updated + v.resolved !== 0))
      c.addIssue({ code: 'custom', message: 'Invalid acknowledgement result' })
  })
export const inventoryAlertCommandResponseSchema = z.discriminatedUnion('outcome', [
  z.object({ source: z.literal('cloudflare'), outcome: z.literal('unknown') }).strict(),
  z
    .object({
      source: z.literal('cloudflare'),
      outcome: z.literal('applied'),
      receipt: inventoryAlertCommandReceiptSchema
    })
    .strict()
])
export type InventoryAlertCommandReceipt = z.infer<typeof inventoryAlertCommandReceiptSchema>
export type InventoryAlertsResponse = z.infer<typeof inventoryAlertsResponseSchema>
export type InventoryAlertPolicyResponse = z.infer<typeof inventoryAlertPolicyResponseSchema>
