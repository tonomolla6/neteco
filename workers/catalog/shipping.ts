/**
 * Deterministic server-side shipping engine for the D1 canary lane.
 *
 * The client provides ONLY a validated destination and its selection; prices,
 * taxes, eligibility and ETAs are always resolved here from the configured
 * zones/rates. Warehouse pickup is always eligible when active, own delivery
 * applies to configured postal prefixes, and peninsular parcel is the
 * configured fallback. Pallet/ADR profiles exist in the rate model so heavier
 * or regulated baskets can map onto them later without schema changes.
 *
 * Snapshots are immutable and expirable; selection happens at checkout time
 * against a still-valid snapshot whose destination hash matches.
 */

import type { Currency } from '../../server/domain/money'
import { roundRatio } from '../../server/domain/money'
import { canonicalJson, sha256Hex, sellableExpression } from './inventory'
import { cartGoodsGrossCents } from './cart'
import { readSalesQuoteShippingAuthority, type SalesQuoteCheckoutReference } from './sales-quotes'
import type { VerifiedSessionClaims } from './authorization'
import type { ShippingCalendarEta } from '../../shared/shipping-calendar'
import {
  calculateShippingCalendarEta,
  readD1ShippingCalendarConfiguration,
  shippingCalendarRevalidationDeadline
} from './shipping-calendar'

export class ShippingError extends Error {
  constructor(
    readonly code:
      'invalid_input' | 'not_found' | 'conflict' | 'version_conflict' | 'not_active' | 'variant_not_available',
    message: string
  ) {
    super(message)
    this.name = 'ShippingError'
  }
}

export interface ShippingDestination {
  postalCode: string
  city: string
}

export function assertDestination(value: unknown): ShippingDestination {
  if (typeof value !== 'object' || value === null)
    throw new ShippingError('invalid_input', 'destination must be an object')
  const raw = value as Record<string, unknown>
  const postalCode = raw.postalCode
  const city = raw.city
  if (typeof postalCode !== 'string' || !/^[0-9]{5}$/.test(postalCode))
    throw new ShippingError('invalid_input', 'postalCode must be a five-digit string')
  if (typeof city !== 'string' || city.length < 1 || city.length > 80)
    throw new ShippingError('invalid_input', 'city is required')
  return { city: city.trim(), postalCode }
}

export async function destinationHash(destination: ShippingDestination): Promise<string> {
  return sha256Hex(canonicalJson({ city: destination.city.trim(), postalCode: destination.postalCode }))
}

export interface ShippingOption {
  methodCode: 'pickup' | 'own_delivery' | 'parcel'
  serviceProfile: 'parcel' | 'pallet' | 'adr'
  zoneCode: string
  netCents: number
  taxCents: number
  grossCents: number
  taxRateBasisPoints: number
  etaMinDays: number
  etaMaxDays: number
  rateVersion: number
  /** Local-date estimate, not a carrier guarantee. Absent only in legacy snapshots. */
  eta?: ShippingCalendarEta
  etaValidUntil?: string | null
}

export interface ShippingOptionSnapshot extends ShippingOption {
  optionIndex: number
  currency: Currency
  /** Accepted back at checkout to prove the client saw exactly this snapshot. */
  optionHash: string
}

export interface CartWeightRow {
  variantId: string
  quantity: number
  weightGrams: number
  published: number
  profileKind: string
  availableQuantity?: number
  backorderAllowed?: number
  leadTimeDays?: number | null
}

export interface RateRow {
  method_code: string
  service_profile: string
  zone_code: string
  net_cents: number
  tax_rate_basis_points: number
  eta_min_days: number
  eta_max_days: number
  rate_version: number
  prefixes_json: string
}

/** Total chargeable weight drives the service profile (pallet above 20 kg). */
function profileForTotalWeight(totalWeightGrams: number): 'parcel' | 'pallet' {
  return totalWeightGrams > 20_000 ? 'pallet' : 'parcel'
}

export async function resolveShippingOptions(
  database: D1Database,
  input: {
    cartId: string
    destination: ShippingDestination
    now: string
    freeShippingThresholdCents?: number | null
    salesQuote?: SalesQuoteCheckoutReference
    ownerSession?: VerifiedSessionClaims | null
  }
): Promise<{ options: ShippingOption[]; destinationHash: string }> {
  const threshold = input.freeShippingThresholdCents ?? null
  if (threshold !== null && (!Number.isSafeInteger(threshold) || threshold < 0))
    throw new ShippingError('invalid_input', 'free shipping threshold must be a non-negative integer')
  const hash = await destinationHash(input.destination)
  const approved = input.salesQuote
    ? await readSalesQuoteShippingAuthority(
        database,
        input.ownerSession ?? null,
        input.salesQuote,
        input.cartId,
        input.destination,
        input.now
      )
    : null

  const lines = await database
    .prepare(
      `SELECT cl.variant_id AS variantId,
              cl.quantity,
              COALESCE(v.weight_grams, 0) AS weightGrams,
              CASE WHEN v.status = 'published' AND p.status = 'published' THEN 1 ELSE 0 END AS published,
              COALESCE(sp.kind, 'parcel') AS profileKind,
              (SELECT TOTAL(${sellableExpression()}) FROM inventory_balances b WHERE b.variant_id=v.id) AS availableQuantity,
              v.backorder_allowed AS backorderAllowed,v.lead_time_days AS leadTimeDays
       FROM cart_lines cl
       LEFT JOIN variants v ON v.id = cl.variant_id
       LEFT JOIN products p ON p.id = v.product_id
       LEFT JOIN shipping_profiles sp ON sp.id = v.shipping_profile_id
       WHERE cl.cart_id = ?1`
    )
    .bind(input.cartId)
    .all<CartWeightRow>()
  if (!lines.results.length) throw new ShippingError('invalid_input', 'Cannot ship an empty cart')
  for (const line of lines.results)
    if (!line.published) throw new ShippingError('variant_not_available', 'Cart contains an unpublished variant')

  if (lines.results.some((line) => line.profileKind === 'adr')) return { destinationHash: hash, options: [] }

  const { results } = await prepareShippingRatesStatement(database).all<RateRow>()
  let options = mapShippingOptions(lines.results, results, input.destination)
  if (
    threshold !== null &&
    options.some((option) => option.methodCode === 'parcel' && option.serviceProfile === 'parcel')
  ) {
    const goodsGross = approved
      ? approved.goods.grossCents
      : await cartGoodsGrossCents(database, input.cartId, input.now, input.ownerSession)
    options = mapShippingOptions(lines.results, results, input.destination, { threshold, goodsGross })
  }
  const calendar = await readD1ShippingCalendarConfiguration(database)
  let stockLeadTimeDays: number | null = 0
  for (const line of lines.results) {
    if (!Number.isFinite(line.availableQuantity) || Number(line.availableQuantity) < 0)
      throw new ShippingError('invalid_input', 'Invalid authoritative stock position')
    if (Number(line.availableQuantity) >= line.quantity) continue
    if (line.backorderAllowed !== 1 || line.leadTimeDays === null || line.leadTimeDays === undefined) {
      stockLeadTimeDays = null
      break
    }
    if (!Number.isSafeInteger(line.leadTimeDays) || line.leadTimeDays < 0 || line.leadTimeDays > 365)
      throw new ShippingError('invalid_input', 'Invalid authoritative supplier lead time')
    stockLeadTimeDays = Math.max(stockLeadTimeDays, line.leadTimeDays)
  }
  const etaValidUntil = shippingCalendarRevalidationDeadline(calendar, input.now)
  options = options.map((option) => ({
    ...option,
    etaValidUntil,
    eta: calculateShippingCalendarEta(calendar, {
      now: input.now,
      postalCode: input.destination.postalCode,
      methodCode: option.methodCode,
      serviceProfile: option.serviceProfile,
      zoneCode: option.zoneCode,
      transitMinDays: option.etaMinDays,
      transitMaxDays: option.etaMaxDays,
      stockLeadTimeDays
    })
  }))
  return { destinationHash: hash, options }
}

export function prepareShippingRatesStatement(database: D1Database, maximumRows?: number): D1PreparedStatement {
  const statement = database.prepare(
    `SELECT r.method_code,
              r.service_profile,
              z.code AS zone_code,
              r.net_cents,
              r.tax_rate_basis_points,
              r.eta_min_days,
              r.eta_max_days,
              r.rate_version,
              z.postal_prefixes AS prefixes_json
       FROM shipping_rates r
       JOIN shipping_zones z ON z.id = r.zone_id
       WHERE r.active = 1 AND z.active = 1
         AND NOT EXISTS (
           SELECT 1 FROM shipping_rates newer
           WHERE newer.zone_id = r.zone_id
             AND newer.method_code = r.method_code
             AND newer.service_profile = r.service_profile
             AND newer.active = 1
             AND newer.rate_version > r.rate_version
         )
       ORDER BY r.method_code, r.rate_version DESC, z.code${maximumRows === undefined ? '' : ' LIMIT ?1'}`
  )
  return maximumRows === undefined ? statement : statement.bind(maximumRows)
}

/** Canonical eligibility and customer charge calculation; operating cost is not a rate. */
export function mapShippingOptions(
  lines: Pick<CartWeightRow, 'quantity' | 'weightGrams' | 'published' | 'profileKind'>[],
  results: RateRow[],
  destination: ShippingDestination,
  freeShipping?: { threshold: number; goodsGross: number }
): ShippingOption[] {
  if (!lines.length) throw new ShippingError('invalid_input', 'Cannot ship an empty cart')
  if (lines.some((line) => !line.published)) throw new ShippingError('variant_not_available', 'Unpublished variant')
  if (lines.some((line) => line.profileKind === 'adr')) return []
  const totalWeight = lines.reduce((sum, line) => sum + line.weightGrams * line.quantity, 0)
  const profile = lines.some((line) => line.profileKind === 'pallet') ? 'pallet' : profileForTotalWeight(totalWeight)

  const options: ShippingOption[] = []
  for (const rate of results) {
    let prefixes: string[] = []
    try {
      const parsed: unknown = JSON.parse(rate.prefixes_json)
      if (Array.isArray(parsed)) prefixes = parsed.filter((entry): entry is string => typeof entry === 'string')
    } catch {
      prefixes = []
    }
    const prefixMatched =
      rate.method_code === 'pickup' ||
      prefixes.some((configured) =>
        rate.method_code === 'own_delivery'
          ? destination.postalCode.startsWith(configured)
          : isPeninsularSpanishPostalCode(destination.postalCode) && configured === 'peninsular'
      )
    if (!prefixMatched) continue
    // Parcel-method rates follow the computed basket profile (ADR rates only
    // apply when regulation data selects them, which the canary never does);
    // pickup and own delivery always use their standard configuration.
    if (rate.method_code === 'pickup') {
      if (rate.service_profile !== 'parcel') continue
    } else {
      // ADR never becomes eligible in this lane; the computed profile is
      // parcel or pallet only.
      if (rate.service_profile !== profile) continue
    }
    options.push({
      etaMaxDays: rate.eta_max_days,
      etaMinDays: rate.eta_min_days,
      grossCents: 0,
      methodCode: rate.method_code as ShippingOption['methodCode'],
      netCents: rate.net_cents,
      rateVersion: rate.rate_version,
      serviceProfile: rate.service_profile as ShippingOption['serviceProfile'],
      taxCents: 0,
      taxRateBasisPoints: rate.tax_rate_basis_points,
      zoneCode: rate.zone_code
    })
  }

  // Only standard parcel rates can become free. The threshold is internal
  // server configuration and gross goods use the same effective price/volume
  // tier resolver as the contractual checkout quote.
  if (
    freeShipping !== undefined &&
    options.some((option) => option.methodCode === 'parcel' && option.serviceProfile === 'parcel')
  ) {
    if (freeShipping.goodsGross >= freeShipping.threshold)
      for (const option of options)
        if (option.methodCode === 'parcel' && option.serviceProfile === 'parcel') option.netCents = 0
  }

  // Rates are stored net. Tax is rounded once from the final net amount and
  // gross is derived from the two contractual components.
  for (const option of options) {
    option.taxCents = roundRatio(BigInt(option.netCents) * BigInt(option.taxRateBasisPoints), 10_000n)
    option.grossCents = option.netCents + option.taxCents
  }
  return options
}

function isPeninsularSpanishPostalCode(postalCode: string): boolean {
  const province = Number(postalCode.slice(0, 2))
  if (province < 1 || province > 52) return false
  return !new Set([7, 35, 38, 51, 52]).has(province)
}

export function hashOptions(options: ShippingOption[]): Promise<string> {
  return sha256Hex(canonicalJson(options))
}

/** Per-option acceptance proof: SHA-256 of the canonical option object. */
export async function withOptionHashes(options: ShippingOption[]): Promise<ShippingOptionSnapshot[]> {
  const snapshots: ShippingOptionSnapshot[] = []
  for (const [optionIndex, option] of options.entries()) {
    snapshots.push({
      ...option,
      currency: 'EUR',
      optionHash: await sha256Hex(canonicalJson({ ...option, optionIndex })),
      optionIndex
    })
  }
  return snapshots
}
