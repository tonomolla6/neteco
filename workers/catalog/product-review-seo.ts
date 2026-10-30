import {
  AGGREGATE_RATING_MIN_REVIEWS,
  REVIEW_POLICY_TEXT,
  REVIEW_POLICY_VERSION,
  emptyReviewDistribution,
  productReviewSeoSummarySchema,
  type ProductReviewSeoSummary
} from '../../shared/review-aggregate'

/**
 * SEO-026: eligible = approved + verified buyer + clean fraud status + consent kept + not authored by an
 * identity holding any staff role (no self-reviews). One aggregate query, no N+1.
 */
export async function readProductReviewSeoSummary(
  db: D1Database,
  productRef: string
): Promise<ProductReviewSeoSummary> {
  const ref = /^[A-Za-z0-9_-]{1,64}$/.test(productRef) ? productRef : null
  const distribution = emptyReviewDistribution()
  if (ref) {
    const rows = await db
      .prepare(
        `SELECT r.rating AS rating, COUNT(*) AS n
         FROM product_reviews r
         JOIN products p ON p.id = r.product_id
         WHERE (p.id = ?1 OR CAST(p.legacy_id AS TEXT) = ?1)
           AND r.moderation_status = 'approved' AND r.is_verified_buyer = 1
           AND r.fraud_status = 'clean' AND r.consent_accepted = 1
           AND NOT EXISTS (
             SELECT 1 FROM identities i JOIN identity_roles ir ON ir.identity_id = i.id
             WHERE i.customer_id = r.customer_id)
         GROUP BY r.rating`
      )
      .bind(ref)
      .all<{ rating: number; n: number }>()
    for (const row of rows.results ?? []) {
      if (row.rating >= 1 && row.rating <= 5) distribution[row.rating as 1 | 2 | 3 | 4 | 5] = Number(row.n)
    }
  }
  const eligibleCount = Object.values(distribution).reduce((a, b) => a + b, 0)
  const sum = Object.entries(distribution).reduce((a, [k, v]) => a + Number(k) * v, 0)
  return productReviewSeoSummarySchema.parse({
    eligibleCount,
    averageRating: eligibleCount ? Number((sum / eligibleCount).toFixed(1)) : 0,
    distribution,
    minimumCount: AGGREGATE_RATING_MIN_REVIEWS,
    eligible: eligibleCount >= AGGREGATE_RATING_MIN_REVIEWS,
    policy: { version: REVIEW_POLICY_VERSION, text: REVIEW_POLICY_TEXT }
  })
}
