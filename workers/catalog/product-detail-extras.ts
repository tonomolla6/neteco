import {
  classifyAvailability,
  arrangeAlternatives,
  selectCoPurchases,
  DETAIL_EXTRAS_NOTICE,
  PUBLIC_SELLABLE_CAP,
  productDetailExtrasSchema,
  type AvailabilityStatus,
  type DetailAlternative,
  type DetailComplement,
  type DetailExtrasQuery,
  type ProductDetailExtras
} from '../../shared/product-detail-extras'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { publicationValidityExpression } from './publication-validity'
import { effectiveGrossCentsExpression, parameterizeEffectivePricingSql } from './pricing'
import { sellableExpression } from './inventory'

/**
 * PDP-014/015/020. Read-only public projection for one published product:
 * - alternatives: ONLY manually curated and reviewed substitute/equivalent edges
 *   (the relation command requires a technical reason and review reference);
 * - complements: curated accessory/compatible edges plus measured co-purchase
 *   (paid orders, minimum support and confidence), never substitutes;
 * - availability/pickup at the single warehouse from the live sellable position.
 * Hazard data is always returned and is never a filter criterion.
 */
export class ProductDetailExtrasError extends Error {
  constructor(readonly code: 'invalid_input' | 'not_found' | 'service_unavailable') {
    super(code)
    this.name = 'ProductDetailExtrasError'
  }
}
export interface ProductDetailExtrasOptions {
  now?: string
}
const MAX_CO_PURCHASE = 6
type Hazard = { signalWord: string | null; hazardStatements: string[]; hasHazardData: boolean }

function hazardOf(raw: string | null): Hazard {
  let value: unknown
  try {
    value = JSON.parse(raw ?? '{}')
  } catch {
    value = {}
  }
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const word = typeof record.signalWord === 'string' ? record.signalWord.trim().slice(0, 40) : ''
  const statements = Array.isArray(record.hazardStatements)
    ? record.hazardStatements
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim().slice(0, 400))
        .slice(0, 30)
    : []
  return {
    signalWord: word || null,
    hazardStatements: statements,
    hasHazardData: Boolean(word) || statements.length > 0
  }
}

interface SourceRow {
  uuid: string
  slug: string
  regulatory: string | null
  warehouses: number
  warehouseId: string | null
  warehouseKind: string | null
  pickup: number
}
interface EdgeRow {
  targetId: number
  kind: 'substitute' | 'compatible' | 'accessory' | 'equivalent'
  ordinal: number
  reviewed: number
}
interface TargetRow {
  productId: number
  slug: string
  name: string
  brand: string
  regulatory: string | null
  minPrice: number
  minNetPrice: number
  formats: number
}
interface VariantRow {
  productId: number
  variantId: number
  sku: string
  minimumQuantity: number
  backorderAllowed: number
  sellable: number
}

export async function readD1ProductDetailExtras(
  database: D1Database,
  query: DetailExtrasQuery,
  options: ProductDetailExtrasOptions = {}
): Promise<ProductDetailExtras> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(query.slug) || query.slug.length > 200)
    throw new ProductDetailExtrasError('invalid_input')
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!catalogPolicyInstantSchema.safeParse(now).success) throw new ProductDetailExtrasError('invalid_input')
  try {
    const source = await database
      .prepare(
        `SELECT p.id uuid,p.slug,p.legacy_id productId,p.regulatory,
      (SELECT count(*) FROM inventory_locations WHERE active=1) warehouses,
      (SELECT min(id) FROM inventory_locations WHERE active=1) warehouseId,
      (SELECT min(kind) FROM inventory_locations WHERE active=1) warehouseKind,
      EXISTS(SELECT 1 FROM shipping_rates r JOIN shipping_zones z ON z.id=r.zone_id
        WHERE r.method_code='pickup' AND r.active=1 AND z.active=1 AND z.kind='warehouse_pickup') pickup
      FROM products p JOIN categories category ON category.id=p.category_id AND category.status='published'
      WHERE p.slug=?1 AND p.status='published' AND p.legacy_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM variants v WHERE v.product_id=p.id AND v.status='published' AND v.legacy_id IS NOT NULL)
      AND ${publicationValidityExpression('p')}`
      )
      .bind(query.slug)
      .first<SourceRow & { productId: number }>()
    if (!source) throw new ProductDetailExtrasError('not_found')
    const sourceId = source.productId
    const single = source.warehouses === 1 && source.warehouseKind === 'warehouse'
    const pickupEnabled = single && source.pickup === 1

    const pricing = parameterizeEffectivePricingSql(effectiveGrossCentsExpression('v'), now)
    const [edgeResult, coResult] = await Promise.all([
      database
        .prepare(
          `SELECT json_extract(edge.value,'$.targetProductId') targetId,json_extract(edge.value,'$.kind') kind,
        CAST(edge.key AS INTEGER) ordinal,
        COALESCE(length(trim(json_extract(c.input_json,'$.reviewReference')))>=3 AND length(trim(json_extract(c.input_json,'$.reason')))>=10,0) reviewed
        FROM products p JOIN catalog_relation_heads h ON h.product_id=p.id
        JOIN catalog_relation_revisions r ON r.product_id=h.product_id AND r.version=h.version
        LEFT JOIN catalog_relation_commands c ON c.actor_id=r.actor_id AND c.command_id=r.command_id
        JOIN json_each(r.relations_json) edge WHERE p.legacy_id=?1 ORDER BY ordinal`
        )
        .bind(sourceId)
        .all<EdgeRow>(),
      database
        .prepare(
          `WITH src AS(SELECT DISTINCT ol.order_id FROM order_lines ol JOIN variants v ON v.id=ol.variant_id
        JOIN products p ON p.id=v.product_id JOIN order_payment_states s ON s.order_id=ol.order_id AND s.status='paid'
        WHERE p.legacy_id=?1)
        SELECT (SELECT count(*) FROM src) sourceOrders,p2.legacy_id productId,count(DISTINCT ol2.order_id) support
        FROM src JOIN order_lines ol2 ON ol2.order_id=src.order_id JOIN variants v2 ON v2.id=ol2.variant_id
        JOIN products p2 ON p2.id=v2.product_id WHERE p2.legacy_id IS NOT NULL AND p2.legacy_id<>?1
        GROUP BY p2.legacy_id HAVING support>=3 ORDER BY support DESC,productId LIMIT 30`
        )
        .bind(sourceId)
        .all<{ sourceOrders: number; productId: number; support: number }>()
    ])
    const edges = edgeResult.results.filter((edge) => edge.reviewed === 1)
    const alternativeEdges = edges.filter((edge) => edge.kind === 'substitute' || edge.kind === 'equivalent')
    const curatedComplements = edges.filter((edge) => edge.kind === 'accessory' || edge.kind === 'compatible')
    const excluded = new Set<number>([sourceId, ...edges.map((edge) => edge.targetId)])
    const sourceOrders = coResult.results[0]?.sourceOrders ?? 0
    const measured = selectCoPurchases(coResult.results, { sourceOrders, excludeProductIds: excluded, limit: 12 })

    const wanted = [...new Set([sourceId, ...edges.map((e) => e.targetId), ...measured.map((m) => m.productId)])]
    const [targetResult, variantResult] = await Promise.all([
      database
        .prepare(
          `WITH targets AS MATERIALIZED(SELECT p.* FROM products p JOIN categories category ON category.id=p.category_id AND category.status='published'
        WHERE p.legacy_id IN(SELECT value FROM json_each(?1)) AND p.legacy_id<>${sourceId} AND p.status='published' AND ${publicationValidityExpression('p')}),
        prices AS MATERIALIZED(SELECT v.product_id,${pricing.sql} grossCents,tax.rate_basis_points rate FROM variants v
        JOIN targets t ON t.id=v.product_id JOIN tax_classes tax ON tax.id=v.tax_class_id WHERE v.status='published' AND v.legacy_id IS NOT NULL),
        summary AS MATERIALIZED(SELECT product_id,min(grossCents) minPrice,
        min(CAST(round(grossCents*10000.0/(10000+rate)) AS INTEGER)) minNetPrice,count(*) formats FROM prices WHERE grossCents>0 GROUP BY product_id)
        SELECT t.legacy_id productId,t.slug,t.name,COALESCE(b.name,'NETECO') brand,t.regulatory,summary.minPrice,summary.minNetPrice,summary.formats
        FROM targets t JOIN summary ON summary.product_id=t.id LEFT JOIN brands b ON b.id=t.brand_id`
        )
        .bind(JSON.stringify(wanted), ...pricing.instantParameters)
        .all<TargetRow>(),
      database
        .prepare(
          `SELECT p.legacy_id productId,v.legacy_id variantId,v.sku,v.minimum_quantity minimumQuantity,v.backorder_allowed backorderAllowed,
        COALESCE((SELECT ${sellableExpression()} FROM inventory_balances b WHERE b.variant_id=v.id AND b.location_id=?2),0) sellable
        FROM variants v JOIN products p ON p.id=v.product_id
        WHERE p.legacy_id IN(SELECT value FROM json_each(?1)) AND v.status='published' AND v.legacy_id IS NOT NULL
        ORDER BY p.legacy_id,v.legacy_id`
        )
        .bind(JSON.stringify(wanted), single ? source.warehouseId : '')
        .all<VariantRow>()
    ])
    const rank: AvailabilityStatus[] = ['in_stock', 'low_stock', 'backorder', 'out_of_stock', 'unavailable']
    const statusOf = (row: VariantRow): AvailabilityStatus =>
      single
        ? classifyAvailability({
            sellable: row.sellable,
            minimumQuantity: row.minimumQuantity,
            backorderAllowed: row.backorderAllowed === 1
          })
        : 'unavailable'
    const canPickup = (status: AvailabilityStatus) => pickupEnabled && (status === 'in_stock' || status === 'low_stock')
    const byProduct = new Map<number, { status: AvailabilityStatus; pickup: boolean }>()
    for (const row of variantResult.results) {
      const status = statusOf(row),
        current = byProduct.get(row.productId)
      if (!current || rank.indexOf(status) < rank.indexOf(current.status))
        byProduct.set(row.productId, { status, pickup: canPickup(status) })
      else if (rank.indexOf(status) === rank.indexOf(current.status) && canPickup(status)) current.pickup = true
    }
    const targets = new Map(targetResult.results.map((row) => [row.productId, row]))
    const item = (id: number) => {
      const target = targets.get(id)
      if (!target) return null
      const availability = byProduct.get(id) ?? { status: 'unavailable' as const, pickup: false }
      return {
        productId: target.productId,
        slug: target.slug,
        name: target.name,
        brand: target.brand,
        minPrice: target.minPrice,
        minNetPrice: target.minNetPrice,
        formats: target.formats,
        availability: availability.status,
        pickupAvailable: availability.pickup,
        hazard: hazardOf(target.regulatory)
      }
    }
    const alternatives: DetailAlternative[] = []
    for (const edge of alternativeEdges) {
      const base = item(edge.targetId)
      if (base && !alternatives.some((a) => a.productId === base.productId))
        alternatives.push({ ...base, kind: edge.kind as 'substitute' | 'equivalent', reviewed: true })
    }
    const complements: DetailComplement[] = []
    for (const edge of curatedComplements) {
      const base = item(edge.targetId)
      if (base && !complements.some((c) => c.productId === base.productId))
        complements.push({ ...base, kind: edge.kind as 'accessory' | 'compatible', basis: 'curated' })
    }
    let measuredCount = 0
    for (const m of measured) {
      const base = item(m.productId)
      if (!base || measuredCount >= MAX_CO_PURCHASE) continue
      measuredCount++
      complements.push({
        ...base,
        kind: 'co_purchase',
        basis: 'co_purchase',
        support: m.support,
        confidencePermille: m.confidencePermille
      })
    }
    const own = variantResult.results.filter((row) => row.productId === sourceId)
    return productDetailExtrasSchema.parse({
      source: 'cloudflare',
      productSlug: source.slug,
      warehouse: { single, pickupEnabled },
      availability: own.map((row) => {
        const status = statusOf(row)
        return {
          variantId: row.variantId,
          sku: row.sku,
          status,
          sellable: single ? Math.min(PUBLIC_SELLABLE_CAP, Math.max(0, row.sellable)) : 0,
          pickupAvailable: canPickup(status)
        }
      }),
      hazard: hazardOf(source.regulatory),
      alternatives: arrangeAlternatives(alternatives, query.sort, query.availableOnly).slice(0, 20),
      complements: complements.slice(0, 20),
      notice: DETAIL_EXTRAS_NOTICE
    })
  } catch (error) {
    if (error instanceof ProductDetailExtrasError) throw error
    throw new ProductDetailExtrasError('service_unavailable')
  }
}
