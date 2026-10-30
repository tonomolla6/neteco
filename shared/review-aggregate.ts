import { z } from 'zod'

/** SEO-026: AggregateRating is emitted only from the store's own verified, moderated reviews. */
export const AGGREGATE_RATING_MIN_REVIEWS = 5
export const REVIEW_POLICY_VERSION = '2026-v1'
export const REVIEW_POLICY_TEXT =
  'Solo mostramos opiniones de compradores verificados de NETECO, moderadas antes de publicarse. ' +
  'No incluimos opiniones del personal ni de la tienda, ni reseñas bloqueadas por riesgo de fraude o retiradas por su autor. ' +
  `La valoración media solo se publica a partir de ${AGGREGATE_RATING_MIN_REVIEWS} opiniones.`

const star = z.number().int().nonnegative()
export const productReviewSeoSummarySchema = z
  .object({
    eligibleCount: z.number().int().nonnegative(),
    averageRating: z.number().min(0).max(5),
    distribution: z.object({ 1: star, 2: star, 3: star, 4: star, 5: star }).strict(),
    minimumCount: z.number().int().positive(),
    eligible: z.boolean(),
    policy: z.object({ version: z.string().min(1).max(32), text: z.string().min(10).max(1000) }).strict()
  })
  .strict()
export type ProductReviewSeoSummary = z.infer<typeof productReviewSeoSummarySchema>

export function emptyReviewDistribution() {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
}

/** Builds schema.org AggregateRating or null. Revalidates so a tampered/inconsistent summary never yields markup. */
export function buildAggregateRatingJsonLd(summary: ProductReviewSeoSummary) {
  const parsed = productReviewSeoSummarySchema.safeParse(summary)
  if (!parsed.success) return null
  const s = parsed.data
  const total = Object.values(s.distribution).reduce((a, b) => a + b, 0)
  if (
    !s.eligible ||
    s.eligibleCount < Math.max(s.minimumCount, AGGREGATE_RATING_MIN_REVIEWS) ||
    total !== s.eligibleCount ||
    s.averageRating < 1
  )
    return null
  return {
    '@type': 'AggregateRating' as const,
    ratingValue: s.averageRating.toFixed(1),
    reviewCount: s.eligibleCount,
    ratingCount: s.eligibleCount,
    bestRating: '5',
    worstRating: '1'
  }
}
