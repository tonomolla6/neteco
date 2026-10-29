import {
  type AiSearchResponse,
  type GroundedCitation,
  type CurateGuideInput,
  AiSearchQueryInputSchema,
  CurateGuideInputSchema,
  assertSeoSafeAiResponse,
  SeoAiSearchError
} from '../../shared/seo-semantic-search'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { sha256Hex } from './bot-logs'

const SPANISH_STOPWORDS = new Set([
  'de',
  'la',
  'el',
  'en',
  'y',
  'a',
  'los',
  'del',
  'se',
  'las',
  'por',
  'un',
  'para',
  'con',
  'no',
  'una',
  'su',
  'al',
  'lo',
  'como',
  'mas',
  'pero',
  'sus',
  'le',
  'ya',
  'o',
  'este',
  'si',
  'porque',
  'esta',
  'entre',
  'cuando',
  'muy',
  'sin',
  'sobre',
  'tambien',
  'me',
  'hasta',
  'hay',
  'donde',
  'quien',
  'desde',
  'todo',
  'nos',
  'durante',
  'todos',
  'uno',
  'les',
  'ni',
  'contra',
  'otros',
  'ese',
  'eso',
  'ante',
  'ellos',
  'e',
  'esto',
  'mi',
  'antes',
  'algunos',
  'que',
  'cual',
  'cuales'
])

function getIsoNow(nowFn?: () => string): string {
  return nowFn ? nowFn() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export interface GroundedAiSearchOptions {
  query: string
  limit?: number
  now?: () => string
}

interface ProductRow {
  product_id: string
  product_slug: string
  product_title: string
  product_description: string
  category_slug: string
  category_name: string
  variant_id: string
  variant_sku: string
  variant_price_cents: number
}

export async function answerGroundedAiSearch(
  database: D1Database,
  options: GroundedAiSearchOptions
): Promise<AiSearchResponse> {
  const parsed = AiSearchQueryInputSchema.safeParse({
    query: options.query,
    limit: options.limit ?? 5
  })
  if (!parsed.success) {
    throw new SeoAiSearchError('invalid_input', `Consulta inválida: ${parsed.error.message}`)
  }

  const { query, limit } = parsed.data
  const now = getIsoNow(options.now)
  const normalized = query
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
  const tokens = normalized.split(/\s+/).filter((t) => t.length >= 2 && !SPANISH_STOPWORDS.has(t))

  // Query ONLY published and active products with active variants
  // Strict catalog grounding
  const { results: rawRows } = await database
    .prepare(
      `SELECT
        p.id as product_id,
        p.slug as product_slug,
        p.name as product_title,
        p.description as product_description,
        c.slug as category_slug,
        c.name as category_name,
        v.id as variant_id,
        v.sku as variant_sku,
        v.price_gross_cents as variant_price_cents
      FROM products p
      JOIN categories c ON c.id = p.category_id
      JOIN variants v ON v.product_id = p.id
      WHERE p.status = 'published' AND v.status = 'published'
      ORDER BY p.created_at DESC`
    )
    .all<ProductRow>()

  // Filter and score products strictly matching tokens
  const scoredProducts: Array<{ row: ProductRow; score: number; matchedTokens: string[] }> = []

  for (const row of rawRows) {
    const textToMatch = `${row.product_title} ${row.product_description} ${row.category_name} ${row.variant_sku}`
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')

    let score = 0
    const matchedTokens: string[] = []

    for (const token of tokens) {
      if (textToMatch.includes(token)) {
        score += 1
        matchedTokens.push(token)
      }
    }

    if (score > 0) {
      scoredProducts.push({ row, score, matchedTokens })
    }
  }

  // Sort by score descending
  scoredProducts.sort((a, b) => b.score - a.score)
  const topMatches = scoredProducts.slice(0, limit)

  let answerText: string
  const citations: GroundedCitation[] = []
  let groundingScore: number
  let canonicalUrl = '/catalogo'
  let suggestedCategorySlug: string | null = null

  if (topMatches.length === 0) {
    answerText =
      'Actualmente no disponemos de productos en nuestro catálogo profesional para esta consulta. Nuestro equipo técnico puede asesorarle en formulaciones a medida.'
    groundingScore = 0
  } else {
    suggestedCategorySlug = topMatches[0]?.row.category_slug ?? null
    canonicalUrl = suggestedCategorySlug
      ? `/categorias/${suggestedCategorySlug}`
      : `/producto/${topMatches[0]?.row.product_slug}`

    for (const match of topMatches) {
      const r = match.row
      const priceEuros = (r.variant_price_cents / 100).toFixed(2) + ' €'

      let safety =
        'Utilizar equipos de protección individual (EPIs): guantes de nitrilo y protección ocular homologada.'
      if (/alcalino|desengrasante|grasa/i.test(r.product_title)) {
        safety = 'Alcalino concentrado: no aplicar sobre aluminio desprotegido. Aclarar con abundante agua caliente.'
      } else if (/cal|acido|desincrustante/i.test(r.product_title)) {
        safety =
          'Carácter ácido: no mezclar jamás con lejía ni hipocloritos para evitar desprendimiento de gases tóxicos.'
      }

      citations.push({
        productId: r.product_id,
        slug: r.product_slug,
        title: r.product_title,
        sku: r.variant_sku,
        priceCents: r.variant_price_cents,
        formattedPrice: priceEuros,
        inStock: true,
        canonicalUrl: `/producto/${r.product_slug}`,
        relevanceSnippet: r.product_description?.slice(0, 200) || r.product_title,
        safetyAdvice: safety
      })
    }

    groundingScore = Math.min(1, Number((0.6 + citations.length * 0.1).toFixed(2)))

    const citedTitles = citations.map((c) => `"${c.title}" (Ref: ${c.sku})`).join(', ')
    answerText = `Para su consulta sobre "${query}", recomendamos según especificaciones de catálogo técnico: ${citedTitles}. Formulado para uso industrial e institucional conforme a la normativa vigente.`
  }

  const response: AiSearchResponse = {
    query,
    answerText,
    citations,
    groundingScore,
    isIndexable: false, // STRICTLY FALSE to protect base SEO from auto-generated thin pages
    noindexEnforced: true, // STRICTLY TRUE
    canonicalUrl,
    suggestedCategorySlug: suggestedCategorySlug ?? undefined
  }

  // Validate guardrail
  assertSeoSafeAiResponse(response)

  // Record query synthesis in D1
  const queryId = crypto.randomUUID()
  await database
    .prepare(
      `INSERT INTO seo_ai_search_queries (
        id, query_normalized, answer_text, citations_json, grounding_score,
        is_indexable, noindex_enforced, canonical_url, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, 0, 1, ?6, ?7)`
    )
    .bind(queryId, normalized, answerText, JSON.stringify(citations), groundingScore, canonicalUrl, now)
    .run()

  return response
}

export interface CurateGuideOptions {
  idempotencyKey: string
  now?: () => string
}

export async function curateEditorialGuide(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: CurateGuideInput,
  options: CurateGuideOptions
): Promise<{ guideId: string; version: number; status: string; isIndexable: boolean }> {
  // Authorization check
  const auth = await authorizeD1Session(database, claims, 'administration.manage', {
    now: options.now ? options.now() : undefined
  })
  if (!auth.allowed) {
    const catalogAuth = await authorizeD1Session(database, claims, 'catalog.write', {
      now: options.now ? options.now() : undefined
    })
    if (!catalogAuth.allowed) {
      throw new SeoAiSearchError('unauthorized', 'Permisos insuficientes para curar guías SEO')
    }
  }

  const parsed = CurateGuideInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new SeoAiSearchError('invalid_input', `Entrada de guía inválida: ${parsed.error.message}`)
  }

  const input = parsed.data
  const now = getIsoNow(options.now)
  const payloadHash = await sha256Hex(JSON.stringify(input))

  // Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM seo_ai_curated_guide_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new SeoAiSearchError(
        'idempotency_conflict',
        'La clave de idempotencia ya fue utilizada con una carga diferente'
      )
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  // Verify cited products exist and are published
  const { results: verifiedProducts } = await database
    .prepare(
      `SELECT id, slug, name as title FROM products
       WHERE id IN (SELECT value FROM json_each(?1)) AND status = 'published'`
    )
    .bind(JSON.stringify(input.productIds))
    .all<{ id: string; slug: string; title: string }>()

  if (verifiedProducts.length !== input.productIds.length) {
    throw new SeoAiSearchError(
      'invalid_product_reference',
      'Una o más referencias de producto no existen o no están publicadas'
    )
  }

  const commandId = crypto.randomUUID()
  const guideId = input.guideId ?? crypto.randomUUID()
  const canonicalUrl = `/guias/${input.slug}`
  const status = input.isIndexable ? 'approved' : 'draft'

  if (input.expectedVersion === 0) {
    // Check if guide already exists
    const existing = await database
      .prepare(`SELECT id, version FROM seo_ai_curated_guides WHERE id = ?1 OR slug = ?2`)
      .bind(guideId, input.slug)
      .first<{ id: string; version: number }>()

    if (existing) {
      throw new SeoAiSearchError(
        'version_conflict',
        `Conflicto CAS: la guía ya existe con versión ${existing.version}, pero se esperaba 0`
      )
    }

    // Creating new guide
    const receipt = { guideId, version: 1, status, isIndexable: input.isIndexable }

    await database.batch([
      database
        .prepare(
          `INSERT INTO seo_ai_curated_guides (
            id, slug, topic_query, title, approved_content, citations_json,
            is_indexable, canonical_url, reviewer_id, version, status, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?11, ?11)`
        )
        .bind(
          guideId,
          input.slug,
          input.topicQuery,
          input.title,
          input.approvedContent,
          JSON.stringify(verifiedProducts),
          input.isIndexable ? 1 : 0,
          canonicalUrl,
          claims.identityId,
          status,
          now
        ),
      database
        .prepare(
          `INSERT INTO seo_ai_curated_guide_commands (
            id, actor_id, session_id, session_version, idempotency_key, payload_hash,
            guide_id, expected_version, version, action, snapshot, receipt_json, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 1, 'create_guide', ?8, ?9, ?10)`
        )
        .bind(
          commandId,
          claims.identityId,
          claims.sessionId,
          claims.sessionVersion,
          options.idempotencyKey,
          payloadHash,
          guideId,
          JSON.stringify(input),
          JSON.stringify(receipt),
          now
        )
    ])

    return receipt
  } else {
    // Updating / Approving existing guide with CAS
    const existingGuide = await database
      .prepare(`SELECT version, status FROM seo_ai_curated_guides WHERE id = ?1`)
      .bind(guideId)
      .first<{ version: number; status: string }>()

    if (!existingGuide) {
      throw new SeoAiSearchError('not_found', 'Guía no encontrada')
    }

    if (existingGuide.version !== input.expectedVersion) {
      throw new SeoAiSearchError(
        'version_conflict',
        `Conflicto CAS: la versión esperada ${input.expectedVersion} no coincide con la actual ${existingGuide.version}`
      )
    }

    const nextVersion = existingGuide.version + 1
    const receipt = { guideId, version: nextVersion, status, isIndexable: input.isIndexable }

    await database.batch([
      database
        .prepare(
          `UPDATE seo_ai_curated_guides SET
            slug = ?1,
            topic_query = ?2,
            title = ?3,
            approved_content = ?4,
            citations_json = ?5,
            is_indexable = ?6,
            canonical_url = ?7,
            reviewer_id = ?8,
            version = ?9,
            status = ?10,
            updated_at = ?11
          WHERE id = ?12 AND version = ?13`
        )
        .bind(
          input.slug,
          input.topicQuery,
          input.title,
          input.approvedContent,
          JSON.stringify(verifiedProducts),
          input.isIndexable ? 1 : 0,
          canonicalUrl,
          claims.identityId,
          nextVersion,
          status,
          now,
          guideId,
          input.expectedVersion
        ),
      database
        .prepare(
          `INSERT INTO seo_ai_curated_guide_commands (
            id, actor_id, session_id, session_version, idempotency_key, payload_hash,
            guide_id, expected_version, version, action, snapshot, receipt_json, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'update_guide', ?10, ?11, ?12)`
        )
        .bind(
          commandId,
          claims.identityId,
          claims.sessionId,
          claims.sessionVersion,
          options.idempotencyKey,
          payloadHash,
          guideId,
          input.expectedVersion,
          nextVersion,
          JSON.stringify(input),
          JSON.stringify(receipt),
          now
        )
    ])

    return receipt
  }
}

interface CuratedGuideRow {
  id: string
  slug: string
  topic_query: string
  title: string
  approved_content: string
  citations_json: string
  is_indexable: number
  canonical_url: string
  version: number
  status: string
  created_at: string
  updated_at: string
}

export async function getCuratedGuideBySlug(
  database: D1Database,
  slug: string
): Promise<Record<string, unknown> | null> {
  const row = await database
    .prepare(`SELECT * FROM seo_ai_curated_guides WHERE slug = ?1`)
    .bind(slug)
    .first<CuratedGuideRow>()

  if (!row) return null

  return {
    id: row.id,
    slug: row.slug,
    topicQuery: row.topic_query,
    title: row.title,
    approvedContent: row.approved_content,
    citations: JSON.parse(row.citations_json),
    isIndexable: row.is_indexable === 1,
    canonicalUrl: row.canonical_url,
    version: row.version,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function listCuratedGuides(database: D1Database, limit = 20): Promise<Array<Record<string, unknown>>> {
  const { results } = await database
    .prepare(`SELECT * FROM seo_ai_curated_guides ORDER BY updated_at DESC LIMIT ?1`)
    .bind(limit)
    .all<CuratedGuideRow>()

  return results.map((row) => ({
    id: row.id,
    slug: row.slug,
    topicQuery: row.topic_query,
    title: row.title,
    isIndexable: row.is_indexable === 1,
    canonicalUrl: row.canonical_url,
    version: row.version,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))
}
