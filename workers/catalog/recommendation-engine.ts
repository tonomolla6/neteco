import {
  type RecommendationEnginePolicy,
  type RecommendationEnginePolicyInput,
  type RecommendationItem,
  type RecommendationRequest,
  type RecommendationResponse,
  type RecommendationEventInput,
  type RecommendationMetrics,
  recommendationEnginePolicyInputSchema,
  recommendationRequestSchema,
  recommendationEventInputSchema,
  applyCategoryDiversity
} from '../../shared/recommendation-engine'

export class RecommendationEngineError extends Error {
  constructor(
    readonly code:
      'invalid_input' | 'unauthenticated' | 'forbidden' | 'not_found' | 'version_conflict' | 'service_unavailable'
  ) {
    super(code)
    this.name = 'RecommendationEngineError'
  }
}

export const _RecommendationEngineError = RecommendationEngineError

function fail(code: RecommendationEngineError['code']): never {
  throw new RecommendationEngineError(code)
}

export const DEFAULT_RECOMMENDATION_POLICY: RecommendationEnginePolicy = {
  id: 'global',
  version: 1,
  weightCompatibility: 40,
  weightSector: 25,
  weightCopurchase: 25,
  weightMargin: 10,
  marginFloorBasisPoints: 1500,
  maxPerCategory: 2,
  manualFallbackProductIds: [],
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: '00000000-0000-4000-8000-000000000000'
}

export async function readD1RecommendationPolicy(db: D1Database): Promise<RecommendationEnginePolicy> {
  const row = await db
    .prepare(
      `SELECT id, version, weight_compatibility, weight_sector, weight_copurchase,
              weight_margin, margin_floor_basis_points, max_per_category,
              manual_fallback_product_ids, updated_at, updated_by
       FROM recommendation_engine_policies WHERE id = 'global'`
    )
    .first<{
      id: 'global'
      version: number
      weight_compatibility: number
      weight_sector: number
      weight_copurchase: number
      weight_margin: number
      margin_floor_basis_points: number
      max_per_category: number
      manual_fallback_product_ids: string
      updated_at: string
      updated_by: string
    }>()

  if (!row) return DEFAULT_RECOMMENDATION_POLICY

  return {
    id: row.id,
    version: row.version,
    weightCompatibility: row.weight_compatibility,
    weightSector: row.weight_sector,
    weightCopurchase: row.weight_copurchase,
    weightMargin: row.weight_margin,
    marginFloorBasisPoints: row.margin_floor_basis_points,
    maxPerCategory: row.max_per_category,
    manualFallbackProductIds: JSON.parse(row.manual_fallback_product_ids),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  }
}

export async function updateD1RecommendationPolicy(
  db: D1Database,
  actorId: string,
  rawInput: RecommendationEnginePolicyInput,
  now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
): Promise<RecommendationEnginePolicy> {
  const parsed = recommendationEnginePolicyInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data

  const existing = await readD1RecommendationPolicy(db)

  if (
    input.expectedVersion === 0 ||
    (existing.version === 1 && existing.updatedBy === '00000000-0000-4000-8000-000000000000')
  ) {
    const check = await db
      .prepare("SELECT version FROM recommendation_engine_policies WHERE id = 'global'")
      .first<{ version: number }>()
    if (!check) {
      if (input.expectedVersion !== 0 && input.expectedVersion !== 1) fail('version_conflict')
      const nextVersion = input.expectedVersion === 0 ? 1 : input.expectedVersion + 1
      await db
        .prepare(
          `INSERT INTO recommendation_engine_policies(
            id, version, weight_compatibility, weight_sector, weight_copurchase,
            weight_margin, margin_floor_basis_points, max_per_category,
            manual_fallback_product_ids, updated_at, updated_by
          ) VALUES('global', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
        )
        .bind(
          nextVersion,
          input.weightCompatibility,
          input.weightSector,
          input.weightCopurchase,
          input.weightMargin,
          input.marginFloorBasisPoints,
          input.maxPerCategory,
          JSON.stringify(input.manualFallbackProductIds),
          now,
          actorId
        )
        .run()

      return {
        id: 'global',
        version: nextVersion,
        weightCompatibility: input.weightCompatibility,
        weightSector: input.weightSector,
        weightCopurchase: input.weightCopurchase,
        weightMargin: input.weightMargin,
        marginFloorBasisPoints: input.marginFloorBasisPoints,
        maxPerCategory: input.maxPerCategory,
        manualFallbackProductIds: input.manualFallbackProductIds,
        updatedAt: now,
        updatedBy: actorId
      }
    }
  }

  if (existing.version !== input.expectedVersion) {
    fail('version_conflict')
  }

  const nextVersion = existing.version + 1
  const result = await db
    .prepare(
      `UPDATE recommendation_engine_policies
       SET version = ?1, weight_compatibility = ?2, weight_sector = ?3,
           weight_copurchase = ?4, weight_margin = ?5, margin_floor_basis_points = ?6,
           max_per_category = ?7, manual_fallback_product_ids = ?8,
           updated_at = ?9, updated_by = ?10
       WHERE id = 'global' AND version = ?11`
    )
    .bind(
      nextVersion,
      input.weightCompatibility,
      input.weightSector,
      input.weightCopurchase,
      input.weightMargin,
      input.marginFloorBasisPoints,
      input.maxPerCategory,
      JSON.stringify(input.manualFallbackProductIds),
      now,
      actorId,
      existing.version
    )
    .run()

  if (result.meta?.changes !== undefined && result.meta.changes === 0) {
    fail('version_conflict')
  }

  return {
    id: 'global',
    version: nextVersion,
    weightCompatibility: input.weightCompatibility,
    weightSector: input.weightSector,
    weightCopurchase: input.weightCopurchase,
    weightMargin: input.weightMargin,
    marginFloorBasisPoints: input.marginFloorBasisPoints,
    maxPerCategory: input.maxPerCategory,
    manualFallbackProductIds: input.manualFallbackProductIds,
    updatedAt: now,
    updatedBy: actorId
  }
}

export async function generateD1Recommendations(
  db: D1Database,
  rawRequest: RecommendationRequest,
  now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
): Promise<RecommendationResponse> {
  const parsed = recommendationRequestSchema.safeParse(rawRequest)
  if (!parsed.success) fail('invalid_input')
  const request = parsed.data

  const policy = await readD1RecommendationPolicy(db)

  // 1. Fetch relations if targetProductId is present
  const relationMap = new Map<string, 'compatible' | 'accessory' | 'substitute'>()
  if (request.targetProductId) {
    const relationRevision = await db
      .prepare(
        `SELECT r.relations_json
         FROM catalog_relation_heads h
         JOIN catalog_relation_revisions r ON r.product_id = h.product_id AND r.version = h.version
         WHERE h.product_id = ?1`
      )
      .bind(request.targetProductId)
      .first<{ relations_json: string }>()

    if (relationRevision?.relations_json) {
      try {
        const relations = JSON.parse(relationRevision.relations_json) as Array<{
          targetProductId: string | number
          kind: 'compatible' | 'accessory' | 'substitute'
        }>
        for (const rel of relations) {
          relationMap.set(String(rel.targetProductId), rel.kind)
        }
      } catch {
        // ignore parse error
      }
    }
  }

  // 2. Fetch co-purchases if targetProductId is present
  const coPurchaseMap = new Map<string, number>()
  if (request.targetProductId) {
    const coPurchases = await db
      .prepare(
        `SELECT CASE WHEN product_a_id = ?1 THEN product_b_id ELSE product_a_id END as other_id,
                co_purchase_count
         FROM catalog_co_purchases
         WHERE product_a_id = ?1 OR product_b_id = ?1`
      )
      .bind(request.targetProductId)
      .all<{ other_id: string; co_purchase_count: number }>()

    for (const cp of coPurchases.results ?? []) {
      coPurchaseMap.set(cp.other_id, cp.co_purchase_count)
    }
  }

  // 3. Fetch candidate products
  const excludedIds = new Set<string>(request.cartProductIds)
  if (request.targetProductId) {
    excludedIds.add(request.targetProductId)
  }

  const products = await db
    .prepare(
      `SELECT id, legacy_id, category_id, name, slug, attributes
       FROM products
       WHERE status = 'published'`
    )
    .all<{
      id: string
      legacy_id: number | null
      category_id: string
      name: string
      slug: string
      attributes: string | null
    }>()

  const candidateItems: RecommendationItem[] = []
  const totalWeight =
    policy.weightCompatibility + policy.weightSector + policy.weightCopurchase + policy.weightMargin || 1

  for (const p of products.results ?? []) {
    if (excludedIds.has(p.id)) continue

    let attrs: Record<string, unknown> = {}
    if (p.attributes) {
      try {
        attrs = JSON.parse(p.attributes)
      } catch {
        attrs = {}
      }
    }

    const marginBps: number = (attrs.grossMarginBasisPoints as number | undefined) ?? 2000

    // Strict margin floor filter (no loss-making or below-floor items)
    if (marginBps < policy.marginFloorBasisPoints) {
      continue
    }

    // A. Compatibility signal
    let compatibilityScore = 0
    const relKind = relationMap.get(p.id) ?? (p.legacy_id !== null ? relationMap.get(String(p.legacy_id)) : undefined)
    if (relKind === 'compatible') compatibilityScore = 1.0
    else if (relKind === 'accessory') compatibilityScore = 0.8
    else if (relKind === 'substitute') compatibilityScore = 0.5

    // B. Sector signal
    let sectorScore: number
    const prodSector = attrs.sector as string | undefined
    if (request.sector && prodSector) {
      if (prodSector === request.sector) sectorScore = 1.0
      else if (prodSector === 'general') sectorScore = 0.5
      else sectorScore = 0.0
    } else {
      sectorScore = 0.5
    }

    // C. Co-purchase signal
    const coPurchasesCount = coPurchaseMap.get(p.id) ?? 0
    const copurchaseScore = Math.min(1.0, coPurchasesCount / 10)

    // Must have at least one positive relevance signal (compatibility, sector, or co-purchase)
    if (compatibilityScore === 0 && copurchaseScore === 0 && sectorScore === 0) {
      continue
    }

    // D. Margin score
    const marginScore = Math.min(1.0, marginBps / 6000)

    // Composite weighted score
    const rawScore =
      (compatibilityScore * policy.weightCompatibility +
        sectorScore * policy.weightSector +
        copurchaseScore * policy.weightCopurchase +
        marginScore * policy.weightMargin) /
      totalWeight

    const score = Math.round(rawScore * 1000) / 10

    candidateItems.push({
      productId: p.id,
      categoryId: p.category_id,
      name: p.name,
      slug: p.slug,
      score,
      origin: 'rule',
      signals: {
        compatibilityScore,
        sectorScore,
        copurchaseScore,
        marginScore,
        grossMarginBasisPoints: marginBps
      }
    })
  }

  // Sort candidate items by score descending
  candidateItems.sort((a, b) => b.score - a.score)

  // Diversity filter
  const selected = applyCategoryDiversity(candidateItems, policy.maxPerCategory, request.limit)

  // 4. Manual Fallbacks if under limit
  if (selected.length < request.limit && policy.manualFallbackProductIds.length > 0) {
    const selectedIds = new Set(selected.map((item) => item.productId))
    const inCartSet = new Set(request.cartProductIds)
    for (const fbId of policy.manualFallbackProductIds) {
      if (selected.length >= request.limit) break
      if (inCartSet.has(fbId) || selectedIds.has(fbId)) continue

      const fbProduct = await db
        .prepare('SELECT id, category_id, name, slug, attributes FROM products WHERE id = ?1')
        .bind(fbId)
        .first<{ id: string; category_id: string; name: string; slug: string; attributes: string | null }>()

      if (!fbProduct) continue

      let attrs: Record<string, unknown> = {}
      if (fbProduct.attributes) {
        try {
          attrs = JSON.parse(fbProduct.attributes)
        } catch {
          attrs = {}
        }
      }
      const marginBps: number = (attrs.grossMarginBasisPoints as number | undefined) ?? 2000
      if (marginBps < policy.marginFloorBasisPoints) continue

      selected.push({
        productId: fbProduct.id,
        categoryId: fbProduct.category_id,
        name: fbProduct.name,
        slug: fbProduct.slug,
        score: 25,
        origin: 'manual_fallback',
        signals: {
          compatibilityScore: 0,
          sectorScore: 0.5,
          copurchaseScore: 0,
          marginScore: Math.min(1.0, marginBps / 6000),
          grossMarginBasisPoints: marginBps
        }
      })
      selectedIds.add(fbProduct.id)
    }
  }

  const requestId = crypto.randomUUID()

  // Track impression in database
  await db
    .prepare(
      `INSERT INTO recommendation_impressions(id, customer_id, target_product_id, sector, items_json, created_at)
       VALUES(?1, ?2, ?3, ?4, ?5, ?6)`
    )
    .bind(
      requestId,
      request.customerId ?? null,
      request.targetProductId ?? null,
      request.sector ?? null,
      JSON.stringify(selected.map((s) => ({ productId: s.productId, origin: s.origin }))),
      now
    )
    .run()

  return {
    source: 'cloudflare',
    requestId,
    targetProductId: request.targetProductId ?? null,
    items: selected,
    evaluatedAt: now
  }
}

export async function recordD1RecommendationEvent(
  db: D1Database,
  rawEvent: RecommendationEventInput,
  now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
): Promise<{ id: string }> {
  const parsed = recommendationEventInputSchema.safeParse(rawEvent)
  if (!parsed.success) fail('invalid_input')
  const event = parsed.data

  const id = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO recommendation_events(id, impression_id, event_type, product_id, order_id, gross_cents, position, created_at)
       VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
    .bind(
      id,
      event.impressionId,
      event.eventType,
      event.productId,
      event.orderId ?? null,
      event.grossCents ?? null,
      event.position ?? null,
      now
    )
    .run()

  return { id }
}

export async function getD1RecommendationMetrics(
  db: D1Database,
  periodDays = 30,
  now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
): Promise<RecommendationMetrics> {
  const periodThreshold = new Date(Date.parse(now) - periodDays * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

  const impressionCountRow = await db
    .prepare('SELECT COUNT(*) as count FROM recommendation_impressions WHERE created_at >= ?1')
    .bind(periodThreshold)
    .first<{ count: number }>()
  const impressions = impressionCountRow?.count ?? 0

  const eventStats = await db
    .prepare(
      `SELECT event_type, COUNT(*) as count, SUM(COALESCE(gross_cents, 0)) as total_gross
       FROM recommendation_events
       WHERE created_at >= ?1
       GROUP BY event_type`
    )
    .bind(periodThreshold)
    .all<{ event_type: string; count: number; total_gross: number }>()

  let clicks = 0
  let conversions = 0
  let attributedRevenueGrossCents = 0

  for (const row of eventStats.results ?? []) {
    if (row.event_type === 'click') clicks = row.count
    if (row.event_type === 'conversion') {
      conversions = row.count
      attributedRevenueGrossCents = row.total_gross ?? 0
    }
  }

  const clickThroughRate = impressions > 0 ? Math.round((clicks / impressions) * 10000) / 10000 : 0
  const conversionRate = clicks > 0 ? Math.round((conversions / clicks) * 10000) / 10000 : 0

  // Origin breakdown (attribution to rule vs manual fallback)
  const impressionsList = await db
    .prepare('SELECT id, items_json FROM recommendation_impressions WHERE created_at >= ?1')
    .bind(periodThreshold)
    .all<{ id: string; items_json: string }>()

  const originByImpressionProduct = new Map<string, 'rule' | 'manual_fallback'>()
  for (const imp of impressionsList.results ?? []) {
    try {
      const items = JSON.parse(imp.items_json) as Array<{ productId: string; origin: 'rule' | 'manual_fallback' }>
      for (const item of items) {
        originByImpressionProduct.set(`${imp.id}:${item.productId}`, item.origin)
      }
    } catch {
      // ignore
    }
  }

  const eventsList = await db
    .prepare('SELECT impression_id, event_type, product_id FROM recommendation_events WHERE created_at >= ?1')
    .bind(periodThreshold)
    .all<{ impression_id: string; event_type: string; product_id: string }>()

  let ruleClicks = 0
  let ruleConversions = 0
  let fallbackClicks = 0
  let fallbackConversions = 0

  for (const evt of eventsList.results ?? []) {
    const origin = originByImpressionProduct.get(`${evt.impression_id}:${evt.product_id}`) ?? 'rule'
    if (origin === 'rule') {
      if (evt.event_type === 'click') ruleClicks++
      if (evt.event_type === 'conversion') ruleConversions++
    } else {
      if (evt.event_type === 'click') fallbackClicks++
      if (evt.event_type === 'conversion') fallbackConversions++
    }
  }

  return {
    source: 'cloudflare',
    periodDays,
    impressions,
    clicks,
    conversions,
    clickThroughRate,
    conversionRate,
    attributedRevenueGrossCents,
    byOrigin: {
      rule: { clicks: ruleClicks, conversions: ruleConversions },
      manualFallback: { clicks: fallbackClicks, conversions: fallbackConversions }
    },
    evaluatedAt: now
  }
}
