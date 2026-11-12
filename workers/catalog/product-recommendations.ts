import { listPublishedProducts, type D1ProductSummary } from './products'
import type { EffectivePricingOptions } from './pricing'
import type {
  ProductRecommendationsQuery,
  ProductRecommendationsResponse,
  RecommendationBasis,
  RecommendationStrip,
  RecommendationStripKind
} from '../../shared/product-recommendations'
import type { ProductCardData } from '../../shared/types/catalog'

/**
 * Recomendaciones de tienda con filtrado colaborativo ítem a ítem, como las grandes tiendas,
 * sobre los datos que Neteco ya tiene:
 *
 * - Co-compra: productos que aparecen en los mismos pedidos (`order_lines`) y la tabla
 *   agregada `catalog_co_purchases` si está poblada. Mínimo dos pedidos en común para decir
 *   «frecuentemente».
 * - Co-visualización: sesiones que vieron este producto y otros (`analytics_client_events`,
 *   evento `product_viewed`, solo con consentimiento). Mínimo dos sesiones.
 * - Relaciones curadas del catálogo (`catalog_relation_heads`): accesorios y compatibles para
 *   «Se suele pedir con»; sustitutos y equivalentes como alternativas.
 * - Respaldo honesto: misma familia, lo más vendido y destacados, con su propio título.
 *
 * Las tarjetas salen de `listPublishedProducts`: mismo precio (también B2B), misma validez
 * de publicación y mismas fotos gobernadas que el listado. Sin precio público no se recomienda.
 */

const VIEW_ENVIRONMENTS = "('local','preview','production')"
const DAY = 86_400_000

function since(now: Date, days: number) {
  return new Date(now.getTime() - days * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

interface AnchorRow {
  id: string
  legacyId: number | null
  categoryId: string
  slug: string
}

interface ScoredRow {
  id: string
  score: number
}

async function rows<T>(statement: D1PreparedStatement): Promise<T[]> {
  try {
    return (await statement.all<T>()).results ?? []
  } catch {
    // Una señal que falla (tabla vacía o aún no migrada) no tumba las demás franjas.
    return []
  }
}

async function resolveSlugs(database: D1Database, slugs: string[]): Promise<AnchorRow[]> {
  if (!slugs.length) return []
  return rows<AnchorRow>(
    database
      .prepare(
        `SELECT id, legacy_id AS legacyId, category_id AS categoryId, slug FROM products
         WHERE status = 'published' AND slug IN (SELECT value FROM json_each(?1))`
      )
      .bind(JSON.stringify(slugs))
  )
}

async function legacyToIds(database: D1Database, scored: Array<{ legacyId: number; score: number }>) {
  if (!scored.length) return []
  const mapped = await rows<{ id: string; legacyId: number }>(
    database
      .prepare(
        `SELECT id, legacy_id AS legacyId FROM products
         WHERE status = 'published' AND legacy_id IN (SELECT value FROM json_each(?1))`
      )
      .bind(JSON.stringify(scored.map((row) => row.legacyId)))
  )
  const byLegacy = new Map(mapped.map((row) => [Number(row.legacyId), row.id]))
  return scored.flatMap((row) => {
    const id = byLegacy.get(Number(row.legacyId))
    return id ? [{ id, score: row.score }] : []
  })
}

async function coPurchases(database: D1Database, anchorIds: string[], now: Date): Promise<ScoredRow[]> {
  if (!anchorIds.length) return []
  const anchors = JSON.stringify(anchorIds)
  const [orders, aggregated] = await Promise.all([
    rows<ScoredRow>(
      database
        .prepare(
          `WITH anchors(id) AS (SELECT value FROM json_each(?1)),
           target_orders AS MATERIALIZED (
             SELECT DISTINCT ol.order_id FROM order_lines ol
             JOIN variants v ON v.id = ol.variant_id
             JOIN orders o ON o.id = ol.order_id
             WHERE v.product_id IN (SELECT id FROM anchors) AND o.status <> 'cancelled' AND o.created_at >= ?2
             LIMIT 5000
           )
           SELECT v.product_id AS id, COUNT(DISTINCT ol.order_id) AS score
           FROM order_lines ol
           JOIN target_orders t ON t.order_id = ol.order_id
           JOIN variants v ON v.id = ol.variant_id
           WHERE v.product_id NOT IN (SELECT id FROM anchors)
           GROUP BY v.product_id ORDER BY score DESC LIMIT 40`
        )
        .bind(anchors, since(now, 365))
    ),
    rows<ScoredRow>(
      database
        .prepare(
          `WITH anchors(id) AS (SELECT value FROM json_each(?1))
           SELECT CASE WHEN product_a_id IN (SELECT id FROM anchors) THEN product_b_id ELSE product_a_id END AS id,
                  SUM(co_purchase_count) AS score
           FROM catalog_co_purchases
           WHERE product_a_id IN (SELECT id FROM anchors) OR product_b_id IN (SELECT id FROM anchors)
           GROUP BY 1 ORDER BY score DESC LIMIT 40`
        )
        .bind(anchors)
    )
  ])
  const merged = new Map<string, number>()
  for (const row of [...orders, ...aggregated])
    if (!anchorIds.includes(row.id)) merged.set(row.id, Math.max(merged.get(row.id) ?? 0, Number(row.score)))
  return [...merged]
    .map(([id, score]) => ({ id, score }))
    .filter((row) => row.score >= 2)
    .sort((left, right) => right.score - left.score)
}

async function coViews(database: D1Database, anchor: AnchorRow, now: Date): Promise<ScoredRow[]> {
  if (anchor.legacyId === null) return []
  const scored = await rows<{ legacyId: number; score: number }>(
    database
      .prepare(
        `WITH viewers AS MATERIALIZED (
           SELECT DISTINCT session_hash FROM analytics_client_events
           WHERE environment IN ${VIEW_ENVIRONMENTS} AND occurred_at >= ?2 AND name = 'product_viewed'
             AND CAST(json_extract(properties_json, '$.productId') AS INTEGER) = ?1
           LIMIT 2000
         )
         SELECT CAST(json_extract(e.properties_json, '$.productId') AS INTEGER) AS legacyId,
                COUNT(DISTINCT e.session_hash) AS score
         FROM analytics_client_events e
         JOIN viewers v ON v.session_hash = e.session_hash
         WHERE e.environment IN ${VIEW_ENVIRONMENTS} AND e.occurred_at >= ?2 AND e.name = 'product_viewed'
           AND CAST(json_extract(e.properties_json, '$.productId') AS INTEGER) <> ?1
         GROUP BY legacyId HAVING score >= 2 ORDER BY score DESC LIMIT 40`
      )
      .bind(anchor.legacyId, since(now, 90))
  )
  return legacyToIds(database, scored)
}

async function trendingViews(database: D1Database, now: Date): Promise<ScoredRow[]> {
  const scored = await rows<{ legacyId: number; score: number }>(
    database
      .prepare(
        `SELECT CAST(json_extract(properties_json, '$.productId') AS INTEGER) AS legacyId,
                COUNT(DISTINCT session_hash) AS score
         FROM analytics_client_events
         WHERE environment IN ${VIEW_ENVIRONMENTS} AND occurred_at >= ?1 AND name = 'product_viewed'
         GROUP BY legacyId HAVING score >= 3 ORDER BY score DESC LIMIT 40`
      )
      .bind(since(now, 7))
  )
  return legacyToIds(database, scored)
}

async function bestsellers(
  database: D1Database,
  now: Date,
  days: number,
  categoryIds: string[] = []
): Promise<ScoredRow[]> {
  return rows<ScoredRow>(
    database
      .prepare(
        `SELECT v.product_id AS id, COUNT(DISTINCT ol.order_id) AS score
         FROM order_lines ol
         JOIN orders o ON o.id = ol.order_id
         JOIN variants v ON v.id = ol.variant_id
         JOIN products p ON p.id = v.product_id AND p.status = 'published'
         WHERE o.status <> 'cancelled' AND o.created_at >= ?1
           AND (?2 = '[]' OR p.category_id IN (SELECT value FROM json_each(?2)))
         GROUP BY v.product_id ORDER BY score DESC, SUM(ol.quantity) DESC LIMIT 40`
      )
      .bind(since(now, days), JSON.stringify(categoryIds))
  )
}

async function sameCategory(database: D1Database, categoryIds: string[]): Promise<ScoredRow[]> {
  if (!categoryIds.length) return []
  return rows<ScoredRow>(
    database
      .prepare(
        `SELECT id, featured AS score FROM products
         WHERE status = 'published' AND category_id IN (SELECT value FROM json_each(?1))
         ORDER BY featured DESC, lower(name), id LIMIT 40`
      )
      .bind(JSON.stringify(categoryIds))
  )
}

async function featured(database: D1Database): Promise<ScoredRow[]> {
  return rows<ScoredRow>(
    database.prepare(
      `SELECT id, 1 AS score FROM products WHERE status = 'published' AND featured = 1
       ORDER BY lower(name), id LIMIT 40`
    )
  )
}

/** Relaciones curadas publicadas de los anclajes, separadas en complementos y alternativas. */
async function curated(database: D1Database, anchorIds: string[]) {
  const complements: number[] = []
  const alternatives: number[] = []
  if (!anchorIds.length) return { complements: [] as ScoredRow[], alternatives: [] as ScoredRow[] }
  const revisions = await rows<{ relations: string }>(
    database
      .prepare(
        `SELECT r.relations_json AS relations
         FROM catalog_relation_heads h
         JOIN catalog_relation_revisions r ON r.product_id = h.product_id AND r.version = h.version
         WHERE h.product_id IN (SELECT value FROM json_each(?1))`
      )
      .bind(JSON.stringify(anchorIds))
  )
  for (const revision of revisions) {
    try {
      for (const relation of JSON.parse(revision.relations) as Array<{ targetProductId: number; kind: string }>) {
        const target = Number(relation.targetProductId)
        if (!Number.isSafeInteger(target)) continue
        if (relation.kind === 'accessory' || relation.kind === 'compatible') complements.push(target)
        else if (relation.kind === 'substitute' || relation.kind === 'equivalent') alternatives.push(target)
      }
    } catch {
      /* Una revisión ilegible no aporta relaciones. */
    }
  }
  const scored = (list: number[]) => [...new Set(list)].map((legacyId, index) => ({ legacyId, score: 100 - index }))
  const [c, a] = await Promise.all([
    legacyToIds(database, scored(complements)),
    legacyToIds(database, scored(alternatives))
  ])
  return { complements: c, alternatives: a }
}

interface Candidate {
  kind: RecommendationStripKind
  basis: RecommendationBasis
  ids: string[]
}

function pick(...sources: Array<[RecommendationBasis, ScoredRow[]]>): [RecommendationBasis, ScoredRow[]] | null {
  return sources.find(([, list]) => list.length >= 2) ?? null
}

function card(summary: D1ProductSummary): ProductCardData {
  const { uuid: _uuid, categoryId: _categoryId, featured: _featured, ...item } = summary
  return item
}

export async function readProductRecommendations(
  database: D1Database,
  query: ProductRecommendationsQuery,
  options: { now?: Date; pricing?: EffectivePricingOptions } = {}
): Promise<ProductRecommendationsResponse> {
  const now = options.now ?? new Date()
  const anchorsRows = await resolveSlugs(database, [
    ...new Set([...(query.product ? [query.product] : []), ...query.cart, ...query.recent])
  ])
  const bySlug = new Map(anchorsRows.map((row) => [row.slug, row]))
  const product = query.product ? (bySlug.get(query.product) ?? null) : null
  const cart = query.cart.flatMap((slug) => bySlug.get(slug) ?? [])
  const recent = query.recent.flatMap((slug) => bySlug.get(slug) ?? [])
  // Lo que el cliente ya tiene delante o en el carrito no se le recomienda.
  const excluded = new Set([...(product ? [product.id] : []), ...cart.map((row) => row.id)])
  const anchors = product ? [product] : cart
  const anchorIds = anchors.map((row) => row.id)
  const wants = new Set(query.strips)

  const [purchases, links, views, trending, monthly, quarterly] = await Promise.all([
    wants.has('bought_together') ? coPurchases(database, anchorIds, now) : Promise.resolve([]),
    wants.has('bought_together') || wants.has('also_viewed')
      ? curated(database, anchorIds)
      : Promise.resolve({ complements: [], alternatives: [] }),
    wants.has('also_viewed') && product ? coViews(database, product, now) : Promise.resolve([]),
    wants.has('trending') ? trendingViews(database, now) : Promise.resolve([]),
    wants.has('trending') ? bestsellers(database, now, 30) : Promise.resolve([]),
    wants.has('for_you') ? bestsellers(database, now, 90) : Promise.resolve([])
  ])
  const familyIds = [...new Set(anchors.map((row) => row.categoryId))]
  const recentFamilies = [...new Set(recent.map((row) => row.categoryId))]
  const [family, familyBest, recentBest, recentFamily, highlighted] = await Promise.all([
    wants.has('also_viewed') ? sameCategory(database, familyIds) : Promise.resolve([]),
    wants.has('also_viewed') && familyIds.length ? bestsellers(database, now, 180, familyIds) : Promise.resolve([]),
    wants.has('for_you') && recentFamilies.length
      ? bestsellers(database, now, 180, recentFamilies)
      : Promise.resolve([]),
    wants.has('for_you') && recentFamilies.length ? sameCategory(database, recentFamilies) : Promise.resolve([]),
    wants.has('trending') || wants.has('for_you') ? featured(database) : Promise.resolve([])
  ])
  const merge = (...lists: ScoredRow[][]) => {
    const seen = new Set<string>()
    return lists.flat().filter((row) => !seen.has(row.id) && seen.add(row.id))
  }
  const recentIds = new Set(recent.map((row) => row.id))

  const candidates: Candidate[] = []
  const add = (kind: RecommendationStripKind, chosen: [RecommendationBasis, ScoredRow[]] | null) => {
    if (chosen) candidates.push({ kind, basis: chosen[0], ids: chosen[1].map((row) => row.id) })
  }
  if (wants.has('bought_together'))
    add('bought_together', pick(['co_purchase', purchases], ['curated', links.complements]))
  if (wants.has('also_viewed') && product)
    add(
      'also_viewed',
      pick(['co_view', views], ['curated', links.alternatives], ['category', merge(familyBest, family)])
    )
  if (wants.has('for_you'))
    add(
      'for_you',
      pick(
        ['recent_views', merge(recentBest, recentFamily).filter((row) => !recentIds.has(row.id))],
        ['bestsellers', quarterly],
        ['featured', highlighted]
      )
    )
  if (wants.has('trending'))
    add('trending', pick(['views', trending], ['bestsellers', monthly], ['featured', highlighted]))

  const wanted = [...new Set(candidates.flatMap((candidate) => candidate.ids))].filter((id) => !excluded.has(id))
  const cards = new Map<string, ProductCardData>()
  for (let offset = 0; offset < wanted.length && offset < 200; offset += 100) {
    const ids = wanted.slice(offset, offset + 100)
    const page = await listPublishedProducts(
      database,
      { productIds: ids, page: 1, limit: ids.length, sort: 'default' },
      options.pricing
    )
    for (const summary of page?.items ?? []) if (summary.minPrice > 0) cards.set(summary.uuid, card(summary))
  }

  // Una misma referencia no se repite en dos franjas: la primera que la reclama se la queda.
  const used = new Set<string>()
  const strips: RecommendationStrip[] = []
  for (const kind of query.strips) {
    const candidate = candidates.find((entry) => entry.kind === kind)
    if (!candidate) continue
    const items: ProductCardData[] = []
    for (const id of candidate.ids) {
      const item = cards.get(id)
      if (!item || excluded.has(id) || used.has(id)) continue
      items.push(item)
      used.add(id)
      if (items.length >= query.limit) break
    }
    if (items.length >= 2) strips.push({ kind, basis: candidate.basis, items })
  }
  return { source: 'cloudflare', strips }
}
