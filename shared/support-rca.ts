import { z } from 'zod'

export const INCIDENT_CATEGORIES = ['damage', 'picking_error', 'delay', 'stock_discrepancy', 'documentation'] as const
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number]

export const RCA_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
export type RcaSeverity = (typeof RCA_SEVERITIES)[number]

export const RCA_STATUSES = ['draft', 'investigating', 'action_planned', 'verified', 'closed'] as const
export type RcaStatus = (typeof RCA_STATUSES)[number]

export const VERIFICATION_STATUSES = [
  'unverified',
  'pending_verification',
  'verified_effective',
  'verified_ineffective'
] as const
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number]

export const PREVENTIVE_ACTION_TYPES = [
  'process_change',
  'supplier_claim',
  'training',
  'packaging_update',
  'inventory_audit',
  'documentation_template',
  'tooling'
] as const
export type PreventiveActionType = (typeof PREVENTIVE_ACTION_TYPES)[number]

export const PREVENTIVE_ACTION_STATUSES = ['pending', 'in_progress', 'implemented', 'cancelled'] as const
export type PreventiveActionStatus = (typeof PREVENTIVE_ACTION_STATUSES)[number]

export const PreventiveActionSchema = z.object({
  id: z.string().uuid(),
  actionType: z.enum(PREVENTIVE_ACTION_TYPES),
  description: z.string().min(5).max(500),
  assignee: z.string().min(1).max(120),
  targetDate: z.string().datetime(),
  status: z.enum(PREVENTIVE_ACTION_STATUSES),
  completedAt: z.string().datetime().optional()
})
export type PreventiveAction = z.infer<typeof PreventiveActionSchema>

export const CreateRcaInputSchema = z.object({
  incidentCategory: z.enum(INCIDENT_CATEGORIES),
  title: z.string().trim().min(5).max(200),
  ticketId: z.string().uuid().optional(),
  orderId: z.string().uuid().optional(),
  severity: z.enum(RCA_SEVERITIES),
  rootCauseSummary: z.string().trim().min(5).max(2000),
  fiveWhys: z.array(z.string().min(1).max(300)).min(1).max(10),
  preventiveActions: z.array(PreventiveActionSchema).default([])
})
export type CreateRcaInput = z.infer<typeof CreateRcaInputSchema>

export const UpdateRcaInputSchema = z.object({
  expectedVersion: z.number().int().min(1),
  status: z.enum(RCA_STATUSES).optional(),
  severity: z.enum(RCA_SEVERITIES).optional(),
  rootCauseSummary: z.string().trim().min(5).max(2000).optional(),
  fiveWhys: z.array(z.string().min(1).max(300)).optional(),
  preventiveActions: z.array(PreventiveActionSchema).optional()
})
export type UpdateRcaInput = z.infer<typeof UpdateRcaInputSchema>

export const VerifyRcaInputSchema = z.object({
  expectedVersion: z.number().int().min(1),
  verificationStatus: z.enum(['verified_effective', 'verified_ineffective']),
  verificationNotes: z.string().trim().min(5).max(2000)
})
export type VerifyRcaInput = z.infer<typeof VerifyRcaInputSchema>

export interface SupportRcaRecord {
  id: string
  publicRef: string
  incidentCategory: IncidentCategory
  ticketId: string | null
  orderId: string | null
  title: string
  status: RcaStatus
  severity: RcaSeverity
  rootCauseSummary: string
  fiveWhys: string[]
  preventiveActions: PreventiveAction[]
  verificationStatus: VerificationStatus
  verifiedAt: string | null
  verifiedBy: string | null
  verificationNotes: string | null
  version: number
  createdAt: string
  updatedAt: string
  createdBy: string
}

export type SupportRcaErrorCode =
  'invalid_input' | 'not_found' | 'concurrency_conflict' | 'idempotency_conflict' | 'unauthorized' | 'database_error'

export class SupportRcaError extends Error {
  constructor(
    public readonly code: SupportRcaErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'SupportRcaError'
  }
}

export async function rcaPayloadHash(action: string, input: unknown): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(JSON.stringify({ action, input }))
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
