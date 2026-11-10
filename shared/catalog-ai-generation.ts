import { z } from 'zod'

export const CATALOG_AI_SCOPES = ['description', 'attributes', 'full_editorial'] as const
export type CatalogAiScope = (typeof CATALOG_AI_SCOPES)[number]

export const SOURCE_TYPES = ['fds', 'sds', 'tech_sheet', 'specs'] as const
export type CatalogSourceType = (typeof SOURCE_TYPES)[number]

export const CatalogTechnicalSourceSchema = z.object({
  id: z.string().min(1).max(50),
  title: z.string().trim().min(2).max(200),
  type: z.enum(SOURCE_TYPES),
  url: z.string().trim().url().optional(),
  sdsNumber: z.string().trim().max(100).optional(),
  verifiedClaims: z.array(z.string().trim().min(2).max(200)).min(1, 'Array must contain at least 1 element(s)'),
  textSnippet: z.string().trim().min(5).max(4000)
})
export type CatalogTechnicalSource = z.infer<typeof CatalogTechnicalSourceSchema>

export const VerifiableClaimItemSchema = z.object({
  claimText: z.string().min(2).max(300),
  sourceRef: z.string().min(1).max(100),
  verified: z.boolean(),
  hazardClpCompliant: z.boolean(),
  category: z.enum(['eco', 'efficacy', 'safety', 'technical', 'regulatory'])
})
export type VerifiableClaimItem = z.infer<typeof VerifiableClaimItemSchema>

export const DUPLICATE_RISKS = ['none', 'low', 'medium', 'high'] as const
export type DuplicateRisk = (typeof DUPLICATE_RISKS)[number]

export const MatchedDuplicateProductSchema = z.object({
  productId: z.string(),
  name: z.string(),
  similarityScore: z.number().min(0).max(1)
})
export type MatchedDuplicateProduct = z.infer<typeof MatchedDuplicateProductSchema>

export const DuplicateCheckResultSchema = z.object({
  maxSimilarityScore: z.number().min(0).max(1),
  duplicateRisk: z.enum(DUPLICATE_RISKS),
  matchedProducts: z.array(MatchedDuplicateProductSchema)
})
export type DuplicateCheckResult = z.infer<typeof DuplicateCheckResultSchema>

export const CATALOG_AI_APPROVAL_STATUSES = ['pending_review', 'approved', 'rejected', 'modified_and_approved'] as const
export type CatalogAiApprovalStatus = (typeof CATALOG_AI_APPROVAL_STATUSES)[number]

export const GenerateCatalogContentInputSchema = z.object({
  productId: z.string().optional(),
  productName: z.string().trim().min(2).max(200),
  targetScope: z.enum(CATALOG_AI_SCOPES),
  prompt: z.string().trim().min(2).max(4000),
  sources: z.array(CatalogTechnicalSourceSchema).min(1).max(10),
  baseCategory: z.string().trim().max(100).optional()
})
export type GenerateCatalogContentInput = z.infer<typeof GenerateCatalogContentInputSchema>

export const ReviewCatalogGenerationInputSchema = z.object({
  expectedVersion: z.number().int().min(1),
  decision: z.enum(['approve', 'reject', 'modify_and_approve']),
  reviewNotes: z.string().trim().max(1000).optional(),
  modifiedContent: z
    .object({
      shortDescription: z.string().trim().max(1000).optional(),
      description: z.string().trim().max(10000).optional(),
      usage: z.string().trim().max(10000).optional(),
      attributes: z.record(z.string(), z.unknown()).optional()
    })
    .optional()
})
export type ReviewCatalogGenerationInput = z.infer<typeof ReviewCatalogGenerationInputSchema>

export const ApplyCatalogGenerationInputSchema = z.object({
  expectedVersion: z.number().int().min(1),
  targetProductId: z.string().min(1)
})
export type ApplyCatalogGenerationInput = z.infer<typeof ApplyCatalogGenerationInputSchema>

export interface CatalogAiGenerationRecord {
  id: string
  productId: string | null
  targetScope: CatalogAiScope
  actorId: string
  sources: CatalogTechnicalSource[]
  prompt: string
  generatedTitle: string | null
  generatedShortDescription: string | null
  generatedDescription: string | null
  generatedUsage: string | null
  generatedAttributes: Record<string, unknown> | null
  verifiableClaims: VerifiableClaimItem[]
  duplicateCheck: DuplicateCheckResult
  isAiGenerated: true
  aiModelName: string
  approvalStatus: CatalogAiApprovalStatus
  humanReviewedAt: string | null
  humanReviewerId: string | null
  appliedContent: Record<string, unknown> | null
  reviewNotes: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type CatalogAiGenerationErrorCode =
  | 'invalid_input'
  | 'unverified_claims'
  | 'high_duplicate_risk'
  | 'not_found'
  | 'unauthorized'
  | 'not_approved'
  | 'concurrency_conflict'
  | 'idempotency_conflict'
  | 'database_error'

export class CatalogAiGenerationError extends Error {
  constructor(
    public readonly code: CatalogAiGenerationErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CatalogAiGenerationError'
  }
}

export async function catalogAiPayloadHash(action: string, input: unknown): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(`${action}:${JSON.stringify(input)}`)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Deterministic text similarity detector using word and bigram Jaccard coefficient.
 */
export function computeTextSimilarity(textA: string, textB: string): number {
  if (!textA || !textB) return 0
  const normA = textA
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
  const normB = textB
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
  if (normA === normB) return 1.0

  const wordsA = normA.split(/\s+/).filter((w) => w.length > 2)
  const wordsB = normB.split(/\s+/).filter((w) => w.length > 2)
  if (wordsA.length === 0 || wordsB.length === 0) return 0

  const tokensA = new Set<string>(wordsA)
  const tokensB = new Set<string>(wordsB)

  // Add bigrams
  for (let i = 0; i < wordsA.length - 1; i++) {
    tokensA.add(`${wordsA[i]}_${wordsA[i + 1]}`)
  }
  for (let i = 0; i < wordsB.length - 1; i++) {
    tokensB.add(`${wordsB[i]}_${wordsB[i + 1]}`)
  }

  let intersectionCount = 0
  for (const t of tokensA) {
    if (tokensB.has(t)) {
      intersectionCount++
    }
  }

  const unionCount = tokensA.size + tokensB.size - intersectionCount
  if (unionCount === 0) return 0
  const score = intersectionCount / unionCount
  return Math.round(score * 100) / 100
}
