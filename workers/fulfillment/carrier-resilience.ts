import { roundRatio } from '../../server/domain/money'
import { sha256Hex } from '../catalog/inventory'
import type {
  CarrierProvider,
  Parcel,
  ShipmentResult,
  ShippingAddress
} from '../../server/integrations/carrier-provider'

export type CircuitBreakerState = 'closed' | 'open' | 'half_open'

export interface CarrierCircuitBreaker {
  carrier: string
  state: CircuitBreakerState
  failureCount: number
  successCount: number
  consecutiveFailures: number
  consecutiveSuccesses: number
  failureThreshold: number
  successThreshold: number
  cooldownSeconds: number
  openedAt: string | null
  halfOpenedAt: string | null
  lastFailureAt: string | null
  lastSuccessAt: string | null
  lastFailureReason: string | null
  updatedAt: string
}

export type CarrierResilienceErrorCode =
  | 'invalid_input'
  | 'circuit_open'
  | 'carrier_unavailable'
  | 'rate_not_found'
  | 'double_label_prevented'
  | 'uncertain_result'
  | 'reconciliation_failed'
  | 'conflict'

export class CarrierResilienceError extends Error {
  constructor(
    readonly code: CarrierResilienceErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CarrierResilienceError'
  }
}

function getNow(now?: string): string {
  if (now) {
    return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function isCarrierExecutionAllowed(breaker: CarrierCircuitBreaker): {
  allowed: boolean
  isProbe: boolean
} {
  if (breaker.state === 'closed') {
    return { allowed: true, isProbe: false }
  }
  if (breaker.state === 'half_open') {
    return { allowed: true, isProbe: true }
  }
  return { allowed: false, isProbe: false }
}

export async function getCarrierCircuitBreaker(
  db: D1Database,
  carrier: string,
  now?: string
): Promise<CarrierCircuitBreaker> {
  const currentTime = getNow(now)
  const row = await db
    .prepare(
      `SELECT carrier, state, failure_count, success_count, consecutive_failures, consecutive_successes,
              failure_threshold, success_threshold, cooldown_seconds, opened_at, half_opened_at,
              last_failure_at, last_success_at, last_failure_reason, updated_at
       FROM carrier_circuit_breakers WHERE carrier = ?1`
    )
    .bind(carrier)
    .first<Record<string, unknown>>()

  if (!row) {
    // Initialize default closed breaker
    const initial: CarrierCircuitBreaker = {
      carrier,
      state: 'closed',
      failureCount: 0,
      successCount: 0,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      failureThreshold: 5,
      successThreshold: 2,
      cooldownSeconds: 300,
      openedAt: null,
      halfOpenedAt: null,
      lastFailureAt: null,
      lastSuccessAt: null,
      lastFailureReason: null,
      updatedAt: currentTime
    }

    await db
      .prepare(
        `INSERT INTO carrier_circuit_breakers(carrier, state, failure_count, success_count, consecutive_failures,
          consecutive_successes, failure_threshold, success_threshold, cooldown_seconds, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      )
      .bind(
        initial.carrier,
        initial.state,
        initial.failureCount,
        initial.successCount,
        initial.consecutiveFailures,
        initial.consecutiveSuccesses,
        initial.failureThreshold,
        initial.successThreshold,
        initial.cooldownSeconds,
        initial.updatedAt
      )
      .run()

    return initial
  }

  const breaker: CarrierCircuitBreaker = {
    carrier: String(row.carrier),
    state: row.state as CircuitBreakerState,
    failureCount: Number(row.failure_count),
    successCount: Number(row.success_count),
    consecutiveFailures: Number(row.consecutive_failures),
    consecutiveSuccesses: Number(row.consecutive_successes),
    failureThreshold: Number(row.failure_threshold),
    successThreshold: Number(row.success_threshold),
    cooldownSeconds: Number(row.cooldown_seconds),
    openedAt: row.opened_at ? String(row.opened_at) : null,
    halfOpenedAt: row.half_opened_at ? String(row.half_opened_at) : null,
    lastFailureAt: row.last_failure_at ? String(row.last_failure_at) : null,
    lastSuccessAt: row.last_success_at ? String(row.last_success_at) : null,
    lastFailureReason: row.last_failure_reason ? String(row.last_failure_reason) : null,
    updatedAt: String(row.updated_at)
  }

  // Check cooldown expiration when in 'open' state
  if (breaker.state === 'open' && breaker.openedAt) {
    const openedTime = Date.parse(breaker.openedAt)
    const currentMs = Date.parse(currentTime)
    if (currentMs >= openedTime + breaker.cooldownSeconds * 1000) {
      // Transition to half_open
      breaker.state = 'half_open'
      breaker.halfOpenedAt = currentTime
      breaker.consecutiveSuccesses = 0
      breaker.updatedAt = currentTime

      await db
        .prepare(
          `UPDATE carrier_circuit_breakers
           SET state = 'half_open', half_opened_at = ?2, consecutive_successes = 0, updated_at = ?2
           WHERE carrier = ?1`
        )
        .bind(carrier, currentTime)
        .run()

      await recordBreakerEvent(db, carrier, 'open', 'half_open', 'Cooldown period elapsed', 0, currentTime)
    }
  }

  return breaker
}

async function recordBreakerEvent(
  db: D1Database,
  carrier: string,
  fromState: CircuitBreakerState,
  toState: CircuitBreakerState,
  reason: string,
  consecutiveFailures: number,
  now: string
): Promise<void> {
  const eventId = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO carrier_circuit_breaker_events(id, carrier, previous_state, new_state, trigger_reason, consecutive_failures, created_at)
       VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    )
    .bind(eventId, carrier, fromState, toState, reason, consecutiveFailures, now)
    .run()
}

export async function recordCarrierFailure(
  db: D1Database,
  carrier: string,
  reason: string,
  now?: string
): Promise<CarrierCircuitBreaker> {
  const currentTime = getNow(now)
  const current = await getCarrierCircuitBreaker(db, carrier, currentTime)

  const newConsecutiveFailures = current.consecutiveFailures + 1
  const newFailureCount = current.failureCount + 1
  let nextState: CircuitBreakerState = current.state
  let openedAt = current.openedAt

  if (current.state === 'closed') {
    if (newConsecutiveFailures >= current.failureThreshold) {
      nextState = 'open'
      openedAt = currentTime
      await recordBreakerEvent(
        db,
        carrier,
        'closed',
        'open',
        `Failure threshold (${current.failureThreshold}) reached: ${reason}`,
        newConsecutiveFailures,
        currentTime
      )
    }
  } else if (current.state === 'half_open') {
    nextState = 'open'
    openedAt = currentTime
    await recordBreakerEvent(
      db,
      carrier,
      'half_open',
      'open',
      `Probe failed during half_open: ${reason}`,
      newConsecutiveFailures,
      currentTime
    )
  }

  await db
    .prepare(
      `UPDATE carrier_circuit_breakers
       SET state = ?2, failure_count = ?3, consecutive_failures = ?4, consecutive_successes = 0,
           opened_at = ?5, last_failure_at = ?6, last_failure_reason = ?7, updated_at = ?6
       WHERE carrier = ?1`
    )
    .bind(carrier, nextState, newFailureCount, newConsecutiveFailures, openedAt, currentTime, reason)
    .run()

  return {
    ...current,
    state: nextState,
    failureCount: newFailureCount,
    consecutiveFailures: newConsecutiveFailures,
    consecutiveSuccesses: 0,
    openedAt,
    lastFailureAt: currentTime,
    lastFailureReason: reason,
    updatedAt: currentTime
  }
}

export async function recordCarrierSuccess(
  db: D1Database,
  carrier: string,
  now?: string
): Promise<CarrierCircuitBreaker> {
  const currentTime = getNow(now)
  const current = await getCarrierCircuitBreaker(db, carrier, currentTime)

  const newSuccessCount = current.successCount + 1
  let newConsecutiveSuccesses = current.consecutiveSuccesses + 1
  let newConsecutiveFailures = 0
  let nextState: CircuitBreakerState = current.state
  let openedAt = current.openedAt

  if (current.state === 'half_open') {
    if (newConsecutiveSuccesses >= current.successThreshold) {
      nextState = 'closed'
      newConsecutiveFailures = 0
      newConsecutiveSuccesses = 0
      openedAt = null
      await recordBreakerEvent(
        db,
        carrier,
        'half_open',
        'closed',
        `Success threshold (${current.successThreshold}) achieved during trial`,
        0,
        currentTime
      )
    }
  } else if (current.state === 'closed') {
    newConsecutiveFailures = 0
  }

  await db
    .prepare(
      `UPDATE carrier_circuit_breakers
       SET state = ?2, success_count = ?3, consecutive_failures = ?4, consecutive_successes = ?5,
           opened_at = ?6, last_success_at = ?7, updated_at = ?7
       WHERE carrier = ?1`
    )
    .bind(carrier, nextState, newSuccessCount, newConsecutiveFailures, newConsecutiveSuccesses, openedAt, currentTime)
    .run()

  return {
    ...current,
    state: nextState,
    successCount: newSuccessCount,
    consecutiveFailures: newConsecutiveFailures,
    consecutiveSuccesses: newConsecutiveSuccesses,
    openedAt,
    lastSuccessAt: currentTime,
    updatedAt: currentTime
  }
}

export interface CarrierRateCacheEntry {
  cacheKey: string
  carrier: string
  zoneCode: string
  serviceCode: string
  serviceProfile: 'parcel' | 'pallet' | 'adr' | 'own_delivery' | 'pickup'
  weightTierGrams: number
  netCents: number
  taxRateBasisPoints: number
  grossCents: number
  etaMinDays: number
  etaMaxDays: number
  cachedAt: string
  expiresAt: string
}

export interface CarrierFallbackRate {
  carrier: string
  serviceProfile: 'parcel' | 'pallet' | 'adr' | 'own_delivery' | 'pickup'
  zoneCode: string
  serviceCode: string
  netCents: number
  taxRateBasisPoints: number
  grossCents: number
  etaMinDays: number
  etaMaxDays: number
  active: number
}

function weightTier(weightGrams: number): number {
  if (weightGrams <= 2000) return 2000
  if (weightGrams <= 5000) return 5000
  if (weightGrams <= 10000) return 10000
  if (weightGrams <= 20000) return 20000
  return Math.ceil(weightGrams / 10000) * 10000
}

export async function cacheCarrierRates(
  db: D1Database,
  carrier: string,
  rates: Array<{
    serviceCode: string
    serviceProfile: 'parcel' | 'pallet' | 'adr' | 'own_delivery' | 'pickup'
    zoneCode: string
    weightGrams: number
    netCents: number
    taxRateBasisPoints: number
    grossCents: number
    etaMinDays: number
    etaMaxDays: number
  }>,
  options: { ttlSeconds?: number; now?: string } = {}
): Promise<void> {
  const currentTime = getNow(options.now)
  const ttl = options.ttlSeconds ?? 86400 // 24 hours default
  const expiresAt = new Date(Date.parse(currentTime) + ttl * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

  for (const rate of rates) {
    const tier = weightTier(rate.weightGrams)
    const rawKey = `${carrier}:${rate.zoneCode}:${rate.serviceProfile}:${tier}:${rate.serviceCode}`
    const cacheKey = await sha256Hex(rawKey)

    await db
      .prepare(
        `INSERT INTO carrier_rate_cache(cache_key, carrier, zone_code, service_code, service_profile,
          weight_tier_grams, net_cents, tax_rate_basis_points, gross_cents, eta_min_days, eta_max_days,
          cached_at, expires_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(cache_key) DO UPDATE SET
          net_cents = excluded.net_cents,
          tax_rate_basis_points = excluded.tax_rate_basis_points,
          gross_cents = excluded.gross_cents,
          eta_min_days = excluded.eta_min_days,
          eta_max_days = excluded.eta_max_days,
          cached_at = excluded.cached_at,
          expires_at = excluded.expires_at`
      )
      .bind(
        cacheKey,
        carrier,
        rate.zoneCode,
        rate.serviceCode,
        rate.serviceProfile,
        tier,
        rate.netCents,
        rate.taxRateBasisPoints,
        rate.grossCents,
        rate.etaMinDays,
        rate.etaMaxDays,
        currentTime,
        expiresAt
      )
      .run()
  }
}

export async function lookupCachedCarrierRate(
  db: D1Database,
  query: {
    carrier: string
    zoneCode: string
    serviceProfile: string
    weightGrams: number
    maxAgeSeconds?: number
    now?: string
  }
): Promise<CarrierRateCacheEntry | null> {
  const currentTime = getNow(query.now)
  const tier = weightTier(query.weightGrams)
  const maxAge = query.maxAgeSeconds ?? 86400
  const oldestAllowedTime = new Date(Date.parse(currentTime) - maxAge * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

  const row = await db
    .prepare(
      `SELECT cache_key, carrier, zone_code, service_code, service_profile, weight_tier_grams,
              net_cents, tax_rate_basis_points, gross_cents, eta_min_days, eta_max_days,
              cached_at, expires_at
       FROM carrier_rate_cache
       WHERE carrier = ?1 AND zone_code = ?2 AND service_profile = ?3 AND weight_tier_grams = ?4
         AND expires_at >= ?5 AND cached_at >= ?6
       ORDER BY cached_at DESC
       LIMIT 1`
    )
    .bind(query.carrier, query.zoneCode, query.serviceProfile, tier, currentTime, oldestAllowedTime)
    .first<Record<string, unknown>>()

  if (!row) return null

  return {
    cacheKey: String(row.cache_key),
    carrier: String(row.carrier),
    zoneCode: String(row.zone_code),
    serviceCode: String(row.service_code),
    serviceProfile: row.service_profile as CarrierRateCacheEntry['serviceProfile'],
    weightTierGrams: Number(row.weight_tier_grams),
    netCents: Number(row.net_cents),
    taxRateBasisPoints: Number(row.tax_rate_basis_points),
    grossCents: Number(row.gross_cents),
    etaMinDays: Number(row.eta_min_days),
    etaMaxDays: Number(row.eta_max_days),
    cachedAt: String(row.cached_at),
    expiresAt: String(row.expires_at)
  }
}

export async function lookupManualFallbackRate(
  db: D1Database,
  query: {
    carrier: string
    zoneCode: string
    serviceProfile: string
  }
): Promise<CarrierFallbackRate | null> {
  const row = await db
    .prepare(
      `SELECT carrier, service_profile, zone_code, service_code, net_cents, tax_rate_basis_points,
              gross_cents, eta_min_days, eta_max_days, active
       FROM carrier_fallback_rates
       WHERE carrier = ?1 AND zone_code = ?2 AND service_profile = ?3 AND active = 1
       LIMIT 1`
    )
    .bind(query.carrier, query.zoneCode, query.serviceProfile)
    .first<Record<string, unknown>>()

  if (!row) return null

  return {
    carrier: String(row.carrier),
    serviceProfile: row.service_profile as CarrierFallbackRate['serviceProfile'],
    zoneCode: String(row.zone_code),
    serviceCode: String(row.service_code),
    netCents: Number(row.net_cents),
    taxRateBasisPoints: Number(row.tax_rate_basis_points),
    grossCents: Number(row.gross_cents),
    etaMinDays: Number(row.eta_min_days),
    etaMaxDays: Number(row.eta_max_days),
    active: Number(row.active)
  }
}

export interface QuoteResilientCarrierRateInput {
  carrier: string
  originPostalCode: string
  destination: ShippingAddress
  parcels: Parcel[]
  serviceProfile?: 'parcel' | 'pallet' | 'adr' | 'own_delivery' | 'pickup'
  now?: string
  maxCacheAgeSeconds?: number
  alternativeCarrier?: {
    name: string
    provider: CarrierProvider
  }
}

export interface ResilientCarrierRateResult {
  source: 'live' | 'cache' | 'manual_safe_rate' | 'alternative_carrier'
  carrier: string
  rate: {
    serviceCode: string
    label: string
    netCents: number
    taxRateBasisPoints: number
    grossCents: number
    etaMinDays: number
    etaMaxDays: number
  }
  cachedAt?: string
}

export async function quoteResilientCarrierRate(
  db: D1Database,
  carrierProvider: CarrierProvider,
  input: QuoteResilientCarrierRateInput
): Promise<ResilientCarrierRateResult> {
  const currentTime = getNow(input.now)
  const carrierName = input.carrier
  const profile = input.serviceProfile ?? 'parcel'
  const zoneCode = input.destination.postalCode.slice(0, 2)
  const totalWeight = input.parcels.reduce((sum, p) => sum + p.weightGrams, 0)

  const breaker = await getCarrierCircuitBreaker(db, carrierName, currentTime)
  const { allowed } = isCarrierExecutionAllowed(breaker)

  if (allowed) {
    try {
      const liveRates = await carrierProvider.rates({
        originPostalCode: input.originPostalCode,
        destination: input.destination,
        parcels: input.parcels
      })

      if (liveRates.length > 0) {
        const primary = liveRates[0]!
        const taxCents = roundRatio(BigInt(primary.netCents) * BigInt(primary.taxRateBasisPoints), 10000n)
        const grossCents = primary.netCents + taxCents

        await recordCarrierSuccess(db, carrierName, currentTime)

        // Cache the quote
        await cacheCarrierRates(
          db,
          carrierName,
          [
            {
              serviceCode: primary.serviceCode,
              serviceProfile: profile,
              zoneCode,
              weightGrams: totalWeight,
              netCents: primary.netCents,
              taxRateBasisPoints: primary.taxRateBasisPoints,
              grossCents,
              etaMinDays: 1,
              etaMaxDays: 2
            }
          ],
          { now: currentTime }
        )

        return {
          source: 'live',
          carrier: carrierName,
          rate: {
            serviceCode: primary.serviceCode,
            label: primary.label,
            netCents: primary.netCents,
            taxRateBasisPoints: primary.taxRateBasisPoints,
            grossCents,
            etaMinDays: 1,
            etaMaxDays: 2
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown carrier error'
      await recordCarrierFailure(db, carrierName, message, currentTime)
    }
  }

  // Fallback 1: valid cached rate
  const cached = await lookupCachedCarrierRate(db, {
    carrier: carrierName,
    zoneCode,
    serviceProfile: profile,
    weightGrams: totalWeight,
    maxAgeSeconds: input.maxCacheAgeSeconds,
    now: currentTime
  })

  if (cached) {
    return {
      source: 'cache',
      carrier: carrierName,
      rate: {
        serviceCode: cached.serviceCode,
        label: `${carrierName} (Tarifa cacheada)`,
        netCents: cached.netCents,
        taxRateBasisPoints: cached.taxRateBasisPoints,
        grossCents: cached.grossCents,
        etaMinDays: cached.etaMinDays,
        etaMaxDays: cached.etaMaxDays
      },
      cachedAt: cached.cachedAt
    }
  }

  // Fallback 2: safe manual configured rate
  const manual = await lookupManualFallbackRate(db, {
    carrier: carrierName,
    zoneCode,
    serviceProfile: profile
  })

  if (manual) {
    return {
      source: 'manual_safe_rate',
      carrier: carrierName,
      rate: {
        serviceCode: manual.serviceCode,
        label: `${carrierName} (Tarifa manual de contingencia)`,
        netCents: manual.netCents,
        taxRateBasisPoints: manual.taxRateBasisPoints,
        grossCents: manual.grossCents,
        etaMinDays: manual.etaMinDays,
        etaMaxDays: manual.etaMaxDays
      }
    }
  }

  // Fallback 3: alternative carrier
  if (input.alternativeCarrier) {
    try {
      const altResult = await quoteResilientCarrierRate(db, input.alternativeCarrier.provider, {
        ...input,
        carrier: input.alternativeCarrier.name,
        alternativeCarrier: undefined
      })
      return {
        ...altResult,
        source: 'alternative_carrier',
        carrier: input.alternativeCarrier.name
      }
    } catch {
      // Continue to throw below
    }
  }

  throw new CarrierResilienceError(
    'carrier_unavailable',
    `Carrier ${carrierName} is unavailable and all fallback mechanisms were exhausted`
  )
}

export interface CarrierShipmentLabel {
  id: string
  orderId: string
  parcelIndex: number
  idempotencyKey: string
  commandId: string | null
  carrier: string
  serviceCode: string
  trackingNumber: string
  providerShipmentId: string
  labelFormat: 'pdf' | 'zpl'
  labelData: string
  status: 'pending' | 'confirmed' | 'uncertain' | 'failed' | 'cancelled'
  reconciliationStatus: 'none' | 'required' | 'in_progress' | 'reconciled_confirmed' | 'reconciled_not_found' | 'failed'
  reconciliationAttempts: number
  uncertainReason: string | null
  quotedGrossCents: number
  actualCostCents: number
  createdAt: string
  updatedAt: string
}

export async function getCarrierShipmentLabel(
  db: D1Database,
  orderId: string,
  parcelIndex: number
): Promise<CarrierShipmentLabel | null> {
  const row = await db
    .prepare(
      `SELECT id, order_id, parcel_index, idempotency_key, command_id, carrier, service_code,
              tracking_number, provider_shipment_id, label_format, label_data, status,
              reconciliation_status, reconciliation_attempts, uncertain_reason, quoted_gross_cents,
              actual_cost_cents, created_at, updated_at
       FROM carrier_shipment_labels
       WHERE order_id = ?1 AND parcel_index = ?2`
    )
    .bind(orderId, parcelIndex)
    .first<Record<string, unknown>>()

  if (!row) return null

  return mapLabelRow(row)
}

function mapLabelRow(row: Record<string, unknown>): CarrierShipmentLabel {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    parcelIndex: Number(row.parcel_index),
    idempotencyKey: String(row.idempotency_key),
    commandId: row.command_id ? String(row.command_id) : null,
    carrier: String(row.carrier),
    serviceCode: String(row.service_code),
    trackingNumber: String(row.tracking_number),
    providerShipmentId: String(row.provider_shipment_id),
    labelFormat: row.label_format as 'pdf' | 'zpl',
    labelData: String(row.label_data),
    status: row.status as CarrierShipmentLabel['status'],
    reconciliationStatus: row.reconciliation_status as CarrierShipmentLabel['reconciliationStatus'],
    reconciliationAttempts: Number(row.reconciliation_attempts),
    uncertainReason: row.uncertain_reason ? String(row.uncertain_reason) : null,
    quotedGrossCents: Number(row.quoted_gross_cents),
    actualCostCents: Number(row.actual_cost_cents),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

export interface CreateCarrierLabelInput {
  orderId: string
  parcelIndex: number
  idempotencyKey: string
  commandId?: string
  orderNumber: string
  destination: ShippingAddress
  parcels: Parcel[]
  serviceCode: string
  quotedGrossCents: number
  now?: string
  reconcileLookup?: (
    orderNumber: string,
    idempotencyKey: string
  ) => Promise<{
    found: boolean
    providerShipmentId?: string
    trackingNumber?: string
    labelData?: string
    costCents?: number
  }>
}

export interface CreateCarrierLabelResult {
  outcome: 'created' | 'already_created' | 'reconciled'
  doubleLabelPrevented: boolean
  label: CarrierShipmentLabel
}

export async function resilientCreateCarrierLabel(
  db: D1Database,
  carrierProvider: CarrierProvider,
  input: CreateCarrierLabelInput
): Promise<CreateCarrierLabelResult> {
  const currentTime = getNow(input.now)

  // 1. Check existing label by parcel or idempotencyKey to guarantee NUNCA DOBLE ETIQUETA
  const existingRow = await db
    .prepare(
      `SELECT id, order_id, parcel_index, idempotency_key, command_id, carrier, service_code,
              tracking_number, provider_shipment_id, label_format, label_data, status,
              reconciliation_status, reconciliation_attempts, uncertain_reason, quoted_gross_cents,
              actual_cost_cents, created_at, updated_at
       FROM carrier_shipment_labels
       WHERE (order_id = ?1 AND parcel_index = ?2) OR idempotency_key = ?3`
    )
    .bind(input.orderId, input.parcelIndex, input.idempotencyKey)
    .first<Record<string, unknown>>()

  if (existingRow) {
    const existing = mapLabelRow(existingRow)

    if (existing.status === 'confirmed') {
      return {
        outcome: 'already_created',
        doubleLabelPrevented: true,
        label: existing
      }
    }

    if (existing.status === 'uncertain') {
      // Must reconcile before retrying!
      if (input.reconcileLookup) {
        const check = await input.reconcileLookup(input.orderNumber, input.idempotencyKey)
        if (check.found) {
          const updatedTracking = check.trackingNumber ?? existing.trackingNumber
          const updatedShipmentId = check.providerShipmentId ?? existing.providerShipmentId
          const updatedLabelData = check.labelData ?? existing.labelData

          await db
            .prepare(
              `UPDATE carrier_shipment_labels
               SET status = 'confirmed', reconciliation_status = 'reconciled_confirmed',
                   reconciliation_attempts = reconciliation_attempts + 1,
                   tracking_number = ?2, provider_shipment_id = ?3, label_data = ?4, updated_at = ?5
               WHERE id = ?1`
            )
            .bind(existing.id, updatedTracking, updatedShipmentId, updatedLabelData, currentTime)
            .run()

          const reconciled = await getCarrierShipmentLabel(db, input.orderId, input.parcelIndex)
          return {
            outcome: 'reconciled',
            doubleLabelPrevented: true,
            label: reconciled!
          }
        } else {
          // Provider confirmed no shipment was created -> mark failed so we can create afresh
          await db
            .prepare(
              `UPDATE carrier_shipment_labels
               SET status = 'failed', reconciliation_status = 'reconciled_not_found',
                   reconciliation_attempts = reconciliation_attempts + 1, updated_at = ?2
               WHERE id = ?1`
            )
            .bind(existing.id, currentTime)
            .run()
        }
      } else {
        throw new CarrierResilienceError(
          'uncertain_result',
          'Previous shipment outcome was uncertain and requires reconciliation before any new attempt'
        )
      }
    }
  }

  // 2. Check circuit breaker for carrier
  const breaker = await getCarrierCircuitBreaker(db, carrierProvider.name, currentTime)
  const { allowed } = isCarrierExecutionAllowed(breaker)
  if (!allowed) {
    throw new CarrierResilienceError('circuit_open', `Circuit breaker for carrier ${carrierProvider.name} is open`)
  }

  // 3. Attempt creation with carrier provider
  let shipmentResult: ShipmentResult
  try {
    shipmentResult = await carrierProvider.createShipment({
      orderNumber: input.orderNumber,
      destination: input.destination,
      parcels: input.parcels,
      serviceCode: input.serviceCode,
      idempotencyKey: input.idempotencyKey
    })
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : 'Unknown carrier error'
    const isTimeout =
      errMessage.includes('ETIMEDOUT') ||
      errMessage.includes('timeout') ||
      errMessage.includes('Connection reset') ||
      errMessage.includes('504')

    if (isTimeout) {
      // Record uncertain state to prevent subsequent double creation
      const uncertainId = crypto.randomUUID()
      await db
        .prepare(
          `INSERT INTO carrier_shipment_labels(
            id, order_id, parcel_index, idempotency_key, command_id, carrier, service_code,
            tracking_number, provider_shipment_id, label_format, label_data, status,
            reconciliation_status, reconciliation_attempts, uncertain_reason, quoted_gross_cents,
            actual_cost_cents, created_at, updated_at
          ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
          ON CONFLICT(order_id, parcel_index) DO UPDATE SET
            status = 'uncertain',
            reconciliation_status = 'required',
            uncertain_reason = excluded.uncertain_reason,
            updated_at = excluded.updated_at`
        )
        .bind(
          uncertainId,
          input.orderId,
          input.parcelIndex,
          input.idempotencyKey,
          input.commandId ?? null,
          carrierProvider.name,
          input.serviceCode,
          'UNCERTAIN_PENDING',
          'UNCERTAIN_PENDING',
          'pdf',
          '',
          'uncertain',
          'required',
          0,
          errMessage,
          input.quotedGrossCents,
          0,
          currentTime,
          currentTime
        )
        .run()

      await recordCarrierFailure(db, carrierProvider.name, errMessage, currentTime)
      throw new CarrierResilienceError('uncertain_result', errMessage)
    }

    await recordCarrierFailure(db, carrierProvider.name, errMessage, currentTime)
    throw error
  }

  // 4. Record confirmed label
  const labelId = crypto.randomUUID()
  const base64Label = Buffer.from(shipmentResult.label).toString('base64')
  const actualCostCents = input.quotedGrossCents // coherent with snapshot quote

  try {
    await db
      .prepare(
        `INSERT INTO carrier_shipment_labels(
          id, order_id, parcel_index, idempotency_key, command_id, carrier, service_code,
          tracking_number, provider_shipment_id, label_format, label_data, status,
          reconciliation_status, reconciliation_attempts, quoted_gross_cents, actual_cost_cents,
          created_at, updated_at
        ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`
      )
      .bind(
        labelId,
        input.orderId,
        input.parcelIndex,
        input.idempotencyKey,
        input.commandId ?? null,
        carrierProvider.name,
        input.serviceCode,
        shipmentResult.trackingNumber,
        shipmentResult.providerShipmentId,
        'pdf',
        base64Label,
        'confirmed',
        'none',
        0,
        input.quotedGrossCents,
        actualCostCents,
        currentTime,
        currentTime
      )
      .run()

    await recordCarrierSuccess(db, carrierProvider.name, currentTime)

    const label = await getCarrierShipmentLabel(db, input.orderId, input.parcelIndex)
    return {
      outcome: 'created',
      doubleLabelPrevented: false,
      label: label!
    }
  } catch (dbError) {
    // If concurrent race inserted a label, fetch and return it without duplicating
    const raceWon = await getCarrierShipmentLabel(db, input.orderId, input.parcelIndex)
    if (raceWon && raceWon.status === 'confirmed') {
      return {
        outcome: 'already_created',
        doubleLabelPrevented: true,
        label: raceWon
      }
    }
    throw dbError
  }
}
