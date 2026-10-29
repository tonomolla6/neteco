import { z } from 'zod'
import { analyticsConsent } from '../../server/utils/analytics'
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

export const MIN_FUNNEL_SAMPLE_THRESHOLD = 30

export const funnelStepSchema = z.enum(['visit', 'product_view', 'cart_add', 'checkout_start', 'purchase'])
export type FunnelStep = z.infer<typeof funnelStepSchema>

export const FUNNEL_STEPS: readonly FunnelStep[] = [
  'visit',
  'product_view',
  'cart_add',
  'checkout_start',
  'purchase'
] as const

export const FUNNEL_STEP_LABELS: Record<FunnelStep, string> = {
  visit: 'Visita',
  product_view: 'Ficha de producto',
  cart_add: 'Añadir al carrito',
  checkout_start: 'Inicio checkout',
  purchase: 'Pago confirmado'
}

export const funnelDeviceSchema = z.enum(['desktop', 'mobile', 'tablet', 'unknown'])
export type FunnelDevice = z.infer<typeof funnelDeviceSchema>

export const funnelSourceSchema = z.enum(['direct', 'organic', 'cpc', 'social', 'email', 'referral', 'other'])
export type FunnelSource = z.infer<typeof funnelSourceSchema>

export const funnelSegmentSchema = z.enum(['anonymous', 'customer', 'professional'])
export type FunnelSegment = z.infer<typeof funnelSegmentSchema>

export const funnelEventInputSchema = z
  .object({
    eventId: catalogPolicyUuidSchema.optional(),
    name: funnelStepSchema,
    occurredAt: z.string().datetime(),
    device: funnelDeviceSchema.default('unknown'),
    source: funnelSourceSchema.default('direct'),
    segment: funnelSegmentSchema.default('anonymous'),
    targetId: z.string().min(1).max(120).optional()
  })
  .strict()

export type FunnelEventInput = z.infer<typeof funnelEventInputSchema>

export interface WilsonIntervalResult {
  rate: number | null
  lower: number
  upper: number
  hasSufficientSample: boolean
}

/**
 * Computes Wilson score interval for a binomial proportion.
 * Gracefully handles n = 0, k = 0, k = n and small sample sizes.
 */
export function wilsonScoreInterval(successes: number, total: number, confidence = 0.95): WilsonIntervalResult {
  if (!Number.isFinite(total) || total <= 0) {
    return { rate: null, lower: 0, upper: 0, hasSufficientSample: false }
  }

  const k = Math.max(0, Math.min(successes, total))
  const n = total
  const p = k / n

  const z = confidence === 0.99 ? 2.5758293035489004 : confidence === 0.9 ? 1.6448536269514722 : 1.959963984540054
  const z2 = z * z
  const denominator = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denominator
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator

  const lower = Math.max(0, center - margin)
  const upper = Math.min(1, center + margin)

  return {
    rate: Math.round(p * 10000) / 10000,
    lower: Math.round(lower * 10000) / 10000,
    upper: Math.round(upper * 10000) / 10000,
    hasSufficientSample: n >= MIN_FUNNEL_SAMPLE_THRESHOLD
  }
}

/**
 * Classifies traffic source from referrer and UTM parameters without storing PII.
 */
export function groupReferrerAndUtm(referrer?: string, utmSource?: string, utmMedium?: string): FunnelSource {
  const medium = (utmMedium ?? '').toLowerCase().trim()
  const source = (utmSource ?? '').toLowerCase().trim()
  const ref = (referrer ?? '').toLowerCase().trim()

  if (
    medium === 'cpc' ||
    medium === 'ppc' ||
    medium === 'paid' ||
    source.includes('adwords') ||
    source.includes('cpc') ||
    source.includes('paid')
  ) {
    return 'cpc'
  }
  if (
    medium === 'email' ||
    medium === 'mail' ||
    source.includes('newsletter') ||
    source.includes('boletin') ||
    source.includes('email')
  ) {
    return 'email'
  }
  if (
    medium === 'social' ||
    ['facebook', 'instagram', 'twitter', 'x.com', 'linkedin', 'tiktok', 'youtube', 't.co'].some(
      (s) => source.includes(s) || ref.includes(s)
    )
  ) {
    return 'social'
  }
  if (medium === 'organic' || ['google', 'bing', 'duckduckgo', 'ecosia', 'yahoo'].some((s) => ref.includes(s))) {
    return 'organic'
  }
  if (!ref && !source && !medium) {
    return 'direct'
  }
  if (ref && !ref.includes('neteco')) {
    return 'referral'
  }
  return 'other'
}

export interface FunnelCookieInstruction {
  name: 'neteco-analytics-id'
  value: string
  maxAgeSeconds: number
}

export type FunnelCollectionResult = {
  accepted: boolean
  reason: 'accepted' | 'disabled' | 'consent_required' | 'bot_excluded' | 'event_excluded'
  cookie: FunnelCookieInstruction | null
}

export async function recordFunnelEvent(
  deps: AnalyticsMeasurementDependencies,
  input: {
    event: unknown
    consentCookie?: string
    anonymousCookie?: string
    userAgent?: string
    referrer?: string
  }
): Promise<FunnelCollectionResult> {
  const excluded = (reason: FunnelCollectionResult['reason']): FunnelCollectionResult => ({
    accepted: false,
    reason,
    cookie: null
  })

  if (deps.enabled !== true) return excluded('disabled')
  if (!analyticsConsent(input.consentCookie)) return excluded('consent_required')

  const policy = analyticsAssertEnabled(deps)
  const origin = deps.origin

  if (/bot|crawl|spider|lighthouse|pagespeed/i.test((input.userAgent ?? '').slice(0, 1024))) {
    return excluded('bot_excluded')
  }

  let parsed: FunnelEventInput
  try {
    parsed = funnelEventInputSchema.parse(catalogPolicyOwnJson(input.event))
  } catch {
    throw new AnalyticsMeasurementError('invalid_input')
  }

  const at = analyticsClock(deps)
  if (Math.abs(Date.parse(parsed.occurredAt) - Date.parse(at)) > 86400000) {
    throw new AnalyticsMeasurementError('invalid_timestamp')
  }

  const pepper = deps.sessionPepper
  if (!(pepper instanceof Uint8Array) || pepper.byteLength !== 32 || !pepper.some((b) => b !== 0)) {
    throw new AnalyticsMeasurementError('configuration_unavailable')
  }

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
  const eventId = (parsed.eventId ?? crypto.randomUUID()).toLowerCase()
  const occurredAt = new Date(parsed.occurredAt).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const expiresAt = new Date(Date.parse(occurredAt) + policy.retentionDays * 86400000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')

  const payloadHash = await analyticsHash(
    analyticsStableJson({
      step: parsed.name,
      sessionHash,
      environment: policy.environment,
      device: parsed.device,
      source: parsed.source,
      segment: parsed.segment,
      targetId: parsed.targetId ?? null,
      occurredAt
    })
  )

  const policyFingerprint = await analyticsPolicyFingerprint(policy)
  await analyticsAssertUnchanged(deps, policyFingerprint)
  analyticsAssertCurrentConfiguration(deps, policy, origin)

  try {
    const results = await database.batch([
      database
        .prepare(
          `INSERT INTO analytics_funnel_events(
             event_id, step, session_hash, environment, policy_reference, policy_version, policy_fingerprint,
             device, source, segment, target_id, payload_hash, occurred_at, received_at, expires_at
           )
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
           WHERE NOT EXISTS(SELECT 1 FROM analytics_funnel_events WHERE event_id=?1)`
        )
        .bind(
          eventId,
          parsed.name,
          sessionHash,
          policy.environment,
          policy.reference,
          policy.version,
          policyFingerprint,
          parsed.device,
          parsed.source,
          parsed.segment,
          parsed.targetId ?? null,
          payloadHash,
          occurredAt,
          at,
          expiresAt
        ),
      database
        .prepare(
          'SELECT payload_hash AS payloadHash, session_hash AS sessionHash, environment FROM analytics_funnel_events WHERE event_id=?'
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

export interface FunnelAnalyticsDashboardQuery {
  from: string
  to: string
  device?: 'all' | FunnelDevice
  source?: 'all' | FunnelSource
  segment?: 'all' | FunnelSegment
}

export interface FunnelStepMetric {
  step: FunnelStep
  name: string
  sessions: number
  conversionFromPrevious: {
    rate: number | null
    lower: number
    upper: number
  }
  conversionFromStart: {
    rate: number | null
    lower: number
    upper: number
  }
  hasSufficientSample: boolean
  isSmallSampleWarning: boolean
}

export interface FunnelDimensionBreakdownItem {
  key: string
  sessions: number
  purchaseSessions: number
  conversionRate: number
}

export interface FunnelAnalyticsDashboardResponse {
  period: {
    from: string
    to: string
  }
  filters: {
    device: string
    source: string
    segment: string
  }
  minSampleThreshold: number
  steps: FunnelStepMetric[]
  overallConversion: {
    rate: number | null
    lower: number
    upper: number
    hasSufficientSample: boolean
  }
  breakdown: {
    byDevice: FunnelDimensionBreakdownItem[]
    bySource: FunnelDimensionBreakdownItem[]
    bySegment: FunnelDimensionBreakdownItem[]
  }
}

export async function readFunnelAnalyticsDashboard(
  deps: AnalyticsMeasurementDependencies,
  claims: VerifiedSessionClaims,
  query: FunnelAnalyticsDashboardQuery
): Promise<FunnelAnalyticsDashboardResponse> {
  const policy = analyticsAssertEnabled(deps)
  const origin = deps.origin
  const database = analyticsDatabase(deps)

  await analyticsAuthorizeAdmin(deps, claims)
  const fingerprint = await analyticsPolicyFingerprint(policy)
  await analyticsAssertUnchanged(deps, fingerprint)
  analyticsAssertCurrentConfiguration(deps, policy, origin)

  const device = query.device ?? 'all'
  const source = query.source ?? 'all'
  const segment = query.segment ?? 'all'
  const from = query.from
  const to = query.to

  const whereClauses = [
    'environment = ?1',
    'occurred_at >= ?2',
    'occurred_at <= ?3',
    `(?4 = 'all' OR device = ?4)`,
    `(?5 = 'all' OR source = ?5)`,
    `(?6 = 'all' OR segment = ?6)`
  ]
  const whereSql = whereClauses.join(' AND ')
  const binds = [policy.environment, from, to, device, source, segment]

  // Query distinct sessions per step
  const stepRows = await database
    .prepare(
      `SELECT
         step,
         COUNT(DISTINCT session_hash) AS session_count
       FROM analytics_funnel_events
       WHERE ${whereSql}
       GROUP BY step`
    )
    .bind(...binds)
    .all<{ step: FunnelStep; session_count: number }>()

  const sessionCountByStep = new Map<FunnelStep, number>()
  for (const row of stepRows.results ?? []) {
    sessionCountByStep.set(row.step, row.session_count)
  }

  const visitSessions = sessionCountByStep.get('visit') ?? 0
  const steps: FunnelStepMetric[] = []
  let previousSessions: number | null = null

  for (let i = 0; i < FUNNEL_STEPS.length; i++) {
    const step = FUNNEL_STEPS[i]
    const sessions = sessionCountByStep.get(step) ?? 0

    let convFromPrev: WilsonIntervalResult
    if (i === 0) {
      convFromPrev = { rate: null, lower: 0, upper: 0, hasSufficientSample: sessions >= MIN_FUNNEL_SAMPLE_THRESHOLD }
    } else {
      convFromPrev = wilsonScoreInterval(sessions, previousSessions ?? 0)
    }

    const convFromStart = wilsonScoreInterval(sessions, visitSessions)
    const hasSufficientSample = sessions >= MIN_FUNNEL_SAMPLE_THRESHOLD
    const isSmallSampleWarning = !hasSufficientSample && sessions > 0

    steps.push({
      step,
      name: FUNNEL_STEP_LABELS[step],
      sessions,
      conversionFromPrevious: {
        rate: convFromPrev.rate,
        lower: convFromPrev.lower,
        upper: convFromPrev.upper
      },
      conversionFromStart: {
        rate: convFromStart.rate,
        lower: convFromStart.lower,
        upper: convFromStart.upper
      },
      hasSufficientSample,
      isSmallSampleWarning
    })

    previousSessions = sessions
  }

  const purchaseSessions = sessionCountByStep.get('purchase') ?? 0
  const overallWilson = wilsonScoreInterval(purchaseSessions, visitSessions)

  // Breakdowns by device, source, segment
  const breakdownByDimension = async (dimCol: 'device' | 'source' | 'segment') => {
    const rows = await database
      .prepare(
        `SELECT
           ${dimCol} AS key,
           COUNT(DISTINCT CASE WHEN step = 'visit' THEN session_hash END) AS visit_sessions,
           COUNT(DISTINCT CASE WHEN step = 'purchase' THEN session_hash END) AS purchase_sessions
         FROM analytics_funnel_events
         WHERE environment = ?1 AND occurred_at >= ?2 AND occurred_at <= ?3
         GROUP BY ${dimCol}`
      )
      .bind(policy.environment, from, to)
      .all<{ key: string; visit_sessions: number; purchase_sessions: number }>()

    return (rows.results ?? []).map((r) => {
      const rate = r.visit_sessions > 0 ? Math.round((r.purchase_sessions / r.visit_sessions) * 10000) / 10000 : 0
      return {
        key: r.key,
        sessions: r.visit_sessions,
        purchaseSessions: r.purchase_sessions,
        conversionRate: rate
      }
    })
  }

  const [byDevice, bySource, bySegment] = await Promise.all([
    breakdownByDimension('device'),
    breakdownByDimension('source'),
    breakdownByDimension('segment')
  ])

  return {
    period: { from, to },
    filters: { device, source, segment },
    minSampleThreshold: MIN_FUNNEL_SAMPLE_THRESHOLD,
    steps,
    overallConversion: {
      rate: overallWilson.rate,
      lower: overallWilson.lower,
      upper: overallWilson.upper,
      hasSufficientSample: overallWilson.hasSufficientSample
    },
    breakdown: {
      byDevice,
      bySource,
      bySegment
    }
  }
}
