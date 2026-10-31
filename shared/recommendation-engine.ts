import { z } from 'zod'
import { catalogPolicyInstantSchema as instant, catalogPolicyUuidSchema as uuid } from './catalog-publication-policy'

export const SECTORS = [
  'hosteleria',
  'sanitario',
  'industrial',
  'lavanderia',
  'automocion',
  'educacion',
  'comercial',
  'general'
] as const

export type Sector = (typeof SECTORS)[number]

export const sectorSchema = z.enum(SECTORS)

export const recommendationEnginePolicySchema = z
  .object({
    id: z.literal('global'),
    version: z.number().int().min(1),
    weightCompatibility: z.number().int().min(0).max(100),
    weightSector: z.number().int().min(0).max(100),
    weightCopurchase: z.number().int().min(0).max(100),
    weightMargin: z.number().int().min(0).max(100),
    marginFloorBasisPoints: z.number().int().min(0).max(5000),
    maxPerCategory: z.number().int().min(1).max(10),
    manualFallbackProductIds: z.array(z.string().min(1).max(100)).max(20),
    updatedAt: instant,
    updatedBy: uuid
  })
  .strict()

export const recommendationEnginePolicyInputSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    weightCompatibility: z.number().int().min(0).max(100).default(40),
    weightSector: z.number().int().min(0).max(100).default(25),
    weightCopurchase: z.number().int().min(0).max(100).default(25),
    weightMargin: z.number().int().min(0).max(100).default(10),
    marginFloorBasisPoints: z.number().int().min(0).max(5000).default(1500),
    maxPerCategory: z.number().int().min(1).max(10).default(2),
    manualFallbackProductIds: z.array(z.string().min(1).max(100)).max(20).default([])
  })
  .strict()

export const recommendationOriginSchema = z.enum(['rule', 'manual_fallback'])

export const recommendationItemSchema = z
  .object({
    productId: z.string().min(1).max(100),
    categoryId: z.string().min(1).max(100),
    name: z.string().min(1).max(300),
    slug: z.string().min(1).max(200),
    score: z.number().min(0).max(100),
    origin: recommendationOriginSchema,
    signals: z
      .object({
        compatibilityScore: z.number().min(0).max(1),
        sectorScore: z.number().min(0).max(1),
        copurchaseScore: z.number().min(0).max(1),
        marginScore: z.number().min(0).max(1),
        grossMarginBasisPoints: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict()

export const recommendationRequestSchema = z
  .object({
    targetProductId: z.string().min(1).max(100).optional(),
    customerId: uuid.optional(),
    cartProductIds: z.array(z.string().min(1).max(100)).max(20).default([]),
    sector: sectorSchema.optional(),
    limit: z.number().int().min(1).max(20).default(4)
  })
  .strict()

export const recommendationResponseSchema = z
  .object({
    source: z.literal('cloudflare'),
    requestId: uuid,
    targetProductId: z.string().nullable(),
    items: z.array(recommendationItemSchema),
    evaluatedAt: instant
  })
  .strict()

export const recommendationEventInputSchema = z
  .object({
    impressionId: uuid,
    eventType: z.enum(['click', 'conversion']),
    productId: z.string().min(1).max(100),
    orderId: uuid.optional(),
    grossCents: z.number().int().min(0).optional(),
    position: z.number().int().min(0).max(50).optional()
  })
  .strict()

export const recommendationMetricsSchema = z
  .object({
    source: z.literal('cloudflare'),
    periodDays: z.number().int().positive(),
    impressions: z.number().int().nonnegative(),
    clicks: z.number().int().nonnegative(),
    conversions: z.number().int().nonnegative(),
    clickThroughRate: z.number().nonnegative(),
    conversionRate: z.number().nonnegative(),
    attributedRevenueGrossCents: z.number().int().nonnegative(),
    byOrigin: z
      .object({
        rule: z.object({ clicks: z.number().int(), conversions: z.number().int() }).strict(),
        manualFallback: z.object({ clicks: z.number().int(), conversions: z.number().int() }).strict()
      })
      .strict(),
    evaluatedAt: instant
  })
  .strict()

export type RecommendationEnginePolicy = z.infer<typeof recommendationEnginePolicySchema>
export type RecommendationEnginePolicyInput = z.infer<typeof recommendationEnginePolicyInputSchema>
export type RecommendationItem = z.infer<typeof recommendationItemSchema>
export type RecommendationRequest = z.infer<typeof recommendationRequestSchema>
export type RecommendationResponse = z.infer<typeof recommendationResponseSchema>
export type RecommendationEventInput = z.infer<typeof recommendationEventInputSchema>
export type RecommendationMetrics = z.infer<typeof recommendationMetricsSchema>

/**
 * Applies category diversity to candidate recommendations.
 * Ensures no more than `maxPerCategory` items from the same category are picked,
 * keeping the highest scoring candidates.
 */
export function applyCategoryDiversity(
  candidates: RecommendationItem[],
  maxPerCategory: number,
  limit: number
): RecommendationItem[] {
  const categoryCounts = new Map<string, number>()
  const selected: RecommendationItem[] = []

  for (const item of candidates) {
    const currentCount = categoryCounts.get(item.categoryId) ?? 0
    if (currentCount < maxPerCategory) {
      selected.push(item)
      categoryCounts.set(item.categoryId, currentCount + 1)
      if (selected.length >= limit) break
    }
  }

  return selected
}
