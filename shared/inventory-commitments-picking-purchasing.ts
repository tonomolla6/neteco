import { z } from 'zod'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from './catalog-publication-policy'

// INV-014 contract commitments, INV-015 picking locations (single warehouse),
// INV-016 purchase orders and receipts. Boundary schemas and shared rules.

const printable = (value: string) => [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
const text = (min: number, max: number) => z.string().trim().min(min).max(max).refine(printable)
const quantity = z.number().int().min(1).max(1_000_000)
const nonNegativeQuantity = z.number().int().min(0).max(1_000_000)
const version = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1)
const reason = text(5, 500)
const uuid = catalogPolicyUuidSchema
const instant = catalogPolicyInstantSchema

/** A contract can reserve stock for at most one year per term. */
export const MAX_COMMITMENT_DAYS = 366
/** Over-delivery up to 10% of the ordered quantity is tolerated and flagged. */
export const OVER_RECEIPT_TOLERANCE_PERCENT = 10
export const COMMITMENT_EXPIRING_SOON_DAYS = 7

export function maxCumulativeReceipt(expectedQuantity: number): number {
  return expectedQuantity + Math.ceil((expectedQuantity * OVER_RECEIPT_TOLERANCE_PERCENT) / 100)
}

export type LineDiscrepancy = 'none' | 'short' | 'over' | 'rejected' | 'pending'
/** Pure rule shared by the worker and the admin UI. */
export function lineDiscrepancy(line: {
  expectedQuantity: number
  receivedQuantity: number
  rejectedQuantity: number
}): LineDiscrepancy {
  if (line.receivedQuantity > line.expectedQuantity) return 'over'
  if (line.rejectedQuantity > 0) return 'rejected'
  if (line.receivedQuantity === 0 && line.rejectedQuantity === 0) return 'pending'
  if (line.receivedQuantity < line.expectedQuantity) return 'short'
  return 'none'
}

// --- INV-014
export const createCommitmentInputSchema = z
  .object({
    variantId: uuid,
    customerId: uuid.optional(),
    contractRef: text(3, 100),
    quantity,
    expiresAt: instant,
    maxRenewals: z.number().int().min(0).max(12).default(0),
    reason
  })
  .strict()
export const renewCommitmentInputSchema = z.object({ expectedVersion: version, expiresAt: instant, reason }).strict()
export const releaseCommitmentInputSchema = z.object({ expectedVersion: version, reason }).strict()

// --- INV-015
export const pickLocationKindSchema = z.enum(['pick', 'bulk', 'receiving', 'quarantine'])
const pickCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,23}$/)
export const createPickLocationInputSchema = z
  .object({
    code: pickCode,
    zone: text(1, 40),
    kind: pickLocationKindSchema.default('pick'),
    pickSequence: z.number().int().min(0).max(100000),
    capacityUnits: z.number().int().min(1).max(10_000_000).optional()
  })
  .strict()
export const updatePickLocationInputSchema = z
  .object({
    expectedVersion: version,
    pickSequence: z.number().int().min(0).max(100000).optional(),
    capacityUnits: z.number().int().min(1).max(10_000_000).nullable().optional(),
    active: z.boolean().optional()
  })
  .strict()
  .refine((v) => v.pickSequence !== undefined || v.capacityUnits !== undefined || v.active !== undefined)
export const putawayInputSchema = z
  .object({
    variantId: uuid,
    pickLocationId: uuid,
    quantity,
    /** Current version of the (bin, variant) stock row; 0 when it does not exist yet. */
    expectedVersion: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1)
  })
  .strict()
export const relocateInputSchema = z
  .object({
    variantId: uuid,
    fromPickLocationId: uuid,
    toPickLocationId: uuid,
    quantity,
    expectedFromVersion: version,
    expectedToVersion: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1)
  })
  .strict()
  .refine((v) => v.fromPickLocationId !== v.toPickLocationId)
export const confirmPickInputSchema = z
  .object({
    variantId: uuid,
    pickLocationId: uuid,
    quantity,
    expectedVersion: version,
    reference: text(3, 200)
  })
  .strict()

// --- INV-016
export const documentKindSchema = z.enum(['delivery_note', 'invoice', 'packing_list', 'quality_certificate', 'other'])
export const purchaseDocumentInputSchema = z
  .object({
    kind: documentKindSchema,
    reference: text(3, 200),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    sizeBytes: z.number().int().min(1).max(52_428_800),
    mediaType: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'text/csv'])
  })
  .strict()
export const createPurchaseOrderInputSchema = z
  .object({
    supplierId: uuid,
    poNumber: text(3, 60),
    expectedAt: instant.optional(),
    notes: text(1, 1000).optional(),
    lines: z
      .array(
        z
          .object({
            variantId: uuid,
            expectedQuantity: quantity,
            unitCostCents: z.number().int().min(0).max(100_000_000)
          })
          .strict()
      )
      .min(1)
      .max(100)
  })
  .strict()
  .refine((v) => new Set(v.lines.map((l) => l.variantId)).size === v.lines.length)
export const submitPurchaseOrderInputSchema = z.object({ expectedVersion: version }).strict()
export const cancelPurchaseOrderInputSchema = z.object({ expectedVersion: version, reason }).strict()
export const closePurchaseOrderInputSchema = z.object({ expectedVersion: version, reason }).strict()
export const recordReceiptInputSchema = z
  .object({
    purchaseOrderId: uuid,
    expectedVersion: version,
    receiptNumber: text(3, 60),
    receivedAt: instant,
    notes: text(1, 1000).optional(),
    lines: z
      .array(
        z
          .object({
            lineIndex: z.number().int().min(0).max(99),
            receivedQuantity: nonNegativeQuantity,
            rejectedQuantity: nonNegativeQuantity.default(0),
            pickLocationId: uuid.optional()
          })
          .strict()
          .refine((l) => l.receivedQuantity + l.rejectedQuantity > 0)
          .refine((l) => l.receivedQuantity > 0 || l.pickLocationId === undefined)
      )
      .min(1)
      .max(100),
    documents: z.array(purchaseDocumentInputSchema).max(10).default([])
  })
  .strict()
  .refine((v) => new Set(v.lines.map((l) => l.lineIndex)).size === v.lines.length)
export const attachDocumentInputSchema = z
  .object({ purchaseOrderId: uuid, receiptId: uuid.optional() })
  .merge(purchaseDocumentInputSchema)
  .strict()

export const inventoryOpsActionSchema = z.enum([
  'create_commitment',
  'renew_commitment',
  'release_commitment',
  'create_pick_location',
  'update_pick_location',
  'putaway',
  'relocate',
  'confirm_pick',
  'create_purchase_order',
  'submit_purchase_order',
  'cancel_purchase_order',
  'close_purchase_order',
  'record_receipt',
  'attach_document'
])
export type InventoryOpsAction = z.infer<typeof inventoryOpsActionSchema>

const schemas = {
  create_commitment: createCommitmentInputSchema,
  renew_commitment: renewCommitmentInputSchema,
  release_commitment: releaseCommitmentInputSchema,
  create_pick_location: createPickLocationInputSchema,
  update_pick_location: updatePickLocationInputSchema,
  putaway: putawayInputSchema,
  relocate: relocateInputSchema,
  confirm_pick: confirmPickInputSchema,
  create_purchase_order: createPurchaseOrderInputSchema,
  submit_purchase_order: submitPurchaseOrderInputSchema,
  cancel_purchase_order: cancelPurchaseOrderInputSchema,
  close_purchase_order: closePurchaseOrderInputSchema,
  record_receipt: recordReceiptInputSchema,
  attach_document: attachDocumentInputSchema
} as const

export function parseInventoryOpsInput(action: InventoryOpsAction, input: unknown): Record<string, unknown> {
  return schemas[action].parse(input) as Record<string, unknown>
}

export const inventoryOpsTargetSchema = uuid

export async function inventoryOpsIntentHash(
  action: InventoryOpsAction,
  targetId: string,
  input: unknown
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify(['inventory-ops:v1', action, targetId, parseInventoryOpsInput(action, input)])
  )
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
}

export const inventoryOpsReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: uuid,
    action: inventoryOpsActionSchema,
    targetId: uuid,
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    resultVersion: z.number().int().min(1),
    data: z.record(z.string(), z.unknown()),
    createdAt: instant
  })
  .strict()
export type InventoryOpsReceipt = z.infer<typeof inventoryOpsReceiptSchema>

export const inventoryOpsErrorCodeSchema = z.enum([
  'unauthenticated',
  'email_unverified',
  'mfa_required',
  'forbidden',
  'csrf_rejected',
  'invalid_input',
  'not_found',
  'method_not_allowed',
  'rate_limited',
  'unavailable',
  'concurrency_conflict',
  'idempotency_payload_mismatch',
  'insufficient_stock',
  'commitment_not_active',
  'commitment_renewals_exhausted',
  'commitment_term_invalid',
  'single_warehouse_required',
  'pick_location_not_found',
  'duplicate_pick_location',
  'pick_location_inactive',
  'pick_location_not_empty',
  'pick_location_capacity_exceeded',
  'pick_stock_exceeds_physical',
  'pick_stock_insufficient',
  'duplicate_po_number',
  'duplicate_receipt_number',
  'duplicate_document',
  'supplier_not_found',
  'variant_not_found',
  'purchase_order_state_invalid',
  'over_receipt_exceeds_tolerance',
  'receipt_line_not_found'
])
export type InventoryOpsErrorCode = z.infer<typeof inventoryOpsErrorCodeSchema>
