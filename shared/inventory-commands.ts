import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema, catalogPolicyInstantSchema } from './catalog-publication-policy'

const ownData = (value: unknown) => {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
const text = (min: number, max: number) =>
  z
    .string()
    .refine((value) => [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127))
    .transform((value) => value.trim())
    .pipe(z.string().min(min).max(max))
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const positive = integer.min(1)
const version = positive.max(Number.MAX_SAFE_INTEGER - 1)
const reason = text(10, 500)
const sourceText = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(
      (value) => value === value.trim() && [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    )
export const inventoryLegacyIdSchema = z
  .string()
  .min(1)
  .max(16)
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => Number.isSafeInteger(Number(value)) && String(Number(value)) === value)
export const inventoryIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .refine((value) => [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127))
export const inventoryCommandActionSchema = z.enum(['receipt', 'count_propose', 'count_approve'])
export type InventoryCommandAction = z.infer<typeof inventoryCommandActionSchema>
export const inventoryReceiptInputSchema = z.preprocess(
  ownData,
  z.object({ expectedBalanceVersion: version, quantity: positive, reason, reference: text(3, 200) }).strict()
)
export const inventoryCountProposalInputSchema = z.preprocess(
  ownData,
  z
    .object({ expectedBalanceVersion: version, countedPhysicalQuantity: integer, reason, reference: text(3, 200) })
    .strict()
)
export const inventoryCountApprovalInputSchema = z.preprocess(
  ownData,
  z.object({ expectedBalanceVersion: version, reason }).strict()
)
export type InventoryReceiptInput = z.infer<typeof inventoryReceiptInputSchema>
export type InventoryCountProposalInput = z.infer<typeof inventoryCountProposalInputSchema>
export type InventoryCountApprovalInput = z.infer<typeof inventoryCountApprovalInputSchema>
export const inventoryCommandReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    action: inventoryCommandActionSchema,
    commandId: catalogPolicyUuidSchema,
    variantId: positive,
    variantUuid: catalogPolicyUuidSchema,
    warehouseId: sourceText(1, 200),
    balanceVersion: positive,
    physicalQuantity: integer,
    physicalDelta: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    proposedPhysicalDelta: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
    proposalId: catalogPolicyUuidSchema.nullable(),
    updated: z.literal(true)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.action === 'count_propose'
        ? value.physicalDelta !== 0 ||
          value.proposedPhysicalDelta === null ||
          value.proposedPhysicalDelta === 0 ||
          value.proposalId === null
        : value.proposedPhysicalDelta !== null ||
          value.physicalDelta === 0 ||
          (value.action === 'receipt'
            ? value.physicalDelta < 1 || value.proposalId !== null
            : value.proposalId === null)
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid inventory effect' })
  })
export type InventoryCommandReceipt = z.infer<typeof inventoryCommandReceiptSchema>

const status = z.enum(['draft', 'review', 'published', 'hidden', 'discontinued'])
const ledgerItem = z
  .object({
    id: sourceText(1, 300),
    type: z.enum([
      'initial',
      'receipt',
      'adjustment',
      'reserve',
      'release',
      'allocate',
      'ship',
      'return',
      'damage',
      'transfer_in',
      'transfer_out'
    ]),
    physicalDelta: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    reservedDelta: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    reason: sourceText(3, 500).nullable(),
    reference: sourceText(1, 200).nullable(),
    actorId: catalogPolicyUuidSchema.nullable(),
    createdAt: catalogPolicyInstantSchema
  })
  .strict()
const proposal = z
  .object({
    id: catalogPolicyUuidSchema,
    proposedBy: catalogPolicyUuidSchema,
    expectedBalanceVersion: positive,
    countedPhysicalQuantity: integer,
    physicalDelta: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    reason,
    reference: text(3, 200),
    createdAt: catalogPolicyInstantSchema,
    approved: z.boolean(),
    stale: z.boolean(),
    canApprove: z.boolean()
  })
  .strict()
export const adminInventoryVariantSchema = z.preprocess(
  ownData,
  z
    .object({
      source: z.literal('cloudflare'),
      capabilities: z
        .object({
          inventoryRead: z.literal(true),
          inventoryReceipt: z.boolean(),
          inventoryCountPropose: z.boolean(),
          inventoryCountApprove: z.boolean()
        })
        .strict(),
      variant: z
        .object({
          id: positive,
          uuid: catalogPolicyUuidSchema,
          productId: positive,
          productUuid: catalogPolicyUuidSchema,
          sku: sourceText(1, 120),
          format: sourceText(1, 160),
          status,
          unitBase: sourceText(1, 32),
          unitLabel: sourceText(1, 160)
        })
        .strict(),
      warehouse: z.object({ id: sourceText(1, 200), code: sourceText(1, 100), name: sourceText(1, 200) }).strict(),
      balance: z
        .object({
          physicalQuantity: integer,
          blockedQuantity: integer,
          safetyStock: integer,
          reservedQuantity: integer,
          sellableQuantity: integer,
          version: positive
        })
        .strict(),
      reconciliation: z
        .object({
          consistent: z.literal(true),
          physicalLedgerQuantity: integer,
          reservedLedgerQuantity: integer,
          movementCount: integer,
          reservationExpiryPending: integer
        })
        .strict(),
      ledger: z
        .object({
          items: z.array(ledgerItem).max(50),
          pagination: z
            .object({ page: positive.max(1_000_000), perPage: positive.max(50), total: integer, pages: integer })
            .strict()
        })
        .strict(),
      counts: z.object({ items: z.array(proposal).max(50), hasMore: z.boolean() }).strict(),
      evaluatedAt: catalogPolicyInstantSchema
    })
    .strict()
)
export type AdminInventoryVariant = z.infer<typeof adminInventoryVariantSchema>
export const inventoryVariantSearchInputSchema = z.preprocess(
  ownData,
  z.object({ q: text(2, 100), page: positive.max(1_000_000), perPage: positive.max(25) }).strict()
)
export const adminInventoryVariantSearchSchema = z.preprocess(
  ownData,
  z
    .object({
      source: z.literal('cloudflare'),
      capabilities: z.object({ inventoryRead: z.literal(true), inventorySearch: z.literal(true) }).strict(),
      items: z
        .array(
          z
            .object({
              id: positive,
              uuid: catalogPolicyUuidSchema,
              sku: sourceText(1, 120),
              name: sourceText(3, 160),
              unitBase: sourceText(1, 32),
              unitLabel: sourceText(1, 160)
            })
            .strict()
        )
        .max(25),
      pagination: z
        .object({ page: positive.max(1_000_000), perPage: positive.max(25), total: integer, pages: integer })
        .strict(),
      evaluatedAt: catalogPolicyInstantSchema
    })
    .strict()
)
export type AdminInventoryVariantSearch = z.infer<typeof adminInventoryVariantSearchSchema>
