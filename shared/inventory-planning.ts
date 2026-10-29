import { z } from 'zod'

const uuid = z
  .string()
  .length(36)
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  .refine((v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().replace('.000Z', 'Z') === v)
const qty = (max: number) => z.number().int().min(0).max(max)
const note = z.string().trim().min(3).max(500)
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)

export const planningUuidSchema = uuid

// INV-017 -----------------------------------------------------------------
export const reorderPolicyInputSchema = z
  .object({
    variantId: uuid,
    leadTimeDays: qty(365),
    reviewDays: qty(90).default(7),
    demandWindowDays: z.number().int().min(7).max(180).default(30),
    orderMultiple: z.number().int().min(1).max(10000).default(1),
    minOrderQuantity: z.number().int().min(1).max(1_000_000).default(1),
    expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0)
  })
  .strict()
export const reorderEvaluateInputSchema = z.object({ variantIds: z.array(uuid).max(100).optional() }).strict()
export const suggestionDecisionInputSchema = z.discriminatedUnion('decision', [
  z
    .object({
      decision: z.literal('approve'),
      expectedVersion: version,
      approvedQuantity: z.number().int().min(1).max(1_000_000),
      note
    })
    .strict(),
  z.object({ decision: z.literal('reject'), expectedVersion: version, note }).strict()
])
export type ReorderPolicyInput = z.infer<typeof reorderPolicyInputSchema>

// INV-018 -----------------------------------------------------------------
export const scanStageSchema = z.enum(['receiving', 'picking', 'packing'])
export const createScanTaskInputSchema = z.union([
  z.object({ stage: z.enum(['picking', 'packing']), orderId: z.string().min(1).max(64) }).strict(),
  z
    .object({
      stage: scanStageSchema,
      reference: z.string().trim().min(2).max(100),
      lines: z
        .array(
          z.object({ sku: z.string().trim().min(1).max(100), quantity: z.number().int().min(1).max(100000) }).strict()
        )
        .min(1)
        .max(200)
    })
    .strict()
])
export const exceptionReasonSchema = z.enum([
  'barcode_unreadable',
  'barcode_missing',
  'wrong_barcode_on_item',
  'damaged_label'
])
export const scanInputSchema = z
  .object({
    barcode: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[0-9A-Za-z._-]+$/),
    quantity: z.number().int().min(1).max(100000).default(1),
    /** Exception mode: SKU typed by hand when the barcode cannot be scanned. */
    exception: z
      .object({ reason: exceptionReasonSchema, note: z.string().trim().min(10).max(500) })
      .strict()
      .optional()
  })
  .strict()
export const closeShortInputSchema = z
  .object({ expectedVersion: version, note: z.string().trim().min(10).max(500) })
  .strict()

// INV-020 -----------------------------------------------------------------
export const rootCauseSchema = z.enum([
  'miscount',
  'receiving_error',
  'picking_error',
  'damage_loss',
  'theft_suspected',
  'supplier_shortage',
  'system_error',
  'unknown'
])
export const createCountPlanInputSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    scheduledFor: instant,
    blind: z.boolean().default(true),
    variantIds: z.array(uuid).min(1).max(200)
  })
  .strict()
export const planTransitionInputSchema = z.object({ expectedVersion: version }).strict()
export const submitCountInputSchema = z
  .object({ variantId: uuid, countedQuantity: qty(10_000_000), expectedLineVersion: version })
  .strict()
export const recountInputSchema = z.object({ variantId: uuid, expectedLineVersion: version, note }).strict()
export const countDecisionInputSchema = z
  .object({
    variantId: uuid,
    expectedLineVersion: version,
    decision: z.enum(['approve', 'reject']),
    rootCause: rootCauseSchema.optional(),
    note
  })
  .strict()
