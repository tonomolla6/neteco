import { z } from 'zod'

const isoTimestampRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

export const reviewRatingSchema = z.number().int().min(1).max(5)
export const moderationStatusSchema = z.enum(['pending', 'approved', 'rejected', 'quarantined'])
export const questionModerationStatusSchema = z.enum(['pending', 'approved', 'rejected', 'answered'])
export const fraudStatusSchema = z.enum(['clean', 'flagged', 'blocked'])

export const submitReviewInputSchema = z
  .object({
    productId: z.string().min(1).max(64),
    orderId: z.string().min(1).max(64).optional(),
    rating: reviewRatingSchema,
    title: z.string().trim().min(3).max(160),
    content: z.string().trim().min(10).max(3000),
    displayName: z.string().trim().min(1).max(100),
    consentAccepted: z.literal(true),
    commandId: z.string().min(1).max(64)
  })
  .strict()

export const submitQuestionInputSchema = z
  .object({
    productId: z.string().min(1).max(64),
    title: z.string().trim().min(3).max(160),
    content: z.string().trim().min(10).max(3000),
    displayName: z.string().trim().min(1).max(100),
    consentAccepted: z.literal(true),
    commandId: z.string().min(1).max(64)
  })
  .strict()

export const moderateReviewInputSchema = z
  .object({
    reviewId: z.string().min(1).max(64),
    action: z.enum(['approve', 'reject', 'quarantine']),
    reason: z.string().trim().min(3).max(500),
    expectedVersion: z.number().int().nonnegative(),
    commandId: z.string().min(1).max(64)
  })
  .strict()

export const moderateQuestionInputSchema = z
  .object({
    questionId: z.string().min(1).max(64),
    action: z.enum(['approve', 'reject']),
    reason: z.string().trim().min(3).max(500),
    expectedVersion: z.number().int().nonnegative(),
    commandId: z.string().min(1).max(64)
  })
  .strict()

export const merchantReplyReviewInputSchema = z
  .object({
    reviewId: z.string().min(1).max(64),
    merchantResponse: z.string().trim().min(3).max(3000),
    expectedVersion: z.number().int().nonnegative(),
    commandId: z.string().min(1).max(64)
  })
  .strict()

export const officialAnswerQuestionInputSchema = z
  .object({
    questionId: z.string().min(1).max(64),
    officialAnswer: z.string().trim().min(3).max(3000),
    expectedVersion: z.number().int().nonnegative(),
    commandId: z.string().min(1).max(64)
  })
  .strict()

export const revokeConsentInputSchema = z
  .object({
    entityId: z.string().min(1).max(64),
    entityType: z.enum(['review', 'question']),
    anonymizeOnly: z.boolean().default(true),
    expectedVersion: z.number().int().nonnegative(),
    commandId: z.string().min(1).max(64)
  })
  .strict()

export const publicProductReviewSchema = z
  .object({
    id: z.string().min(1).max(64),
    productId: z.string().min(1).max(64),
    rating: reviewRatingSchema,
    title: z.string(),
    content: z.string(),
    isVerifiedBuyer: z.boolean(),
    displayName: z.string(),
    merchantResponse: z.string().nullable(),
    merchantRespondedAt: z.string().regex(isoTimestampRegex).nullable(),
    createdAt: z.string().regex(isoTimestampRegex)
  })
  .strict()

export const publicProductQuestionSchema = z
  .object({
    id: z.string().min(1).max(64),
    productId: z.string().min(1).max(64),
    title: z.string(),
    content: z.string(),
    isVerifiedBuyer: z.boolean(),
    displayName: z.string(),
    officialAnswer: z.string().nullable(),
    answeredAt: z.string().regex(isoTimestampRegex).nullable(),
    createdAt: z.string().regex(isoTimestampRegex)
  })
  .strict()

export type SubmitReviewInput = z.infer<typeof submitReviewInputSchema>
export type SubmitQuestionInput = z.infer<typeof submitQuestionInputSchema>
export type ModerateReviewInput = z.infer<typeof moderateReviewInputSchema>
export type ModerateQuestionInput = z.infer<typeof moderateQuestionInputSchema>
export type MerchantReplyReviewInput = z.infer<typeof merchantReplyReviewInputSchema>
export type OfficialAnswerQuestionInput = z.infer<typeof officialAnswerQuestionInputSchema>
export type RevokeConsentInput = z.infer<typeof revokeConsentInputSchema>
export type PublicProductReview = z.infer<typeof publicProductReviewSchema>
export type PublicProductQuestion = z.infer<typeof publicProductQuestionSchema>

export interface FraudEvaluationResult {
  score: number
  status: 'clean' | 'flagged' | 'blocked'
  reasons: string[]
}

const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/i
const SPAM_KEYWORDS = ['buy cheap', 'descuento gratis', 'casino', 'viagra', 'crypto', 'fake-store']

export function evaluateFraudRisk(
  title: string,
  content: string,
  priorSubmissionsInLastHour = 0
): FraudEvaluationResult {
  const combined = `${title} ${content}`.toLowerCase()
  const reasons: string[] = []
  let score = 0.0

  // 1. External URLs detection
  if (URL_PATTERN.test(combined)) {
    score += 0.5
    reasons.push('contains_external_links')
  }

  // 2. Prohibited spam keywords
  for (const keyword of SPAM_KEYWORDS) {
    if (combined.includes(keyword)) {
      score += 0.4
      reasons.push(`suspicious_keyword_${keyword.replace(/\s+/g, '_')}`)
      break
    }
  }

  // 3. Excessive velocity / review bombing detection
  if (priorSubmissionsInLastHour >= 5) {
    score += 0.7
    reasons.push('velocity_rate_limit_exceeded')
  } else if (priorSubmissionsInLastHour >= 3) {
    score += 0.3
    reasons.push('elevated_submission_velocity')
  }

  // 4. Repeated character patterns
  if (/(.)\1{9,}/.test(combined)) {
    score += 0.3
    reasons.push('repetitive_gibberish')
  }

  const cappedScore = Math.min(1.0, Number(score.toFixed(2)))
  const status: 'clean' | 'flagged' | 'blocked' =
    cappedScore >= 0.7 ? 'blocked' : cappedScore >= 0.5 ? 'flagged' : 'clean'

  return {
    score: cappedScore,
    status,
    reasons
  }
}

export async function computeReviewsQaPayloadHash(payload: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(payload))
  const hashBuf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuf), (b) => b.toString(16).padStart(2, '0')).join('')
}
