import { splitGross } from '../../server/domain/money'
import { parseVolumeTiers } from './volume-pricing'
import { sellableExpression } from './inventory'
import { readPublicProductMedia } from '../media/public-catalog'
import { readPublicTypedDetail, assertCurrentTypedAttributes } from './typed-attribute-facets'
import {
  publicationValidityWithClock,
  assertCurrentPublicationValidity,
  publicMediaProjectionIds
} from './publication-validity'
import {
  effectiveGrossCentsExpression,
  effectiveB2BGrossCentsExpression,
  effectiveB2BSourceExpression,
  effectiveB2BVersionIdExpression,
  PRICE_CUSTOMER_TOKEN,
  effectiveGovernedVersionIdExpression,
  parameterizeEffectivePricingSql,
  resolvePricingInstant,
  type EffectivePricingOptions
} from './pricing'

const visualFallback = { type: 'botella', color: '#64748b' }

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

interface ProductRow {
  uuid: string
  categoryUuid: string
  id: number
  name: string
  slug: string
  brand: string
  categoryId: number
  shortDesc: string | null
  description: string | null
  usage: string | null
  badgesJson: string
  visualJson: string
  image: string | null
  datasheet: string | null
  featured: number
  series: string | null
  attrsJson: string
  typedJson: string | null
  regulatoryJson: string
}

interface VariantRow {
  uuid: string
  id: number
  format: string
  sku: string
  ean: string | null
  gtin: string | null
  mpn: string | null
  price: number
  compareAtPrice: number | null
  referencePrice30d: number | null
  priceTiersJson: string
  pricingVersion: string
  taxRateBasisPoints: number
  stock: number
  units: number
  unitBase: string
  unitLabel: string
  unitsPerCase: number
  casesPerPallet: number | null
  minimumQuantity: number
  maximumQuantity: number | null
  quantityIncrement: number
  backorderAllowed: number
  leadTimeDays: number | null
  color: string | null
  image: string | null
}

interface SiblingRow {
  uuid: string
  name: string
  slug: string
  visualJson: string
  image: string | null
}

interface RelatedRow {
  uuid: string
  id: number
  name: string
  slug: string
  brand: string
  badgesJson: string
  visualJson: string
  image: string | null
  minPrice: number
  minNetPrice: number
  formats: number
}

/** Public detail DTO matching the current Nuxt product page. Images/documents
 * come exclusively from explicit, currently eligible media publications.
 */
export async function getPublishedProductDetail(
  database: D1Database,
  slug: string,
  pricingOptions?: EffectivePricingOptions
) {
  if (!/^[a-z0-9][a-z0-9-]{0,179}$/.test(slug)) return null
  const instant = resolvePricingInstant(pricingOptions)
  const validity = publicationValidityWithClock('p', pricingOptions?.instant),
    siblingValidity = publicationValidityWithClock('sibling', pricingOptions?.instant)
  const product = await database
    .prepare(
      `SELECT p.id AS uuid, p.category_id AS categoryUuid, p.legacy_id AS id,
        p.name, p.slug, COALESCE(b.name, 'NETECO') AS brand,
        c.legacy_id AS categoryId, p.short_description AS shortDesc,
        p.description, p.usage,
        COALESCE(json_extract(p.attributes, '$.badges'), '[]') AS badgesJson,
        COALESCE(json_extract(p.attributes, '$.visual'), '{"type":"botella","color":"#64748b"}') AS visualJson,
        json_extract(p.attributes, '$.image') AS image,
        json_extract(p.attributes, '$.datasheet') AS datasheet,
        p.featured, p.series,
        COALESCE(json_extract(p.attributes, '$.attrs'), '[]') AS attrsJson,
        p.attributes -> '$.typed' AS typedJson,
        p.regulatory AS regulatoryJson
      FROM products p
      JOIN categories c ON c.id = p.category_id AND c.status = 'published'
      LEFT JOIN brands b ON b.id = p.brand_id
      WHERE p.slug = ? AND p.status = 'published'
        AND ${validity.sql}
        AND p.legacy_id IS NOT NULL AND c.legacy_id IS NOT NULL`
    )
    .bind(slug, ...validity.parameters)
    .first<ProductRow>()
  if (!product) return null

  const selectedVersion = effectiveGovernedVersionIdExpression('v')
  const b2bGross = pricingOptions?.customerId
    ? effectiveB2BGrossCentsExpression('v', PRICE_CUSTOMER_TOKEN)
    : 'COALESCE(pv.gross_cents, v.price_gross_cents)'
  const b2bVersion = pricingOptions?.customerId
    ? effectiveB2BVersionIdExpression('v', PRICE_CUSTOMER_TOKEN)
    : "COALESCE(pv.id, 'legacy:' || v.id)"
  const b2bSource = pricingOptions?.customerId ? effectiveB2BSourceExpression('v', PRICE_CUSTOMER_TOKEN) : "'public'"
  const variantSql = parameterizeEffectivePricingSql(
    `SELECT v.id AS uuid, v.legacy_id AS id, v.format, v.sku, v.ean, v.gtin, v.mpn,
        ${b2bGross} AS price,
        CASE WHEN pv.id IS NULL THEN v.compare_at_gross_cents ELSE pv.compare_at_gross_cents END AS compareAtPrice,
        pv.reference_gross_cents_30d AS referencePrice30d,
        CASE WHEN ${b2bSource}='public' THEN COALESCE(pv.volume_tiers, '[]') ELSE '[]' END AS priceTiersJson,
        ${b2bVersion} AS pricingVersion,
        tax.rate_basis_points AS taxRateBasisPoints,
        COALESCE((SELECT SUM(${sellableExpression()}) FROM inventory_balances b WHERE b.variant_id = v.id), 0) AS stock,
        v.content_quantity AS units, v.unit_base AS unitBase, v.unit_label AS unitLabel,
        v.units_per_case AS unitsPerCase, v.cases_per_pallet AS casesPerPallet,
        v.minimum_quantity AS minimumQuantity, v.maximum_quantity AS maximumQuantity,
        v.quantity_increment AS quantityIncrement, v.backorder_allowed AS backorderAllowed,
        COALESCE(v.lead_time_days, (SELECT restock_default_days FROM fulfillment_lead_time_policy WHERE id = 1)) AS leadTimeDays,
        v.color, v.image
      FROM variants v
      JOIN tax_classes tax ON tax.id = v.tax_class_id
      LEFT JOIN variant_price_versions pv ON pv.id = ${selectedVersion} AND pv.variant_id = v.id
      WHERE v.product_id = ? AND v.status = 'published' AND v.legacy_id IS NOT NULL
      ORDER BY v.legacy_id`,
    instant,
    pricingOptions?.customerId
  )
  const variantQuery = database
    .prepare(variantSql.sql)
    .bind(...variantSql.instantParameters, product.uuid)
    .all<VariantRow>()

  const siblingQuery = product.series
    ? database
        .prepare(
          `SELECT sibling.id AS uuid, sibling.name, sibling.slug,
            COALESCE(json_extract(sibling.attributes, '$.visual'), '{"type":"botella","color":"#64748b"}') AS visualJson,
            json_extract(sibling.attributes, '$.image') AS image
          FROM products sibling
          WHERE sibling.series = ? AND sibling.id <> ? AND sibling.status = 'published'
            AND ${siblingValidity.sql}
          ORDER BY sibling.name, sibling.id`
        )
        .bind(product.series, product.uuid, ...siblingValidity.parameters)
        .all<SiblingRow>()
    : Promise.resolve({ results: [] as SiblingRow[] })

  const breadcrumbQuery = database
    .prepare(
      `WITH RECURSIVE ancestors(id, parent_id, name, slug, depth) AS (
        SELECT id, parent_id, name, slug, 0 FROM categories WHERE id = ?
        UNION ALL
        SELECT parent.id, parent.parent_id, parent.name, parent.slug, child.depth + 1
        FROM categories parent JOIN ancestors child ON child.parent_id = parent.id
        WHERE child.depth < 20
      )
      SELECT name, slug FROM ancestors ORDER BY depth DESC`
    )
    .bind(product.categoryUuid)
    .all<{ name: string; slug: string }>()

  const relatedPrice = parameterizeEffectivePricingSql(
    pricingOptions?.customerId
      ? effectiveB2BGrossCentsExpression('v', PRICE_CUSTOMER_TOKEN)
      : effectiveGrossCentsExpression('v'),
    instant,
    pricingOptions?.customerId
  )
  const relatedQuery = database
    .prepare(
      `WITH prices AS (
        SELECT v.product_id, ${relatedPrice.sql} AS grossCents,
          tax.rate_basis_points AS taxRateBasisPoints
        FROM variants v JOIN tax_classes tax ON tax.id = v.tax_class_id
        JOIN products candidate ON candidate.id = v.product_id
          AND candidate.category_id = ? AND candidate.status = 'published'
        WHERE v.status = 'published' AND v.legacy_id IS NOT NULL
      ), summary AS (
        SELECT product_id, min(grossCents) AS minPrice,
          min(CAST(round((grossCents * 10000.0) / (10000 + taxRateBasisPoints)) AS INTEGER)) AS minNetPrice,
          count(*) AS formats FROM prices GROUP BY product_id
      )
      SELECT p.id AS uuid, p.legacy_id AS id, p.name, p.slug, COALESCE(b.name, 'NETECO') AS brand,
        COALESCE(json_extract(p.attributes, '$.badges'), '[]') AS badgesJson,
        COALESCE(json_extract(p.attributes, '$.visual'), '{"type":"botella","color":"#64748b"}') AS visualJson,
        json_extract(p.attributes, '$.image') AS image,
        summary.minPrice, summary.minNetPrice, summary.formats
      FROM products p JOIN summary ON summary.product_id = p.id AND summary.formats > 0
      LEFT JOIN brands b ON b.id = p.brand_id
      WHERE p.category_id = ? AND p.id <> ? AND p.status = 'published' AND p.legacy_id IS NOT NULL
        AND ${validity.sql}
      ORDER BY p.featured DESC, p.name, p.id LIMIT 4`
    )
    .bind(
      ...relatedPrice.instantParameters,
      product.categoryUuid,
      product.categoryUuid,
      product.uuid,
      ...validity.parameters
    )
    .all<RelatedRow>()

  const [variants, siblings, breadcrumb, related] = await Promise.all([
    variantQuery,
    siblingQuery,
    breadcrumbQuery,
    relatedQuery
  ])
  if (!variants.results.length) return null
  const typed =
    product.typedJson == null ? undefined : await readPublicTypedDetail(database, product.uuid, pricingOptions?.instant)
  const publishedMedia = await readPublicProductMedia(
    database,
    [product.uuid, ...siblings.results.map((row) => row.uuid), ...related.results.map((row) => row.uuid)],
    pricingOptions?.instant?.replace(/\.\d{3}Z$/, 'Z')
  )
  const media = publishedMedia.get(product.uuid)
  const projection = publicMediaProjectionIds(publishedMedia.values())
  await assertCurrentPublicationValidity(
    database,
    [
      product.uuid,
      ...siblings.results.map((row) => row.uuid),
      ...related.results.map((row) => row.uuid),
      ...(typed?.referenceIds ?? [])
    ],
    pricingOptions?.instant,
    { ...projection, variantIds: [...projection.variantIds, ...variants.results.map((variant) => variant.uuid)] }
  )
  await assertCurrentTypedAttributes(database, typed?.observations ?? [])

  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    brand: product.brand,
    categoryId: product.categoryId,
    shortDesc: product.shortDesc,
    description: product.description,
    usage: product.usage,
    badges: parseJson<string[]>(product.badgesJson, []),
    visual: parseJson(product.visualJson, visualFallback),
    image: media?.image ?? null,
    imageAlt: media?.imageAlt ?? null,
    images: (media?.gallery ?? []).map(({ image, imageAlt }) => ({ src: image, alt: imageAlt })),
    datasheet: media?.documents.find((document) => document.role === 'datasheet')?.url ?? null,
    featured: product.featured === 1,
    series: product.series,
    attrs: parseJson<Array<{ k: string; v: string }>>(product.attrsJson, []),
    ...(typed ? { typedAttrs: typed.attrs } : {}),
    regulatory: parseJson<Record<string, unknown>>(product.regulatoryJson, {}),
    variants: variants.results.map(({ priceTiersJson, backorderAllowed, ...variant }) => ({
      ...variant,
      image: media?.variants.get(variant.uuid)?.image ?? null,
      imageAlt: media?.variants.get(variant.uuid)?.imageAlt ?? null,
      priceTiers: parseVolumeTiers(priceTiersJson, Number(variant.price)),
      backorderAllowed: backorderAllowed === 1,
      netPrice: splitGross(Number(variant.price), Number(variant.taxRateBasisPoints)).netCents
    })),
    siblings: siblings.results.map(({ uuid, visualJson, ...sibling }) => ({
      ...sibling,
      image: publishedMedia.get(uuid)?.image ?? null,
      imageAlt: publishedMedia.get(uuid)?.imageAlt ?? null,
      visual: parseJson(visualJson, visualFallback)
    })),
    breadcrumb: breadcrumb.results,
    related: related.results.map(({ uuid, badgesJson, visualJson, ...item }) => ({
      ...item,
      image: publishedMedia.get(uuid)?.image ?? null,
      imageAlt: publishedMedia.get(uuid)?.imageAlt ?? null,
      badges: parseJson<string[]>(badgesJson, []),
      visual: parseJson(visualJson, visualFallback)
    })),
    documents: media?.documents ?? []
  }
}
