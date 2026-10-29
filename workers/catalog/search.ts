import type { SearchSuggestion } from '../../shared/types/catalog'
import { normalizeSynonymTerm } from '../../shared/search-synonyms'
import { normalizeSearchTerm } from '../../server/utils/search-terms'
import { sellableExpression } from './inventory'
import { readPublicProductMedia } from '../media/public-catalog'
import {
  publicationValidityWithClock,
  assertCurrentPublicationValidity,
  publicMediaProjectionIds
} from './publication-validity'
import {
  effectiveGrossCentsExpression,
  parameterizeEffectivePricingSql,
  resolvePricingInstant,
  type EffectivePricingOptions
} from './pricing'

export const PUBLIC_SEARCH_MAX_LENGTH = 160
/** Bound of one product's merchandising adjustment, mirrored by the 0091 CHECK on `weight`. */
export const SEARCH_MERCHANDISING_MAX_WEIGHT = 10

export function isValidPublicSearchQuery(value: string) {
  return (
    value.length <= PUBLIC_SEARCH_MAX_LENGTH &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  )
}

/** unicode61 in the existing FTS index handles accents; substring matching supplements names,
 * brands and categories that are not all indexed. SQLite lower is ASCII-only. */
export function spanishFoldSql(expression: string) {
  const replacements = [
    ['Á', 'a'],
    ['á', 'a'],
    ['É', 'e'],
    ['é', 'e'],
    ['Í', 'i'],
    ['í', 'i'],
    ['Ó', 'o'],
    ['ó', 'o'],
    ['Ú', 'u'],
    ['ú', 'u'],
    ['Ü', 'u'],
    ['ü', 'u'],
    ['Ñ', 'n'],
    ['ñ', 'n']
  ] as const
  return `lower(${replacements.reduce((sql, [from, to]) => `replace(${sql}, '${from}', '${to}')`, expression)})`
}

function likePattern(term: string) {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`
}

export function synonymTermData(term: string) {
  const folded = normalizeSynonymTerm(term)
  return {
    term: folded,
    match: (folded.match(/[\p{L}\p{N}]+/gu) ?? [])
      .slice(0, 8)
      .map((token) => `"${token}"*`)
      .join(' AND '),
    pattern: likePattern(folded)
  }
}
/** One exact, normalized source lookup; never feed expansions back into the
 * synonym table. Nine bounded terms share the caller's D1 query snapshot. */
export function publicSearchTermsSql(input: string, overrideTerms?: string[]) {
  const original = synonymTermData(input)
  if (overrideTerms)
    return {
      sql: `SELECT json_extract(value,'$.term') term,json_extract(value,'$.match') fts,json_extract(value,'$.pattern') pattern FROM json_each(?)`,
      parameters: [JSON.stringify(overrideTerms.slice(0, 9).map(synonymTermData))]
    }
  return {
    sql: `SELECT json_extract(value,'$.term') term,json_extract(value,'$.match') fts,json_extract(value,'$.pattern') pattern FROM json_each(?)
      UNION ALL SELECT json_extract(replacement.value,'$.term'),json_extract(replacement.value,'$.match'),json_extract(replacement.value,'$.pattern')
      FROM search_synonyms_current synonym,json_each(synonym.term_data) replacement
      WHERE synonym.source_normalized=? AND synonym.active=1 AND synonym.action='save' LIMIT 9`,
    parameters: [JSON.stringify([original]), original.term]
  }
}

interface SearchRecord {
  uuid: string
  name: string
  slug: string
  brand: string
  visualJson: string
  image: string | null
  minPrice: number
  minNetPrice: number
  sku: string | null
  /** Sentinel row discriminator: 0 is a product, 1 carries the live redirect path. */
  rowKind: number
  redirectPath: string | null
  exactRank: number
  nameRank: number
  merchRank: number
  featuredRank: number
  foldedName: string
}

function visualFromJson(value: string): SearchSuggestion['visual'] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      parsed &&
      typeof parsed === 'object' &&
      'type' in parsed &&
      'color' in parsed &&
      typeof parsed.type === 'string' &&
      typeof parsed.color === 'string'
    ) {
      return { type: parsed.type, color: parsed.color }
    }
  } catch {
    /* Use the catalog fallback for incomplete imported attributes. */
  }
  return { type: 'botella', color: '#64748b' }
}

/** Two bounded reads, never one per result. Tests may pin the server
 * instant; no HTTP field can choose prices. Out-of-stock catalog remains searchable.
 *
 * SEA-013 merchandising lives inside the same statement (no extra read): live rules of
 * the exact normalized term, evaluated at the pricing instant. A boost only counts for a
 * product that is sellable right now, so it can never lift unavailable stock above available
 * equivalents. A bury never changes which products are selected, only their order inside the
 * selected window. Exact identifier and exact name matches always rank first. A redirect is
 * returned beside the results, which are never withheld. */
export async function searchPublishedProducts(
  database: D1Database,
  input: string,
  pricingOptions?: EffectivePricingOptions,
  overrideTerms?: string[]
): Promise<{ items: SearchSuggestion[]; redirect?: { path: string } }> {
  if (!isValidPublicSearchQuery(input)) {
    throw new Error('Invalid search query')
  }
  const term = normalizeSearchTerm(input)
  if (term.length < 2) return { items: [] }
  const folded = term.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es-ES')
  const tokens = folded.match(/[\p{L}\p{N}]+/gu) ?? []
  if (!tokens.length) return { items: [] }
  const searchTerms = publicSearchTermsSql(input, overrideTerms)
  const identifier = (column: string) => `lower(COALESCE(v.${column}, ''))`
  const identifiers = ['sku', 'ean', 'gtin', 'mpn'].map(identifier)
  const exact = identifiers.map((column) => `${column} = ?`).join(' OR ')
  // Escaped %term% LIKE means literal substring matching, but actual D1
  // rejects long patterns well below our public 160-character query bound.
  // instr preserves that meaning without wildcard parsing or a new limit.
  const partial = identifiers.map((column) => `instr(${column}, ?) > 0`).join(' OR ')
  const instant = resolvePricingInstant(pricingOptions)
  const ruleInstant = new Date(instant).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const ruleTerm = synonymTermData(input).term
  const validity = publicationValidityWithClock('p', pricingOptions?.instant)
  const { sql, instantParameters } = parameterizeEffectivePricingSql(
    `WITH effective AS (
      SELECT variant.id, ${effectiveGrossCentsExpression('variant')} AS gross
      FROM variants variant WHERE variant.status = 'published'
    ), summary AS (
      SELECT v.product_id,
        min(effective.gross) AS minPrice,
        min(CAST(round(effective.gross * 10000.0 / (10000 + tax.rate_basis_points)) AS INTEGER)) AS minNetPrice,
        max(CASE WHEN ${exact} THEN 1 ELSE 0 END) AS exactMatch,
        max(CASE WHEN ${partial} THEN 1 ELSE 0 END) AS identifierMatch,
        COALESCE(min(CASE WHEN ${exact} THEN v.sku END),
                 min(CASE WHEN ${partial} THEN v.sku END)) AS sku
      FROM variants v JOIN effective ON effective.id = v.id
      JOIN tax_classes tax ON tax.id = v.tax_class_id
      WHERE v.status = 'published' GROUP BY v.product_id
    ), merch AS (
      SELECT rule.product_id,
        max(-${SEARCH_MERCHANDISING_MAX_WEIGHT}, min(${SEARCH_MERCHANDISING_MAX_WEIGHT},
          sum(CASE rule.kind WHEN 'boost' THEN rule.weight ELSE -rule.weight END))) AS delta
      FROM search_merchandising_current rule
      WHERE rule.term_normalized = ? AND rule.status = 'active' AND rule.kind IN ('boost', 'bury')
        AND rule.valid_from <= ? AND rule.valid_until > ?
      GROUP BY rule.product_id
    ), redirect_rule AS (
      SELECT rule.redirect_path FROM search_merchandising_current rule
      WHERE rule.term_normalized = ? AND rule.status = 'active' AND rule.kind = 'redirect'
        AND rule.valid_from <= ? AND rule.valid_until > ?
        AND (rule.redirect_path NOT GLOB '/producto/*' OR EXISTS (
          SELECT 1 FROM products target WHERE target.slug = substr(rule.redirect_path, 11)
            AND target.status = 'published'))
      LIMIT 1
    ), ranked AS (
      SELECT p.id AS uuid, p.name, p.slug, COALESCE(b.name, 'NETECO') AS brand,
        COALESCE(json_extract(p.attributes, '$.visual'), '{}') AS visualJson,
        json_extract(p.attributes, '$.image') AS image,
        summary.minPrice, summary.minNetPrice, summary.sku,
        summary.exactMatch AS exactRank,
        CASE WHEN ${spanishFoldSql('p.name')} = ? THEN 1 ELSE 0 END AS nameRank,
        CASE WHEN merch.delta > 0 AND EXISTS (
          SELECT 1 FROM variants stocked JOIN inventory_balances b ON b.variant_id = stocked.id
          WHERE stocked.product_id = p.id AND stocked.status = 'published' AND ${sellableExpression()} > 0
        ) THEN merch.delta ELSE 0 END AS boostRank,
        CASE WHEN merch.delta < 0 THEN merch.delta ELSE 0 END AS buryRank,
        p.featured AS featuredRank, ${spanishFoldSql('p.name')} AS foldedName
      FROM products p
      JOIN categories c ON c.id = p.category_id AND c.status = 'published'
      LEFT JOIN brands b ON b.id = p.brand_id
      JOIN summary ON summary.product_id = p.id
      LEFT JOIN merch ON merch.product_id = p.id
      WHERE p.status = 'published' AND ${validity.sql} AND (
        EXISTS (SELECT 1 FROM (${searchTerms.sql}) search_term WHERE (
        p.rowid IN (SELECT rowid FROM products_fts WHERE products_fts MATCH search_term.fts)
        OR instr(${spanishFoldSql('p.name')},search_term.term)>0
        OR instr(${spanishFoldSql("COALESCE(b.name, '')")},search_term.term)>0
        OR instr(${spanishFoldSql('c.name')},search_term.term)>0
        OR EXISTS (SELECT 1 FROM variants synonym_variant WHERE synonym_variant.product_id=p.id
          AND synonym_variant.status='published' AND (
            instr(lower(COALESCE(synonym_variant.sku,'')),search_term.term)>0
            OR instr(lower(COALESCE(synonym_variant.ean,'')),search_term.term)>0
            OR instr(lower(COALESCE(synonym_variant.gtin,'')),search_term.term)>0
            OR instr(lower(COALESCE(synonym_variant.mpn,'')),search_term.term)>0))))
        OR summary.identifierMatch = 1
      )
      ORDER BY exactRank DESC, nameRank DESC, boostRank DESC, featuredRank DESC, foldedName, uuid
      LIMIT 8
    )
    SELECT uuid, name, slug, brand, visualJson, image, minPrice, minNetPrice, sku, NULL AS redirectPath, 0 AS rowKind,
      exactRank, nameRank, boostRank + buryRank AS merchRank, featuredRank, foldedName
    FROM ranked
    UNION ALL
    SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, redirect_path, 1, 0, 0, 0, 0, ''
    FROM redirect_rule
    ORDER BY rowKind, exactRank DESC, nameRank DESC, merchRank DESC, featuredRank DESC, foldedName, uuid`,
    instant
  )
  const result = await database
    .prepare(sql)
    .bind(
      ...instantParameters,
      ...Array(4).fill(folded),
      ...Array(4).fill(folded),
      ...Array(4).fill(folded),
      ...Array(4).fill(folded),
      ruleTerm,
      ruleInstant,
      ruleInstant,
      ruleTerm,
      ruleInstant,
      ruleInstant,
      folded,
      ...validity.parameters,
      ...searchTerms.parameters
    )
    .all<SearchRecord>()
  const redirectPath = result.results.find((record) => record.rowKind === 1)?.redirectPath ?? null
  const records = result.results.filter((record) => record.rowKind === 0)
  const publishedMedia = await readPublicProductMedia(
    database,
    records.map((record) => record.uuid),
    pricingOptions?.instant?.replace(/\.\d{3}Z$/, 'Z')
  )
  await assertCurrentPublicationValidity(
    database,
    records.map((record) => record.uuid),
    pricingOptions?.instant,
    publicMediaProjectionIds(publishedMedia.values())
  )
  return {
    items: records.map(
      ({
        uuid,
        visualJson,
        rowKind: _rowKind,
        redirectPath: _redirectPath,
        exactRank: _exactRank,
        nameRank: _nameRank,
        merchRank: _merchRank,
        featuredRank: _featuredRank,
        foldedName: _foldedName,
        ...record
      }) => ({
        ...record,
        image: publishedMedia.get(uuid)?.image ?? null,
        imageAlt: publishedMedia.get(uuid)?.imageAlt ?? null,
        visual: visualFromJson(visualJson)
      })
    ),
    ...(redirectPath ? { redirect: { path: redirectPath } } : {})
  }
}
