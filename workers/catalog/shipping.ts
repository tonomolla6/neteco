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
  DEFAULT_RESTOCK_LEAD_DAYS,
  groupByLeadDays,
  lineLeadDays,
  type ShipmentMode,
  type ShipmentPlanEntry
} from '../../shared/shipment-plan'
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
  /**
   * `together`: un solo envío con todo, en la fecha del producto más lento. `split`: un envío
   * por plazo, cada uno con su porte. Ausente en instantáneas anteriores al plan de envíos.
   */
  shipmentMode?: ShipmentMode
  shipments?: ShipmentPlanEntry[]
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
  sku?: string
  defaultRestockDays?: number | null
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
    /** PRI-017 margin/profile guard (workers/pricing/free-shipping); absent keeps the legacy threshold rule. */
    allowFreeShipping?: (shippingNetCents: number) => boolean
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
              v.backorder_allowed AS backorderAllowed,v.lead_time_days AS leadTimeDays,
              v.sku AS sku
       FROM cart_lines cl
       LEFT JOIN variants v ON v.id = cl.variant_id
       LEFT JOIN products p ON p.id = v.product_id
       LEFT JOIN shipping_profiles sp ON sp.id = v.shipping_profile_id
       WHERE cl.cart_id = ?1
       ORDER BY cl.variant_id`
    )
    .bind(input.cartId)
    .all<CartWeightRow>()
  if (!lines.results.length) throw new ShippingError('invalid_input', 'Cannot ship an empty cart')
  for (const line of lines.results)
    if (!line.published) throw new ShippingError('variant_not_available', 'Cart contains an unpublished variant')

  if (lines.results.some((line) => line.profileKind === 'adr')) return { destinationHash: hash, options: [] }

  // A checkout created before migration 0156 has no shipment-plan tables. Keep
  // its legacy snapshot shape; a partial migration must never offer a plan that
  // cannot be persisted atomically with the order.
  const { results: fulfillmentTables } = await database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name IN('fulfillment_lead_time_policy','order_shipment_plans')"
    )
    .all<{ name: string }>()
  const shipmentPlansEnabled = fulfillmentTables.length === 2
  if (fulfillmentTables.length !== 0 && !shipmentPlansEnabled) throw new Error('incomplete_fulfillment_schema')

  const { results } = await prepareShippingRatesStatement(database).all<RateRow>()
  let options = mapShippingOptions(lines.results, results, input.destination)
  if (
    threshold !== null &&
    options.some((option) => option.methodCode === 'parcel' && option.serviceProfile === 'parcel')
  ) {
    const goodsGross = approved
      ? approved.goods.grossCents
      : await cartGoodsGrossCents(database, input.cartId, input.now, input.ownerSession)
    options = mapShippingOptions(lines.results, results, input.destination, {
      threshold,
      goodsGross,
      ...(input.allowFreeShipping ? { allowFree: input.allowFreeShipping } : {})
    })
  }
  const calendar = await readD1ShippingCalendarConfiguration(database)
  // Plazo de cada línea: 0 con existencias; si no, su reposición (variante o plazo por defecto).
  // Una variante que no admite pedido sin existencias deja la fecha sin estimar, como antes.
  const needsDefaultRestock = lines.results.some(
    (line) => Number(line.availableQuantity) < line.quantity && line.leadTimeDays == null
  )
  const restockPolicy =
    shipmentPlansEnabled && needsDefaultRestock
      ? await database
          .prepare('SELECT restock_default_days AS days FROM fulfillment_lead_time_policy WHERE id = 1')
          .first<{ days: number }>()
      : null
  const defaultRestockDays = restockPolicy?.days ?? DEFAULT_RESTOCK_LEAD_DAYS
  let leadKnown = true
  const leadByVariant = new Map<string, number>()
  for (const line of lines.results) {
    if (!Number.isFinite(line.availableQuantity) || Number(line.availableQuantity) < 0)
      throw new ShippingError('invalid_input', 'Invalid authoritative stock position')
    if (
      line.leadTimeDays !== null &&
      line.leadTimeDays !== undefined &&
      (!Number.isSafeInteger(line.leadTimeDays) || line.leadTimeDays < 0 || line.leadTimeDays > 365)
    )
      throw new ShippingError('invalid_input', 'Invalid authoritative supplier lead time')
    const available = Number(line.availableQuantity)
    if (
      available < line.quantity &&
      (line.backorderAllowed !== 1 || (!shipmentPlansEnabled && line.leadTimeDays == null))
    )
      leadKnown = false
    leadByVariant.set(
      line.variantId,
      lineLeadDays({
        quantity: line.quantity,
        availableQuantity: available,
        leadTimeDays: line.leadTimeDays,
        defaultRestockDays
      })
    )
  }
  const groups = groupByLeadDays(lines.results, (line) => leadByVariant.get(line.variantId) ?? 0)
  const slowestLeadDays = groups.reduce((slowest, group) => Math.max(slowest, group.leadDays), 0)
  const etaValidUntil = shippingCalendarRevalidationDeadline(calendar, input.now)
  const etaFor = (option: ShippingOption, stockLeadTimeDays: number | null) =>
    calculateShippingCalendarEta(calendar, {
      now: input.now,
      postalCode: input.destination.postalCode,
      methodCode: option.methodCode,
      serviceProfile: option.serviceProfile,
      zoneCode: option.zoneCode,
      transitMinDays: option.etaMinDays,
      transitMaxDays: option.etaMaxDays,
      stockLeadTimeDays
    })
  const planLines = (group: { lines: CartWeightRow[] }) =>
    group.lines.map((line) => ({
      variantId: line.variantId,
      sku: line.sku ?? '',
      quantity: line.quantity
    }))
  if (!shipmentPlansEnabled)
    return {
      destinationHash: hash,
      options: options.map((option) => ({
        ...option,
        etaValidUntil,
        eta: etaFor(option, leadKnown ? slowestLeadDays : null)
      }))
    }
  const together: ShippingOption[] = options.map((option) => {
    const eta = etaFor(option, leadKnown ? slowestLeadDays : null)
    return {
      ...option,
      etaValidUntil,
      eta,
      shipmentMode: 'together' as const,
      shipments: [
        {
          index: 0,
          leadDays: slowestLeadDays,
          from: eta.from,
          to: eta.to,
          netCents: option.netCents,
          taxCents: option.taxCents,
          grossCents: option.grossCents,
          lines: planLines({ lines: lines.results })
        }
      ]
    }
  })
  // Por separado: el porte ya cotizado cubre el primer envío; cada envío adicional paga el
  // suyo, calculado con el peso y el perfil de sus propias líneas. Un presupuesto aprobado
  // fija un único porte, así que no admite dividir.
  const split: ShippingOption[] = []
  if (groups.length > 1 && leadKnown && !approved) {
    for (const option of together) {
      const shipments: ShipmentPlanEntry[] = []
      let consistent = true
      for (const [index, group] of groups.entries()) {
        const eta = etaFor(option, group.leadDays)
        let cost = { netCents: option.netCents, taxCents: option.taxCents, grossCents: option.grossCents }
        if (index > 0) {
          const own = mapShippingOptions(group.lines, results, input.destination).find(
            (candidate) => candidate.methodCode === option.methodCode
          )
          if (!own) {
            consistent = false
            break
          }
          cost = { netCents: own.netCents, taxCents: own.taxCents, grossCents: own.grossCents }
        }
        shipments.push({
          index,
          leadDays: group.leadDays,
          from: eta.from,
          to: eta.to,
          ...cost,
          lines: planLines(group)
        })
      }
      if (!consistent) continue
      const netCents = shipments.reduce((sum, shipment) => sum + shipment.netCents, 0)
      // El IVA del porte se redondea una vez sobre el neto total, como en cualquier otra
      // opción; la diferencia de céntimo con la suma por envío la absorbe el último.
      const taxCents = roundRatio(BigInt(netCents) * BigInt(option.taxRateBasisPoints), 10_000n)
      const last = shipments[shipments.length - 1]!
      const drift = taxCents - shipments.reduce((sum, shipment) => sum + shipment.taxCents, 0)
      if (last.taxCents + drift < 0) continue
      last.taxCents += drift
      last.grossCents = last.netCents + last.taxCents
      split.push({
        ...option,
        netCents,
        taxCents,
        grossCents: netCents + taxCents,
        // La fecha del pedido dividido es la de su último envío.
        eta: etaFor(option, slowestLeadDays),
        shipmentMode: 'split',
        shipments
      })
    }
  }
  options = [...together, ...split]
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
  freeShipping?: { threshold: number; goodsGross: number; allowFree?: (shippingNetCents: number) => boolean }
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
        if (
          option.methodCode === 'parcel' &&
          option.serviceProfile === 'parcel' &&
          (freeShipping.allowFree === undefined || freeShipping.allowFree(option.netCents))
        )
          option.netCents = 0
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
