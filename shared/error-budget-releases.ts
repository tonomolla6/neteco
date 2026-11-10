import { z } from 'zod'

export const SRE_JOURNEYS = [
  'storefront',
  'checkout_orders',
  'catalog_api',
  'critical_mutations',
  'payments_webhooks',
  'jobs_queues'
] as const

export type SreJourney = (typeof SRE_JOURNEYS)[number]

export const RELEASE_TYPES = ['feature', 'reliability_fix', 'hotfix', 'rollback', 'infrastructure'] as const

export type ReleaseType = (typeof RELEASE_TYPES)[number]

export const RELEASE_DECISION_STATUSES = ['approved', 'blocked_budget_exhausted', 'overridden_emergency'] as const

export type ReleaseDecisionStatus = (typeof RELEASE_DECISION_STATUSES)[number]

export class ErrorBudgetReleaseError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number = 400,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'ErrorBudgetReleaseError'
  }
}

export const recordSliMeasurementSchema = z
  .object({
    commandId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(128),
    journey: z.enum(SRE_JOURNEYS),
    windowStart: z.string().datetime(),
    windowEnd: z.string().datetime(),
    totalEvents: z.number().int().nonnegative(),
    failedEvents: z.number().int().nonnegative(),
    targetSloRatio: z.number().positive().max(1.0),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .strict()
  .refine((data) => data.failedEvents <= data.totalEvents, {
    message: 'failedEvents must not exceed totalEvents'
  })
  .refine((data) => new Date(data.windowEnd) >= new Date(data.windowStart), {
    message: 'windowEnd must be greater than or equal to windowStart'
  })

export type RecordSliMeasurementInput = z.infer<typeof recordSliMeasurementSchema>

export const evaluateReleaseSchema = z
  .object({
    commandId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(128),
    releaseVersion: z.string().trim().min(1).max(64),
    releaseType: z.enum(RELEASE_TYPES),
    commitHash: z.string().trim().min(7).max(64)
  })
  .strict()

export type EvaluateReleaseInput = z.infer<typeof evaluateReleaseSchema>

export const emergencyOverrideSchema = z
  .object({
    commandId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(128),
    decisionId: z.string().uuid(),
    justification: z.string().trim().min(5).max(1000)
  })
  .strict()

export type EmergencyOverrideInput = z.infer<typeof emergencyOverrideSchema>

export interface JourneyBudgetStatus {
  journey: SreJourney
  targetSloRatio: number
  totalEvents: number
  failedEvents: number
  allowedErrorCount: number
  consumedBudgetPercent: number
  remainingBudgetPercent: number
  burnRate: number
  isExhausted: boolean
  warningBurnRate: number
  freezeBurnRate: number
}

export interface BudgetStatusSummary {
  evaluatedAt: string
  freezeActive: boolean
  blockingJourneys: SreJourney[]
  journeys: Record<SreJourney, JourneyBudgetStatus>
}

export interface SreReleaseDecision {
  id: string
  releaseVersion: string
  releaseType: ReleaseType
  commitHash: string
  requestedBy: string
  status: ReleaseDecisionStatus
  budgetStatusSummary: BudgetStatusSummary
  justification?: string | null
  overriddenBy?: string | null
  overriddenAt?: string | null
  createdAt: string
}

export interface ErrorBudgetOverview {
  generatedAt: string
  featureFreezeActive: boolean
  blockingJourneys: SreJourney[]
  journeys: Partial<Record<SreJourney, JourneyBudgetStatus>>
}

/**
 * Calculates budget metrics for a single journey given aggregated events and SLO target.
 */
export function calculateJourneyBudget(options: {
  journey: SreJourney
  totalEvents: number
  failedEvents: number
  targetSloRatio: number
  warningBurnRate?: number
  freezeBurnRate?: number
  minRemainingBudgetPercent?: number
}): JourneyBudgetStatus {
  const {
    journey,
    totalEvents,
    failedEvents,
    targetSloRatio,
    warningBurnRate = 2.0,
    freezeBurnRate = 14.4,
    minRemainingBudgetPercent = 5.0
  } = options

  const allowedErrorRate = Math.max(1 - targetSloRatio, 0.000001)
  const allowedErrorCount = Math.max(Math.round(totalEvents * allowedErrorRate), 1)

  const actualErrorRate = totalEvents > 0 ? failedEvents / totalEvents : 0
  const burnRate = allowedErrorRate > 0 ? actualErrorRate / allowedErrorRate : 0

  const consumedBudgetPercent = allowedErrorCount > 0 ? (failedEvents / allowedErrorCount) * 100 : 0
  const remainingBudgetPercent = 100 - consumedBudgetPercent

  const isExhausted = remainingBudgetPercent < minRemainingBudgetPercent || burnRate >= freezeBurnRate

  return {
    journey,
    targetSloRatio,
    totalEvents,
    failedEvents,
    allowedErrorCount,
    consumedBudgetPercent,
    remainingBudgetPercent,
    burnRate,
    isExhausted,
    warningBurnRate,
    freezeBurnRate
  }
}
