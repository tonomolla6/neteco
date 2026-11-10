import { z } from 'zod'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from './catalog-publication-policy'
import { inventoryCountProposalInputSchema } from './inventory-commands'

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const version = integer
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const source = z.literal('cloudflare')
const csv = z
  .string()
  .min(1)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 65536)
const reason = inventoryCountProposalInputSchema.out.shape.reason
const reference = inventoryCountProposalInputSchema.out.shape.reference
export const inventoryCountImportPreviewInputSchema = z.object({ csv }).strict()
export const inventoryCountImportProposalInputSchema = z.object({ csv, previewHash: hash, reason, reference }).strict()
export const inventoryCountImportApprovalInputSchema = z.object({ expectedVersion: version.min(1), reason }).strict()
export const inventoryCountImportRowSchema = z
  .object({
    rowNumber: integer.min(2).max(101),
    sku: z.string().max(200),
    countedPhysicalQuantity: integer.nullable(),
    variantId: integer.min(1).nullable(),
    expectedBalanceVersion: version.min(1).nullable(),
    physicalQuantity: integer.nullable(),
    physicalDelta: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
    error: z
      .enum(['unknown_sku', 'ambiguous_sku', 'duplicate_sku', 'invalid_quantity', 'source_unavailable'])
      .nullable()
  })
  .strict()
export const inventoryCountImportPreviewSchema = z
  .object({
    source,
    previewHash: hash,
    canPropose: z.boolean(),
    rows: z.array(inventoryCountImportRowSchema).min(1).max(100)
  })
  .strict()
export const inventoryCountImportReceiptSchema = z
  .object({
    source,
    commandId: catalogPolicyUuidSchema,
    action: z.enum(['propose', 'approve']),
    importId: catalogPolicyUuidSchema,
    expectedVersion: version,
    version: version.min(1),
    payloadHash: hash,
    rowCount: integer.min(1).max(100),
    changedCount: integer.min(1).max(100),
    recordedAt: catalogPolicyInstantSchema,
    inventoryEffect: z.enum(['none', 'physical_adjustment']),
    economicEffect: z.literal('none')
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.changedCount > value.rowCount ||
      value.version !== value.expectedVersion + 1 ||
      (value.action === 'propose'
        ? value.expectedVersion !== 0 || value.inventoryEffect !== 'none'
        : value.expectedVersion !== 1 || value.inventoryEffect !== 'physical_adjustment')
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid correlated receipt' })
  })
const summary = z
  .object({
    source,
    importId: catalogPolicyUuidSchema,
    version: version.min(1).max(2),
    status: z.enum(['proposed', 'approved']),
    proposedBy: catalogPolicyUuidSchema,
    approvedBy: catalogPolicyUuidSchema.nullable(),
    reason,
    reference,
    createdAt: catalogPolicyInstantSchema,
    approvedAt: catalogPolicyInstantSchema.nullable()
  })
  .strict()
export const inventoryCountImportSnapshotSchema = summary
  .extend({
    rows: z
      .array(
        inventoryCountImportRowSchema
          .extend({
            currentBalanceVersion: version.min(1),
            currentPhysicalQuantity: integer,
            stale: z.boolean()
          })
          .strict()
      )
      .min(1)
      .max(100),
    capabilities: z.object({ approve: z.boolean() }).strict()
  })
  .strict()
export const inventoryCountImportListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    perPage: z.coerce.number().int().min(1).max(25).default(25)
  })
  .strict()
export const inventoryCountImportListSchema = z
  .object({
    source,
    page: integer.min(1),
    perPage: integer.min(1).max(25),
    total: integer,
    items: z.array(summary).max(25)
  })
  .strict()
export const inventoryCountImportCommandSchema = z.discriminatedUnion('outcome', [
  z.object({ source, outcome: z.literal('applied'), receipt: inventoryCountImportReceiptSchema }).strict(),
  z.object({ source, outcome: z.literal('unknown'), receipt: z.null() }).strict()
])
export type InventoryCountImportPreview = z.infer<typeof inventoryCountImportPreviewSchema>
export type InventoryCountImportSnapshot = z.infer<typeof inventoryCountImportSnapshotSchema>
export type InventoryCountImportReceipt = z.infer<typeof inventoryCountImportReceiptSchema>
export type InventoryCountImportCommand = z.infer<typeof inventoryCountImportCommandSchema>
export type InventoryCountImportList = z.infer<typeof inventoryCountImportListSchema>

export async function inventoryCountImportIntentHash(
  action: 'propose' | 'approve',
  targetId: string | null,
  input: unknown
) {
  const parsed =
    action === 'propose'
      ? inventoryCountImportProposalInputSchema.parse(input)
      : inventoryCountImportApprovalInputSchema.parse(input)
  if (action === 'propose' ? targetId !== null : !catalogPolicyUuidSchema.safeParse(targetId).success)
    throw new Error('invalid_inventory_count_target')
  const canonical = JSON.stringify({
    action,
    targetId,
    input: Object.fromEntries(Object.entries(parsed).sort(([a], [b]) => a.localeCompare(b)))
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
