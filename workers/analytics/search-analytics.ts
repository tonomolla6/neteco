import { z } from 'zod'
import { analyticsConsent } from '../../server/utils/analytics'
import { normalizeSearchTerm } from '../../server/utils/search-terms'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  AnalyticsMeasurementError,
  analyticsAssertEnabled,
  analyticsAssertCurrentConfiguration,
  analyticsAssertUnchanged,
  analyticsAuthorizeAdmin,
  analyticsClock,
  analyticsDatabase,
  analyticsHash,
  analyticsPolicyFingerprint,
  analyticsStableJson,
  type AnalyticsMeasurementDependencies
} from './authority'

export const MIN_SEARCH_SAMPLE_THRESHOLD = 20

export const searchDeviceSchema = z.enum(['desktop', 'mobile', 'tablet', 'unknown'])
export type SearchDevice = z.infer<typeof searchDeviceSchema>

export const searchSegmentSchema = z.enum(['anonymous', 'customer', 'professional'])
export type SearchSegment = z.infer<typeof searchSegmentSchema>

export const searchEventInputSchema = z.discriminatedUnion('name', [
  z
    .object({
      eventId: catalogPolicyUuidSchema.optional(),
      name: z.literal('search_performed'),
      query: z.string().min(1).max(500),
      resultCount: z.number().int().nonnegative(),
      device: searchDeviceSchema.default('unknown'),
      segment: searchSegmentSchema.default('anonymous'),
      occurredAt: z.string().datetime()
    })
    .strict(),
  z
    .object({
      eventId: catalogPolicyUuidSchema.optional(),
      name: z.literal('search_result_clicked'),
      query: z.string().min(1).max(500).optional(),
      targetId: z.string().min(1).max(120),
      rank: z.number().int().positive().max(1000),
      device: searchDeviceSchema.default('unknown'),
      segment: searchSegmentSchema.default('anonymous'),
      occurredAt: z.string().datetime()
    })
    .strict(),
  z
    .object({
      eventId: catalogPolicyUuidSchema.optional(),
      name: z.literal('add_to_cart'),
      query: z.string().min(1).max(500).optional(),
      targetId: z.string().min(1).max(120),
      quantity: z.number().int().positive().max(100000).default(1),
      device: searchDeviceSchema.default('unknown'),
      segment: searchSegmentSchema.default('anonymous'),
      occurredAt: z.string().datetime()
    })
    .strict()
])

export type SearchEventInput = z.infer<typeof searchEventInputSchema>

/** Redacts detected email addresses, phone numbers, and NIF/NIE/CIF identifiers. */
export function redactSearchPii(rawQuery: string): string {
  if (!rawQuery) return ''
  const emailRegex = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi
  const phoneRegex = /(?:\+?34[ -]?)?[6789](?:[ -]?\d){8}\b/g
  const nifRegex = /\b[XYZxyz]?\d{7,8}[A-Za-z]\b|\b[A-HJ-NP-SUVW]\d{7}[0-9A-J]\b/gi

  return rawQuery.replace(emailRegex, '[REDACTADO]').replace(phoneRegex, '[REDACTADO]').replace(nifRegex, '[REDACTADO]')
}

/** Sanitizes, redacts, normalizes spaces and truncates to 160 chars. */
export function sanitizeSearchQuery(rawQuery: string): string {
  const redacted = redactSearchPii(rawQuery)
  return normalizeSearchTerm(redacted)
}

export interface SearchCookieInstruction {
  name: 'neteco-analytics-id'
  value: string
  maxAgeSeconds: number
}

export type SearchCollectionResult = {
  accepted: boolean
  reason: 'accepted' | 'disabled' | 'consent_required' | 'bot_excluded' | 'event_excluded'
  cookie: SearchCookieInstruction | null
}

export async function recordSearchEvent(
  deps: AnalyticsMeasurementDependencies,
  input: { event: unknown; consentCookie?: string; anonymousCookie?: string; userAgent?: string }
): Promise<SearchCollectionResult> {
  const excluded = (reason: SearchCollectionResult['reason']): SearchCollectionResult => ({
    accepted: false,
    reason,
    cookie: null
  })

  if (deps.enabled !== true) return excluded('disabled')
  if (!analyticsConsent(input.consentCookie)) return excluded('consent_required')

  const policy = analyticsAssertEnabled(deps)
  const origin = deps.origin

  if (/bot|crawl|spider|lighthouse|pagespeed/i.test((input.userAgent ?? '').slice(0, 1024)))
    return excluded('bot_excluded')

  let parsed: SearchEventInput
  try {
    parsed = searchEventInputSchema.parse(catalogPolicyOwnJson(input.event))
  } catch {
    throw new AnalyticsMeasurementError('invalid_input')
  }

  const at = analyticsClock(deps)
  if (Math.abs(Date.parse(parsed.occurredAt) - Date.parse(at)) > 86400000)
    throw new AnalyticsMeasurementError('invalid_timestamp')

  const pepper = deps.sessionPepper
  if (!(pepper instanceof Uint8Array) || pepper.byteLength !== 32 || !pepper.some((byte) => byte !== 0))
    throw new AnalyticsMeasurementError('configuration_unavailable')

  const parsedId = catalogPolicyUuidSchema.safeParse(input.anonymousCookie)
  const id = parsedId.success ? parsedId.data : crypto.randomUUID()

  const key = await crypto.subtle.importKey('raw', Uint8Array.from(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ])

  const sessionHash = Array.from(
    new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`neteco:analytics:anonymous:v1:${policy.environment}:${origin}:${id}`)
      )
    ),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('')

  const database = analyticsDatabase(deps)

  // Resolve search term: either given directly or attributed from the latest search in the same session
  let termNormalized: string
  if ('query' in parsed && parsed.query) {
    termNormalized = sanitizeSearchQuery(parsed.query)
  } else {
    // Look up most recent search_performed in same session within last 24h
    const prior = await database
      .prepare(
        `SELECT term_normalized FROM analytics_search_events
         WHERE environment=? AND session_hash=? AND name='search_performed' AND occurred_at<=?
         ORDER BY occurred_at DESC LIMIT 1`
      )
      .bind(policy.environment, sessionHash, parsed.occurredAt)
      .first<{ term_normalized: string }>()

    if (prior?.term_normalized) {
      termNormalized = prior.term_normalized
    } else {
      // If there's no attributed search in the session, click/add-to-cart has no search attribution
      return excluded('event_excluded')
    }
  }

  if (termNormalized.length === 0) return excluded('event_excluded')

  const eventId = (parsed.eventId ?? crypto.randomUUID()).toLowerCase()
  const occurredAt = new Date(parsed.occurredAt).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const expiresAt = new Date(Date.parse(occurredAt) + policy.retentionDays * 86400000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')

  const payloadHash = await analyticsHash(
    analyticsStableJson({
      name: parsed.name,
      sessionHash,
      environment: policy.environment,
      termNormalized,
      device: parsed.device,
      segment: parsed.segment,
      occurredAt
    })
  )

  const policyFingerprint = await analyticsPolicyFingerprint(policy)
  await analyticsAssertUnchanged(deps, policyFingerprint)
  analyticsAssertCurrentConfiguration(deps, policy, origin)

  const resultCount = parsed.name === 'search_performed' ? parsed.resultCount : null
  const targetId = 'targetId' in parsed ? parsed.targetId : null
  const rank = 'rank' in parsed ? parsed.rank : null
  const quantity = 'quantity' in parsed ? parsed.quantity : null

  try {
    const results = await database.batch([
      database
        .prepare(
          `INSERT INTO analytics_search_events(
             event_id, name, session_hash, environment, policy_reference, policy_version, policy_fingerprint,
             term_normalized, device, segment, result_count, target_id, rank, quantity, payload_hash,
             occurred_at, received_at, expires_at
           )
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18
           WHERE NOT EXISTS(SELECT 1 FROM analytics_search_events WHERE event_id=?1)`
        )
        .bind(
          eventId,
          parsed.name,
          sessionHash,
          policy.environment,
          policy.reference,
          policy.version,
          policyFingerprint,
          termNormalized,
          parsed.device,
          parsed.segment,
          resultCount,
          targetId,
          rank,
          quantity,
          payloadHash,
          occurredAt,
          at,
          expiresAt
        ),
      database
        .prepare(
          'SELECT payload_hash AS payloadHash, session_hash AS sessionHash, environment FROM analytics_search_events WHERE event_id=?'
        )
        .bind(eventId)
    ])

    const record = results[1]?.results?.[0] as
      { payloadHash?: string; sessionHash?: string; environment?: string } | undefined
    if (
      !record ||
      record.payloadHash !== payloadHash ||
      record.sessionHash !== sessionHash ||
      record.environment !== policy.environment
    ) {
      throw new AnalyticsMeasurementError('idempotency_conflict')
    }

    await analyticsAssertUnchanged(deps, policyFingerprint)
    analyticsAssertCurrentConfiguration(deps, policy, origin)
  } catch (error) {
    if (error instanceof AnalyticsMeasurementError) throw error
    throw new AnalyticsMeasurementError('service_unavailable')
  }

  return {
    accepted: true,
    reason: 'accepted',
    cookie: parsedId.success
      ? null
      : { name: 'neteco-analytics-id', value: id, maxAgeSeconds: Math.min(policy.retentionDays * 86400, 180 * 86400) }
  }
}

export interface SearchAnalyticsDashboardQuery {
  from: string
  to: string
  device?: 'all' | SearchDevice
  segment?: 'all' | SearchSegment
  page?: number
  perPage?: number
}

export interface SearchMetricItem {
  term: string
  searches: number
  zeroResults: number
  clicks: number
  addToCart: number
  ctr: number | null
  addToCartRate: number | null
  hasSufficientSample: boolean
}

export interface ZeroResultMetricItem {
  term: string
  searches: number
  zeroResults: number
  synonymUrl: string
  merchandisingUrl: string
}

export interface SearchAnalyticsDashboardResponse {
  period: { from: string; to: string }
  filters: { device: string; segment: string }
  summary: {
    totalSearches: number
    totalZeroResults: number
    totalClicks: number
    totalAddToCart: number
    globalCtr: number | null
    globalAddToCartRate: number | null
  }
  minSampleThreshold: number
  topQueries: SearchMetricItem[]
  zeroResultQueries: ZeroResultMetricItem[]
  pagination: {
    page: number
    perPage: number
    total: number
  }
}

export async function readSearchAnalyticsDashboard(
  deps: AnalyticsMeasurementDependencies,
  claims: VerifiedSessionClaims,
  query: SearchAnalyticsDashboardQuery
): Promise<SearchAnalyticsDashboardResponse> {
  const policy = analyticsAssertEnabled(deps)
  const origin = deps.origin
  const database = analyticsDatabase(deps)

  await analyticsAuthorizeAdmin(deps, claims)
  const fingerprint = await analyticsPolicyFingerprint(policy)
  await analyticsAssertUnchanged(deps, fingerprint)
  analyticsAssertCurrentConfiguration(deps, policy, origin)

  const dayFrom = query.from.slice(0, 10)
  const dayTo = query.to.slice(0, 10)
  const device = query.device ?? 'all'
  const segment = query.segment ?? 'all'
  const page = Math.max(1, query.page ?? 1)
  const perPage = Math.min(100, Math.max(1, query.perPage ?? 20))

  const whereClauses = [
    'environment = ?1',
    'day >= ?2',
    'day <= ?3',
    `(?4 = 'all' OR device = ?4)`,
    `(?5 = 'all' OR segment = ?5)`
  ]
  const whereSql = whereClauses.join(' AND ')
  const binds = [policy.environment, dayFrom, dayTo, device, segment]

  const summaryRow = await database
    .prepare(
      `SELECT
         COALESCE(SUM(searches_count), 0) AS totalSearches,
         COALESCE(SUM(zero_results_count), 0) AS totalZeroResults,
         COALESCE(SUM(clicks_count), 0) AS totalClicks,
         COALESCE(SUM(add_to_cart_count), 0) AS totalAddToCart
       FROM search_analytics_daily
       WHERE ${whereSql}`
    )
    .bind(...binds)
    .first<{
      totalSearches: number
      totalZeroResults: number
      totalClicks: number
      totalAddToCart: number
    }>()

  const totalSearches = Number(summaryRow?.totalSearches ?? 0)
  const totalZeroResults = Number(summaryRow?.totalZeroResults ?? 0)
  const totalClicks = Number(summaryRow?.totalClicks ?? 0)
  const totalAddToCart = Number(summaryRow?.totalAddToCart ?? 0)

  const globalCtr =
    totalSearches >= MIN_SEARCH_SAMPLE_THRESHOLD ? Number((totalClicks / totalSearches).toFixed(4)) : null
  const globalAddToCartRate =
    totalSearches >= MIN_SEARCH_SAMPLE_THRESHOLD ? Number((totalAddToCart / totalSearches).toFixed(4)) : null

  // Aggregated top queries
  const topRows = await database
    .prepare(
      `SELECT
         term_normalized AS term,
         SUM(searches_count) AS searches,
         SUM(zero_results_count) AS zeroResults,
         SUM(clicks_count) AS clicks,
         SUM(add_to_cart_count) AS addToCart
       FROM search_analytics_daily
       WHERE ${whereSql}
       GROUP BY term_normalized
       ORDER BY searches DESC, term_normalized ASC
       LIMIT ?6 OFFSET ?7`
    )
    .bind(...binds, perPage, (page - 1) * perPage)
    .all<{
      term: string
      searches: number
      zeroResults: number
      clicks: number
      addToCart: number
    }>()

  const countRow = await database
    .prepare(
      `SELECT COUNT(DISTINCT term_normalized) AS total
       FROM search_analytics_daily
       WHERE ${whereSql}`
    )
    .bind(...binds)
    .first<{ total: number }>()

  const topQueries: SearchMetricItem[] = (topRows.results ?? []).map((row) => {
    const searches = Number(row.searches)
    const clicks = Number(row.clicks)
    const addToCart = Number(row.addToCart)
    const zeroResults = Number(row.zeroResults)
    const hasSufficientSample = searches >= MIN_SEARCH_SAMPLE_THRESHOLD

    return {
      term: row.term,
      searches,
      zeroResults,
      clicks,
      addToCart,
      ctr: hasSufficientSample ? Number((clicks / searches).toFixed(4)) : null,
      addToCartRate: hasSufficientSample ? Number((addToCart / searches).toFixed(4)) : null,
      hasSufficientSample
    }
  })

  // Zero-results queries with link actions
  const zeroRows = await database
    .prepare(
      `SELECT
         term_normalized AS term,
         SUM(searches_count) AS searches,
         SUM(zero_results_count) AS zeroResults
       FROM search_analytics_daily
       WHERE ${whereSql}
       GROUP BY term_normalized
       HAVING zeroResults > 0
       ORDER BY zeroResults DESC, searches DESC, term_normalized ASC
       LIMIT 50`
    )
    .bind(...binds)
    .all<{
      term: string
      searches: number
      zeroResults: number
    }>()

  const zeroResultQueries: ZeroResultMetricItem[] = (zeroRows.results ?? []).map((row) => ({
    term: row.term,
    searches: Number(row.searches),
    zeroResults: Number(row.zeroResults),
    synonymUrl: `/admin/busqueda?q=${encodeURIComponent(row.term)}&tab=synonyms`,
    merchandisingUrl: `/admin/busqueda?q=${encodeURIComponent(row.term)}&tab=merchandising`
  }))

  return {
    period: { from: query.from, to: query.to },
    filters: { device, segment },
    summary: {
      totalSearches,
      totalZeroResults,
      totalClicks,
      totalAddToCart,
      globalCtr,
      globalAddToCartRate
    },
    minSampleThreshold: MIN_SEARCH_SAMPLE_THRESHOLD,
    topQueries,
    zeroResultQueries,
    pagination: {
      page,
      perPage,
      total: Number(countRow?.total ?? 0)
    }
  }
}
