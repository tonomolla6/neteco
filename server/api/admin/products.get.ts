import { z } from 'zod'
import { useDatabase } from '../../db/client'

const querySchema = z.object({
  q: z.string().trim().max(160).optional(),
  category: z.coerce.number().int().positive().optional(),
  active: z.enum(['0', '1']).optional(),
  status: z.enum(['draft', 'review', 'published', 'hidden', 'discontinued']).optional()
})

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const query = querySchema.parse(getQuery(event))
  const sql = useDatabase()
  const items = await sql<
    Array<{
      id: number
      name: string
      slug: string
      brand: string
      featured: boolean
      active: boolean
      status: 'draft' | 'review' | 'published' | 'hidden' | 'discontinued'
      series: string | null
      visual: { type: string; color: string }
      categoryId: number
      categoryName: string
      minPrice: number
      formats: number
    }>
  >`
    SELECT p.legacy_id AS id, p.name, p.slug, COALESCE(b.name, 'NETECO') AS brand,
           p.featured, p.status = 'published' AS active, p.status, p.series,
           COALESCE(p.attributes -> 'visual', '{"type":"botella","color":"#64748b"}'::jsonb) AS visual,
           c.legacy_id AS "categoryId", c.name AS "categoryName",
           min(price.gross_cents)::int AS "minPrice", count(v.id)::int AS formats
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN brands b ON b.id = p.brand_id
    LEFT JOIN variants v ON v.product_id = p.id
    LEFT JOIN effective_variant_prices price ON price.variant_id = v.id
    WHERE (${query.q ?? null}::text IS NULL OR p.name ILIKE ${query.q ? `%${query.q}%` : null}
           OR b.name ILIKE ${query.q ? `%${query.q}%` : null}
           OR EXISTS (SELECT 1 FROM variants sku WHERE sku.product_id = p.id AND sku.sku ILIKE ${query.q ? `%${query.q}%` : null}))
      AND (${query.category ?? null}::int IS NULL OR c.legacy_id = ${query.category ?? null})
      AND (${query.active ?? null}::text IS NULL
           OR (${query.active ?? null} = '1' AND p.status = 'published')
           OR (${query.active ?? null} = '0' AND p.status <> 'published'))
      AND (${query.status ?? null}::text IS NULL OR p.status = ${query.status ?? null})
    GROUP BY p.id, b.name, c.legacy_id, c.name
    ORDER BY lower(p.name)
    LIMIT 500
  `
  return { items }
})
