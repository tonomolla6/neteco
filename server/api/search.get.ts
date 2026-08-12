import { useDatabase } from '../db/client'

export default defineEventHandler(async (event) => {
  const term = String(getQuery(event).q ?? '').trim()
  if (term.length < 2) return { items: [] }

  const sql = useDatabase()
  const items = await sql<
    Array<{
      name: string
      slug: string
      brand: string
      visual: { type: string; color: string }
      image: string | null
      minPrice: number
    }>
  >`
    SELECT p.name, p.slug, COALESCE(b.name, 'NETECO') AS brand,
           COALESCE(p.attributes -> 'visual', '{"type":"botella","color":"#64748b"}'::jsonb) AS visual,
           p.attributes ->> 'image' AS image, min(v.price_gross_cents)::int AS "minPrice"
    FROM products p
    LEFT JOIN brands b ON b.id = p.brand_id
    JOIN variants v ON v.product_id = p.id AND v.status = 'published'
    WHERE p.status = 'published'
      AND (
        p.search_document @@ websearch_to_tsquery('spanish', ${term})
        OR p.name ILIKE ${`%${term}%`}
        OR b.name ILIKE ${`%${term}%`}
        OR EXISTS (
          SELECT 1 FROM variants exact_variant
          WHERE exact_variant.product_id = p.id AND exact_variant.sku ILIKE ${`%${term}%`}
        )
      )
    GROUP BY p.id, b.name
    ORDER BY
      max(CASE WHEN v.sku = ${term} THEN 1 ELSE 0 END) DESC,
      ts_rank(p.search_document, websearch_to_tsquery('spanish', ${term})) DESC,
      p.featured DESC,
      p.name
    LIMIT 8
  `
  return { items }
})
