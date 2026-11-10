import { z } from 'zod'

export const sendTimeCategorySchema = z.enum(['marketing', 'operational'])
export type SendTimeCategory = z.infer<typeof sendTimeCategorySchema>

export const sendTimeChannelSchema = z.enum(['email', 'sms', 'push'])
export type SendTimeChannel = z.infer<typeof sendTimeChannelSchema>

export const sendTimeDecisionStatusSchema = z.enum([
  'sent_immediate',
  'scheduled_optimized',
  'held_out',
  'suppressed_no_consent',
  'suppressed_rate_limit'
])
export type SendTimeDecisionStatus = z.infer<typeof sendTimeDecisionStatusSchema>

export const sendTimeOptimizationPolicySchema = z
  .object({
    id: z.literal('global'),
    version: z.number().int().min(1),
    holdoutRateBasisPoints: z.number().int().min(0).max(5000), // e.g. 1000 = 10%
    minHoursBetweenMarketing: z.number().int().min(1).max(168), // min cooldown
    maxWeeklyMarketingSends: z.number().int().min(1).max(14),
    allowedWindowStartHour: z.number().int().min(0).max(23),
    allowedWindowEndHour: z.number().int().min(1).max(24),
    updatedAt: z.string(),
    updatedBy: z.string()
  })
  .strict()
export type SendTimeOptimizationPolicy = z.infer<typeof sendTimeOptimizationPolicySchema>

export const sendTimeOptimizationPolicyInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    holdoutRateBasisPoints: z.number().int().min(0).max(5000),
    minHoursBetweenMarketing: z.number().int().min(1).max(168),
    maxWeeklyMarketingSends: z.number().int().min(1).max(14),
    allowedWindowStartHour: z.number().int().min(0).max(23),
    allowedWindowEndHour: z.number().int().min(1).max(24)
  })
  .strict()
  .refine((data) => data.allowedWindowEndHour > data.allowedWindowStartHour, {
    message: 'allowedWindowEndHour must be greater than allowedWindowStartHour'
  })
export type SendTimeOptimizationPolicyInput = z.infer<typeof sendTimeOptimizationPolicyInputSchema>

export const sendTimeMessageEvaluationInputSchema = z
  .object({
    messageId: z.string().trim().min(4).max(64),
    customerId: z.string().uuid(),
    category: sendTimeCategorySchema,
    channel: sendTimeChannelSchema,
    campaignCode: z.string().trim().min(1).max(64).optional()
  })
  .strict()
export type SendTimeMessageEvaluationInput = z.infer<typeof sendTimeMessageEvaluationInputSchema>

export interface SendTimeOptimizationDecision {
  id: string
  messageId: string
  customerId: string
  category: SendTimeCategory
  channel: SendTimeChannel
  campaignCode: string | null
  status: SendTimeDecisionStatus
  scheduledFor: string
  reason: string
  holdoutApplied: boolean
  consentVerified: boolean
  createdAt: string
}

/**
 * Deterministic hash-based holdout allocation.
 * Returns true if customer falls into holdout control group.
 */
export function isCustomerHeldOut(
  customerId: string,
  campaignCode: string = 'global',
  holdoutRateBasisPoints: number = 1000
): boolean {
  if (holdoutRateBasisPoints <= 0) return false
  if (holdoutRateBasisPoints >= 10000) return true
  let hash = 0
  const str = `${customerId}:${campaignCode}:holdout`
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  const positive = Math.abs(hash)
  const bucket = positive % 10000
  return bucket < holdoutRateBasisPoints
}

/**
 * Calculates the next optimal send time window adhering to business hours (startHour to endHour)
 * and skipping weekends (Saturday & Sunday).
 */
export function calculateNextOptimalWindow(fromIso: string, startHour: number, endHour: number): string {
  const date = new Date(fromIso)
  if (Number.isNaN(date.getTime())) {
    throw new Error('invalid_from_iso')
  }

  // Check current UTC day and hour
  let day = date.getUTCDay() // 0 = Sunday, 6 = Saturday
  const hour = date.getUTCHours()

  // If weekday and currently within allowed business window
  if (day >= 1 && day <= 5 && hour >= startHour && hour < endHour) {
    // Within window
    return fromIso
  }

  // Target next business morning at startHour:30 UTC
  const target = new Date(date)
  target.setUTCMinutes(30, 0, 0)
  target.setUTCHours(startHour)

  // If already at or past startHour today, advance by at least 1 day
  if (hour >= endHour) {
    target.setUTCDate(target.getUTCDate() + 1)
  }

  // Adjust for weekend: if Saturday (6), move to Monday (+2); if Sunday (0), move to Monday (+1)
  day = target.getUTCDay()
  if (day === 6) {
    target.setUTCDate(target.getUTCDate() + 2)
  } else if (day === 0) {
    target.setUTCDate(target.getUTCDate() + 1)
  }

  return target.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function sendTimeOptimizationIntentHash(action: string, input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(['send-time-optimization:v1', action, input]))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
