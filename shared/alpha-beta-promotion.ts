import { z } from 'zod'

export const PROMOTION_STATUSES = ['draft', 'in_review', 'approved', 'promoted', 'rejected'] as const
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number]

export const PROMOTION_SIGNOFF_ROLES = ['business', 'legal', 'release_manager'] as const
export type PromotionSignoffRole = (typeof PROMOTION_SIGNOFF_ROLES)[number]

export class AlphaBetaPromotionError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number = 400,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'AlphaBetaPromotionError'
  }
}

export const checklistSummarySchema = z
  .object({
    sloVerified: z.boolean(),
    alertsConfigured: z.boolean(),
    runbooksPublished: z.boolean(),
    restoreRehearsed: z.boolean(),
    pentestCleared: z.boolean(),
    uatPassed: z.boolean(),
    notes: z.string().max(1000).optional()
  })
  .strict()

export type ChecklistSummary = z.infer<typeof checklistSummarySchema>

export const evidenceBundleSchema = z
  .object({
    releaseVersion: z.string().min(1).max(64),
    targetCommit: z.string().min(7).max(64),
    sloDashboardRef: z.string().min(3).max(256),
    alertsAuditRef: z.string().min(3).max(256),
    runbookIndexRef: z.string().min(3).max(256),
    restoreDrillLogRef: z.string().min(3).max(256),
    pentestReportHash: z.string().length(64),
    uatReportRef: z.string().min(3).max(256),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .strict()

export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>

export const createPromotionSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    releaseVersion: z.string().trim().min(1).max(64),
    p0DefectsCount: z.number().int().min(0),
    p1DefectsCount: z.number().int().min(0),
    checklist: checklistSummarySchema,
    evidenceBundle: evidenceBundleSchema
  })
  .strict()

export type CreatePromotionInput = z.infer<typeof createPromotionSchema>

export const updateChecklistSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    promotionId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    p0DefectsCount: z.number().int().min(0),
    p1DefectsCount: z.number().int().min(0),
    checklist: checklistSummarySchema,
    evidenceBundle: evidenceBundleSchema.optional()
  })
  .strict()

export type UpdateChecklistInput = z.infer<typeof updateChecklistSchema>

export const submitSignoffSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    promotionId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    role: z.enum(PROMOTION_SIGNOFF_ROLES),
    statement: z.string().trim().min(5).max(1000)
  })
  .strict()

export type SubmitSignoffInput = z.infer<typeof submitSignoffSchema>

export const promoteReleaseSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    promotionId: z.string().uuid(),
    expectedVersion: z.number().int().min(1)
  })
  .strict()

export type PromoteReleaseInput = z.infer<typeof promoteReleaseSchema>

export const rejectPromotionSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    promotionId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    reason: z.string().trim().min(5).max(500)
  })
  .strict()

export type RejectPromotionInput = z.infer<typeof rejectPromotionSchema>

export interface PromotionSignoffRecord {
  id: string
  promotionId: string
  role: PromotionSignoffRole
  actorId: string
  signatureHash: string
  statement: string
  signedAt: string
}

export interface AlphaBetaPromotionRecord {
  id: string
  releaseVersion: string
  targetPhase: 'Beta'
  status: PromotionStatus
  checklistSummary: ChecklistSummary
  p0DefectsCount: number
  p1DefectsCount: number
  evidenceBundle: EvidenceBundle
  evidenceHash: string
  promotedAt: string | null
  rejectionReason: string | null
  version: number
  createdAt: string
  updatedAt: string
  createdBy: string
  signoffs?: PromotionSignoffRecord[]
}
