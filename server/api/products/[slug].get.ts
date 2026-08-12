import { useDatabase } from '../../db/client'

interface ProductDetail {
  uuid: string
  id: number
  name: string
  slug: string
  brand: string
  categoryId: number
  shortDesc: string | null
  description: string | null
  usage: string | null
  badges: string[]
  visual: { type: string; color: string }
  image: string | null
  datasheet: string | null
  featured: boolean
  series: string | null
}

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  const sql = useDatabase()
  const [product] = await sql<ProductDetail[]>`
    SELECT p.id AS uuid, p.legacy_id AS id, p.name, p.slug, COALESCE(b.name, 'NETECO') AS brand,
           c.legacy_id AS "categoryId", p.short_description AS "shortDesc", p.description,
           p.usage, COALESCE(p.attributes -> 'badges', '[]'::jsonb) AS badges,
           COALESCE(p.attributes -> 'visual', '{"type":"botella","color":"#64748b"}'::jsonb) AS visual,
           p.attributes ->> 'image' AS image, p.attributes ->> 'datasheet' AS datasheet, p.featured, p.series
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN brands b ON b.id = p.brand_id
    WHERE p.slug = ${slug ?? ''} AND p.status = 'published'
  `
  if (!product) throw createError({ statusCode: 404, statusMessage: 'Producto no encontrado' })

  const variants = await sql<
    Array<{
      uuid: string
      id: number
      format: string
      sku: string
      price: number
      stock: number
      units: number
      unitLabel: string
      color: string | null
      image: string | null
    }>
  >`
    SELECT v.id AS uuid, v.legacy_id AS id, v.format, v.sku, v.price_gross_cents AS price,
           greatest(
             COALESCE(sum(ib.physical_quantity - ib.blocked_quantity), 0)
             - v.safety_stock
             - COALESCE((
               SELECT sum(ir.quantity)::int
               FROM inventory_reservations ir
               WHERE ir.variant_id = v.id AND ir.status = 'active' AND ir.expires_at > now()
             ), 0),
             0
           )::int AS stock,
           v.content_quantity::float8 AS units, v.unit_label AS "unitLabel",
           NULL::text AS color, NULL::text AS image
    FROM variants v
    LEFT JOIN inventory_balances ib ON ib.variant_id = v.id
    WHERE v.product_id = ${product.uuid} AND v.status = 'published'
    GROUP BY v.id
    ORDER BY v.legacy_id
  `

  const siblings = product.series
    ? await sql<Array<{ name: string; slug: string; visual: { type: string; color: string }; image: null }>>`
        SELECT sibling.name, sibling.slug,
               COALESCE(sibling.attributes -> 'visual', '{"type":"botella","color":"#64748b"}'::jsonb) AS visual,
               sibling.attributes ->> 'image' AS image
        FROM products sibling
        WHERE sibling.series = ${product.series} AND sibling.id <> ${product.uuid}
          AND sibling.status = 'published'
        ORDER BY sibling.name
      `
    : []

  const breadcrumb = await sql<Array<{ name: string; slug: string }>>`
    WITH RECURSIVE ancestors AS (
      SELECT c.id, c.parent_id, c.name, c.slug, 0 AS depth
      FROM categories c
      WHERE c.legacy_id = ${product.categoryId}
      UNION ALL
      SELECT parent.id, parent.parent_id, parent.name, parent.slug, child.depth + 1
      FROM categories parent
      JOIN ancestors child ON child.parent_id = parent.id
    )
    SELECT name, slug FROM ancestors ORDER BY depth DESC
  `
  const related = await sql<
    Array<{
      id: number
      name: string
      slug: string
      brand: string
      badges: string[]
      visual: { type: string; color: string }
      image: null
      minPrice: number
      formats: number
    }>
  >`
    SELECT related.legacy_id AS id, related.name, related.slug, COALESCE(b.name, 'NETECO') AS brand,
           COALESCE(related.attributes -> 'badges', '[]'::jsonb) AS badges,
           COALESCE(related.attributes -> 'visual', '{"type":"botella","color":"#64748b"}'::jsonb) AS visual,
           related.attributes ->> 'image' AS image, min(v.price_gross_cents)::int AS "minPrice", count(v.id)::int AS formats
    FROM products related
    LEFT JOIN brands b ON b.id = related.brand_id
    JOIN variants v ON v.product_id = related.id AND v.status = 'published'
    WHERE related.category_id = (SELECT category_id FROM products WHERE id = ${product.uuid})
      AND related.id <> ${product.uuid} AND related.status = 'published'
    GROUP BY related.id, b.name
    ORDER BY related.featured DESC, related.name
    LIMIT 4
  `
  const { uuid: _uuid, ...publicProduct } = product
  return { ...publicProduct, variants, siblings, breadcrumb, related }
})
