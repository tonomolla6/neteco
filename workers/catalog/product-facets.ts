import type { ProductFacets } from '../../shared/types/catalog'
import { sellableExpression } from './inventory'

export interface ProductFacetFilter {
  key: string
  clause: string
  parameters: Array<string | number>
}

export interface ProductFacetRow {
  value: string
  n: number
  units?: number
  label?: string
  hex?: string | null
  id?: number
  name?: string
  slug?: string
  min?: number | null
  max?: number | null
}

const KEYS = [
  'brand',
  'badge',
  'envase',
  'price',
  'category',
  'talla',
  'capacidad',
  'color',
  'medida',
  'acabado',
  'stock'
]
/** Number of statements prepareProductFacetStatements adds to the listing batch. */
export const PRODUCT_FACET_STATEMENTS = KEYS.length
const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']
const CAPACITY_ORDER: Record<string, number> = { L: 0, kg: 1, ud: 2, unidad: 2 }
const byCount = (left: { value: string; n: number }, right: { value: string; n: number }) =>
  right.n - left.n ||
  left.value.localeCompare(right.value, 'es') ||
  (left.value < right.value ? -1 : left.value > right.value ? 1 : 0)

// Exactly String.split(' · '), followed by /^Color (.+)$/ on the LAST
// segment. Earlier Color segments remain ordinary axes, as in the legacy JS.
const SEGMENTS = `,facet_segments(variantId,productId,remaining,segment,position) AS (
  SELECT variantId,productId,format,NULL,0 FROM facet_variants
  UNION ALL
  SELECT variantId,productId,
    CASE WHEN instr(remaining,' · ')=0 THEN NULL ELSE substr(remaining,instr(remaining,' · ')+3) END,
    CASE WHEN instr(remaining,' · ')=0 THEN remaining ELSE substr(remaining,1,instr(remaining,' · ')-1) END,
    position+1 FROM facet_segments WHERE remaining IS NOT NULL
),facet_last AS MATERIALIZED (
  SELECT variantId,max(position) AS position FROM facet_segments GROUP BY variantId
),facet_colors AS MATERIALIZED (
  SELECT segment.variantId,segment.productId,substr(segment.segment,7) AS value
  FROM facet_segments segment JOIN facet_last last ON last.variantId=segment.variantId AND last.position=segment.position
  WHERE substr(segment.segment,1,6)='Color ' AND length(substr(segment.segment,7))>0
    AND instr(segment.segment,char(10))=0 AND instr(segment.segment,char(13))=0
    AND instr(segment.segment,char(8232))=0 AND instr(segment.segment,char(8233))=0
)`

// ECMAScript \s, not SQLite trim() or just the ASCII space character.
const PRECORTE = `lower(substr(segment.segment,1,8))='precorte' AND unicode(substr(segment.segment,9,1)) IN (
  9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)`

/**
 * «Solo en stock»: el producto tiene al menos un formato publicado con existencias
 * vendibles (físico menos bloqueado, stock de seguridad y reservas activas).
 */
export const IN_STOCK_CLAUSE = `EXISTS (SELECT 1 FROM variants stock_variant
  WHERE stock_variant.product_id = p.id AND stock_variant.status = 'published'
    AND (SELECT TOTAL(${sellableExpression()}) FROM inventory_balances b WHERE b.variant_id = stock_variant.id) > 0)`

export function prepareProductFacetStatements(
  database: D1Database,
  options: { effectiveSummary: string; instantParameters: string[]; joins: string; filters: ProductFacetFilter[] }
) {
  return KEYS.map((key) => {
    const filters = options.filters.filter((filter) => filter.key !== key)
    // Materialize the deep authority/filter expression independently of the
    // aggregation/axis expression, preserving D1's expression-depth budget.
    let sql = `${options.effectiveSummary},facet_products AS MATERIALIZED (
      SELECT p.id,COALESCE(b.name,'NETECO') AS brand,summary.minPrice,
        COALESCE(json_extract(p.attributes,'$.badges'),'[]') AS badgesJson,
        COALESCE(json_extract(p.attributes,'$.visual'),'{"type":"botella","color":"#64748b"}') AS visualJson,
        c.legacy_id AS categoryId,c.name AS categoryName,c.slug AS categorySlug
      ${options.joins} WHERE ${filters.map((filter) => filter.clause).join(' AND ') || '1'}
    )`
    if (['talla', 'capacidad', 'color', 'medida', 'acabado'].includes(key))
      sql += `,facet_variants AS MATERIALIZED (
        SELECT v.id AS variantId,v.product_id AS productId,v.format,v.content_quantity AS units,v.unit_label AS label,v.color
        FROM facet_products p JOIN variants v ON v.product_id=p.id AND v.status='published'
      )`
    if (['color', 'medida', 'acabado'].includes(key)) sql += SEGMENTS
    const query: Record<string, string> = {
      brand: "SELECT brand AS value,count(*) AS n FROM facet_products WHERE brand<>'' GROUP BY brand",
      badge: `SELECT badge.value AS value,count(*) AS n FROM facet_products p
        CROSS JOIN json_each(CASE WHEN json_valid(p.badgesJson) THEN CASE WHEN json_type(p.badgesJson)='array' THEN p.badgesJson ELSE '[]' END ELSE '[]' END) badge
        WHERE badge.value IS NOT NULL AND badge.value<>'' AND NOT(badge.type IN ('false','integer','real') AND badge.value=0)
        GROUP BY badge.value`,
      envase: `SELECT CASE WHEN json_valid(visualJson) THEN json_extract(visualJson,'$.type') END AS value,count(*) AS n FROM facet_products
        WHERE value IS NOT NULL AND value<>'' GROUP BY value`,
      price: 'SELECT MIN(minPrice) AS min,MAX(minPrice) AS max FROM facet_products',
      category:
        'SELECT categoryId AS id,categoryName AS name,categorySlug AS slug,count(*) AS n FROM facet_products GROUP BY categoryId,categoryName,categorySlug',
      talla:
        "SELECT substr(format,7) AS value,count(DISTINCT productId) AS n FROM facet_variants WHERE substr(format,1,6)='Talla ' GROUP BY value",
      capacidad: 'SELECT units,label,count(DISTINCT productId) AS n FROM facet_variants GROUP BY units,label',
      color: `,facet_color_hex AS MATERIALIZED (
          SELECT color.value,min(variant.variantId) AS variantId FROM facet_colors color
          JOIN facet_variants variant ON variant.variantId=color.variantId
          WHERE variant.color IS NOT NULL AND variant.color<>'' GROUP BY color.value
        )
        SELECT color.value,count(DISTINCT color.productId) AS n,hex.color AS hex FROM facet_colors color
        LEFT JOIN facet_color_hex representative ON representative.value=color.value
        LEFT JOIN facet_variants hex ON hex.variantId=representative.variantId GROUP BY color.value`,
      medida: `SELECT segment.segment AS value,count(DISTINCT segment.productId) AS n
        FROM facet_segments segment JOIN facet_last last ON last.variantId=segment.variantId AND segment.position<last.position
        JOIN facet_colors color ON color.variantId=segment.variantId
        WHERE segment.segment GLOB '*[0-9]*' AND instr(lower(segment.segment),'precort')=0 GROUP BY segment.segment`,
      acabado: `SELECT CASE WHEN ${PRECORTE} THEN 'Precortado' ELSE segment.segment END AS value,count(DISTINCT segment.productId) AS n
        FROM facet_segments segment JOIN facet_last last ON last.variantId=segment.variantId AND segment.position<last.position
        JOIN facet_colors color ON color.variantId=segment.variantId
        WHERE NOT(segment.segment GLOB '*[0-9]*' AND instr(lower(segment.segment),'precort')=0)
        GROUP BY CASE WHEN ${PRECORTE} THEN 'Precortado' ELSE segment.segment END`,
      stock: `SELECT count(*) AS n FROM facet_products p WHERE ${IN_STOCK_CLAUSE}`
    }
    return database
      .prepare(sql + '\n' + query[key])
      .bind(...options.instantParameters, ...filters.flatMap((filter) => filter.parameters))
  })
}

export function decodeProductFacetResults(results: ReadonlyArray<{ results?: unknown[] }>): ProductFacets {
  const rows = (index: number) => (results[index]?.results ?? []) as ProductFacetRow[]
  const tallas = rows(5)
    .map(({ value, n }) => ({ value, n }))
    .sort((left, right) => {
      const rank = (value: string) => {
        const index = SIZE_ORDER.indexOf(value)
        return index < 0 ? 999 : index
      }
      // Unknown sizes used to inherit undefined SQL encounter order. Their tie
      // is now explicitly Spanish locale + raw value, independent of row order.
      return (
        rank(left.value) - rank(right.value) ||
        left.value.localeCompare(right.value, 'es') ||
        (left.value < right.value ? -1 : left.value > right.value ? 1 : 0)
      )
    })
  const capacidades = rows(6)
    .map((row) => ({ value: `${row.units}-${row.label}`, units: row.units!, label: row.label!, n: row.n }))
    .sort(
      (left, right) =>
        (CAPACITY_ORDER[left.label] ?? 9) - (CAPACITY_ORDER[right.label] ?? 9) ||
        left.units - right.units ||
        left.label.localeCompare(right.label, 'es')
    )
  const price = rows(3)[0]
  return {
    brands: rows(0)
      .map(({ value, n }) => ({ value, n }))
      .sort(byCount),
    badges: rows(1)
      .map(({ value, n }) => ({ value, n }))
      .sort(byCount),
    envases: rows(2)
      .map(({ value, n }) => ({ value, n }))
      .sort(byCount),
    tallas,
    capacidades,
    colores: rows(7)
      .map(({ value, n, hex }) => ({ value, n, hex: hex ?? null }))
      .sort(byCount),
    medidas: rows(8)
      .map(({ value, n }) => ({ value, n }))
      .sort(byCount),
    acabados: rows(9)
      .map(({ value, n }) => ({ value, n }))
      .sort(byCount),
    price: price?.min == null || price.max == null ? null : { min: price.min, max: price.max },
    inStock: Number(rows(10)[0]?.n ?? 0),
    categories: rows(4)
      .map((row) => ({ id: row.id!, name: row.name!, slug: row.slug!, n: row.n }))
      .sort((left, right) => right.n - left.n || left.name.localeCompare(right.name, 'es') || left.id - right.id)
  }
}
