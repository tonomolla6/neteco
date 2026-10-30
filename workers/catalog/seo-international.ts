import { z } from 'zod'
import type { VerifiedSessionClaims } from './authorization'
import { canonicalPayloadHash } from './cart'
import { checkAdminAuthority, isConstraintFailure, isUuid, serverNow } from './admin-command-authority'
import { buildHreflangSet, HreflangError, type HreflangSet } from '../../shared/seo-international'
import { localeSchema, marketCodeSchema } from '../../shared/catalog-markets'

interface Options {
  now?: () => string
}

const reviewInputSchema = z
  .object({
    marketCode: marketCodeSchema,
    reviewedConfigVersion: z.number().int().min(1).max(1_000_000),
    locale: localeSchema,
    reviewerName: z.string().trim().min(2).max(120)
  })
  .strict()

export type MarketTranslationReviewInput = z.infer<typeof reviewInputSchema>

export interface MarketTranslationReview {
  commandId: string
  productId: string
  marketCode: string
  reviewedConfigVersion: number
  locale: string
  createdAt: string
}

/**
 * A translation becomes indexable only after a human reviewed exactly this version of the
 * market content. Editing the content bumps the version and silently withdraws the alternate.
 */
export async function reviewMarketTranslation(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  commandId: string,
  productId: string,
  rawInput: unknown,
  options?: Options
): Promise<MarketTranslationReview> {
  if (!isUuid(commandId) || typeof productId !== 'string' || productId.length < 1 || productId.length > 64)
    throw new HreflangError('invalid_input')
  const parsed = reviewInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new HreflangError('invalid_input')
  const input = parsed.data

  const now = serverNow(options?.now)
  const authority = await checkAdminAuthority(database, claims, now)
  if (!authority.ok) throw new HreflangError(authority.code)

  const payloadHash = await canonicalPayloadHash({ productId, actorId: authority.actorId, ...input })
  const existing = await database
    .prepare(
      `SELECT command_id AS commandId, product_id AS productId, market_code AS marketCode,
              reviewed_config_version AS reviewedConfigVersion, locale, payload_hash AS payloadHash, created_at AS createdAt
       FROM catalog_market_translation_reviews WHERE command_id = ?1`
    )
    .bind(commandId)
    .first<MarketTranslationReview & { payloadHash: string }>()
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new HreflangError('conflict')
    const { payloadHash: _hash, ...replay } = existing
    return replay
  }

  const config = await database
    .prepare('SELECT version, locale FROM catalog_market_configs WHERE product_id = ?1 AND market_code = ?2')
    .bind(productId, input.marketCode)
    .first<{ version: number; locale: string }>()
  if (!config) throw new HreflangError('not_found')
  if (config.version !== input.reviewedConfigVersion || config.locale !== input.locale)
    throw new HreflangError('conflict')

  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO catalog_market_translation_reviews(
             command_id, product_id, market_code, reviewed_config_version, locale, reviewer_name,
             actor_id, session_id, session_version, payload_hash, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
        )
        .bind(
          commandId,
          productId,
          input.marketCode,
          input.reviewedConfigVersion,
          input.locale,
          input.reviewerName,
          authority.actorId,
          claims!.sessionId,
          claims!.sessionVersion,
          payloadHash,
          now
        )
    ])
  } catch (error) {
    if (isConstraintFailure(error, 'authority')) throw new HreflangError('forbidden')
    if (isConstraintFailure(error, 'stale_config', 'UNIQUE', 'PRIMARY KEY')) throw new HreflangError('conflict')
    throw error
  }
  return {
    commandId,
    productId,
    marketCode: input.marketCode,
    reviewedConfigVersion: input.reviewedConfigVersion,
    locale: input.locale,
    createdAt: now
  }
}

export type HreflangMarketExclusion =
  | 'market_inactive'
  | 'not_available'
  | 'not_publicly_sellable'
  | 'sds_missing'
  | 'translation_not_reviewed'
  | 'duplicate_hreflang'
  | 'invalid_slug'
  | 'invalid_locale'

export interface ProductHreflang {
  productId: string
  canonical: string
  links: HreflangSet['links']
  excluded: Array<{ marketCode: string; reason: HreflangMarketExclusion }>
}

interface ConfigRow {
  marketCode: string
  locale: string
  slug: string
  isAvailable: number
  isCompliant: number
  availabilityStatus: string
  clpWarnings: string
  sdsUrl: string | null
  marketActive: number
  reviewed: string | null
}

function hasWarnings(json: string): boolean {
  try {
    const parsed: unknown = JSON.parse(json)
    return !Array.isArray(parsed) || parsed.length > 0
  } catch {
    return true
  }
}

export async function resolveProductHreflang(
  database: D1Database,
  query: { origin: string; slug?: string; productId?: string; market?: string },
  _options?: Options
): Promise<ProductHreflang> {
  if (query.market !== undefined && !marketCodeSchema.safeParse(query.market).success)
    throw new HreflangError('invalid_input')
  if (
    (!query.slug && !query.productId) ||
    (query.slug !== undefined && !/^[a-z0-9-]{1,255}$/.test(query.slug)) ||
    (query.productId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(query.productId))
  )
    throw new HreflangError('invalid_input')

  const product = await database
    .prepare(
      `SELECT id, slug FROM products WHERE status = 'published' AND ${query.slug ? 'slug = ?1' : 'id = ?1'} LIMIT 1`
    )
    .bind(query.slug ?? query.productId)
    .first<{ id: string; slug: string }>()
  if (!product) throw new HreflangError('not_found')

  const { results } = await database
    .prepare(
      `SELECT c.market_code AS marketCode, c.locale, c.slug, c.is_available AS isAvailable, c.is_compliant AS isCompliant,
              c.availability_status AS availabilityStatus, c.clp_warnings AS clpWarnings, c.sds_url AS sdsUrl,
              m.is_active AS marketActive, r.command_id AS reviewed
       FROM catalog_market_configs c
       JOIN catalog_markets m ON m.code = c.market_code
       LEFT JOIN catalog_market_translation_reviews r
         ON r.product_id = c.product_id AND r.market_code = c.market_code
        AND r.reviewed_config_version = c.version AND r.locale = c.locale
       WHERE c.product_id = ?1 AND c.market_code <> 'ES'
       ORDER BY c.market_code`
    )
    .bind(product.id)
    .all<ConfigRow>()

  const excluded: ProductHreflang['excluded'] = []
  const eligible: Array<{ marketCode: string; locale: string; slug: string }> = []
  for (const row of results) {
    let reason: HreflangMarketExclusion | null = null
    if (!row.marketActive) reason = 'market_inactive'
    else if (!row.isAvailable || !row.isCompliant) reason = 'not_available'
    else if (['restricted', 'b2b_only', 'discontinued'].includes(row.availabilityStatus))
      reason = 'not_publicly_sellable'
    else if (hasWarnings(row.clpWarnings) && !row.sdsUrl) reason = 'sds_missing'
    else if (!row.reviewed) reason = 'translation_not_reviewed'
    if (reason) excluded.push({ marketCode: row.marketCode, reason })
    else eligible.push({ marketCode: row.marketCode, locale: row.locale, slug: row.slug })
  }

  const set = buildHreflangSet(query.origin, { slug: product.slug }, eligible)
  const canonical = set.canonicalByMarket[query.market ?? 'ES']
  if (!canonical) throw new HreflangError('not_found')
  return { productId: product.id, canonical, links: set.links, excluded: [...excluded, ...set.excluded] }
}
