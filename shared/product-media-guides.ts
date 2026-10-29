import { z } from 'zod'

const isoTimestampRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const hex64Regex = /^[0-9a-f]{64}$/

export const mediaGuideTypeSchema = z.enum(['expert_demo', 'dosage', 'application', 'assembly'])
export const mediaMimeTypeSchema = z.enum(['video/mp4', 'video/webm'])
export const mediaAspectRatioSchema = z.enum(['16:9', '9:16', '4:3', '1:1'])
export const mediaGuideStatusSchema = z.enum(['draft', 'published', 'archived'])

export const mediaStepSchema = z
  .object({
    stepIndex: z.number().int().positive(),
    title: z.string().trim().min(2).max(120),
    description: z.string().trim().min(3).max(500)
  })
  .strict()

export const productMediaGuideSchema = z
  .object({
    id: z.string().min(1).max(64),
    productId: z.string().min(1).max(64),
    guideType: mediaGuideTypeSchema,
    title: z.string().trim().min(3).max(160),
    description: z.string().max(1000).nullable(),
    expertPresenter: z.string().max(100).nullable(),
    expertTitle: z.string().max(150).nullable(),
    videoUrl: z.string().min(3).max(500),
    mimeType: mediaMimeTypeSchema,
    durationSeconds: z.number().int().positive().max(3600),
    aspectRatio: mediaAspectRatioSchema,
    posterUrl: z.string().min(3).max(500),
    posterOptimizedWebp: z.string().max(500).nullable(),
    posterWidth: z.number().int().positive(),
    posterHeight: z.number().int().positive(),
    subtitlesVttUrl: z.string().max(500).nullable(),
    subtitlesLanguage: z.string().min(2).max(10),
    transcriptText: z.string().min(10),
    steps: z.array(mediaStepSchema),
    requiresConsent: z.boolean(),
    status: mediaGuideStatusSchema,
    sortOrder: z.number().int(),
    version: z.number().int().positive(),
    createdAt: z.string().regex(isoTimestampRegex),
    updatedAt: z.string().regex(isoTimestampRegex)
  })
  .strict()

export const upsertMediaGuideInputSchema = z
  .object({
    id: z.string().min(1).max(64),
    productId: z.string().min(1).max(64),
    guideType: mediaGuideTypeSchema,
    title: z.string().trim().min(3).max(160),
    description: z.string().max(1000).optional(),
    expertPresenter: z.string().max(100).optional(),
    expertTitle: z.string().max(150).optional(),
    videoUrl: z.string().min(3).max(500),
    mimeType: mediaMimeTypeSchema.default('video/mp4'),
    durationSeconds: z.number().int().positive().max(3600),
    aspectRatio: mediaAspectRatioSchema.default('16:9'),
    posterUrl: z.string().min(3).max(500),
    posterOptimizedWebp: z.string().max(500).optional(),
    posterWidth: z.number().int().positive().default(1280),
    posterHeight: z.number().int().positive().default(720),
    subtitlesVttUrl: z.string().max(500).optional(),
    subtitlesLanguage: z.string().min(2).max(10).default('es'),
    transcriptText: z.string().min(10),
    steps: z.array(mediaStepSchema).default([]),
    requiresConsent: z.boolean().default(false),
    status: mediaGuideStatusSchema.default('published'),
    sortOrder: z.number().int().default(0),
    actorId: z.string().min(1).max(64),
    expectedVersion: z.number().int().nonnegative(),
    commandId: z.string().min(1).max(64),
    now: z.string().regex(isoTimestampRegex).optional()
  })
  .strict()

export const mediaTelemetryEventTypeSchema = z.enum([
  'impression',
  'play_start',
  'progress_25',
  'progress_50',
  'progress_75',
  'complete',
  'transcript_view',
  'subtitles_toggle'
])

export const mediaUsageMetricInputSchema = z
  .object({
    guideId: z.string().min(1).max(64),
    eventType: mediaTelemetryEventTypeSchema,
    playPositionSeconds: z.number().nonnegative().optional(),
    sessionHash: z.string().regex(hex64Regex),
    consentVerified: z.boolean(),
    now: z.string().regex(isoTimestampRegex).optional()
  })
  .strict()

export type ProductMediaGuide = z.infer<typeof productMediaGuideSchema>
export type UpsertMediaGuideInput = z.infer<typeof upsertMediaGuideInputSchema>
export type MediaUsageMetricInput = z.infer<typeof mediaUsageMetricInputSchema>
export type MediaTelemetryEventType = z.infer<typeof mediaTelemetryEventTypeSchema>

export async function computeMediaGuidePayloadHash(payload: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(payload))
  const hashBuf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuf), (b) => b.toString(16).padStart(2, '0')).join('')
}
