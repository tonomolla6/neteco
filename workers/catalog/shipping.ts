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
import { canonicalJson, sha256Hex } from './inventory'

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
}

export interface ShippingOptionSnapshot extends ShippingOption {
  optionIndex: number
  currency: Currency
  /** Accepted back at checkout to prove the client saw exactly this snapshot. */
  optionHash: string
}

interface CartWeightRow {
  variantId: string
  quantity: number
  weightGrams: number
  published: number
  profileKind: string
}

interface RateRow {
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
  input: { cartId: string; destination: ShippingDestination; now: string }
): Promise<{ options: ShippingOption[]; destinationHash: string }> {
  const hash = await destinationHash(input.destination)

  const lines = await database
    .prepare(
      `SELECT cl.variant_id AS variantId,
              cl.quantity,
              COALESCE(v.weight_grams, 0) AS weightGrams,
              CASE WHEN v.status = 'published' AND p.status = 'published' THEN 1 ELSE 0 END AS published,
              COALESCE(sp.kind, 'parcel') AS profileKind
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

  const totalWeight = lines.results.reduce((sum, line) => sum + line.weightGrams * line.quantity, 0)
  const profile = lines.results.some((line) => line.profileKind === 'pallet')
    ? 'pallet'
    : profileForTotalWeight(totalWeight)

  const { results } = await database
    .prepare(
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
       ORDER BY r.method_code, r.rate_version`
    )
    .all<RateRow>()

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
          ? input.destination.postalCode.startsWith(configured)
          : isPeninsularSpanishPostalCode(input.destination.postalCode) && configured === 'peninsular'
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

  // Rates are stored net. Tax is rounded once from the net amount and gross is
  // derived from the two contractual components.
  for (const option of options) {
    option.taxCents = roundRatio(BigInt(option.netCents) * BigInt(option.taxRateBasisPoints), 10_000n)
    option.grossCents = option.netCents + option.taxCents
  }
  return { destinationHash: hash, options }
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
