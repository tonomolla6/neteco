import { z } from 'zod'
import { catalogPolicyUuidSchema } from './catalog-publication-policy'

export const userSegmentSchema = z.enum(['anonymous', 'customer', 'professional'])
export type UserSegment = z.infer<typeof userSegmentSchema>

export const rerankVariantSchema = z.enum(['control', 'personalized'])
export type RerankVariant = z.infer<typeof rerankVariantSchema>

export const recordRerankInteractionInputSchema = z
  .object({
    eventId: catalogPolicyUuidSchema,
    clickedProductId: catalogPolicyUuidSchema.optional(),
    clickedRank: z.number().int().positive().max(1000).optional(),
    converted: z.boolean().default(false),
    conversionCents: z.number().int().nonnegative().optional()
  })
  .strict()

export type RecordRerankInteractionInput = z.infer<typeof recordRerankInteractionInputSchema>

export interface UserAffinities {
  segment: UserSegment
  preferredCategories?: string[]
  recentProductIds?: string[]
  brandAffinities?: string[]
}

export interface PersonalizedRerankResult<T> {
  items: T[]
  reranked: boolean
  variant: RerankVariant
  experimentId: string
  bypassedReason?: 'explicit_sort' | 'explicit_filters' | 'no_affinity' | 'control_variant'
}

export interface UpliftVariantMetrics {
  impressions: number
  clicks: number
  ctr: number
  conversions: number
  cvr: number
  revenueCents: number
  avgOrderValueCents: number
}

export interface UpliftReport {
  experimentId: string
  period: { from: string; to: string }
  control: UpliftVariantMetrics
  treatment: UpliftVariantMetrics
  ctrUpliftPercent: number
  convUpliftPercent: number
  revenueUpliftPercent: number
  statisticallySignificant: boolean
  totalEvaluatedEvents: number
  explicitSortBypassHonoredCount: number
}
