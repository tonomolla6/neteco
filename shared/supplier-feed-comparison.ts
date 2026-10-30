import { z } from 'zod'

export const feedDiffTypeSchema = z.enum(['alta', 'cambio', 'baja'])
export type FeedDiffType = z.infer<typeof feedDiffTypeSchema>

export const feedReviewStatusSchema = z.enum(['pending_review', 'approved', 'rejected', 'applied'])
export type FeedReviewStatus = z.infer<typeof feedReviewStatusSchema>

export const supplierFeedItemRawSchema = z.object({
  supplierSku: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  barcode: z.string().max(50).nullable().optional(),
  priceCents: z.number().int().min(0),
  stockQuantity: z.number().int().min(0).optional(),
  leadTimeDays: z.number().int().min(0).optional(),
  categoryName: z.string().max(100).optional(),
  description: z.string().max(5000).optional(),
  discontinued: z.boolean().optional()
})
export type SupplierFeedItemRaw = z.infer<typeof supplierFeedItemRawSchema>

export const supplierFeedReviewItemSchema = z.object({
  id: z.string().uuid(),
  importId: z.string().uuid(),
  supplierId: z.string().min(2).max(64),
  supplierSku: z.string().min(1).max(100),
  diffType: feedDiffTypeSchema,
  productId: z.string().nullable().optional(),
  variantId: z.string().nullable().optional(),
  status: feedReviewStatusSchema,
  isPublished: z.number().int().min(0).max(1),
  beforePayload: z.record(z.unknown()).nullable().optional(),
  afterPayload: z.record(z.unknown()).nullable().optional(),
  diffDetails: z.record(z.unknown()),
  reviewDecisionBy: z.string().nullable().optional(),
  reviewDecisionAt: z.string().nullable().optional(),
  reviewNotes: z.string().nullable().optional(),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type SupplierFeedReviewItem = z.infer<typeof supplierFeedReviewItemSchema>

export const stageSupplierFeedInputSchema = z.object({
  supplierId: z.string().min(2).max(64),
  feedName: z.string().min(2).max(160),
  items: z.array(supplierFeedItemRawSchema).min(1).max(5000)
})
export type StageSupplierFeedInput = z.infer<typeof stageSupplierFeedInputSchema>

export const reviewFeedItemInputSchema = z.object({
  itemId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  decision: z.enum(['approved', 'rejected']),
  reviewNotes: z.string().max(500).optional()
})
export type ReviewFeedItemInput = z.infer<typeof reviewFeedItemInputSchema>

export const applyApprovedFeedItemsInputSchema = z.object({
  importId: z.string().uuid(),
  itemIds: z.array(z.string().uuid()).min(1)
})
export type ApplyApprovedFeedItemsInput = z.infer<typeof applyApprovedFeedItemsInputSchema>

export interface ExistingSupplierItem {
  supplierSku: string
  productId?: string | null
  variantId?: string | null
  name: string
  priceCents: number
  stockQuantity?: number
  leadTimeDays?: number
  isDiscontinued?: boolean
}

export interface ComputedFeedDiffResult {
  altas: Array<{
    supplierSku: string
    afterPayload: SupplierFeedItemRaw
    diffDetails: { reason: 'new_item_in_feed'; fields: string[] }
  }>
  cambios: Array<{
    supplierSku: string
    productId?: string | null
    variantId?: string | null
    beforePayload: ExistingSupplierItem
    afterPayload: SupplierFeedItemRaw
    diffDetails: {
      reason: 'fields_changed'
      changedFields: Array<{ field: string; before: unknown; after: unknown }>
    }
  }>
  bajas: Array<{
    supplierSku: string
    productId?: string | null
    variantId?: string | null
    beforePayload: ExistingSupplierItem
    diffDetails: {
      reason: 'missing_from_feed_or_discontinued'
    }
  }>
}

/**
 * Pure diff engine for supplier catalog feeds.
 * Categorizes feed records strictly into:
 * - 'alta': newly seen SKU
 * - 'cambio': existing SKU with modified pricing, lead time, stock or description
 * - 'baja': SKU previously active but omitted or explicitly marked discontinued
 *
 * ALL computed items require manual or rule-based review before publication.
 */
export function computeSupplierFeedDiff(
  existingItems: ExistingSupplierItem[],
  incomingItems: SupplierFeedItemRaw[]
): ComputedFeedDiffResult {
  const existingMap = new Map<string, ExistingSupplierItem>()
  for (const existing of existingItems) {
    existingMap.set(existing.supplierSku, existing)
  }

  const incomingMap = new Map<string, SupplierFeedItemRaw>()
  for (const incoming of incomingItems) {
    incomingMap.set(incoming.supplierSku, incoming)
  }

  const altas: ComputedFeedDiffResult['altas'] = []
  const cambios: ComputedFeedDiffResult['cambios'] = []
  const bajas: ComputedFeedDiffResult['bajas'] = []

  // Check incoming items
  for (const incoming of incomingItems) {
    const existing = existingMap.get(incoming.supplierSku)
    if (!existing) {
      // New item -> Alta
      altas.push({
        supplierSku: incoming.supplierSku,
        afterPayload: incoming,
        diffDetails: {
          reason: 'new_item_in_feed',
          fields: ['name', 'priceCents', 'supplierSku']
        }
      })
    } else if (incoming.discontinued) {
      // Marked discontinued -> Baja
      bajas.push({
        supplierSku: incoming.supplierSku,
        productId: existing.productId,
        variantId: existing.variantId,
        beforePayload: existing,
        diffDetails: {
          reason: 'missing_from_feed_or_discontinued'
        }
      })
    } else {
      // Compare fields
      const changedFields: Array<{ field: string; before: unknown; after: unknown }> = []
      if (existing.priceCents !== incoming.priceCents) {
        changedFields.push({
          field: 'priceCents',
          before: existing.priceCents,
          after: incoming.priceCents
        })
      }
      if (
        incoming.leadTimeDays !== undefined &&
        existing.leadTimeDays !== undefined &&
        existing.leadTimeDays !== incoming.leadTimeDays
      ) {
        changedFields.push({
          field: 'leadTimeDays',
          before: existing.leadTimeDays,
          after: incoming.leadTimeDays
        })
      }
      if (
        incoming.stockQuantity !== undefined &&
        existing.stockQuantity !== undefined &&
        existing.stockQuantity !== incoming.stockQuantity
      ) {
        changedFields.push({
          field: 'stockQuantity',
          before: existing.stockQuantity,
          after: incoming.stockQuantity
        })
      }
      if (existing.name !== incoming.name) {
        changedFields.push({
          field: 'name',
          before: existing.name,
          after: incoming.name
        })
      }

      if (changedFields.length > 0) {
        cambios.push({
          supplierSku: incoming.supplierSku,
          productId: existing.productId,
          variantId: existing.variantId,
          beforePayload: existing,
          afterPayload: incoming,
          diffDetails: {
            reason: 'fields_changed',
            changedFields
          }
        })
      }
    }
  }

  // Check missing items -> Bajas
  for (const existing of existingItems) {
    if (!incomingMap.has(existing.supplierSku) && !existing.isDiscontinued) {
      bajas.push({
        supplierSku: existing.supplierSku,
        productId: existing.productId,
        variantId: existing.variantId,
        beforePayload: existing,
        diffDetails: {
          reason: 'missing_from_feed_or_discontinued'
        }
      })
    }
  }

  return { altas, cambios, bajas }
}

/**
 * Publication guardrail: enforces acceptance criterion:
 * "Altas/cambios/bajas quedan en revisión; nunca se publican silenciosamente."
 */
export function assertCanPublishFeedItem(item: { status: string; isPublished: number }): void {
  if (item.status !== 'approved') {
    throw new Error('unreviewed_feed_item_cannot_publish')
  }
}
