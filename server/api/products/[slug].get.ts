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
  attrs: Array<{ k: string; v: string }>
  regulatory: {
    signalWord?: string
    ufi?: string
    registrationNumber?: string
    hazardStatements?: string[]
    precautionaryStatements?: string[]
  }
}

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  const sql = useDatabase()
  const [product] = await sql<ProductDetail[]>`
    SELECT p.id AS uuid, p.legacy_id AS id, p.name, p.slug, COALESCE(b.name, 'NETECO') AS brand,
           c.legacy_id AS "categoryId", p.short_description AS "shortDesc", p.description,
           p.usage, COALESCE(p.attributes -> 'badges', '[]'::jsonb) AS badges,
           COALESCE(p.attributes -> 'visual', '{"type":"botella","color":"#64748b"}'::jsonb) AS visual,
           p.attributes ->> 'image' AS image, p.attributes ->> 'datasheet' AS datasheet, p.featured, p.series,
           COALESCE(p.attributes -> 'attrs', '[]'::jsonb) AS attrs,
           COALESCE(p.regulatory, '{}'::jsonb) AS regulatory
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
      ean: string | null
      gtin: string | null
      mpn: string | null
      price: number
      stock: number
      units: number
      unitBase: string
      unitLabel: string
      unitsPerCase: number
      casesPerPallet: number | null
      minimumQuantity: number
      maximumQuantity: number | null
      quantityIncrement: number
      backorderAllowed: boolean
      leadTimeDays: number | null
      color: string | null
      image: string | null
    }>
  >`
    SELECT v.id AS uuid, v.legacy_id AS id, v.format, v.sku, v.ean, v.gtin, v.mpn,
           v.price_gross_cents AS price,
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
           v.content_quantity::float8 AS units, v.unit_base AS "unitBase", v.unit_label AS "unitLabel",
           v.units_per_case AS "unitsPerCase", v.cases_per_pallet AS "casesPerPallet",
           v.minimum_quantity AS "minimumQuantity", v.maximum_quantity AS "maximumQuantity",
           v.quantity_increment AS "quantityIncrement", v.backorder_allowed AS "backorderAllowed",
           v.lead_time_days AS "leadTimeDays", v.color, v.image
    FROM variants v
    LEFT JOIN inventory_balances ib ON ib.variant_id = v.id
    WHERE v.product_id = ${product.uuid} AND v.status = 'published'
    GROUP BY v.id
    ORDER BY v.legacy_id
  `
  const siblings = product.series
    ? await sql<Array<{ name: string; slug: string; visual: { type: string; color: string }; image: string | null }>>`
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
      image: string | null
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
  const documents = await sql<
    Array<{
      id: string
      role: 'datasheet' | 'sds' | 'certificate' | 'label'
      name: string
      url: string
      version: string
      language: string | null
      authorizedAt: string | null
    }>
  >`
    SELECT asset.id, media.role, asset.original_name AS name, '/media/' || asset.id::text AS url,
           media.version, asset.metadata ->> 'language' AS language,
           asset.authorized_at::text AS "authorizedAt"
    FROM product_media media
    JOIN media_assets asset ON asset.id = media.asset_id
    WHERE media.product_id = ${product.uuid}
      AND media.role IN ('datasheet', 'sds', 'certificate', 'label')
      AND asset.rights_status = 'approved' AND asset.quarantine_status = 'clean'
    ORDER BY CASE media.role WHEN 'sds' THEN 1 WHEN 'datasheet' THEN 2 WHEN 'label' THEN 3 ELSE 4 END,
             media.sort_order, asset.original_name
  `
  const { uuid: _uuid, ...publicProduct } = product
  return { ...publicProduct, variants, siblings, breadcrumb, related, documents }
})
