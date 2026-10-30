import { z } from 'zod'
import { catalogPolicyUuidSchema as uuid, catalogPolicyInstantSchema as instant } from './catalog-publication-policy'

export const searchIntentSchema = z.enum(['informational', 'commercial', 'transactional', 'navigational'])
export type SearchIntent = z.infer<typeof searchIntentSchema>

export const editorialBriefingStatusSchema = z.enum([
  'planned',
  'drafting',
  'in_review',
  'scheduled',
  'published',
  'needs_update',
  'archived'
])
export type EditorialBriefingStatus = z.infer<typeof editorialBriefingStatusSchema>

export const reviewStatusSchema = z.enum(['pending', 'in_review', 'approved', 'rejected'])
export type ReviewStatus = z.infer<typeof reviewStatusSchema>

export const expertAuthorSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    credentials: z.string().trim().min(3).max(200),
    identityId: uuid.optional()
  })
  .strict()
export type ExpertAuthor = z.infer<typeof expertAuthorSchema>

export const briefingSourceSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    url: z.string().url().max(500).optional(),
    citation: z.string().trim().min(3).max(300),
    verified: z.boolean().default(true)
  })
  .strict()
export type BriefingSource = z.infer<typeof briefingSourceSchema>

export const briefingAssetSchema = z
  .object({
    assetType: z.enum(['image', 'infographic', 'technical_sheet', 'table', 'video', 'checklist']),
    name: z.string().trim().min(2).max(160),
    url: z.string().url().max(500).optional(),
    status: z.enum(['planned', 'drafted', 'ready']).default('planned')
  })
  .strict()
export type BriefingAsset = z.infer<typeof briefingAssetSchema>

export const briefingKpisSchema = z
  .object({
    targetMonthlyVisits: z.number().int().min(0).max(10_000_000),
    targetSerpRank: z.number().int().min(1).max(100),
    conversionGoal: z.string().trim().min(3).max(200),
    actualMonthlyVisits: z.number().int().min(0).optional(),
    actualSerpRank: z.number().int().min(1).max(100).optional()
  })
  .strict()
export type BriefingKpis = z.infer<typeof briefingKpisSchema>

export const createEditorialBriefingInputSchema = z
  .object({
    pageId: uuid.optional(),
    topic: z.string().trim().min(3).max(200),
    searchIntent: searchIntentSchema,
    targetKeyword: z.string().trim().min(2).max(120),
    secondaryKeywords: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
    expertAuthor: expertAuthorSchema,
    sources: z.array(briefingSourceSchema).min(1).max(30),
    assets: z.array(briefingAssetSchema).max(30).default([]),
    targetPublishDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    updateCadenceMonths: z.number().int().min(1).max(36).default(6),
    kpiTargets: briefingKpisSchema
  })
  .strict()
export type CreateEditorialBriefingInput = z.infer<typeof createEditorialBriefingInputSchema>

export const updateEditorialBriefingInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    topic: z.string().trim().min(3).max(200),
    searchIntent: searchIntentSchema,
    targetKeyword: z.string().trim().min(2).max(120),
    secondaryKeywords: z.array(z.string().trim().min(1).max(120)).max(20),
    expertAuthor: expertAuthorSchema,
    sources: z.array(briefingSourceSchema).min(1).max(30),
    assets: z.array(briefingAssetSchema).max(30),
    targetPublishDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    updateCadenceMonths: z.number().int().min(1).max(36),
    kpiTargets: briefingKpisSchema
  })
  .strict()
export type UpdateEditorialBriefingInput = z.infer<typeof updateEditorialBriefingInputSchema>

export const reviewEditorialBriefingInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    reviewStatus: reviewStatusSchema,
    reviewNotes: z.string().trim().min(3).max(1000).optional()
  })
  .strict()
export type ReviewEditorialBriefingInput = z.infer<typeof reviewEditorialBriefingInputSchema>

export const publishOrScheduleEditorialBriefingInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    action: z.enum(['schedule', 'publish', 'archive']),
    actualPublishedAt: instant.optional(),
    scheduledDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
  })
  .strict()
export type PublishOrScheduleEditorialBriefingInput = z.infer<typeof publishOrScheduleEditorialBriefingInputSchema>

export const editorialBriefingSchema = z
  .object({
    id: uuid,
    pageId: uuid.nullable(),
    topic: z.string(),
    searchIntent: searchIntentSchema,
    targetKeyword: z.string(),
    secondaryKeywords: z.array(z.string()),
    expertAuthor: expertAuthorSchema,
    sources: z.array(briefingSourceSchema),
    assets: z.array(briefingAssetSchema),
    reviewStatus: reviewStatusSchema,
    reviewNotes: z.string().nullable(),
    reviewerIdentityId: uuid.nullable(),
    targetPublishDate: z.string(),
    actualPublishedAt: instant.nullable(),
    updateCadenceMonths: z.number().int().nullable(),
    lastReviewedAt: instant.nullable(),
    kpiTargets: briefingKpisSchema,
    status: editorialBriefingStatusSchema,
    version: z.number().int().min(1),
    createdBy: uuid,
    createdAt: instant,
    updatedAt: instant
  })
  .strict()
export type EditorialBriefing = z.infer<typeof editorialBriefingSchema>

export const unifiedEditorialCalendarSchema = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    timeZone: z.literal('Europe/Madrid'),
    briefings: z.array(editorialBriefingSchema),
    metrics: z
      .object({
        totalPlanned: z.number().int().min(0),
        totalInReview: z.number().int().min(0),
        totalApproved: z.number().int().min(0),
        totalPublished: z.number().int().min(0)
      })
      .strict()
  })
  .strict()
export type UnifiedEditorialCalendar = z.infer<typeof unifiedEditorialCalendarSchema>
