import { useDatabase } from '../../../db/client'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  const sql = useDatabase()
  const [product] = await sql<
    Array<{
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
      featured: boolean
      active: boolean
      series: string | null
    }>
  >`
    SELECT p.id AS uuid, p.legacy_id AS id, p.name, p.slug, COALESCE(b.name, 'NETECO') AS brand,
           c.legacy_id AS "categoryId", p.short_description AS "shortDesc", p.description,
           p.usage, COALESCE(p.attributes -> 'badges', '[]'::jsonb) AS badges,
           COALESCE(p.attributes -> 'visual', '{"type":"caja","color":"#009ac9"}'::jsonb) AS visual,
           p.featured, p.status = 'published' AS active, p.series
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN brands b ON b.id = p.brand_id
    WHERE p.legacy_id = ${id}
  `
  if (!product) throw createError({ statusCode: 404, statusMessage: 'Producto no encontrado' })
  const variants = await sql<
    Array<{
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
    SELECT v.legacy_id AS id, v.format, v.sku, v.price_gross_cents AS price,
           COALESCE(sum(balance.physical_quantity), 0)::int AS stock,
           v.content_quantity::float8 AS units, v.unit_label AS "unitLabel",
           NULL::text AS color, NULL::text AS image
    FROM variants v
    LEFT JOIN inventory_balances balance ON balance.variant_id = v.id
    WHERE v.product_id = ${product.uuid} AND v.status <> 'discontinued'
    GROUP BY v.id ORDER BY v.legacy_id
  `
  const { uuid: _uuid, ...publicProduct } = product
  return { ...publicProduct, variants }
})
