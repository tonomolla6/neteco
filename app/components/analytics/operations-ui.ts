import { catalogPolicyInstantSchema } from '~~/shared/catalog-publication-policy'
import {
  analyticsSnapshotSchema,
  analyticsReconciliationSchema,
  ANALYTICS_DEFINITIONS,
  type AnalyticsSnapshot,
  type AnalyticsReconciliation
} from '~~/shared/analytics-measurement'

export type AnalyticsRange = Readonly<{ from: string; to: string }>
export type AnalyticsDates = Readonly<{ from: string; to: string }>
export type AnalyticsQuery = AnalyticsRange & Readonly<{ page: number; perPage: number }>

function boundRead(
  value: { period: AnalyticsRange; pagination: { page: number; perPage: number; total: number } },
  query: AnalyticsQuery,
  length: number
) {
  if (
    value.period.from !== query.from ||
    value.period.to !== query.to ||
    value.pagination.page !== query.page ||
    value.pagination.perPage !== query.perPage ||
    length > query.perPage ||
    length > value.pagination.total
  )
    throw new Error('analytics_read_unconfirmed')
}

export function parseAnalyticsSnapshot(raw: unknown, query: AnalyticsQuery): AnalyticsSnapshot {
  const value = analyticsSnapshotSchema.parse(raw)
  boundRead(value, query, value.facts.length)
  if (
    value.definitions
      .map((definition) => definition.key)
      .sort()
      .join(',') !==
      ANALYTICS_DEFINITIONS.map((definition) => definition.key)
        .sort()
        .join(',') ||
    new Set(value.facts.map((fact) => `${fact.sourceKind}:${fact.sourceId}`)).size !== value.facts.length
  )
    throw new Error('analytics_read_unconfirmed')
  return value
}

export function parseAnalyticsReconciliation(raw: unknown, query: AnalyticsQuery): AnalyticsReconciliation {
  const value = analyticsReconciliationSchema.parse(raw)
  boundRead(value, query, value.issues.length)
  if (
    new Set(value.issues.map((issue) => `${issue.code}:${issue.sourceKind}:${issue.sourceId}`)).size !==
      value.issues.length ||
    value.issues.some((issue) => issue.occurredAt < query.from || issue.occurredAt >= query.to)
  )
    throw new Error('analytics_read_unconfirmed')
  return value
}

export function matchingAnalyticsPopulation(snapshot: AnalyticsSnapshot, reconciliation: AnalyticsReconciliation) {
  return (
    snapshot.population.environment === reconciliation.population.environment &&
    snapshot.population.validationOnly === reconciliation.population.validationOnly &&
    snapshot.period.from === reconciliation.period.from &&
    snapshot.period.to === reconciliation.period.to &&
    snapshot.policy.reference === reconciliation.policy.reference &&
    snapshot.policy.version === reconciliation.policy.version &&
    snapshot.policy.purpose === reconciliation.policy.purpose &&
    snapshot.policy.retentionDays === reconciliation.policy.retentionDays
  )
}

/** Date inputs explicitly represent UTC midnights, never browser-local time. */
export function analyticsRange(dates: AnalyticsDates): AnalyticsRange {
  if (![dates.from, dates.to].every((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)))
    throw new Error('analytics_range_invalid')
  const from = catalogPolicyInstantSchema.parse(`${dates.from}T00:00:00Z`),
    to = catalogPolicyInstantSchema.parse(`${dates.to}T00:00:00Z`),
    seconds = (Date.parse(to) - Date.parse(from)) / 1000
  if (seconds <= 0 || seconds > 31 * 86_400) throw new Error('analytics_range_invalid')
  return Object.freeze({ from, to })
}

export function defaultAnalyticsDates(now = new Date()): AnalyticsDates {
  if (!Number.isFinite(now.getTime())) throw new Error('analytics_range_invalid')
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
    from = new Date(to.getTime() - 7 * 86_400_000)
  return Object.freeze({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) })
}

/** Preserve integer cents even at the safe-integer boundary and for negative
 * period differences. A missing observation is not a zero balance. */
export function analyticsMoney(cents: number | null): string {
  if (cents === null) return 'No disponible'
  if (!Number.isSafeInteger(cents)) throw new Error('analytics_money_invalid')
  const value = BigInt(cents),
    negative = value < 0n,
    absolute = negative ? -value : value,
    whole = absolute / 100n,
    fraction = String(absolute % 100n).padStart(2, '0'),
    amount = negative ? (whole === 0n ? -0 : -whole) : whole
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' })
    .formatToParts(amount)
    .map((part) => (part.type === 'fraction' ? fraction : part.value))
    .join('')
}

export function analyticsCount(value: number | null): string {
  if (value === null) return 'No disponible'
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('analytics_count_invalid')
  return new Intl.NumberFormat('es-ES').format(value)
}

export function analyticsInstant(value: string): string {
  catalogPolicyInstantSchema.parse(value)
  return `${new Intl.DateTimeFormat('es-ES', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(value))} UTC`
}

/** Observed lag is measured against the response timestamp, not a client clock. */
export function analyticsLag(oldest: string | null, generatedAt: string): string {
  catalogPolicyInstantSchema.parse(generatedAt)
  if (oldest === null) return 'No disponible'
  catalogPolicyInstantSchema.parse(oldest)
  const seconds = (Date.parse(generatedAt) - Date.parse(oldest)) / 1000
  if (seconds < 0) return 'No disponible'
  if (seconds < 60) return `${seconds} s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h`
  return `${Math.floor(seconds / 86_400)} d`
}

/** Do not render raw transport messages, response bodies or identifiers from
 * errors. Accessors on an injected error are not executed. */
export function analyticsDenied(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const own = (object: object, key: string): unknown => Object.getOwnPropertyDescriptor(object, key)?.value
  for (const key of ['statusCode', 'status']) {
    const status = own(error, key)
    if (status === 401 || status === 403) return true
  }
  const response = own(error, 'response')
  if (!response || typeof response !== 'object') return false
  let status: unknown
  try {
    status =
      response instanceof Response
        ? Object.getOwnPropertyDescriptor(Response.prototype, 'status')?.get?.call(response)
        : own(response, 'status')
  } catch {
    return false
  }
  return status === 401 || status === 403
}
