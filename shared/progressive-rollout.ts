import { z } from 'zod'

export const ROLLOUT_STATUSES = ['draft', 'active', 'paused', 'tripped', 'rolled_back', 'promoted_full'] as const

export type RolloutStatus = (typeof ROLLOUT_STATUSES)[number]

export class ProgressiveRolloutError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number = 400,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'ProgressiveRolloutError'
  }
}

export const guardrailConfigSchema = z
  .object({
    maxErrorRatePercent: z.number().min(0).max(100),
    maxP95LatencyMs: z.number().int().min(1),
    minSampleCount: z.number().int().min(1)
  })
  .strict()

export type GuardrailConfig = z.infer<typeof guardrailConfigSchema>

export const betaScopeNoticeSchema = z
  .object({
    title: z.string().min(2).max(120),
    summary: z.string().min(5).max(500),
    limitations: z.array(z.string().min(1).max(200)),
    learnMoreUrl: z.string().url().optional()
  })
  .strict()

export type BetaScopeNotice = z.infer<typeof betaScopeNoticeSchema>

export const createRolloutSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    featureKey: z.string().trim().min(2).max(64),
    name: z.string().trim().min(3).max(120),
    trafficPercentage: z.number().int().min(0).max(100),
    cohorts: z.array(z.string().min(1).max(64)),
    zones: z.array(z.string().min(1).max(32)),
    guardrails: guardrailConfigSchema,
    betaScopeNotice: betaScopeNoticeSchema
  })
  .strict()

export type CreateRolloutInput = z.infer<typeof createRolloutSchema>

export const updateRolloutSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    rolloutId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    trafficPercentage: z.number().int().min(0).max(100).optional(),
    cohorts: z.array(z.string().min(1).max(64)).optional(),
    zones: z.array(z.string().min(1).max(32)).optional(),
    status: z.enum(['draft', 'active', 'paused']).optional(),
    guardrails: guardrailConfigSchema.optional(),
    betaScopeNotice: betaScopeNoticeSchema.optional()
  })
  .strict()

export type UpdateRolloutInput = z.infer<typeof updateRolloutSchema>

export const recordRolloutMetricsSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    rolloutId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    windowStart: z.string().datetime(),
    windowEnd: z.string().datetime(),
    sampleCount: z.number().int().min(0),
    errorCount: z.number().int().min(0),
    p95LatencyMs: z.number().int().min(0)
  })
  .strict()
  .refine((data) => data.errorCount <= data.sampleCount, {
    message: 'errorCount cannot exceed sampleCount'
  })
  .refine((data) => new Date(data.windowEnd) >= new Date(data.windowStart), {
    message: 'windowEnd must be greater than or equal to windowStart'
  })

export type RecordRolloutMetricsInput = z.infer<typeof recordRolloutMetricsSchema>

export const manualRollbackSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    rolloutId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    reason: z.string().trim().min(3).max(500)
  })
  .strict()

export type ManualRollbackInput = z.infer<typeof manualRollbackSchema>

export const promoteRolloutFullSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    rolloutId: z.string().uuid(),
    expectedVersion: z.number().int().min(1)
  })
  .strict()

export type PromoteRolloutFullInput = z.infer<typeof promoteRolloutFullSchema>

export const evaluateSubjectSchema = z
  .object({
    featureKey: z.string().trim().min(2).max(64),
    subjectId: z.string().min(1).max(128),
    cohort: z.string().max(64).optional(),
    zone: z.string().max(32).optional()
  })
  .strict()

export type EvaluateSubjectInput = z.infer<typeof evaluateSubjectSchema>

export interface ProgressiveRolloutRecord {
  id: string
  featureKey: string
  name: string
  status: RolloutStatus
  trafficPercentage: number
  cohorts: string[]
  zones: string[]
  guardrails: GuardrailConfig
  betaScopeNotice: BetaScopeNotice
  tripReason: string | null
  version: number
  createdAt: string
  updatedAt: string
  createdBy: string
}

export interface GuardrailEvaluationRecord {
  id: string
  rolloutId: string
  windowStart: string
  windowEnd: string
  sampleCount: number
  errorCount: number
  errorRatePercent: number
  p95LatencyMs: number
  breached: boolean
  breachDetails: {
    errorRateBreached: boolean
    latencyBreached: boolean
    reasons: string[]
  }
  createdAt: string
}

export interface RolloutEvaluationResult {
  enabled: boolean
  featureKey: string
  status: RolloutStatus
  reason: 'promoted_full' | 'cohort_match' | 'traffic_bucket' | 'disabled' | 'tripped' | 'rolled_back' | 'not_found'
  betaScopeNotice: BetaScopeNotice | null
}
