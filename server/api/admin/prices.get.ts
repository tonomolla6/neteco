import { z } from 'zod'
import { useDatabase } from '../../db/client'

const querySchema = z.object({ q: z.string().trim().max(160).optional() })

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const query = querySchema.parse(getQuery(event))
  const sql = useDatabase()
  const items = await sql`
    SELECT variant.id AS "variantId", variant.legacy_id AS id, variant.sku, variant.format,
           product.name AS product, price.gross_cents AS "grossCents",
           price.compare_at_gross_cents AS "compareAtGrossCents",
           price.reference_gross_cents_30d AS "referenceGrossCents30d",
           price.volume_tiers AS "volumeTiers", price.pricing_version AS "pricingVersion",
           price.valid_from AS "validFrom",
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'id', history.id, 'grossCents', history.gross_cents,
               'compareAtGrossCents', history.compare_at_gross_cents,
               'referenceGrossCents30d', history.reference_gross_cents_30d,
               'volumeTiers', history.volume_tiers, 'validFrom', history.valid_from,
               'validUntil', history.valid_until, 'status', history.status,
               'reason', history.reason
             ) ORDER BY history.valid_from DESC, history.created_at DESC)
             FROM variant_price_versions history WHERE history.variant_id = variant.id
           ), '[]'::jsonb) AS history
    FROM variants variant
    JOIN products product ON product.id = variant.product_id
    JOIN effective_variant_prices price ON price.variant_id = variant.id
    WHERE variant.status <> 'discontinued'
      AND (${query.q ?? null}::text IS NULL OR product.name ILIKE ${query.q ? `%${query.q}%` : null}
        OR variant.sku ILIKE ${query.q ? `%${query.q}%` : null})
    ORDER BY lower(product.name), variant.legacy_id
    LIMIT 500
  `
  return { items }
})
