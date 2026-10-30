import {
  effectiveGrossCentsExpression,
  effectiveB2BGrossCentsExpression,
  PRICE_CUSTOMER_TOKEN,
  effectiveGovernedVersionIdExpression,
  parameterizeEffectivePricingSql,
  resolvePricingInstant,
  type EffectivePricingOptions
} from './pricing'
import type { ProductFacets } from '../../shared/types/catalog'
import { prepareProductFacetStatements, decodeProductFacetResults, type ProductFacetRow } from './product-facets'
import {
  preparePublicTypedFilters,
  publicTypedAttributeCtes,
  preparePublicTypedFacetsStatement,
  parsePublicTypedFacetsRows,
  type PublicTypedFacetRow
} from './typed-attribute-facets'
import { publicMediaImageUrl } from '../media/public-catalog'
import { eligibleMediaPublicationSql } from '../media/governance'
import { publicationValidityWithClock } from './publication-validity'
import { typedAttributePublicCategoryValiditySql } from './typed-attribute-sql'
import { publicSearchTermsSql, spanishFoldSql } from './search'
import { categoryOrderSqlPrefix, readLiveCategoryOrder, type LiveCategoryOrder } from './category-merchandising'

export type ProductSort = 'default' | 'name' | 'price_asc' | 'price_desc'

export interface ProductQuery {
  typed?: string
  category?: string
  search?: string
  brand?: string
  badge?: string
  envase?: string
  talla?: string
  capacidad?: string
  color?: string
  medida?: string
  acabado?: string
  priceMin?: string
  priceMax?: string
  featured?: boolean
  facets?: boolean
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
  mediaPublicationId?: string | null
  imageAlt?: string | null
  featured: number
  shortDesc: string | null
  categoryId: number
  minPrice: number
  minNetPrice: number
  compareAtPrice: number | null
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
  imageAlt?: string | null
  featured: boolean
  shortDesc: string | null
  categoryId: number
  minPrice: number
  minNetPrice: number
  compareAtPrice: number | null
  formats: number
}

export interface D1ProductListResponse {
  items: D1ProductSummary[]
  total: number
  page: number
  pages: number
  facets?: ProductFacets
}

interface FilterPart {
  key: string
  clause: string
  parameters: Array<string | number>
}

function compileWhere(parts: FilterPart[], excluded: string[] = []) {
  const included = parts.filter((part) => !excluded.includes(part.key))
  return {
    text: `WHERE ${included.map((part) => part.clause).join(' AND ')}`,
    parameters: included.flatMap((part) => part.parameters)
  }
}

function values(raw?: string, separator = ',') {
  return (raw ?? '')
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= 100)
    .slice(0, 50)
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, '\\$&')
}

function priceCents(value?: string) {
  if (value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_000_000_000 ? Math.round(parsed * 100) : null
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
  const typed = await preparePublicTypedFilters(database, query.typed)
  // Capture one server-owned evaluation time AFTER semantic preflight. All
  // authority, pricing and media statements below share this same instant and
  // execute in one D1 transaction. No client parameter controls this clock.
  const instant = resolvePricingInstant(pricingOptions)
  const validity = publicationValidityWithClock('p', instant)
  const filters: FilterPart[] = [
    { key: 'active', clause: `p.status = 'published' AND ${validity.sql}`, parameters: validity.parameters },
    ...typed.sqlFilters
  ]
  let searchCte = ''
  let searchParameters: string[] = []

  if (query.category) {
    filters.push({
      key: 'category',
      clause: `p.category_id IN (
      WITH RECURSIVE tree(id) AS (
        SELECT id FROM categories WHERE slug = ? AND status = 'published'
        UNION
        SELECT child.id FROM categories child JOIN tree parent ON child.parent_id = parent.id
        WHERE child.status = 'published'
      )
      SELECT id FROM tree
    )`,
      parameters: [query.category]
    })
  }

  if (query.search) {
    const match = ftsQuery(query.search)
    if (match) {
      const terms = publicSearchTermsSql(query.search)
      // Keep term expansion/folding in its own materialized relation. When
      // workerd evaluates full typed/reference facets, inlining this correlated
      // expression into publication authority exceeds D1's expression budget.
      // This is only a candidate set: the unchanged public authority below
      // still controls every count, page and auto-excluded facet in one batch.
      searchCte = `,search_terms AS MATERIALIZED (${terms.sql}),
        search_products AS MATERIALIZED (
        SELECT p.id AS product_id FROM products p LEFT JOIN brands b ON b.id=p.brand_id
        WHERE EXISTS (SELECT 1 FROM search_terms search_term WHERE (
        p.rowid IN (SELECT rowid FROM products_fts WHERE products_fts MATCH search_term.fts)
        OR instr(${spanishFoldSql('p.name')},search_term.term)>0
        OR instr(${spanishFoldSql("COALESCE(b.name, '')")},search_term.term)>0
        OR EXISTS (
          SELECT 1 FROM variants search_variant
          WHERE search_variant.product_id = p.id
            AND search_variant.status = 'published'
            AND instr(lower(COALESCE(search_variant.sku, '')),search_term.term)>0
        )
      )))`
      searchParameters = terms.parameters
      filters.push({ key: 'q', clause: 'p.id IN (SELECT product_id FROM search_products)', parameters: [] })
    }
  }

  // One JSON binding per multiselect keeps any combination of fifty values
  // below D1's parameter limit without changing normalization or facet keys.
  const brands = values(query.brand)
  if (brands.length)
    filters.push({
      key: 'brand',
      clause: 'b.name IN (SELECT value FROM json_each(?))',
      parameters: [JSON.stringify(brands)]
    })
  const badges = values(query.badge)
  if (badges.length)
    filters.push({
      key: 'badge',
      clause: `EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(p.attributes, '$.badges'), '[]')) badge
        WHERE badge.value IN (SELECT value FROM json_each(?)))`,
      parameters: [JSON.stringify(badges)]
    })
  const containers = values(query.envase).filter((value) => /^[a-záéíóúñ-]+$/i.test(value))
  if (containers.length)
    filters.push({
      key: 'envase',
      clause: "json_extract(p.attributes, '$.visual.type') IN (SELECT value FROM json_each(?))",
      parameters: [JSON.stringify(containers)]
    })
  const sizes = values(query.talla).map((value) => `Talla ${value}`)
  if (sizes.length)
    filters.push({
      key: 'talla',
      clause: `EXISTS (SELECT 1 FROM variants size_variant WHERE size_variant.product_id = p.id
        AND size_variant.status = 'published' AND size_variant.format IN (SELECT value FROM json_each(?)))`,
      parameters: [JSON.stringify(sizes)]
    })
  const capacities = values(query.capacidad)
    .map((value) => value.match(/^([\d.]+)-(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match && Number.isFinite(Number(match[1]))))
    .map((match) => [Number(match[1]), match[2]!] as const)
  if (capacities.length)
    filters.push({
      key: 'capacidad',
      clause: `EXISTS (SELECT 1 FROM variants capacity_variant WHERE capacity_variant.product_id = p.id
        AND capacity_variant.status = 'published' AND EXISTS (
          SELECT 1 FROM json_each(?) selected_capacity
          WHERE capacity_variant.content_quantity = json_extract(selected_capacity.value, '$[0]')
            AND capacity_variant.unit_label = json_extract(selected_capacity.value, '$[1]')))`,
      parameters: [JSON.stringify(capacities)]
    })
  const colors = values(query.color)
  if (colors.length)
    filters.push({
      key: 'color',
      clause: `EXISTS (SELECT 1 FROM variants color_variant WHERE color_variant.product_id = p.id
        AND color_variant.status = 'published' AND EXISTS (
          SELECT 1 FROM json_each(?) selected_color
          WHERE lower(color_variant.format) LIKE lower(selected_color.value) ESCAPE '\\'))`,
      parameters: [JSON.stringify(colors.map((color) => `%Color ${escapeLike(color)}`))]
    })
  const measurements = values(query.medida, '|')
  if (measurements.length)
    filters.push({
      key: 'medida',
      clause: `EXISTS (SELECT 1 FROM variants measurement_variant WHERE measurement_variant.product_id = p.id
        AND measurement_variant.status = 'published' AND EXISTS (
          SELECT 1 FROM json_each(?) selected_measurement
          WHERE lower(measurement_variant.format) LIKE lower(selected_measurement.value) ESCAPE '\\'))`,
      parameters: [JSON.stringify(measurements.map((measurement) => `${escapeLike(measurement)} · %`))]
    })
  const finishes = values(query.acabado)
  if (finishes.length) {
    const precut = finishes.some((finish) => finish.toLocaleLowerCase('es') === 'precortado')
    const patterns = finishes
      .filter((finish) => finish.toLocaleLowerCase('es') !== 'precortado')
      .map((finish) => `%${escapeLike(finish)} · Color %`)
    filters.push({
      key: 'acabado',
      clause: `EXISTS (SELECT 1 FROM variants finish_variant WHERE finish_variant.product_id = p.id
        AND finish_variant.status = 'published' AND (${[
          ...(precut
            ? ["(lower(finish_variant.format) LIKE '% · precorte %' OR lower(finish_variant.format) LIKE 'precorte %')"]
            : []),
          ...(patterns.length
            ? [
                "EXISTS (SELECT 1 FROM json_each(?) selected_finish WHERE lower(finish_variant.format) LIKE lower(selected_finish.value) ESCAPE '\\')"
              ]
            : [])
        ].join(' OR ')}))`,
      parameters: patterns.length ? [JSON.stringify(patterns)] : []
    })
  }
  const minimum = priceCents(query.priceMin)
  const maximum = priceCents(query.priceMax)
  if (minimum !== null || maximum !== null)
    filters.push({
      key: 'price',
      clause: [minimum !== null ? 'summary.minPrice >= ?' : '', maximum !== null ? 'summary.minPrice <= ?' : '']
        .filter(Boolean)
        .join(' AND '),
      parameters: [minimum, maximum].filter((value): value is number => value !== null)
    })
  if (query.featured) filters.push({ key: 'featured', clause: 'p.featured = 1', parameters: [] })

  const pricingSummary = parameterizeEffectivePricingSql(
    `WITH effective_variant_prices AS (
      SELECT variant.id AS variantId,
             ${pricingOptions?.customerId ? effectiveB2BGrossCentsExpression('variant', PRICE_CUSTOMER_TOKEN) : effectiveGrossCentsExpression('variant')} AS grossCents,
             ${effectiveGovernedVersionIdExpression('variant')} AS versionId
      FROM variants variant
      WHERE variant.status = 'published'
    ),
    variant_summary AS (
      SELECT priced.product_id,
             min(effective.grossCents) AS minPrice,
             min((effective.grossCents / (10000 + tax.rate_basis_points)) * 10000 +
                 (((effective.grossCents % (10000 + tax.rate_basis_points)) * 20000 +
                   (10000 + tax.rate_basis_points)) / (2 * (10000 + tax.rate_basis_points)))) AS minNetPrice,
             max(CASE WHEN version.id IS NULL THEN priced.compare_at_gross_cents
                  ELSE version.compare_at_gross_cents END) AS compareAtPrice,
             count(*) AS formats
      FROM variants priced
      JOIN effective_variant_prices effective ON effective.variantId = priced.id
      LEFT JOIN variant_price_versions version ON version.id = effective.versionId AND version.variant_id = priced.id
      JOIN tax_classes tax ON tax.id = priced.tax_class_id
      WHERE priced.status = 'published'
      GROUP BY priced.product_id
    )`,
    instant,
    pricingOptions?.customerId
  )
  const typedCtes = typed.filters.length ? publicTypedAttributeCtes(instant) : undefined
  const searchSummary = pricingSummary.sql + searchCte
  const searchSummaryParameters = [...pricingSummary.instantParameters, ...searchParameters]
  const effectiveSummary = searchSummary + (typedCtes ? `,${typedCtes.sql}` : '')
  const instantParameters = [...searchSummaryParameters, ...(typedCtes?.parameters ?? [])]
  const joins = `FROM products p
    JOIN categories c ON c.id = p.category_id AND c.status = 'published'
    LEFT JOIN brands b ON b.id = p.brand_id
    JOIN variant_summary summary ON summary.product_id = p.id AND summary.formats > 0`
  const where = compileWhere(filters)
  // SEA-015: a live category merchandising rule reorders only the untouched default listing of a
  // category. Any failure or absence keeps the default order: ranking must never break the listing.
  const merchandised: LiveCategoryOrder | null =
    query.category && query.sort === 'default' && !query.search
      ? await readLiveCategoryOrder(database, query.category, {
          instant,
          customerId: pricingOptions?.customerId ?? null
        }).catch(() => null)
      : null
  const merchandisedFirst = merchandised ? categoryOrderSqlPrefix(merchandised) : ''
  const orderBy =
    {
      default: `${merchandisedFirst}p.featured DESC, lower(p.name), p.id`,
      name: 'lower(p.name), p.id',
      price_asc: 'summary.minPrice ASC, lower(p.name), p.id',
      price_desc: 'summary.minPrice DESC, lower(p.name), p.id'
    }[query.sort] ?? 'p.featured DESC, lower(p.name), p.id'

  const countStatement = database
    .prepare(`${effectiveSummary} SELECT count(*) AS total ${joins} ${where.text}`)
    .bind(...instantParameters, ...where.parameters)
  const listStatement = database
    .prepare(
      `${effectiveSummary},page_products AS MATERIALIZED (
      SELECT row_number() OVER (ORDER BY ${orderBy}) AS listOrder,
             p.id AS uuid,
             p.legacy_id AS id,
             p.name,
             p.slug,
             COALESCE(b.name, 'NETECO') AS brand,
             COALESCE(json_extract(p.attributes, '$.badges'), '[]') AS badgesJson,
             COALESCE(json_extract(p.attributes, '$.visual'), '{"type":"botella","color":"#64748b"}') AS visualJson,
             p.featured,
             p.short_description AS shortDesc,
             c.legacy_id AS categoryId,
             summary.minPrice,
             summary.minNetPrice,
             summary.compareAtPrice,
             summary.formats
      ${joins}
      ${where.text}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
      ),page_media AS MATERIALIZED (
        SELECT eligible.id,eligible.product_id,eligible.alt,
          row_number() OVER (PARTITION BY eligible.product_id
            ORDER BY CASE role WHEN 'main' THEN 0 WHEN 'image' THEN 1 ELSE 2 END,
              valid_from DESC,created_at DESC,eligible.id DESC) AS imageOrder
        FROM (${eligibleMediaPublicationSql('?1')}) eligible
        JOIN page_products page ON page.uuid=eligible.product_id
        WHERE eligible.variant_id IS NULL AND eligible.role IN ('main','image')
      )
      SELECT page.*,media.id AS mediaPublicationId,media.alt AS imageAlt
      FROM page_products page LEFT JOIN page_media media ON media.product_id=page.uuid AND media.imageOrder=1
      ORDER BY page.listOrder`
    )
    .bind(...instantParameters, ...where.parameters, query.limit, (query.page - 1) * query.limit)
  const statements: D1PreparedStatement[] = []
  const typedAdmissionIndex = typed.observations.length ? statements.length : undefined
  if (typed.observations.length)
    statements.push(
      database
        .prepare(
          `SELECT count(*) AS admitted FROM json_each(?) observed
      CROSS JOIN catalog_typed_attribute_definitions d ON d.id=json_extract(observed.value,'$.id')
      JOIN categories c ON c.id=d.category_id AND c.status='published' AND c.legacy_id BETWEEN 1 AND 9007199254740990
      WHERE d.status='active' AND d.current_revision=json_extract(observed.value,'$.revision')
        AND ${typedAttributePublicCategoryValiditySql('d.category_id')}`
        )
        .bind(JSON.stringify(typed.observations))
    )
  const categoryIndex = query.category ? statements.length : undefined
  if (query.category)
    statements.push(
      database.prepare("SELECT id FROM categories WHERE slug=? AND status='published'").bind(query.category)
    )
  const countIndex = statements.length
  statements.push(countStatement, listStatement)
  if (query.facets)
    statements.push(
      ...prepareProductFacetStatements(database, { effectiveSummary, instantParameters, joins, filters }),
      preparePublicTypedFacetsStatement(database, {
        effectiveSummary: searchSummary,
        instantParameters: searchSummaryParameters,
        joins,
        filters,
        typedFilters: typed.filters,
        instant
      })
    )
  // This is the only response-projection read: count, ordered page+eligible media, facets,
  // category existence and typed-filter admission share one D1 snapshot.
  // Never read source state again after decoding this transaction's results.
  const results = await database.batch<
    ProductRecord | PublicTypedFacetRow | ProductFacetRow | { total: number } | { admitted: number } | { id: string }
  >(statements)
  if (
    typedAdmissionIndex !== undefined &&
    (results[typedAdmissionIndex]?.results[0] as { admitted?: number } | undefined)?.admitted !==
      typed.observations.length
  )
    throw new Error('typed_attributes_changed')
  if (categoryIndex !== undefined && !results[categoryIndex]?.results.length) return null
  const total = Number((results[countIndex]?.results[0] as { total?: number } | undefined)?.total ?? 0)
  const records = (results[countIndex + 1]?.results ?? []) as ProductRecord[]
  // Keep the former media/authority helper bounds for internal callers too;
  // the HTTP endpoint separately caps page size at 100. This is page-only
  // validation, never materialization of the aggregate's contributing IDs.
  if (
    records.length > 1000 ||
    records.some(
      ({ uuid }) =>
        typeof uuid !== 'string' ||
        !uuid ||
        uuid.length > 200 ||
        Array.from(uuid).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
  )
    throw new Error('invalid_media_product_ids')
  if (new TextEncoder().encode(JSON.stringify([...new Set(records.map(({ uuid }) => uuid))])).byteLength > 256 * 1024)
    throw new Error('invalid_publication_validity_ids')
  const facets = query.facets ? decodeProductFacetResults(results.slice(countIndex + 2, countIndex + 12)) : undefined
  const typedFacets = query.facets
    ? parsePublicTypedFacetsRows((results[countIndex + 12]?.results ?? []) as PublicTypedFacetRow[])
    : undefined

  return {
    items: records.map((record) => ({
      uuid: record.uuid,
      id: record.id,
      name: record.name,
      slug: record.slug,
      brand: record.brand,
      badges: parseJson<string[]>(record.badgesJson, []),
      visual: parseJson(record.visualJson, { type: 'botella', color: '#64748b' }),
      image: record.mediaPublicationId ? publicMediaImageUrl(record.mediaPublicationId) : null,
      imageAlt: record.imageAlt ?? null,
      featured: record.featured === 1,
      shortDesc: record.shortDesc,
      categoryId: record.categoryId,
      minPrice: record.minPrice,
      minNetPrice: record.minNetPrice,
      compareAtPrice: record.compareAtPrice,
      formats: record.formats
    })),
    total,
    page: query.page,
    pages: Math.max(1, Math.ceil(total / query.limit)),
    ...(facets ? { facets: { ...facets, typed: typedFacets?.facets ?? [] } } : {})
  }
}
