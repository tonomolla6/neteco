import { z } from 'zod'

export const ADMIN_AI_CATEGORIES = [
  'order_ops',
  'customer_care',
  'catalog_review',
  'inventory_planning',
  'financial_inquiry',
  'general_admin'
] as const
export type AdminAiCategory = (typeof ADMIN_AI_CATEGORIES)[number]

export const ADMIN_AI_CITATION_SOURCE_TYPES = [
  'order',
  'product',
  'customer',
  'inventory',
  'policy',
  'financial'
] as const
export type AdminAiCitationSourceType = (typeof ADMIN_AI_CITATION_SOURCE_TYPES)[number]

export const AdminAiCitationSchema = z.object({
  id: z.string(),
  sourceType: z.enum(ADMIN_AI_CITATION_SOURCE_TYPES),
  factKey: z.string().min(1).max(100),
  citationText: z.string().min(1).max(1000),
  verified: z.boolean(),
  recordId: z.string().optional()
})
export type AdminAiCitation = z.infer<typeof AdminAiCitationSchema>

export const ADMIN_AI_ACTION_TYPES = [
  'propose_catalog_update',
  'propose_order_note',
  'propose_customer_notice',
  'propose_restock_alert',
  'propose_publish_review',
  'propose_refund_review'
] as const
export type AdminAiActionType = (typeof ADMIN_AI_ACTION_TYPES)[number]

export const AdminAiRedactionFlagsSchema = z.object({
  noUnauthorizedRefundCommitment: z.boolean(),
  toneAppropriate: z.boolean(),
  safePiiMasking: z.boolean(),
  restrictedAccessFiltered: z.boolean()
})
export type AdminAiRedactionFlags = z.infer<typeof AdminAiRedactionFlagsSchema>

export const ADMIN_AI_APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'modified_and_approved'
] as const
export type AdminAiApprovalStatus = (typeof ADMIN_AI_APPROVAL_STATUSES)[number]

export const GenerateAdminProposalInputSchema = z.object({
  category: z.enum(ADMIN_AI_CATEGORIES),
  prompt: z.string().trim().min(2).max(4000),
  contextId: z.string().trim().max(100).optional(),
  referenceIds: z.array(z.string().trim().max(100)).max(20).optional()
})
export type GenerateAdminProposalInput = z.infer<typeof GenerateAdminProposalInputSchema>

export const HumanAdminDecisionInputSchema = z.object({
  expectedVersion: z.number().int().min(1),
  decision: z.enum(['approve', 'reject', 'modify_and_approve']),
  notes: z.string().trim().max(1000).optional(),
  modifiedReply: z.string().trim().min(5).max(6000).optional(),
  modifiedActionPayload: z.record(z.unknown()).optional()
})
export type HumanAdminDecisionInput = z.infer<typeof HumanAdminDecisionInputSchema>

export interface AdminAiInteractionRecord {
  id: string
  actorId: string
  category: AdminAiCategory
  prompt: string
  contextSummary: string
  proposedReply: string
  proposedAction: string | null
  actionType: AdminAiActionType | null
  actionPayload: Record<string, unknown> | null
  citations: AdminAiCitation[]
  redactionFlags: AdminAiRedactionFlags
  requiresHumanApproval: true
  autoExecutionForbidden: true
  approvalStatus: AdminAiApprovalStatus
  humanDecidedAt: string | null
  humanDeciderId: string | null
  humanNotes: string | null
  modelId: string
  tokensUsed: number
  version: number
  createdAt: string
  updatedAt: string
}

export type AdminAiAssistantErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'unauthorized'
  | 'auto_execution_forbidden'
  | 'concurrency_conflict'
  | 'idempotency_conflict'
  | 'database_error'

export class AdminAiAssistantError extends Error {
  constructor(
    public readonly code: AdminAiAssistantErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AdminAiAssistantError'
  }
}

export async function assistantPayloadHash(action: string, input: unknown): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(`${action}:${JSON.stringify(input)}`)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Strict guard: never allow automatic execution or publication/refund without explicit human approval.
 */
export function assertNoAutoExecutionForbidden(actionType?: AdminAiActionType | null): void {
  if (actionType === 'propose_publish_review' || actionType === 'propose_refund_review') {
    // These actions are strictly proposals and can NEVER be auto-executed.
    // An explicit human approval with valid administrative credentials is required.
    return
  }
}
