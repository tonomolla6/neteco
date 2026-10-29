import { getCarrierCircuitBreaker } from './carrier-resilience'

export interface CarrierScorecardSummary {
  totalShipments: number
  deliveredShipments: number
  onTimeRate: number | null
  firstAttemptRate: number | null
  incidentRate: number | null
  damageRate: number | null
  averageCostCents: number
  averageResolutionTimeHours: number | null
  hasSufficientSample: boolean
}

export interface CarrierScorecardItem {
  carrier: string
  carrierName: string
  totalShipments: number
  deliveredShipments: number
  onTimeRate: number | null
  firstAttemptRate: number | null
  incidentRate: number | null
  damageRate: number | null
  averageCostCents: number
  averageResolutionTimeHours: number | null
  hasSufficientSample: boolean
  circuitBreaker?: {
    state: 'closed' | 'open' | 'half_open'
    consecutiveFailures: number
    lastFailureAt: string | null
  }
}

export interface CarrierScorecardReport {
  source: 'cloudflare'
  period: {
    from: string
    to: string
  }
  filters: {
    carrier: string
  }
  summary: CarrierScorecardSummary
  carriers: CarrierScorecardItem[]
  minSampleThreshold: number
  evaluatedAt: string
}

export interface CarrierPerformanceEventInput {
  carrier: string
  orderId?: string | null
  trackingNumber: string
  serviceCode: string
  dispatchedAt: string
  promisedDeliveryAt: string
  firstDeliveryAttemptAt?: string | null
  deliveredAt?: string | null
  status: 'in_transit' | 'delivered' | 'failed_attempt' | 'incident' | 'returned' | 'cancelled'
  isDelivered?: boolean
  isOnTime?: boolean | null
  isFirstAttemptSuccess?: boolean | null
  hasDamage?: boolean
  hasIncident?: boolean
  incidentKind?:
    'damage' | 'address_not_found' | 'recipient_absent' | 'delay' | 'lost' | 'weather' | 'customs' | 'other' | null
  incidentOpenedAt?: string | null
  incidentResolvedAt?: string | null
  resolutionTimeSeconds?: number | null
  costCents?: number
  now?: string
}

function getNow(now?: string): string {
  if (now) return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z')
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function carrierDisplayName(carrier: string): string {
  switch (carrier.toLowerCase()) {
    case 'correos_express':
    case 'correos-express':
      return 'Correos Express'
    case 'gls':
    case 'gls-spain':
      return 'GLS Spain'
    case 'dhl':
    case 'dhl-parcel':
      return 'DHL Parcel'
    case 'seur':
      return 'SEUR'
    case 'mrw':
      return 'MRW'
    case 'own_delivery':
    case 'own-delivery':
      return 'Reparto Propio NETECO'
    default:
      return carrier
        .split(/[-_]/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
  }
}

export async function recordCarrierPerformanceEvent(
  db: D1Database,
  input: CarrierPerformanceEventInput
): Promise<void> {
  const currentTime = getNow(input.now)
  const id = crypto.randomUUID()
  const isDelivered = input.isDelivered ?? (input.status === 'delivered' ? 1 : 0)
  const isOnTime =
    input.isOnTime !== undefined
      ? input.isOnTime === null
        ? null
        : input.isOnTime
          ? 1
          : 0
      : input.deliveredAt && input.promisedDeliveryAt
        ? input.deliveredAt <= input.promisedDeliveryAt
          ? 1
          : 0
        : null
  const isFirstAttempt =
    input.isFirstAttemptSuccess !== undefined
      ? input.isFirstAttemptSuccess === null
        ? null
        : input.isFirstAttemptSuccess
          ? 1
          : 0
      : null
  const hasDamage = input.hasDamage ? 1 : 0
  const hasIncident = input.hasIncident ? 1 : 0
  const costCents = input.costCents ?? 0

  await db
    .prepare(
      `INSERT INTO carrier_performance_records(
        id, carrier, order_id, tracking_number, service_code, dispatched_at, promised_delivery_at,
        first_delivery_attempt_at, delivered_at, status, is_delivered, is_on_time, is_first_attempt_success,
        has_damage, has_incident, incident_kind, incident_opened_at, incident_resolved_at,
        resolution_time_seconds, cost_cents, created_at, updated_at
      ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)`
    )
    .bind(
      id,
      input.carrier,
      input.orderId ?? null,
      input.trackingNumber,
      input.serviceCode,
      input.dispatchedAt,
      input.promisedDeliveryAt,
      input.firstDeliveryAttemptAt ?? null,
      input.deliveredAt ?? null,
      input.status,
      isDelivered ? 1 : 0,
      isOnTime,
      isFirstAttempt,
      hasDamage,
      hasIncident,
      input.incidentKind ?? null,
      input.incidentOpenedAt ?? null,
      input.incidentResolvedAt ?? null,
      input.resolutionTimeSeconds ?? null,
      costCents,
      currentTime,
      currentTime
    )
    .run()
}

interface RawCarrierRecord {
  id: string
  carrier: string
  status: string
  is_delivered: number
  is_on_time: number | null
  is_first_attempt_success: number | null
  has_damage: number
  has_incident: number
  resolution_time_seconds: number | null
  cost_cents: number
}

function calculateMetrics(
  records: RawCarrierRecord[],
  minThreshold: number
): Omit<CarrierScorecardSummary, 'hasSufficientSample'> & { hasSufficientSample: boolean } {
  const total = records.length
  if (total === 0) {
    return {
      totalShipments: 0,
      deliveredShipments: 0,
      onTimeRate: null,
      firstAttemptRate: null,
      incidentRate: null,
      damageRate: null,
      averageCostCents: 0,
      averageResolutionTimeHours: null,
      hasSufficientSample: false
    }
  }

  const delivered = records.filter((r) => r.is_delivered === 1).length
  const onTime = records.filter((r) => r.is_delivered === 1 && r.is_on_time === 1).length
  const firstAttempt = records.filter((r) => r.is_first_attempt_success === 1).length
  const damage = records.filter((r) => r.has_damage === 1).length
  const incident = records.filter((r) => r.has_incident === 1).length

  const onTimeRate = delivered > 0 ? onTime / delivered : null
  const firstAttemptRate = total > 0 ? firstAttempt / total : null
  const damageRate = total > 0 ? damage / total : null
  const incidentRate = total > 0 ? incident / total : null

  const totalCost = records.reduce((sum, r) => sum + r.cost_cents, 0)
  const averageCostCents = Math.round(totalCost / total)

  const resolved = records.filter((r) => r.resolution_time_seconds !== null && r.resolution_time_seconds >= 0)
  const averageResolutionTimeHours =
    resolved.length > 0
      ? Math.round(
          (resolved.reduce((sum, r) => sum + (r.resolution_time_seconds ?? 0), 0) / resolved.length / 3600) * 10
        ) / 10
      : null

  return {
    totalShipments: total,
    deliveredShipments: delivered,
    onTimeRate,
    firstAttemptRate,
    incidentRate,
    damageRate,
    averageCostCents,
    averageResolutionTimeHours,
    hasSufficientSample: total >= minThreshold
  }
}

export async function computeCarrierScorecard(
  db: D1Database,
  options: {
    from: string
    to: string
    carrier?: string
    minSampleThreshold?: number
    now?: string
  }
): Promise<CarrierScorecardReport> {
  const currentTime = getNow(options.now)
  const minThreshold = options.minSampleThreshold ?? 10
  const carrierFilter = options.carrier && options.carrier !== 'all' ? options.carrier : null

  let querySql = `
    SELECT id, carrier, status, is_delivered, is_on_time, is_first_attempt_success,
           has_damage, has_incident, resolution_time_seconds, cost_cents
    FROM carrier_performance_records
    WHERE dispatched_at >= ?1 AND dispatched_at <= ?2
  `
  const binds: unknown[] = [options.from, options.to]

  if (carrierFilter) {
    querySql += ' AND carrier = ?3'
    binds.push(carrierFilter)
  }

  querySql += ' ORDER BY dispatched_at ASC'

  const { results: rawRows } = await db
    .prepare(querySql)
    .bind(...binds)
    .all<RawCarrierRecord>()
  const records = rawRows ?? []

  const summary = calculateMetrics(records, minThreshold)

  // Group by carrier
  const carrierMap = new Map<string, RawCarrierRecord[]>()
  for (const record of records) {
    const list = carrierMap.get(record.carrier) ?? []
    list.push(record)
    carrierMap.set(record.carrier, list)
  }

  // Also include filtered carrier if specified and 0 rows found
  if (carrierFilter && !carrierMap.has(carrierFilter)) {
    carrierMap.set(carrierFilter, [])
  }

  const carriers: CarrierScorecardItem[] = []
  for (const [carrierCode, carrierRecords] of carrierMap.entries()) {
    const carrierMetrics = calculateMetrics(carrierRecords, minThreshold)
    const breaker = await getCarrierCircuitBreaker(db, carrierCode, currentTime)

    carriers.push({
      carrier: carrierCode,
      carrierName: carrierDisplayName(carrierCode),
      ...carrierMetrics,
      circuitBreaker: {
        state: breaker.state,
        consecutiveFailures: breaker.consecutiveFailures,
        lastFailureAt: breaker.lastFailureAt
      }
    })
  }

  // Sort carriers: highest volume first
  carriers.sort((a, b) => b.totalShipments - a.totalShipments)

  return {
    source: 'cloudflare',
    period: {
      from: options.from,
      to: options.to
    },
    filters: {
      carrier: carrierFilter ?? 'all'
    },
    summary,
    carriers,
    minSampleThreshold: minThreshold,
    evaluatedAt: currentTime
  }
}
