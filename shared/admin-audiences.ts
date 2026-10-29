import { z } from 'zod'

export const AUDIENCE_RULE_FIELDS = [
  'customer_type',
  'orders_count',
  'total_spent_cents',
  'days_since_last_order',
  'newsletter_consent',
  'registration_days'
] as const
export type AudienceRuleField = (typeof AUDIENCE_RULE_FIELDS)[number]

export const AUDIENCE_RULE_OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'between'] as const
export type AudienceRuleOperator = (typeof AUDIENCE_RULE_OPERATORS)[number]

export const AudienceRuleConditionSchema = z.object({
  field: z.enum(AUDIENCE_RULE_FIELDS),
  operator: z.enum(AUDIENCE_RULE_OPERATORS),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.array(z.number())])
})
export type AudienceRuleCondition = z.infer<typeof AudienceRuleConditionSchema>

export const AudienceRuleSetSchema = z.object({
  logic: z.enum(['AND', 'OR']).default('AND'),
  conditions: z.array(AudienceRuleConditionSchema).default([])
})
export type AudienceRuleSet = z.infer<typeof AudienceRuleSetSchema>

export const CreateSegmentInputSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9_-]+$/, 'El slug solo puede contener letras minúsculas, números, guiones y subrayados'),
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(500).optional(),
  targetType: z.enum(['all', 'b2b', 'b2c']).default('all'),
  rules: AudienceRuleSetSchema
})
export type CreateSegmentInput = z.infer<typeof CreateSegmentInputSchema>

export const UpdateSegmentRulesInputSchema = z.object({
  expectedVersion: z.number().int().min(1),
  name: z.string().trim().min(3).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  targetType: z.enum(['all', 'b2b', 'b2c']).optional(),
  rules: AudienceRuleSetSchema,
  changeSummary: z.string().trim().min(1).max(255)
})
export type UpdateSegmentRulesInput = z.infer<typeof UpdateSegmentRulesInputSchema>

export interface AudienceEstimationResult {
  totalMatchingUsers: number
  consentedUsers: number
  unconsentedUsers: number
  consentPercentage: number
  estimatedAt: string
}

export interface AudienceUserPreview {
  id: string
  maskedIdentifier: string
  customerType: 'b2b' | 'b2c'
  hasConsent: boolean
  orderCount: number
  totalSpentCents: number
  daysSinceLastOrder: number | null
}

export interface AudienceSegmentRecord {
  id: string
  slug: string
  name: string
  description: string | null
  version: number
  rules: AudienceRuleSet
  targetType: 'all' | 'b2b' | 'b2c'
  status: 'draft' | 'active' | 'archived'
  lastEstimatedAt: string | null
  estimatedTotalUsers: number
  estimatedConsentedUsers: number
  createdAt: string
  updatedAt: string
  createdBy: string
  updatedBy: string
}

export interface AudienceSegmentVersionRecord {
  id: string
  segmentId: string
  version: number
  rules: AudienceRuleSet
  changeSummary: string
  createdBy: string
  createdAt: string
}

export type AdminAudiencesErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'slug_taken'
  | 'concurrency_conflict'
  | 'idempotency_conflict'
  | 'unauthorized'
  | 'database_error'

export class AdminAudiencesError extends Error {
  constructor(
    public readonly code: AdminAudiencesErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AdminAudiencesError'
  }
}

export function maskEmail(email: string): string {
  const parts = email.split('@')
  if (parts.length !== 2) return '***@unknown.invalid'
  const local = parts[0]!
  const domain = parts[1]!
  if (local.length <= 2) {
    return `${local[0] ?? ''}***@${domain}`
  }
  return `${local[0]}***${local[local.length - 1]}@${domain}`
}

export async function audiencePayloadHash(action: string, input: unknown): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(JSON.stringify({ action, input }))
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
