import { z } from 'zod'

export const CAMPAIGN_PIPELINE_STATUSES = [
  'draft',
  'qa_pending',
  'qa_approved',
  'scheduled',
  'published',
  'rolled_back'
] as const

export type CampaignPipelineStatus = (typeof CAMPAIGN_PIPELINE_STATUSES)[number]

export const CAMPAIGN_CHECK_TYPES = ['performance', 'accessibility', 'qa_review'] as const
export type CampaignCheckType = (typeof CAMPAIGN_CHECK_TYPES)[number]

export class CampaignPipelineError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number = 400,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'CampaignPipelineError'
  }
}

export const campaignSectionSchema = z
  .object({
    id: z.string().min(1).max(64),
    type: z.enum(['hero_banner', 'product_grid', 'text_cta', 'split_feature']),
    heading: z.string().min(1).max(200),
    headingLevel: z.enum(['h1', 'h2', 'h3', 'h4']).default('h2'),
    body: z.string().max(2000).optional(),
    ctaText: z.string().max(64).optional(),
    ctaUrl: z.string().max(256).optional(),
    ctaAriaLabel: z.string().max(128).optional(),
    imageUrl: z.string().max(256).optional(),
    imageAlt: z.string().max(200).optional(),
    imageWidth: z.number().int().positive().optional(),
    imageHeight: z.number().int().positive().optional(),
    imageFormat: z.enum(['webp', 'avif', 'png', 'jpeg', 'svg']).optional(),
    imageBytesEstimate: z.number().int().positive().optional(),
    theme: z
      .object({
        textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/)
      })
      .optional()
  })
  .strict()

export type CampaignSection = z.infer<typeof campaignSectionSchema>

export const campaignDocumentSchema = z
  .object({
    headline: z.string().min(3).max(200),
    metaDescription: z.string().min(10).max(300),
    sections: z.array(campaignSectionSchema).min(1),
    trackingTags: z.record(z.string()).optional()
  })
  .strict()

export type CampaignDocument = z.infer<typeof campaignDocumentSchema>

export const saveDraftSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    campaignSlug: z.string().trim().min(2).max(100),
    title: z.string().trim().min(2).max(200),
    document: campaignDocumentSchema
  })
  .strict()

export type SaveDraftInput = z.infer<typeof saveDraftSchema>

export const runCampaignChecksSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    pipelineId: z.string().uuid(),
    expectedVersion: z.number().int().min(1)
  })
  .strict()

export type RunCampaignChecksInput = z.infer<typeof runCampaignChecksSchema>

export const qaSignoffSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    pipelineId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    notes: z.string().trim().min(3).max(500)
  })
  .strict()

export type QaSignoffInput = z.infer<typeof qaSignoffSchema>

export const schedulePublicationSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    pipelineId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    publishAt: z.string().datetime(),
    unpublishAt: z.string().datetime().optional()
  })
  .strict()
  .refine((data) => !data.unpublishAt || new Date(data.unpublishAt) >= new Date(data.publishAt), {
    message: 'unpublishAt must be after or equal to publishAt'
  })

export type SchedulePublicationInput = z.infer<typeof schedulePublicationSchema>

export const publishCampaignNowSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    pipelineId: z.string().uuid(),
    expectedVersion: z.number().int().min(1)
  })
  .strict()

export type PublishCampaignNowInput = z.infer<typeof publishCampaignNowSchema>

export const rollbackCampaignSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    pipelineId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    reason: z.string().trim().min(3).max(500)
  })
  .strict()

export type RollbackCampaignInput = z.infer<typeof rollbackCampaignSchema>

export interface CheckViolation {
  code: string
  message: string
  sectionId?: string
  severity: 'blocker' | 'warning'
}

export interface CheckResult {
  checkType: CampaignCheckType
  passed: boolean
  score: number
  violations: CheckViolation[]
  details: Record<string, unknown>
}

export interface CampaignContentPipelineRecord {
  id: string
  campaignSlug: string
  title: string
  currentVersion: number
  publishedVersion: number | null
  previousPublishedVersion: number | null
  status: CampaignPipelineStatus
  publishAt: string | null
  unpublishAt: string | null
  document: CampaignDocument
  version: number
  createdAt: string
  updatedAt: string
  createdBy: string
  checks?: CheckResult[]
}
