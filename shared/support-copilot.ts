import { z } from 'zod'

export const CITATION_SOURCE_TYPES = [
  'order',
  'shipment',
  'tracking',
  'inventory',
  'policy',
  'ticket_history',
  'customer_profile'
] as const
export type CitationSourceType = (typeof CITATION_SOURCE_TYPES)[number]

export const CopilotCitationSchema = z.object({
  id: z.string(),
  sourceType: z.enum(CITATION_SOURCE_TYPES),
  factKey: z.string(),
  citationText: z.string(),
  verified: z.boolean()
})
export type CopilotCitation = z.infer<typeof CopilotCitationSchema>

export const RedactionFlagsSchema = z.object({
  noUnauthorizedRefundCommitment: z.boolean(),
  toneAppropriate: z.boolean(),
  safePiiMasking: z.boolean()
})
export type RedactionFlags = z.infer<typeof RedactionFlagsSchema>

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'modified_and_approved'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export const ACCURACY_EVALUATIONS = ['accurate', 'partially_accurate', 'inaccurate', 'hallucinated_data'] as const
export type AccuracyEvaluation = (typeof ACCURACY_EVALUATIONS)[number]

export const GenerateDraftInputSchema = z.object({
  ticketId: z.string().uuid(),
  query: z.string().trim().max(1000).optional()
})
export type GenerateDraftInput = z.infer<typeof GenerateDraftInputSchema>

export const HumanApprovalInputSchema = z.object({
  expectedVersion: z.number().int().min(1),
  decision: z.enum(['approve', 'reject', 'modify_and_approve']),
  modifiedReply: z.string().trim().min(5).max(4000).optional(),
  rejectionReason: z.string().trim().max(1000).optional()
})
export type HumanApprovalInput = z.infer<typeof HumanApprovalInputSchema>

export const EvaluateAccuracyInputSchema = z.object({
  score: z.number().int().min(1).max(5),
  evaluation: z.enum(ACCURACY_EVALUATIONS),
  notes: z.string().trim().max(1000).optional()
})
export type EvaluateAccuracyInput = z.infer<typeof EvaluateAccuracyInputSchema>

export interface CopilotInteractionRecord {
  id: string
  ticketId: string
  operatorId: string
  contextSummary: string
  proposedReply: string
  citations: CopilotCitation[]
  redactionFlags: RedactionFlags
  approvalStatus: ApprovalStatus
  humanApprovedAt: string | null
  humanApproverId: string | null
  finalSentReply: string | null
  accuracyEvaluation: AccuracyEvaluation | null
  accuracyScore: number | null
  accuracyNotes: string | null
  evaluatedAt: string | null
  evaluatedBy: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type SupportCopilotErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'ticket_not_found'
  | 'concurrency_conflict'
  | 'idempotency_conflict'
  | 'unauthorized'
  | 'redaction_failure'
  | 'database_error'

export class SupportCopilotError extends Error {
  constructor(
    public readonly code: SupportCopilotErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'SupportCopilotError'
  }
}

export async function copilotPayloadHash(action: string, input: unknown): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(JSON.stringify({ action, input }))
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
