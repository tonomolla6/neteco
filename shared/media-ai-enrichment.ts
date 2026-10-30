import { z } from 'zod'

export const MEDIA_AI_ENRICHMENT_TYPES = [
  'remove_background',
  'propose_crops',
  'propose_metadata',
  'full_visual_enrichment'
] as const
export type MediaAiEnrichmentType = (typeof MEDIA_AI_ENRICHMENT_TYPES)[number]

export const CROP_RATIOS = ['1:1', '4:3', '16:9'] as const
export type CropRatio = (typeof CROP_RATIOS)[number]

export const CropProposalItemSchema = z.object({
  ratio: z.enum(CROP_RATIOS),
  purpose: z.enum(['catalog_thumbnail', 'gallery_main', 'banner', 'detail_zoom']),
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().positive(),
  height: z.number().positive()
})
export type CropProposalItem = z.infer<typeof CropProposalItemSchema>

export const BackgroundRemovalProposalSchema = z.object({
  maskDescription: z.string(),
  alphaCutoutStorageKey: z.string(),
  backgroundType: z.enum(['transparent', 'pure_white_ecommerce']),
  edgeAccuracyScore: z.number().min(0).max(1),
  noPackagingInvented: z.boolean()
})
export type BackgroundRemovalProposal = z.infer<typeof BackgroundRemovalProposalSchema>

export const MetadataProposalSchema = z.object({
  suggestedAltText: z.string().trim().min(5).max(500),
  dominantColors: z.array(z.string().regex(/^#[0-9A-Fa-f]{6}$/)).max(10),
  focalPoint: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1)
  }),
  noFictionalClaimsOrBadges: z.boolean()
})
export type MetadataProposal = z.infer<typeof MetadataProposalSchema>

export const ProhibitedInventionCheckSchema = z.object({
  passed: z.boolean(),
  noInventedPackaging: z.boolean(),
  noInventedClaims: z.boolean(),
  noInventedUses: z.boolean(),
  flaggedTokens: z.array(z.string())
})
export type ProhibitedInventionCheck = z.infer<typeof ProhibitedInventionCheckSchema>

export const MEDIA_AI_APPROVAL_STATUSES = ['pending_approval', 'approved', 'rejected', 'modified_and_approved'] as const
export type MediaAiApprovalStatus = (typeof MEDIA_AI_APPROVAL_STATUSES)[number]

export const ProposeMediaEnrichmentInputSchema = z.object({
  assetId: z.string().min(1).max(64),
  enrichmentType: z.enum(MEDIA_AI_ENRICHMENT_TYPES),
  options: z
    .object({
      targetAspectRatio: z.enum(CROP_RATIOS).optional(),
      requestedAltKeywords: z.array(z.string().trim().max(50)).max(10).optional(),
      contextProductName: z.string().trim().max(200).optional(),
      instruction: z.string().trim().max(1000).optional()
    })
    .optional()
})
export type ProposeMediaEnrichmentInput = z.infer<typeof ProposeMediaEnrichmentInputSchema>

export const DecideMediaEnrichmentInputSchema = z.object({
  expectedVersion: z.number().int().min(1),
  decision: z.enum(['approve', 'reject', 'modify_and_approve']),
  humanNotes: z.string().trim().max(1000).optional(),
  modifiedAltText: z.string().trim().min(5).max(500).optional(),
  modifiedCrops: z.array(CropProposalItemSchema).optional()
})
export type DecideMediaEnrichmentInput = z.infer<typeof DecideMediaEnrichmentInputSchema>

export const ApplyMediaEnrichmentInputSchema = z.object({
  expectedVersion: z.number().int().min(1),
  targetAssetId: z.string().min(1).max(64)
})
export type ApplyMediaEnrichmentInput = z.infer<typeof ApplyMediaEnrichmentInputSchema>

export interface MediaAiEnrichmentRecord {
  id: string
  assetId: string
  actorId: string
  enrichmentType: MediaAiEnrichmentType
  originalMetadata: Record<string, unknown>
  backgroundRemoval: BackgroundRemovalProposal | null
  proposedCrops: CropProposalItem[] | null
  proposedMetadata: MetadataProposal | null
  prohibitedInventionCheck: ProhibitedInventionCheck
  requiresHumanApproval: true
  approvalStatus: MediaAiApprovalStatus
  humanDecidedAt: string | null
  humanDeciderId: string | null
  humanNotes: string | null
  appliedToAssetAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type MediaAiEnrichmentErrorCode =
  | 'invalid_input'
  | 'prohibited_invention_detected'
  | 'not_found'
  | 'unauthorized'
  | 'not_approved'
  | 'concurrency_conflict'
  | 'idempotency_conflict'
  | 'database_error'

export class MediaAiEnrichmentError extends Error {
  constructor(
    public readonly code: MediaAiEnrichmentErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'MediaAiEnrichmentError'
  }
}

export async function mediaAiPayloadHash(action: string, input: unknown): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(`${action}:${JSON.stringify(input)}`)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const PROHIBITED_INVENTION_PATTERNS = [
  /inventar\s+envase/i,
  /nuevo\s+envase\s+virtual/i,
  /fictitious\s+bottle/i,
  /add\s+fake\s+packaging/i,
  /insignia\s+falsa/i,
  /sello\s+bio\s+inventado/i,
  /fake\s+claim/i,
  /100%\s+ecol[oó]gico\s+garantizado/i,
  /cura\s+enfermedades/i,
  /milagroso/i,
  /uso\s+no\s+autorizado/i
]

/**
 * Validates strictly that the request and proposal do NOT invent packaging, claims, or uses.
 */
export function validateProhibitedInventions(textOrPrompt?: string): ProhibitedInventionCheck {
  if (!textOrPrompt) {
    return {
      passed: true,
      noInventedPackaging: true,
      noInventedClaims: true,
      noInventedUses: true,
      flaggedTokens: []
    }
  }

  const flagged: string[] = []
  let noPackaging = true
  let noClaims = true
  let noUses = true

  for (const pattern of PROHIBITED_INVENTION_PATTERNS) {
    if (pattern.test(textOrPrompt)) {
      flagged.push(pattern.source)
      if (/envase|bottle|packaging/i.test(pattern.source)) noPackaging = false
      if (/claim|ecol[oó]gico|milagroso|insignia/i.test(pattern.source)) noClaims = false
      if (/uso|cura/i.test(pattern.source)) noUses = false
    }
  }

  return {
    passed: flagged.length === 0,
    noInventedPackaging: noPackaging,
    noInventedClaims: noClaims,
    noInventedUses: noUses,
    flaggedTokens: flagged
  }
}
