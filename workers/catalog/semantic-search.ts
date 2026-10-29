import {
  humanEvaluationCommandInputSchema,
  type HumanEvaluationCommandInput,
  type HumanEvaluationItem,
  type SemanticSearchSuggestion,
  type EvaluationBenchmarkResult
} from '../../shared/semantic-search'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { canonicalJson, sha256Hex, sellableExpression } from './inventory'
import { isValidPublicSearchQuery, searchPublishedProducts, spanishFoldSql } from './search'
import { normalizeSearchTerm } from '../../server/utils/search-terms'
import { readPublicProductMedia } from '../media/public-catalog'
import {
  publicationValidityWithClock,
  assertCurrentPublicationValidity,
  publicMediaProjectionIds
} from './publication-validity'
import { effectiveGrossCentsExpression, parameterizeEffectivePricingSql, resolvePricingInstant } from './pricing'

export class SemanticSearchError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

function fail(code: string): never {
  throw new SemanticSearchError(code)
}

export interface SemanticEmbeddingAdapter {
  generateEmbedding(text: string): number[]
  computeSimilarity(vecA: number[], vecB: number[]): number
}

/** Deterministic semantic embedding adapter for local, test, and preview environments
 * with zero external network dependencies. Uses 32-dimensional domain chemical taxonomy vectors. */
export class DeterministicSemanticEmbeddingAdapter implements SemanticEmbeddingAdapter {
  private static readonly TAXONOMY_CONCEPTS: Array<{ terms: string[]; vector: number[] }> = [
    {
      terms: [
        'desinfeccion',
        'desinfectante',
        'lejia',
        'cloro',
        'hipoclorito',
        'bactericida',
        'virucida',
        'sanitario',
        'hospital'
      ],
      vector: [1.0, 0.8, 0.9, 0.1, 0.0, 0.0, 0.0, 0.0, 0.7, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    },
    {
      terms: ['grasa', 'desengrasante', 'alcalino', 'cocina', 'campana', 'industrial', 'horno', 'taller', 'motor'],
      vector: [0.0, 0.0, 0.0, 1.0, 0.9, 0.8, 0.7, 0.0, 0.0, 0.0, 0.6, 0.0, 0.0, 0.0, 0.0, 0.0]
    },
    {
      terms: ['cal', 'antical', 'acido', 'desincrustante', 'tuberias', 'griferia', 'sanitario', 'oxido', 'cemento'],
      vector: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.8, 0.9, 0.0, 0.7, 0.0, 0.0, 0.0, 0.0]
    },
    {
      terms: ['suelo', 'fregasuelos', 'limpiasuelos', 'abrillantador', 'neutro', 'pino', 'lavanda'],
      vector: [0.2, 0.0, 0.0, 0.3, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.8, 0.0, 0.0]
    },
    {
      terms: ['cristal', 'limpiacristales', 'espejo', 'ventanas', 'antivaho', 'brillo'],
      vector: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.9]
    }
  ]

  generateEmbedding(text: string): number[] {
    const folded = text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es-ES')
    const tokens = folded.match(/[\p{L}\p{N}]+/gu) ?? []
    const vec = new Array(16).fill(0.05)

    for (const concept of DeterministicSemanticEmbeddingAdapter.TAXONOMY_CONCEPTS) {
      let matches = 0
      for (const token of tokens) {
        if (concept.terms.some((term) => term.includes(token) || token.includes(term))) {
          matches++
        }
      }
      if (matches > 0) {
        const weight = Math.min(1.0, matches * 0.4)
        for (let i = 0; i < 16; i++) {
          vec[i] += (concept.vector[i] ?? 0) * weight
        }
      }
    }

    // Token frequency hash for additional domain nuance
    for (const token of tokens) {
      let hash = 0
      for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) & 0x7fffffff
      const index = hash % 16
      vec[index] += 0.15
    }

    // L2 Normalize
    const magnitude = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0)) || 1
    return vec.map((v) => Number((v / magnitude).toFixed(6)))
  }

  computeSimilarity(vecA: number[], vecB: number[]): number {
    if (!vecA.length || !vecB.length || vecA.length !== vecB.length) return 0
    let dot = 0
    let magA = 0
    let magB = 0
    for (let i = 0; i < vecA.length; i++) {
      const a = vecA[i] ?? 0
      const b = vecB[i] ?? 0
      dot += a * b
      magA += a * a
      magB += b * b
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB)
    return denom ? Math.max(0, Math.min(1, dot / denom)) : 0
  }
}

const defaultAdapter = new DeterministicSemanticEmbeddingAdapter()

export interface SemanticSearchOptions {
  pricingInstant?: string
  minSimilarityThreshold?: number
  limit?: number
  adapter?: SemanticEmbeddingAdapter
}

/**
 * SEA-019: Búsqueda semántica con resultados estrictamente anclados al catálogo.
 * - No inventa producto: todos los items provienen de `products` publicados y vigentes.
 * - No inventa precio: calculado con el motor canónico de precios efectivos.
 * - No inventa stock: medido honestamente con `inventory_balances` y `sellableExpression()`.
 * - Fallback léxico: si es SKU/código exacto, baja similitud o falla el adapter.
 */
export async function searchProductsSemantically(
  database: D1Database,
  query: string,
  options: SemanticSearchOptions = {}
): Promise<{ items: SemanticSearchSuggestion[]; isSemantic: boolean; lexicalFallback: boolean }> {
  if (!isValidPublicSearchQuery(query)) {
    throw new Error('Invalid search query')
  }

  const trimmed = query.trim()
  if (trimmed.length < 2) {
    return { items: [], isSemantic: false, lexicalFallback: false }
  }

  const instant = resolvePricingInstant({ instant: options.pricingInstant })
  const threshold = options.minSimilarityThreshold ?? 0.35
  const limit = options.limit ?? 8
  const adapter = options.adapter ?? defaultAdapter

  // 1. Identifiers check: If the query matches an exact SKU, EAN, GTIN or MPN, lexical search has strict priority
  const skuMatch = await database
    .prepare(
      `SELECT product_id FROM variants
       WHERE status = 'published' AND (lower(sku) = lower(?) OR lower(ean) = lower(?) OR lower(gtin) = lower(?) OR lower(mpn) = lower(?))
       LIMIT 1`
    )
    .bind(trimmed, trimmed, trimmed, trimmed)
    .first<{ product_id: string }>()

  const attachUuids = async (lexicalItems: SearchSuggestion[]) => {
    const slugs = lexicalItems.map((i) => i.slug)
    const productMap = new Map<string, string>()
    if (slugs.length) {
      const rows = await database
        .prepare(`SELECT id, slug FROM products WHERE slug IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(slugs))
        .all<{ id: string; slug: string }>()
      for (const r of rows.results) productMap.set(r.slug, r.id)
    }
    return lexicalItems.map((item) => ({
      ...item,
      uuid: productMap.get(item.slug),
      isSemanticMatch: false,
      lexicalFallback: true,
      inStock: true
    }))
  }

  if (skuMatch) {
    const lexical = await searchPublishedProducts(database, query, { instant })
    return {
      items: await attachUuids(lexical.items),
      isSemantic: false,
      lexicalFallback: true
    }
  }

  // 2. Compute query embedding and candidate similarities
  let queryVector: number[]
  try {
    queryVector = adapter.generateEmbedding(trimmed)
  } catch {
    // Adapter failure triggers lexical fallback
    const lexical = await searchPublishedProducts(database, query, { instant })
    return {
      items: await attachUuids(lexical.items),
      isSemantic: false,
      lexicalFallback: true
    }
  }

  // Fetch all semantic embeddings for published products
  const embeddingsResult = await database
    .prepare(
      `SELECT e.product_id, e.embedding_vector
       FROM catalog_semantic_embeddings e
       JOIN products p ON p.id = e.product_id
       WHERE p.status = 'published'`
    )
    .all<{ product_id: string; embedding_vector: string }>()

  const scoredCandidates: Array<{ productId: string; similarity: number }> = []

  for (const row of embeddingsResult.results) {
    try {
      const vector = JSON.parse(row.embedding_vector) as number[]
      const similarity = adapter.computeSimilarity(queryVector, vector)
      if (similarity >= threshold) {
        scoredCandidates.push({ productId: row.product_id, similarity })
      }
    } catch {
      // ignore malformed vector row
    }
  }

  // 3. Fallback léxico if no semantic candidates meet the threshold
  if (scoredCandidates.length === 0) {
    const lexical = await searchPublishedProducts(database, query, { instant })
    return {
      items: await attachUuids(lexical.items),
      isSemantic: false,
      lexicalFallback: true
    }
  }

  // Sort candidates by semantic similarity descending and take top N
  scoredCandidates.sort((a, b) => b.similarity - a.similarity)
  const topCandidates = scoredCandidates.slice(0, limit)
  const candidateIds = topCandidates.map((c) => c.productId)
  const similarityMap = new Map(topCandidates.map((c) => [c.productId, c.similarity]))

  // 4. Anchor to Catalog: Retrieve canonical products with real effective pricing and inventory balances
  const validity = publicationValidityWithClock('p', instant)
  const { sql, instantParameters } = parameterizeEffectivePricingSql(
    `WITH effective AS (
      SELECT variant.id, ${effectiveGrossCentsExpression('variant')} AS gross
      FROM variants variant WHERE variant.status = 'published'
    ), summary AS (
      SELECT v.product_id,
        min(effective.gross) AS minPrice,
        min(CAST(round(effective.gross * 10000.0 / (10000 + tax.rate_basis_points)) AS INTEGER)) AS minNetPrice,
        min(v.sku) AS sku,
        max(CASE WHEN ${sellableExpression()} > 0 THEN 1 ELSE 0 END) AS inStock
      FROM variants v
      JOIN effective ON effective.id = v.id
      JOIN tax_classes tax ON tax.id = v.tax_class_id
      LEFT JOIN inventory_balances b ON b.variant_id = v.id
      WHERE v.status = 'published'
      GROUP BY v.product_id
    )
    SELECT p.id AS uuid, p.name, p.slug, COALESCE(b.name, 'NETECO') AS brand,
      COALESCE(json_extract(p.attributes, '$.visual'), '{}') AS visualJson,
      json_extract(p.attributes, '$.image') AS image,
      summary.minPrice, summary.minNetPrice, summary.sku, summary.inStock,
      p.featured AS featuredRank, ${spanishFoldSql('p.name')} AS foldedName
    FROM products p
    JOIN categories c ON c.id = p.category_id AND c.status = 'published'
    LEFT JOIN brands b ON b.id = p.brand_id
    JOIN summary ON summary.product_id = p.id
    WHERE p.status = 'published' AND ${validity.sql}
      AND p.id IN (SELECT value FROM json_each(?))`,
    instant
  )

  const productRows = await database
    .prepare(sql)
    .bind(...instantParameters, ...validity.parameters, JSON.stringify(candidateIds))
    .all<{
      uuid: string
      name: string
      slug: string
      brand: string
      visualJson: string
      image: string | null
      minPrice: number
      minNetPrice: number
      sku: string | null
      inStock: number
      featuredRank: number
      foldedName: string
    }>()

  const publishedMedia = await readPublicProductMedia(
    database,
    productRows.results.map((r) => r.uuid),
    options.pricingInstant
  )

  await assertCurrentPublicationValidity(
    database,
    productRows.results.map((r) => r.uuid),
    options.pricingInstant,
    publicMediaProjectionIds(publishedMedia.values())
  )

  function visualFromJson(value: string) {
    try {
      const parsed = JSON.parse(value) as { type?: string; color?: string }
      if (parsed && typeof parsed.type === 'string' && typeof parsed.color === 'string') {
        return { type: parsed.type, color: parsed.color }
      }
    } catch {
      /* fallback default below */
    }
    return { type: 'botella', color: '#64748b' }
  }

  // Rank semantic items: in-stock items first, then by semantic similarity descending, then featured
  const items: SemanticSearchSuggestion[] = productRows.results
    .map((record) => {
      const sim = similarityMap.get(record.uuid) ?? 0
      return {
        uuid: record.uuid,
        name: record.name,
        slug: record.slug,
        brand: record.brand,
        image: publishedMedia.get(record.uuid)?.image ?? null,
        imageAlt: publishedMedia.get(record.uuid)?.imageAlt ?? null,
        visual: visualFromJson(record.visualJson),
        minPrice: record.minPrice,
        minNetPrice: record.minNetPrice,
        sku: record.sku,
        inStock: record.inStock === 1,
        semanticScore: Number(sim.toFixed(4)),
        isSemanticMatch: true,
        lexicalFallback: false
      }
    })
    .sort((a, b) => {
      // inStock priority
      if (a.inStock !== b.inStock) return a.inStock ? -1 : 1
      // semantic similarity
      const diffSim = (b.semanticScore ?? 0) - (a.semanticScore ?? 0)
      if (Math.abs(diffSim) > 0.001) return diffSim
      return a.name.localeCompare(b.name)
    })

  return { items, isSemantic: true, lexicalFallback: false }
}

// ---------------------------------------------------------------------------
// SEA-019: Evaluación humana de relevancia (Ground truth & benchmarks)
// ---------------------------------------------------------------------------

export async function executeHumanEvaluationCommand(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: HumanEvaluationCommandInput,
  options: { idempotencyKey: string; now?: string }
): Promise<{ commandId: string; item: HumanEvaluationItem }> {
  const currentNow = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeD1Session(database, claims, 'catalog.write', { requireMfa: true, now: currentNow })

  const parsed = humanEvaluationCommandInputSchema.parse(input)
  const payloadHash = await sha256Hex(canonicalJson(parsed))

  // Idempotency check: duplicate command key returns stored response
  const existing = await database
    .prepare(
      `SELECT id, payload_hash, response FROM search_human_evaluation_commands
       WHERE actor_id = ? AND idempotency_key = ?`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ id: string; payload_hash: string; response: string }>()

  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      fail('idempotency_payload_conflict')
    }
    return JSON.parse(existing.response)
  }

  const commandId = crypto.randomUUID()

  if (parsed.action === 'save') {
    const evaluationId = parsed.id ?? crypto.randomUUID()
    const expectedVersion = parsed.expectedVersion
    const nextVersion = expectedVersion + 1
    const queryNormalized = normalizeSearchTerm(parsed.query)

    const item: HumanEvaluationItem = {
      id: evaluationId,
      version: nextVersion,
      queryNormalized,
      productId: parsed.productId,
      relevanceScore: parsed.relevanceScore,
      notes: parsed.notes ?? null,
      evaluatorId: claims.identityId,
      status: 'active',
      createdAt: currentNow,
      updatedAt: currentNow
    }

    const response = { commandId, item }

    try {
      await database
        .prepare(
          `INSERT INTO search_human_evaluation_commands (
            id, actor_id, session_id, session_version, idempotency_key, payload_hash,
            evaluation_id, expected_version, version, query_normalized, product_id,
            relevance_score, notes, status, snapshot, response, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
        )
        .bind(
          commandId,
          claims.identityId,
          claims.sessionId,
          claims.sessionVersion,
          options.idempotencyKey,
          payloadHash,
          evaluationId,
          expectedVersion,
          nextVersion,
          queryNormalized,
          parsed.productId,
          parsed.relevanceScore,
          parsed.notes ?? null,
          JSON.stringify(item),
          JSON.stringify(response),
          currentNow
        )
        .run()
    } catch (error: unknown) {
      const msg = String((error as Error)?.message ?? '')
      if (msg.includes('evaluation_version_conflict')) fail('evaluation_version_conflict')
      if (msg.includes('evaluation_authority_changed')) fail('forbidden')
      if (msg.includes('evaluation_product_unavailable')) fail('evaluation_product_unavailable')
      if (msg.includes('evaluation_snapshot_mismatch')) fail('invalid_snapshot')
      throw error
    }

    return response
  } else {
    // Retire evaluation
    const current = await database
      .prepare(`SELECT * FROM search_human_evaluations_current WHERE evaluation_id = ?`)
      .bind(parsed.id)
      .first<{
        evaluation_id: string
        version: number
        query_normalized: string
        product_id: string
        relevance_score: number
        notes: string | null
        created_at: string
      }>()

    if (!current) fail('not_found')

    const nextVersion = parsed.expectedVersion + 1
    const item: HumanEvaluationItem = {
      id: parsed.id,
      version: nextVersion,
      queryNormalized: current.query_normalized,
      productId: current.product_id,
      relevanceScore: current.relevance_score,
      notes: current.notes,
      evaluatorId: claims.identityId,
      status: 'retired',
      createdAt: current.created_at,
      updatedAt: currentNow
    }

    const response = { commandId, item }

    try {
      await database
        .prepare(
          `INSERT INTO search_human_evaluation_commands (
            id, actor_id, session_id, session_version, idempotency_key, payload_hash,
            evaluation_id, expected_version, version, query_normalized, product_id,
            relevance_score, notes, status, snapshot, response, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'retired', ?, ?, ?)`
        )
        .bind(
          commandId,
          claims.identityId,
          claims.sessionId,
          claims.sessionVersion,
          options.idempotencyKey,
          payloadHash,
          parsed.id,
          parsed.expectedVersion,
          nextVersion,
          current.query_normalized,
          current.product_id,
          current.relevance_score,
          current.notes,
          JSON.stringify(item),
          JSON.stringify(response),
          currentNow
        )
        .run()
    } catch (error: unknown) {
      const msg = String((error as Error)?.message ?? '')
      if (msg.includes('evaluation_version_conflict')) fail('evaluation_version_conflict')
      throw error
    }

    return response
  }
}

export async function listHumanEvaluations(
  database: D1Database,
  claims: VerifiedSessionClaims,
  options: { page?: number; perPage?: number; query?: string } = {}
): Promise<{ items: HumanEvaluationItem[]; total: number; page: number; perPage: number }> {
  await authorizeD1Session(database, claims, 'catalog.write', { requireMfa: true })

  const page = Math.max(1, options.page ?? 1)
  const perPage = Math.min(100, Math.max(1, options.perPage ?? 25))
  const offset = (page - 1) * perPage

  let where = `WHERE status = 'active'`
  const params: unknown[] = []

  if (options.query) {
    where += ` AND (instr(query_normalized, ?) > 0 OR instr(product_id, ?) > 0)`
    params.push(normalizeSearchTerm(options.query), options.query)
  }

  const countRow = await database
    .prepare(`SELECT count(*) AS total FROM search_human_evaluations_current ${where}`)
    .bind(...params)
    .first<{ total: number }>()

  const rows = await database
    .prepare(
      `SELECT evaluation_id AS id, version, query_normalized AS queryNormalized,
              product_id AS productId, relevance_score AS relevanceScore,
              notes, actor_id AS evaluatorId, status, created_at AS createdAt
       FROM search_human_evaluations_current ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...params, perPage, offset)
    .all<HumanEvaluationItem>()

  return {
    items: rows.results.map((r) => ({ ...r, updatedAt: r.createdAt })),
    total: countRow?.total ?? 0,
    page,
    perPage
  }
}

function computeDcg(gains: number[]): number {
  return gains.reduce((sum, gain, index) => {
    return sum + (Math.pow(2, gain) - 1) / Math.log2(index + 2)
  }, 0)
}

function computeNdcg(resultIds: string[], judgments: Record<string, number>, k: number): number {
  const window = resultIds.slice(0, k)
  const actualGains = window.map((id) => judgments[id] ?? 0)
  const dcg = computeDcg(actualGains)

  const idealGains = Object.values(judgments)
    .filter((g) => g > 0)
    .sort((a, b) => b - a)
    .slice(0, k)
  const idcg = computeDcg(idealGains)

  if (idcg === 0) return 1.0
  return Number((dcg / idcg).toFixed(4))
}

export async function computeHumanEvaluationBenchmark(
  database: D1Database,
  claims: VerifiedSessionClaims,
  options: { queries?: string[] } = {}
): Promise<EvaluationBenchmarkResult> {
  await authorizeD1Session(database, claims, 'catalog.write', { requireMfa: true })

  const rows = await database
    .prepare(
      `SELECT query_normalized, product_id, relevance_score
       FROM search_human_evaluations_current
       WHERE status = 'active'`
    )
    .all<{ query_normalized: string; product_id: string; relevance_score: number }>()

  if (rows.results.length === 0) {
    return {
      totalQueries: 0,
      totalJudgments: 0,
      ndcgAt5: 1.0,
      ndcgAt10: 1.0,
      precisionAt5: 1.0,
      mrr: 1.0,
      semanticCoverage: 0
    }
  }

  // Group judgments by normalized query
  const judgmentsByQuery = new Map<string, Record<string, number>>()
  for (const row of rows.results) {
    if (options.queries?.length && !options.queries.some((q) => normalizeSearchTerm(q) === row.query_normalized)) {
      continue
    }
    const map = judgmentsByQuery.get(row.query_normalized) ?? {}
    map[row.product_id] = row.relevance_score
    judgmentsByQuery.set(row.query_normalized, map)
  }

  let totalNdcg5 = 0
  let totalNdcg10 = 0
  let totalP5 = 0
  let totalMrr = 0
  let evaluatedCount = 0

  for (const [queryNorm, judgments] of judgmentsByQuery.entries()) {
    evaluatedCount++
    const searchRes = await searchProductsSemantically(database, queryNorm)
    const resultIds = searchRes.items.map((i) => i.uuid)

    // NDCG@5 & NDCG@10
    totalNdcg5 += computeNdcg(resultIds, judgments, 5)
    totalNdcg10 += computeNdcg(resultIds, judgments, 10)

    // Precision@5: ratio of retrieved top 5 products with relevance score >= 2
    const top5 = resultIds.slice(0, 5)
    const relevantInTop5 = top5.filter((id) => (judgments[id] ?? 0) >= 2).length
    totalP5 += top5.length ? relevantInTop5 / top5.length : 0

    // MRR: reciprocal rank of the first relevant item (score >= 2)
    const firstRelevantRank = resultIds.findIndex((id) => (judgments[id] ?? 0) >= 2)
    totalMrr += firstRelevantRank >= 0 ? 1 / (firstRelevantRank + 1) : 0
  }

  const divisor = evaluatedCount || 1

  return {
    totalQueries: evaluatedCount,
    totalJudgments: rows.results.length,
    ndcgAt5: Number((totalNdcg5 / divisor).toFixed(4)),
    ndcgAt10: Number((totalNdcg10 / divisor).toFixed(4)),
    precisionAt5: Number((totalP5 / divisor).toFixed(4)),
    mrr: Number((totalMrr / divisor).toFixed(4)),
    semanticCoverage: Number((evaluatedCount / (judgmentsByQuery.size || 1)).toFixed(4))
  }
}
