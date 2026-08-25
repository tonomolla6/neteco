import {
  effectiveGrossCentsExpression,
  parameterizeEffectivePricingSql,
  resolvePricingInstant,
  type EffectivePricingOptions
} from './pricing'

export type ProductSort = 'default' | 'name' | 'price_asc' | 'price_desc'

export interface ProductQuery {
  category?: string
  search?: string
  page: number
  limit: number
  sort: ProductSort
}

interface ProductRecord {
  uuid: string
  id: number
  name: string
  slug: string
  brand: string
  badgesJson: string
  visualJson: string
  image: string | null
  featured: number
  shortDesc: string | null
  categoryId: number
  minPrice: number
  minNetPrice: number
  formats: number
}

export interface D1ProductSummary {
  uuid: string
  id: number
  name: string
  slug: string
  brand: string
  badges: string[]
  visual: { type: string; color: string }
  image: string | null
  featured: boolean
  shortDesc: string | null
  categoryId: number
  minPrice: number
  minNetPrice: number
  formats: number
}

export interface D1ProductListResponse {
  items: D1ProductSummary[]
  total: number
  page: number
  pages: number
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function ftsQuery(value: string) {
  return (value.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [])
    .slice(0, 8)
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(' AND ')
}

export async function listPublishedProducts(
  database: D1Database,
  query: ProductQuery,
  pricingOptions?: EffectivePricingOptions
): Promise<D1ProductListResponse | null> {
  const instant = resolvePricingInstant(pricingOptions)
  const conditions = ["p.status = 'published'"]
  const parameters: Array<string | number> = []

  if (query.category) {
    const category = await database
      .prepare("SELECT id FROM categories WHERE slug = ? AND status = 'published'")
      .bind(query.category)
      .first<{ id: string }>()
    if (!category) return null
    conditions.push(`p.category_id IN (
      WITH RECURSIVE tree(id) AS (
        SELECT id FROM categories WHERE slug = ? AND status = 'published'
        UNION
        SELECT child.id FROM categories child JOIN tree parent ON child.parent_id = parent.id
        WHERE child.status = 'published'
      )
      SELECT id FROM tree
    )`)
    parameters.push(query.category)
  }

  if (query.search) {
    const match = ftsQuery(query.search)
    if (match) {
      conditions.push(`(
        p.rowid IN (SELECT rowid FROM products_fts WHERE products_fts MATCH ?)
        OR lower(p.name) LIKE ?
        OR lower(COALESCE(b.name, '')) LIKE ?
        OR EXISTS (
          SELECT 1 FROM variants search_variant
          WHERE search_variant.product_id = p.id
            AND lower(COALESCE(search_variant.sku, '')) LIKE ?
        )
      )`)
      const like = `%${query.search.toLocaleLowerCase('es')}%`
      parameters.push(match, like, like, like)
    }
  }

  const { sql: effectiveSummary, instantParameters } = parameterizeEffectivePricingSql(
    `WITH effective_variant_prices AS (
      SELECT variant.id AS variantId,
             ${effectiveGrossCentsExpression('variant')} AS grossCents
      FROM variants variant
      WHERE variant.status = 'published'
    ),
    variant_summary AS (
      SELECT priced.product_id,
             min(effective.grossCents) AS minPrice,
             min(CAST(round((effective.grossCents * 10000.0) /
                            (10000 + tax.rate_basis_points)) AS INTEGER)) AS minNetPrice,
             count(*) AS formats
      FROM variants priced
      JOIN effective_variant_prices effective ON effective.variantId = priced.id
      JOIN tax_classes tax ON tax.id = priced.tax_class_id
      WHERE priced.status = 'published'
      GROUP BY priced.product_id
    )`,
    instant
  )
  const joins = `FROM products p
    JOIN categories c ON c.id = p.category_id AND c.status = 'published'
    LEFT JOIN brands b ON b.id = p.brand_id
    JOIN variant_summary summary ON summary.product_id = p.id AND summary.formats > 0`
  const where = `WHERE ${conditions.join(' AND ')}`
  const orderBy =
    {
      default: 'p.featured DESC, lower(p.name), p.id',
      name: 'lower(p.name), p.id',
      price_asc: 'summary.minPrice ASC, lower(p.name), p.id',
      price_desc: 'summary.minPrice DESC, lower(p.name), p.id'
    }[query.sort] ?? 'p.featured DESC, lower(p.name), p.id'

  const countStatement = database
    .prepare(`${effectiveSummary} SELECT count(*) AS total ${joins} ${where}`)
    .bind(...instantParameters, ...parameters)
  const listStatement = database
    .prepare(
      `${effectiveSummary}
      SELECT p.id AS uuid,
             p.legacy_id AS id,
             p.name,
             p.slug,
             COALESCE(b.name, 'NETECO') AS brand,
             COALESCE(json_extract(p.attributes, '$.badges'), '[]') AS badgesJson,
             COALESCE(json_extract(p.attributes, '$.visual'), '{"type":"botella","color":"#64748b"}') AS visualJson,
             json_extract(p.attributes, '$.image') AS image,
             p.featured,
             p.short_description AS shortDesc,
             c.legacy_id AS categoryId,
             summary.minPrice,
             summary.minNetPrice,
             summary.formats
      ${joins}
      ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`
    )
    .bind(...instantParameters, ...parameters, query.limit, (query.page - 1) * query.limit)
  const [countResult, listResult] = await database.batch<ProductRecord | { total: number }>([
    countStatement,
    listStatement
  ])
  const total = Number((countResult?.results[0] as { total?: number } | undefined)?.total ?? 0)
  const records = (listResult?.results ?? []) as ProductRecord[]

  return {
    items: records.map((record) => ({
      uuid: record.uuid,
      id: record.id,
      name: record.name,
      slug: record.slug,
      brand: record.brand,
      badges: parseJson<string[]>(record.badgesJson, []),
      visual: parseJson(record.visualJson, { type: 'botella', color: '#64748b' }),
      image: record.image,
      featured: record.featured === 1,
      shortDesc: record.shortDesc,
      categoryId: record.categoryId,
      minPrice: record.minPrice,
      minNetPrice: record.minNetPrice,
      formats: record.formats
    })),
    total,
    page: query.page,
    pages: Math.max(1, Math.ceil(total / query.limit))
  }
}
