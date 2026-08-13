import { useDatabase } from '../db/client'
import { uniqueSearchTerms } from '../utils/search-terms'

export default defineEventHandler(async (event) => {
  const term = String(getQuery(event).q ?? '').trim()
  if (term.length < 2) return { items: [] }

  const sql = useDatabase()
  const synonymRows = await sql<Array<{ replacements: string[] }>>`
    SELECT replacements FROM search_synonyms
    WHERE active = true
      AND lower(unaccent(source_term::text)) = lower(unaccent(${term}))
    ORDER BY source_term
  `
  const expandedTerms = uniqueSearchTerms(
    term,
    synonymRows.map((row) => row.replacements)
  )
  const items = await sql<
    Array<{
      name: string
      slug: string
      brand: string
      visual: { type: string; color: string }
      image: string | null
      minPrice: number
      sku: string | null
    }>
  >`
    SELECT p.name, p.slug, COALESCE(b.name, 'NETECO') AS brand,
           COALESCE(p.attributes -> 'visual', '{"type":"botella","color":"#64748b"}'::jsonb) AS visual,
           p.attributes ->> 'image' AS image, min(v.price_gross_cents)::int AS "minPrice",
           (
             SELECT exact_variant.sku FROM variants exact_variant
             WHERE exact_variant.product_id = p.id AND exact_variant.status = 'published'
               AND exact_variant.sku ILIKE ${`%${term}%`}
             ORDER BY CASE WHEN exact_variant.sku = ${term} THEN 0 ELSE 1 END, exact_variant.sku
             LIMIT 1
           ) AS sku
    FROM products p
    LEFT JOIN brands b ON b.id = p.brand_id
    JOIN variants v ON v.product_id = p.id AND v.status = 'published'
    WHERE p.status = 'published'
      AND (
        p.search_document @@ websearch_to_tsquery('spanish', ${term})
        OR EXISTS (
          SELECT 1 FROM unnest(${expandedTerms}::text[]) expanded(term)
          WHERE p.search_document @@ websearch_to_tsquery('spanish', expanded.term)
        )
        OR lower(p.name) % lower(${term})
        OR lower(unaccent(p.name)) % lower(unaccent(${term}))
        OR p.name ILIKE ${`%${term}%`}
        OR b.name ILIKE ${`%${term}%`}
        OR EXISTS (
          SELECT 1 FROM categories search_category
          WHERE search_category.id = p.category_id
            AND lower(unaccent(search_category.name)) % lower(unaccent(${term}))
        )
        OR p.attributes::text ILIKE ${`%${term}%`}
        OR EXISTS (
          SELECT 1 FROM variants exact_variant
          WHERE exact_variant.product_id = p.id
            AND (exact_variant.sku ILIKE ${`%${term}%`} OR exact_variant.ean ILIKE ${`%${term}%`}
              OR exact_variant.gtin ILIKE ${`%${term}%`} OR exact_variant.mpn ILIKE ${`%${term}%`})
        )
      )
    GROUP BY p.id, b.name
    ORDER BY
      max(CASE WHEN v.sku = ${term} OR v.ean = ${term} OR v.gtin = ${term} OR v.mpn = ${term} THEN 1 ELSE 0 END) DESC,
      (SELECT max(ts_rank(p.search_document, websearch_to_tsquery('spanish', expanded.term)))
       FROM unnest(${expandedTerms}::text[]) expanded(term)) DESC,
      similarity(lower(p.name), lower(${term})) DESC,
      p.featured DESC,
      p.name
    LIMIT 8
  `
  return { items }
})
