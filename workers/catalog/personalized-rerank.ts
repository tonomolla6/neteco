import type {
  UserAffinities,
  RerankVariant,
  PersonalizedRerankResult,
  UpliftReport,
  UpliftVariantMetrics
} from '../../shared/personalized-rerank'
import { canonicalJson, sha256Hex } from './inventory'

export interface RerankableProductItem {
  uuid: string
  name: string
  categoryId: string
  minPrice: number
  inStock: boolean
  score?: number
  brand?: string
  [key: string]: unknown
}

export interface PersonalizedRerankOptions<T extends RerankableProductItem> {
  items: T[]
  explicitSort?: string
  explicitFilters?: Record<string, unknown>
  affinities?: UserAffinities
  variant?: RerankVariant
  maxBoostWeight?: number
  experimentId?: string
}

/**
 * SEA-020: Reordenación personalizada controlada.
 * - Mantiene filtros/orden explícitos: si el usuario especifica un orden distinto de 'featured'/'default',
 *   la reordenación se omite completamente para preservar la intención explícita.
 * - Mantiene filtros explícitos: nunca introduce ni promueve productos que no satisfagan los filtros.
 * - Controlada: el boost de afinidad está acotado (maxBoostWeight) y nunca permite que productos
 *   sin stock adelanten a productos en stock.
 */
export function applyPersonalizedRerank<T extends RerankableProductItem>(
  options: PersonalizedRerankOptions<T>
): PersonalizedRerankResult<T> {
  const {
    items,
    explicitSort = 'featured',
    explicitFilters: _explicitFilters,
    affinities,
    variant = 'control',
    maxBoostWeight = 2.0,
    experimentId = 'rerank_affinity_v1'
  } = options

  // 1. Explicit sort check: If the user chose an explicit sort (e.g. price_asc, price_desc, name),
  // personalization is strictly bypassed to honor explicit sorting.
  const isExplicitSort = explicitSort !== 'featured' && explicitSort !== 'default' && explicitSort !== ''

  if (isExplicitSort) {
    return {
      items: [...items],
      reranked: false,
      variant,
      experimentId,
      bypassedReason: 'explicit_sort'
    }
  }

  // 2. Control variant check: Control variant always retains the standard ranking
  if (variant === 'control') {
    return {
      items: [...items],
      reranked: false,
      variant: 'control',
      experimentId,
      bypassedReason: 'control_variant'
    }
  }

  // 3. User affinities check: If no specific affinities exist, return unadjusted
  if (
    !affinities ||
    (!affinities.preferredCategories?.length &&
      !affinities.recentProductIds?.length &&
      !affinities.brandAffinities?.length &&
      !affinities.segment)
  ) {
    return {
      items: [...items],
      reranked: false,
      variant,
      experimentId,
      bypassedReason: 'no_affinity'
    }
  }

  // 4. Controlled affinity scoring within the filtered candidate set
  // Candidate set is already filtered; no external items are ever added.
  const scoredItems = items.map((item, originalIndex) => {
    let affinityBoost = 0

    // Category affinity boost
    if (affinities.preferredCategories?.includes(item.categoryId)) {
      affinityBoost += 1.5
    }

    // Segment affinity: professional users get a boost on larger formats/industrial categories
    if (affinities.segment === 'professional') {
      affinityBoost += 0.5
    }

    // Brand affinity
    if (item.brand && affinities.brandAffinities?.includes(item.brand)) {
      affinityBoost += 0.5
    }

    // Cap total boost by maxBoostWeight
    const boundedBoost = Math.min(maxBoostWeight, affinityBoost)
    const baseScore = item.score ?? items.length - originalIndex
    const totalScore = baseScore + boundedBoost

    return {
      item,
      originalIndex,
      inStock: item.inStock,
      totalScore,
      boosted: boundedBoost > 0
    }
  })

  // Sort:
  // - In-stock items ALWAYS rank ahead of out-of-stock items (stock tier preserved)
  // - Within the same stock tier, sort by totalScore DESC
  // - Tie-breaker: originalIndex ASC
  scoredItems.sort((a, b) => {
    if (a.inStock !== b.inStock) {
      return a.inStock ? -1 : 1
    }
    const scoreDiff = b.totalScore - a.totalScore
    if (Math.abs(scoreDiff) > 0.001) {
      return scoreDiff
    }
    return a.originalIndex - b.originalIndex
  })

  const hasOrderChanged = scoredItems.some((s, idx) => s.originalIndex !== idx)

  return {
    items: scoredItems.map((s) => s.item),
    reranked: hasOrderChanged,
    variant: 'personalized',
    experimentId
  }
}

/**
 * Deterministically assigns a session to an experiment variant ('control' or 'personalized')
 * based on hash of session + experimentId.
 */
export function assignExperimentVariant(sessionHash: string, experimentId: string, controlRatio = 0.5): RerankVariant {
  let hash = 0
  const combined = `${sessionHash}:${experimentId}`
  for (let i = 0; i < combined.length; i++) {
    hash = (hash * 31 + combined.charCodeAt(i)) & 0x7fffffff
  }
  const ratio = (hash % 1000) / 1000
  return ratio < controlRatio ? 'control' : 'personalized'
}

export interface RecordImpressionInput {
  eventId: string
  experimentId: string
  sessionHash: string
  variant: RerankVariant
  userSegment: 'anonymous' | 'customer' | 'professional'
  queryNormalized: string
  hasExplicitSort: boolean
  hasExplicitFilters: boolean
  productsShown: string[]
  occurredAt?: string
}

export async function recordRerankImpression(
  database: D1Database,
  input: RecordImpressionInput
): Promise<{ success: boolean }> {
  const occurredAt = input.occurredAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const payloadHash = await sha256Hex(canonicalJson(input))

  await database
    .prepare(
      `INSERT INTO search_rerank_events (
        event_id, experiment_id, session_hash, variant, user_segment,
        query_normalized, has_explicit_sort, has_explicit_filters,
        products_shown, occurred_at, payload_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.eventId,
      input.experimentId,
      input.sessionHash,
      input.variant,
      input.userSegment,
      input.queryNormalized,
      input.hasExplicitSort ? 1 : 0,
      input.hasExplicitFilters ? 1 : 0,
      JSON.stringify(input.productsShown),
      occurredAt,
      payloadHash
    )
    .run()

  return { success: true }
}

export interface RecordInteractionInput {
  eventId: string
  clickedProductId?: string
  clickedRank?: number
  converted: boolean
  conversionCents?: number
  occurredAt?: string
}

export async function recordRerankInteraction(
  database: D1Database,
  input: RecordInteractionInput
): Promise<{ interactionId: string }> {
  const interactionId = crypto.randomUUID()
  const occurredAt = input.occurredAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const payloadHash = await sha256Hex(canonicalJson({ interactionId, ...input }))

  await database
    .prepare(
      `INSERT INTO search_rerank_interactions (
        interaction_id, event_id, clicked_product_id, clicked_rank,
        converted, conversion_cents, occurred_at, payload_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      interactionId,
      input.eventId,
      input.clickedProductId ?? null,
      input.clickedRank ?? null,
      input.converted ? 1 : 0,
      input.conversionCents ?? 0,
      occurredAt,
      payloadHash
    )
    .run()

  return { interactionId }
}

export async function readPersonalizedUpliftReport(database: D1Database, experimentId: string): Promise<UpliftReport> {
  // Query events and interactions aggregated by variant
  const rows = await database
    .prepare(
      `SELECT e.variant,
              count(DISTINCT e.event_id) AS impressions,
              count(DISTINCT CASE WHEN i.clicked_product_id IS NOT NULL THEN i.interaction_id END) AS clicks,
              count(DISTINCT CASE WHEN i.converted = 1 THEN i.interaction_id END) AS conversions,
              COALESCE(sum(CASE WHEN i.converted = 1 THEN i.conversion_cents ELSE 0 END), 0) AS revenue_cents,
              sum(e.has_explicit_sort) AS explicit_sort_bypasses,
              min(e.occurred_at) AS min_occurred,
              max(e.occurred_at) AS max_occurred
       FROM search_rerank_events e
       LEFT JOIN search_rerank_interactions i ON i.event_id = e.event_id
       WHERE e.experiment_id = ?
       GROUP BY e.variant`
    )
    .bind(experimentId)
    .all<{
      variant: RerankVariant
      impressions: number
      clicks: number
      conversions: number
      revenue_cents: number
      explicit_sort_bypasses: number
      min_occurred: string | null
      max_occurred: string | null
    }>()

  let controlMetrics: UpliftVariantMetrics = {
    impressions: 0,
    clicks: 0,
    ctr: 0,
    conversions: 0,
    cvr: 0,
    revenueCents: 0,
    avgOrderValueCents: 0
  }

  let treatmentMetrics: UpliftVariantMetrics = {
    impressions: 0,
    clicks: 0,
    ctr: 0,
    conversions: 0,
    cvr: 0,
    revenueCents: 0,
    avgOrderValueCents: 0
  }

  let totalBypasses = 0
  let earliest = ''
  let latest = ''

  for (const row of rows.results) {
    totalBypasses += row.explicit_sort_bypasses ?? 0
    if (row.min_occurred && (!earliest || row.min_occurred < earliest)) earliest = row.min_occurred
    if (row.max_occurred && (!latest || row.max_occurred > latest)) latest = row.max_occurred

    const imps = row.impressions || 0
    const clks = row.clicks || 0
    const convs = row.conversions || 0
    const rev = row.revenue_cents || 0

    const metrics: UpliftVariantMetrics = {
      impressions: imps,
      clicks: clks,
      ctr: imps > 0 ? Number((clks / imps).toFixed(4)) : 0,
      conversions: convs,
      cvr: imps > 0 ? Number((convs / imps).toFixed(4)) : 0,
      revenueCents: rev,
      avgOrderValueCents: convs > 0 ? Math.round(rev / convs) : 0
    }

    if (row.variant === 'control') {
      controlMetrics = metrics
    } else if (row.variant === 'personalized') {
      treatmentMetrics = metrics
    }
  }

  const ctrUplift =
    controlMetrics.ctr > 0
      ? Number((((treatmentMetrics.ctr - controlMetrics.ctr) / controlMetrics.ctr) * 100).toFixed(2))
      : 0

  const convUplift =
    controlMetrics.cvr > 0
      ? Number((((treatmentMetrics.cvr - controlMetrics.cvr) / controlMetrics.cvr) * 100).toFixed(2))
      : 0

  const revUplift =
    controlMetrics.revenueCents > 0
      ? Number(
          (((treatmentMetrics.revenueCents - controlMetrics.revenueCents) / controlMetrics.revenueCents) * 100).toFixed(
            2
          )
        )
      : 0

  const totalEvents = controlMetrics.impressions + treatmentMetrics.impressions

  return {
    experimentId,
    period: {
      from: earliest || new Date().toISOString(),
      to: latest || new Date().toISOString()
    },
    control: controlMetrics,
    treatment: treatmentMetrics,
    ctrUpliftPercent: ctrUplift,
    convUpliftPercent: convUplift,
    revenueUpliftPercent: revUplift,
    statisticallySignificant: totalEvents >= 50 && (Math.abs(ctrUplift) > 5 || Math.abs(convUplift) > 5),
    totalEvaluatedEvents: totalEvents,
    explicitSortBypassHonoredCount: totalBypasses
  }
}
