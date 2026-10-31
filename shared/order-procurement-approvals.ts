import { z } from 'zod'

export const PROCUREMENT_APPROVAL_STATUSES = ['not_required', 'pending_approval', 'approved', 'rejected'] as const

export type ProcurementApprovalStatus = (typeof PROCUREMENT_APPROVAL_STATUSES)[number]

export function normalizePoReference(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error('purchaseOrderReference must be single-line text')
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 31 || (code >= 127 && code <= 159) || code === 8232 || code === 8233) {
      throw new Error('purchaseOrderReference contains forbidden control characters')
    }
  }
  const normalized = value.trim().normalize('NFC')
  if (normalized.length > 120) throw new Error('purchaseOrderReference exceeds 120 characters')
  return normalized || null
}

export function normalizeCostCenter(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error('costCenter must be text')
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 31 || (code >= 127 && code <= 159) || code === 8232 || code === 8233) {
      throw new Error('costCenter contains forbidden control characters')
    }
  }
  const normalized = value.trim().normalize('NFC')
  if (normalized.length > 80) throw new Error('costCenter exceeds 80 characters')
  return normalized || null
}

export const orderProcurementAssignSchema = z
  .object({
    orderId: z.string().uuid(),
    purchaseOrderReference: z.string().max(120).optional().nullable(),
    costCenter: z.string().max(80).optional().nullable(),
    approvalThresholdCents: z.number().int().min(0).optional().nullable()
  })
  .strict()

export type OrderProcurementAssignInput = z.infer<typeof orderProcurementAssignSchema>

export const orderProcurementReviewSchema = z
  .object({
    orderId: z.string().uuid(),
    action: z.enum(['approve', 'reject']),
    expectedVersion: z.number().int().min(1),
    rejectionReason: z.string().min(1).max(500).optional(),
    notes: z.string().max(1000).optional()
  })
  .strict()

export type OrderProcurementReviewInput = z.infer<typeof orderProcurementReviewSchema>

export interface OrderProcurementEvent {
  id: string
  orderId: string
  eventType:
    'submitted' | 'approval_requested' | 'approved' | 'rejected' | 'cost_center_assigned' | 'po_reference_assigned'
  actorId: string
  actorType: 'customer' | 'admin' | 'system'
  notes: string | null
  createdAt: string
}

export interface OrderProcurementDetails {
  orderId: string
  purchaseOrderReference: string | null
  costCenter: string | null
  approvalStatus: ProcurementApprovalStatus
  requiresApproval: boolean
  approvalThresholdCents: number | null
  approvedBy: string | null
  approvedAt: string | null
  rejectedBy: string | null
  rejectedAt: string | null
  rejectionReason: string | null
  approvalNotes: string | null
  version: number
  createdAt: string
  updatedAt: string
  events: OrderProcurementEvent[]
}

export interface OrderInvoiceProcurementView {
  orderId: string
  invoiceId: string | null
  purchaseOrderReference: string | null
  costCenter: string | null
  visibleOnInvoice: boolean
  exportedAt: string | null
  createdAt: string
}
