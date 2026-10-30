import { z } from 'zod'

export const metricEntrySchema = z
  .object({
    metric: z.string().trim().min(2).max(150),
    value: z.union([z.number(), z.string().trim().min(1).max(50)]).optional(),
    before: z.union([z.number(), z.string().trim().min(1).max(50)]).optional(),
    after: z.union([z.number(), z.string().trim().min(1).max(50)]).optional(),
    unit: z.string().trim().min(1).max(50),
    improvementPercent: z.number().optional(),
    verifiedBy: z.string().trim().max(150).optional()
  })
  .strict()

export type MetricEntry = z.infer<typeof metricEntrySchema>

export const signedPermissionSchema = z
  .object({
    signerName: z.string().trim().min(2).max(120),
    signerRole: z.string().trim().min(2).max(120),
    companyName: z.string().trim().min(2).max(150),
    companyCif: z
      .string()
      .trim()
      .min(5)
      .max(20)
      .regex(/^[A-Z0-9-]{5,20}$/i),
    documentRef: z.string().trim().min(3).max(100),
    documentSha256: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/i),
    signedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    scope: z.string().trim().min(3).max(100),
    publishAuthorized: z.boolean()
  })
  .strict()

export type SignedPermission = z.infer<typeof signedPermissionSchema>

export const contextDataSchema = z
  .object({
    sector: z.string().trim().min(2).max(100),
    facilityDescription: z.string().trim().min(5).max(1000),
    initialSituation: z.string().trim().min(10).max(2000),
    baselineMetrics: z.array(metricEntrySchema).default([])
  })
  .strict()

export type ContextData = z.infer<typeof contextDataSchema>

export const solutionDataSchema = z
  .object({
    netecoProducts: z.array(z.string().trim().min(2).max(100)).min(1),
    dosageProtocol: z.string().trim().min(5).max(2000),
    implementationDurationWeeks: z.number().int().positive().max(104),
    solutionSummary: z.string().trim().min(10).max(3000)
  })
  .strict()

export type SolutionData = z.infer<typeof solutionDataSchema>

export const verifiableOutcomeSchema = z
  .object({
    outcomeMetrics: z.array(metricEntrySchema).min(1),
    verificationMethod: z.string().trim().min(5).max(1000),
    verifierIdentity: z.string().trim().min(2).max(150),
    certificateRef: z.string().trim().max(100).optional(),
    evidenceSha256: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/i)
  })
  .strict()

export type VerifiableOutcome = z.infer<typeof verifiableOutcomeSchema>

export const reviewIntervals = [3, 6, 12, 24] as const
export type ReviewInterval = (typeof reviewIntervals)[number]

export const createCaseStudySchema = z
  .object({
    title: z.string().trim().min(5).max(200),
    subtitle: z.string().trim().max(300).optional(),
    slug: z
      .string()
      .trim()
      .min(3)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    signedPermission: signedPermissionSchema,
    context: contextDataSchema,
    solution: solutionDataSchema,
    verifiableOutcome: verifiableOutcomeSchema,
    reviewIntervalMonths: z.union([z.literal(3), z.literal(6), z.literal(12), z.literal(24)]).default(12),
    coverImageUrl: z.string().trim().url().max(500).optional(),
    commandId: z.string().trim().min(1).max(64)
  })
  .strict()

export type CreateCaseStudyInput = z.infer<typeof createCaseStudySchema>

export const updateCaseStudySchema = z
  .object({
    caseId: z.string().trim().min(1).max(64),
    title: z.string().trim().min(5).max(200).optional(),
    subtitle: z.string().trim().max(300).optional(),
    signedPermission: signedPermissionSchema.optional(),
    context: contextDataSchema.optional(),
    solution: solutionDataSchema.optional(),
    verifiableOutcome: verifiableOutcomeSchema.optional(),
    reviewIntervalMonths: z.literal(3).or(z.literal(6)).or(z.literal(12)).or(z.literal(24)).optional(),
    coverImageUrl: z.string().trim().url().max(500).optional(),
    expectedVersion: z.number().int().nonnegative(),
    commandId: z.string().trim().min(1).max(64)
  })
  .strict()

export type UpdateCaseStudyInput = z.infer<typeof updateCaseStudySchema>

export const publishCaseStudySchema = z
  .object({
    caseId: z.string().trim().min(1).max(64),
    expectedVersion: z.number().int().nonnegative(),
    commandId: z.string().trim().min(1).max(64)
  })
  .strict()

export type PublishCaseStudyInput = z.infer<typeof publishCaseStudySchema>

export const performPeriodicReviewSchema = z
  .object({
    caseId: z.string().trim().min(1).max(64),
    reviewNotes: z.string().trim().min(5).max(1000),
    confirmedPermissionValid: z.literal(true),
    nextReviewIntervalMonths: z.literal(3).or(z.literal(6)).or(z.literal(12)).or(z.literal(24)),
    expectedVersion: z.number().int().nonnegative(),
    commandId: z.string().trim().min(1).max(64)
  })
  .strict()

export type PerformPeriodicReviewInput = z.infer<typeof performPeriodicReviewSchema>

export function calculateNextReviewDate(fromDateIso: string, intervalMonths: ReviewInterval): string {
  const d = new Date(fromDateIso)
  d.setUTCMonth(d.getUTCMonth() + intervalMonths)
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export type ReviewGovernanceStatus = 'current' | 'due_soon' | 'overdue' | 'retired'

export function computeReviewGovernanceStatus(params: {
  nextReviewDueAt: string
  now?: string
}): ReviewGovernanceStatus {
  const nowMs = params.now ? new Date(params.now).getTime() : Date.now()
  const dueMs = new Date(params.nextReviewDueAt).getTime()

  if (nowMs > dueMs) {
    return 'overdue'
  }

  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
  if (dueMs - nowMs <= thirtyDaysMs) {
    return 'due_soon'
  }

  return 'current'
}

export interface PublishReadinessResult {
  canPublish: boolean
  blockers: string[]
}

export function evaluatePublishReadiness(params: {
  publishAuthorizedByCustomer: boolean
  outcomeMetricsCount: number
  reviewStatus: ReviewGovernanceStatus
  signedDocumentSha256?: string
}): PublishReadinessResult {
  const blockers: string[] = []

  if (!params.publishAuthorizedByCustomer) {
    blockers.push('customer_authorization_required')
  }

  if (params.outcomeMetricsCount <= 0) {
    blockers.push('verifiable_outcomes_required')
  }

  if (params.reviewStatus === 'overdue') {
    blockers.push('review_overdue')
  }

  if (!params.signedDocumentSha256 || !/^[0-9a-f]{64}$/i.test(params.signedDocumentSha256)) {
    blockers.push('invalid_signed_permission_document')
  }

  return {
    canPublish: blockers.length === 0,
    blockers
  }
}

export function validateStrictNoCommunityPayload(payload: unknown): {
  isClean: boolean
  violations: string[]
} {
  const violations: string[] = []
  if (!payload || typeof payload !== 'object') {
    return { isClean: true, violations }
  }

  const keys = Object.keys(payload as object)
  for (const key of keys) {
    const lowerKey = key.toLowerCase().replace(/[^a-z]/g, '')
    if (lowerKey.includes('comment')) {
      violations.push('community_comments_forbidden')
    }
    if (lowerKey.includes('social') || lowerKey.includes('follower') || lowerKey.includes('profile')) {
      violations.push('social_profiles_forbidden')
    }
  }

  return {
    isClean: violations.length === 0,
    violations
  }
}

export async function evaluateCaseStudyPayloadHash(data: unknown): Promise<string> {
  const serialized = JSON.stringify(data, Object.keys(data as object).sort())
  const encoder = new TextEncoder()
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(serialized))
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface PublicCaseStudy {
  id: string
  slug: string
  title: string
  subtitle: string | null
  coverImageUrl: string | null
  sector: string
  facilityDescription: string
  initialSituation: string
  netecoProducts: string[]
  dosageProtocol: string
  implementationDurationWeeks: number
  solutionSummary: string
  outcomeMetrics: MetricEntry[]
  verificationMethod: string
  verifierIdentity: string
  certificateRef: string | null
  permissionCompanyName: string
  customerAuthorizationStatement: string
  reviewValidUntil: string
  publishedAt: string
}
