import { z } from 'zod'

export const draftOrderStatusSchema = z.enum([
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'expired',
  'converted',
  'cancelled'
])
export type DraftOrderStatus = z.infer<typeof draftOrderStatusSchema>

export const draftTimelineEventTypeSchema = z.enum([
  'created',
  'submitted_for_approval',
  'under_review',
  'approved',
  'rejected',
  'expired',
  'converted',
  'cancelled',
  'note_added'
])
export type DraftTimelineEventType = z.infer<typeof draftTimelineEventTypeSchema>

export const draftOrderItemSchema = z
  .object({
    variantId: z.string().min(1),
    sku: z.string().min(1).max(50),
    name: z.string().min(1).max(200),
    quantity: z.number().int().min(1).max(10000),
    unitPriceCents: z.number().int().min(0),
    lineTotalCents: z.number().int().min(0)
  })
  .refine((item) => item.lineTotalCents === item.quantity * item.unitPriceCents, {
    message: 'line_total_mismatch',
    path: ['lineTotalCents']
  })
export type DraftOrderItem = z.infer<typeof draftOrderItemSchema>

export const draftOrderTimelineEventSchema = z.object({
  id: z.string().uuid(),
  draftOrderId: z.string().uuid(),
  eventType: draftTimelineEventTypeSchema,
  fromStatus: draftOrderStatusSchema.nullable().optional(),
  toStatus: draftOrderStatusSchema,
  actorType: z.enum(['customer', 'approver', 'system']),
  actorId: z.string().min(1),
  notes: z.string().nullable().optional(),
  createdAt: z.string()
})
export type DraftOrderTimelineEvent = z.infer<typeof draftOrderTimelineEventSchema>

export const draftOrderSchema = z.object({
  id: z.string().uuid(),
  draftNumber: z.string().min(3).max(50),
  customerId: z.string().min(1),
  companyName: z.string().min(2).max(160),
  contactEmail: z.string().email(),
  status: draftOrderStatusSchema,
  totalCents: z.number().int().min(0),
  subtotalCents: z.number().int().min(0),
  taxCents: z.number().int().min(0),
  shippingCents: z.number().int().min(0),
  currency: z.enum(['EUR', 'USD', 'GBP']).default('EUR'),
  items: z.array(draftOrderItemSchema).min(1),
  inventoryReserved: z.number().int().min(0).max(1),
  paymentStatus: z.enum(['unbilled', 'preauthorized', 'captured', 'voided']),
  expiresAt: z.string(),
  approvalRequestedAt: z.string().nullable().optional(),
  approvedAt: z.string().nullable().optional(),
  approvedBy: z.string().nullable().optional(),
  rejectionReason: z.string().nullable().optional(),
  convertedOrderId: z.string().nullable().optional(),
  version: z.number().int().min(1),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
  timeline: z.array(draftOrderTimelineEventSchema).optional()
})
export type DraftOrder = z.infer<typeof draftOrderSchema>

export const createDraftOrderInputSchema = z.object({
  customerId: z.string().min(1),
  companyName: z.string().min(2).max(160),
  contactEmail: z.string().email(),
  items: z.array(draftOrderItemSchema).min(1),
  shippingCents: z.number().int().min(0).default(0),
  taxRatePercent: z.number().min(0).max(100).default(21),
  expiresInHours: z.number().int().min(1).max(720).default(48) // default 48h expiration
})
export type CreateDraftOrderInput = z.infer<typeof createDraftOrderInputSchema>

export const reviewDraftOrderInputSchema = z.object({
  draftOrderId: z.string().uuid(),
  decision: z.enum(['approved', 'rejected']),
  notes: z.string().max(500).optional(),
  expectedVersion: z.number().int().min(1)
})
export type ReviewDraftOrderInput = z.infer<typeof reviewDraftOrderInputSchema>

/**
 * Validates that an active draft order has not expired and satisfies
 * the non-indefinite reservation/payment rule.
 */
export function assertDraftOrderCanBeApprovedOrConverted(draft: DraftOrder, nowIso: string): void {
  if (draft.expiresAt <= nowIso) {
    throw new Error('draft_order_expired')
  }
  if (['rejected', 'expired', 'converted', 'cancelled'].includes(draft.status)) {
    throw new Error(`cannot_operate_on_draft_with_status_${draft.status}`)
  }
}
