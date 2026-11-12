import { z } from 'zod'
/**
 * Checkout acceptance: cart + immutable snapshots -> awaiting_payment order
 * with an atomic inventory reservation, modelled as a persistent saga.
 *
 * Failure windows:
 *   W1 fail before reservation            -> nothing happened; retry is free.
 *   W2 reservation committed, rest failed -> the attempt row persists state
 *      'reserved' plus the reservation id; retry verifies it is still alive and
 *      finishes the SAME order without reserving again.
 *   W3 order created, conclusion failed   -> retry detects the existing order and
 *      completes idempotently; exactly one order can ever exist per cart.
 *   W4 abandoned attempts                 -> compensateStaleAttempts releases
 *      their reservation exactly once and never touches finished orders.
 *
 * Revalidation runs BEFORE any side effect and recomputes every contractual
 * dimension server-side; any drift returns revalidation_required together with
 * fresh acceptable snapshots and zero mutations. The client never supplies
 * money, stock or timing data.
 */

import {
  CartError,
  CartInfrastructureError,
  assertCommandKey,
  canonicalPayloadHash,
  getCart,
  quoteCart,
  type QuoteSnapshot
} from './cart'
import {
  InventoryError,
  releaseReservation,
  reserveInventory,
  sha256Hex,
  sellableExpression,
  type OperationInput,
  type ReserveInput,
  type ReserveResult,
  type SimpleResult,
  type ReservationLineInput
} from './inventory'
import { validateQuantity } from '../../server/domain/money'
import { effectiveB2BVersionIdExpression, inlineEffectivePricingSql } from './pricing'
import { publicationValidityExpression } from './publication-validity'
import { isD1CheckConstraintFailure } from '../runtime/d1-errors'
import { customerTaxIdIsValid, normalizeCustomerTaxId } from '../../shared/customer-tax-validation'
import { normalizeOrderPurchaseOrderReference, readOrderPurchaseOrderReference } from './order-customer-reference'
import {
  assertDestination,
  destinationHash,
  hashOptions,
  resolveShippingOptions,
  withOptionHashes,
  type ShippingDestination,
  type ShippingOptionSnapshot
} from './shipping'
import { activeOrderCustomerId } from './customer-orders'
import type { VerifiedSessionClaims } from './authorization'
import { prepareEmailOutboxEnqueue } from '../communications/email-outbox'
import { readAppliedOrderPromotion, promotionAvailableForOrder, promotionOrderStatements } from './promotion-order'
import { promotionBenefitBlocked } from './checkout-promo-fraud'
import {
  checkoutRedemptionStatements,
  isStoreCreditRedemptionEnabled,
  planCheckoutRedemption,
  type CheckoutCreditPlan
} from '../pricing/checkout-store-credit'
import { freeShippingEvidenceStatement, resolveFreeShippingPolicy } from '../pricing/checkout-free-shipping'
import {
  buildOrderPricingSnapshot,
  orderPricingSnapshotStatement,
  readQuoteAutoDiscountEvidence,
  readShippingFreeEvidence,
  snapshotRequired
} from '../pricing/checkout-evidence'
import { shippingCalendarCurrentPredicate } from './shipping-calendar'
import { calculateCheckoutMarket, calculateMarketLedger, loadCheckoutMarketProfile } from './market-checkout-policy'
import {
  readSalesQuoteCheckoutAuthority,
  readSalesQuoteShippingAuthority,
  salesQuoteCompletionStatements,
  SalesQuoteError,
  type SalesQuoteCheckoutReference
} from './sales-quotes'

export { CartInfrastructureError }

const RESERVATION_TTL_SECONDS = 30 * 60
const SHIPPING_QUOTE_TTL_SECONDS = 30 * 60
const RESERVING_GRACE_SECONDS = 5 * 60

export interface CheckoutInventoryGateway {
  reserve(input: ReserveInput): Promise<ReserveResult>
  release(input: OperationInput): Promise<SimpleResult>
}

function directInventoryGateway(database: D1Database): CheckoutInventoryGateway {
  return {
    release: (input) => releaseReservation(database, input),
    reserve: (input) => reserveInventory(database, input)
  }
}

function plusSeconds(instant: string, seconds: number): string {
  return new Date(Date.parse(instant) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function assertCanonicalInstant(value: string, name: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value))
    throw new CartError('invalid_input', `${name} must be a canonical ISO-8601 UTC instant`)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().replace('.000Z', 'Z') !== value)
    throw new CartError('invalid_input', `${name} must be a real ISO-8601 UTC instant`)
}

interface CommandRow {
  payload_hash: string
  response_status: number
  response_body: string
}

async function findCheckoutCommand(
  database: D1Database,
  cartId: string,
  commandId: string
): Promise<CommandRow | null> {
  return database
    .prepare(
      'SELECT payload_hash, response_status, response_body FROM checkout_commands WHERE cart_id = ?1 AND command_id = ?2'
    )
    .bind(cartId, commandId)
    .first<CommandRow>()
}

function replayOrConflict<T>(command: CommandRow | null, hash: string): T | null {
  if (!command) return null
  if (command.payload_hash !== hash) throw new CartError('conflict', 'Command key reused with a different payload')
  return JSON.parse(command.response_body) as T
}

// ---------------------------------------------------------------------------
// Shipping options snapshot (expirable, immutable)
// ---------------------------------------------------------------------------

export interface ShippingOptionsInput {
  cartId: string
  token: string
  idempotencyKey: string
  expectedVersion: number
  destination: ShippingDestination
  correlationId: string
  now: string
  /** Trusted server policy only; never accepted from the HTTP command body. */
  freeShippingThresholdCents?: number | null
  salesQuote?: SalesQuoteCheckoutReference
  ownerSession?: VerifiedSessionClaims | null
}

export type ShippingOptionsResult =
  | { outcome: 'options'; body: Record<string, unknown> }
  | { outcome: 'conflict'; code: 'conflict' }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_active'; status: string }
  | { outcome: 'empty_cart' }

export async function requestShippingOptions(
  database: D1Database,
  input: ShippingOptionsInput
): Promise<ShippingOptionsResult> {
  assertCommandKey(input.idempotencyKey)
  assertCommandKey(input.correlationId, 'correlationId')
  assertCanonicalInstant(input.now, 'now')
  const destination = assertDestination(input.destination)
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new CartError('invalid_input', 'expectedVersion must be a positive integer')

  const shippingCustomerId = input.ownerSession
    ? await activeOrderCustomerId(database, input.ownerSession, input.now)
    : null
  if (input.ownerSession && !shippingCustomerId)
    throw new CartError('unauthorized', 'Customer session is no longer active')
  const payload = {
    kind: 'shipping-options',
    destination,
    expectedVersion: input.expectedVersion,
    ...(shippingCustomerId ? { customerId: shippingCustomerId } : {}),
    ...(input.salesQuote ? { salesQuote: input.salesQuote } : {})
  }
  const hash = await canonicalPayloadHash(payload)
  // Authentication ALWAYS precedes any replay/cache consultation; a stored
  // answer for the same key+payload is then served even if the cart has since
  // expired or been converted (it is the original contractual response).
  const cartView = await getCart(database, { cartId: input.cartId, token: input.token })
  if (input.salesQuote)
    await readSalesQuoteShippingAuthority(
      database,
      input.ownerSession ?? null,
      input.salesQuote,
      input.cartId,
      destination,
      input.now
    )
  const cart = { id: input.cartId, status: cartView.status as typeof cartView.status, version: cartView.version }
  const cached = await findCheckoutCommand(database, input.cartId, input.idempotencyKey)
  const replayed = replayOrConflict<Record<string, unknown>>(cached, hash)
  if (replayed) return { outcome: 'options', body: replayed }
  if (cart.status !== 'active') return { outcome: 'not_active', status: cart.status }
  if (cart.version !== input.expectedVersion) return { outcome: 'version_conflict', currentVersion: cart.version }

  // PRI-017: active parcel rules govern free shipping (zone, profile, margin); none keeps the legacy threshold.
  const freePolicy = await resolveFreeShippingPolicy(database, {
    cartId: input.cartId,
    postalCode: destination.postalCode,
    now: input.now,
    legacyThresholdCents: input.freeShippingThresholdCents ?? null,
    ownerSession: input.ownerSession,
    hasSalesQuote: Boolean(input.salesQuote)
  })
  const resolved = await resolveShippingOptions(database, {
    cartId: input.cartId,
    destination,
    now: input.now,
    freeShippingThresholdCents: freePolicy ? freePolicy.thresholdGrossCents : input.freeShippingThresholdCents,
    ...(freePolicy ? { allowFreeShipping: freePolicy.allowFree } : {}),
    salesQuote: input.salesQuote,
    ownerSession: input.ownerSession
  })
  if (!resolved.options.length) return { outcome: 'empty_cart' }
  const freeEvidence = freePolicy ? await freePolicy.evidence() : null
  const options = await withOptionHashes(resolved.options)
  const expiresAt = plusSeconds(input.now, SHIPPING_QUOTE_TTL_SECONDS)
  const optionsHash = await hashOptions(resolved.options)
  const shippingQuoteId = crypto.randomUUID()

  const responseBody = {
    destinationHash: resolved.destinationHash,
    expiresAt,
    options,
    shippingQuoteId
  }
  const calendarEligibility = await shippingCalendarCurrentPredicate(
    database,
    options[0]!.eta,
    options[0]!.etaValidUntil
  )
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO shipping_quotes (
             id, cart_id, cart_version, destination_hash, options_json, option_count,
             snapshot_hash, expires_at, correlation_id, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
        )
        .bind(
          shippingQuoteId,
          input.cartId,
          cart.version,
          resolved.destinationHash,
          JSON.stringify(options),
          options.length,
          optionsHash,
          expiresAt,
          input.correlationId,
          input.now
        ),
      database
        .prepare(
          `INSERT INTO checkout_commands (
             cart_id, command_id, kind, payload_hash, response_status, response_body,
             correlation_id, created_at
           ) VALUES (?1, ?2, 'shipping-options', ?3, 200, ?4, ?5, ?6)`
        )
        .bind(input.cartId, input.idempotencyKey, hash, JSON.stringify(responseBody), input.correlationId, input.now),
      ...(freeEvidence ? [freeShippingEvidenceStatement(database, shippingQuoteId, freeEvidence, input.now)] : []),
      // GUARD: both snapshot and ledger row must exist or everything rolls back.
      database
        .prepare(
          `INSERT INTO carts (
             id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at
           ) SELECT 'cart-guard:' || ?1, printf('%.0f', 0), 'guard-impossible', 1,
                    '2026-01-01T00:00:00Z', ?2, ?3, ?3
           WHERE NOT EXISTS (
             SELECT 1 FROM checkout_commands
             WHERE cart_id = ?4 AND command_id = ?5 AND kind = 'shipping-options'
           )
             OR NOT EXISTS (
             SELECT 1 FROM shipping_quotes WHERE id = ?6 AND expires_at = ?7
           )
           OR NOT ${calendarEligibility}
           LIMIT 1`
        )
        .bind(
          input.idempotencyKey,
          input.correlationId,
          input.now,
          input.cartId,
          input.idempotencyKey,
          shippingQuoteId,
          expiresAt
        )
    ])
  } catch (batchError) {
    const raced = await findCheckoutCommand(database, input.cartId, input.idempotencyKey)
    const replayedRace = replayOrConflict<Record<string, unknown>>(raced, hash)
    if (replayedRace) return { outcome: 'options', body: replayedRace }
    throw new CartInfrastructureError(`shipping options batch failed: ${(batchError as Error).message}`)
  }

  const stored = await findCheckoutCommand(database, input.cartId, input.idempotencyKey)
  if (!stored) throw new Error('unreachable: shipping-options command must exist after commit')
  return { outcome: 'options', body: JSON.parse(stored.response_body) as Record<string, unknown> }
}

// ---------------------------------------------------------------------------
// Order placement saga
// ---------------------------------------------------------------------------

export interface AddressInput {
  recipientName: string
  companyName?: string
  taxId?: string
  line1: string
  line2?: string
  instructions?: string
  city: string
  province?: string
  postalCode: string
  countryCode?: string
  phone?: string
  nif?: string
}

export interface PlaceOrderInput {
  cartId: string
  token: string
  idempotencyKey: string
  expectedVersion: number
  quoteId: string
  shippingQuoteId: string
  selectedOptionIndex: number
  selectedOptionHash: string
  /** Optional for legacy raw callers; required by the storefront adapter. */
  expectedTotalGrossCents?: number
  contactEmail: string
  contactName?: string
  contactPhone?: string
  buyerCompanyName?: string
  buyerTaxId?: string
  purchaseOrderReference?: string
  shippingAddress: AddressInput
  billingAddress?: AddressInput
  consentTos: boolean
  consentPrivacy: boolean
  correlationId: string
  now: string
  /** Set only by the Worker after verifying the sealed session cookie. */
  ownerSession?: VerifiedSessionClaims | null
  /** A reference only: immutable D1 approval is the sole price authority. */
  salesQuote?: SalesQuoteCheckoutReference
  paymentMethod?: 'credit'
  /**
   * PRI-018, trusted server callers only (the HTTP adapter never sets it): store credit, in cents, to deduct
   * from the amount to charge. Spent FIFO inside the order transaction; the order total is not changed.
   */
  storeCreditCents?: number
  /** Buyer-visible market profile that must still be current; identity of the market comes from the address. */
  marketCheckout?: MarketCheckoutSelection
}

export interface MarketCheckoutSelection {
  market: string
  version: number
  termsVersion: string
  paymentMethod: 'card' | 'bank_transfer' | 'credit'
}

const marketSelectionSchema = z
  .object({
    market: z.string().regex(/^[A-Z]{2}$/),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    termsVersion: z.string().regex(/^[a-zA-Z0-9_-]{3,100}$/),
    paymentMethod: z.enum(['card', 'bank_transfer', 'credit'])
  })
  .strict()

export type PlaceOrderResult =
  | { outcome: 'order_created'; body: Record<string, unknown> }
  | { outcome: 'conflict'; code: 'conflict' }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_active'; status: string }
  | { outcome: 'empty_cart' }
  | {
      outcome: 'revalidation_required'
      reason: string
      freshQuote?: QuoteSnapshot
      freshShippingOptions?: Record<string, unknown>
    }
  | { outcome: 'out_of_stock'; detail: string }
  | { outcome: 'credit_unavailable' }
  | { outcome: 'credit_limit_exceeded' }

export { assertAddress as assertCheckoutAddress }
function assertAddress(value: AddressInput | undefined, requirePhone: boolean): void {
  if (!value) {
    if (requirePhone) throw new CartError('invalid_input', 'shipping address is required')
    return
  }
  const invalid = (message: string): never => {
    throw new CartError('invalid_input', message)
  }
  if (
    typeof value.recipientName !== 'string' ||
    value.recipientName.trim().length < 2 ||
    value.recipientName.trim().length > 120
  )
    invalid('recipientName is required')
  if (typeof value.line1 !== 'string' || value.line1.trim().length < 3 || value.line1.length > 160)
    invalid('line1 is required')
  if (value.line2 !== undefined && (typeof value.line2 !== 'string' || value.line2.length > 160))
    invalid('line2 must be a string')
  const country = value.countryCode ?? 'ES'
  if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)) invalid('countryCode is invalid')
  if (typeof value.city !== 'string' || !value.city.trim() || value.city.trim().length > 80) invalid('city is required')
  if (typeof value.province !== 'string' || !value.province.trim() || value.province.trim().length > 80)
    invalid('province is required')
  if (country === 'ES') {
    if (typeof value.postalCode !== 'string' || !/^[0-9]{5}$/.test(value.postalCode))
      invalid('postalCode must be five digits')
  } else if (
    typeof value.postalCode !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9 -]{1,10}[A-Za-z0-9]$/.test(value.postalCode)
  )
    invalid('postalCode is invalid')
  if (requirePhone && (typeof value.phone !== 'string' || !/^[0-9 +()-]{6,24}$/.test(value.phone)))
    invalid('phone is required')
  if (
    !requirePhone &&
    value.nif !== undefined &&
    (typeof value.nif !== 'string' || value.nif.length < 6 || value.nif.length > 20)
  )
    invalid('nif is invalid')
  optionalCheckoutText(value.companyName, 2, 160, 'companyName')
  optionalCheckoutText(value.instructions, 1, 500, 'instructions')
  optionalTaxId(value.taxId, 'taxId', country)
  optionalTaxId(value.nif, 'nif', country)
}

function optionalCheckoutText(value: unknown, minimum: number, maximum: number, field: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new CartError('invalid_input', `${field} must be a string`)
  const normalized = value.trim()
  if (!normalized) return null
  if (normalized.length < minimum || normalized.length > maximum)
    throw new CartError('invalid_input', `${field} length is invalid`)
  return normalized
}

function optionalTaxId(value: unknown, field: string, country = 'ES'): string | null {
  const normalized = optionalCheckoutText(value, 6, 20, field)
  if (!normalized) return null
  if (country !== 'ES') {
    // Foreign tax identifiers are only stored as bounded opaque references; no national checksum is claimed.
    if (!/^[A-Za-z0-9][A-Za-z0-9 .-]{4,18}[A-Za-z0-9]$/.test(normalized))
      throw new CartError('invalid_input', `${field} is invalid`)
    return normalized.toUpperCase()
  }
  if (!customerTaxIdIsValid('ES', normalized, { required: true }))
    throw new CartError('invalid_input', `${field} is invalid`)
  return normalizeCustomerTaxId(normalized)
}

interface StoredQuoteLine {
  availableQuantity: number
  backorderAllowed: boolean
  grossCents: number
  name: string
  netCents: number
  priceVersionId: string
  quantity: number
  sku: string
  taxCents: number
  taxRateBasisPoints: number
  unitGrossCents: number
  variantId: string
  discountGrossCents: number
}

async function loadQuoteLines(database: D1Database, quoteId: string): Promise<StoredQuoteLine[]> {
  const { results } = await database
    .prepare(
      `SELECT q.variant_id AS variantId,
              q.quantity,
              q.sku,
              p.name,
              q.unit_gross_cents AS unitGrossCents,
              q.unit_gross_cents*q.quantity-q.gross_cents AS discountGrossCents,
              q.net_cents AS netCents,
              q.tax_cents AS taxCents,
              q.gross_cents AS grossCents,
              q.tax_rate_basis_points AS taxRateBasisPoints,
              q.price_version_id AS priceVersionId,
              q.backorder_allowed AS backorderAllowed,
              COALESCE((
                SELECT TOTAL(${sellableExpression()})
                FROM inventory_balances b WHERE b.variant_id = q.variant_id
              ), 0) AS availableQuantity
       FROM checkout_quote_lines q
       JOIN products p ON p.id = (
         SELECT product_id FROM variants WHERE variants.id = q.variant_id
       )
       WHERE q.quote_id = ?1
       ORDER BY q.line_index`
    )
    .bind(quoteId)
    .all<{
      availableQuantity: number
      backorderAllowed: number
      grossCents: number
      name: string
      netCents: number
      priceVersionId: string
      quantity: number
      sku: string
      taxCents: number
      taxRateBasisPoints: number
      unitGrossCents: number
      variantId: string
      discountGrossCents: number
    }>()
  return results.map((row) => ({
    ...row,
    availableQuantity: Number(row.availableQuantity),
    backorderAllowed: Number(row.backorderAllowed) === 1
  }))
}

async function pickLocation(database: D1Database, variantId: string, quantity: number): Promise<string | null> {
  const row = await database
    .prepare(
      `SELECT b.location_id AS locationId
       FROM inventory_balances b
       JOIN variants v ON v.id = b.variant_id
       WHERE b.variant_id = ?1 AND (v.backorder_allowed = 1 OR ${sellableExpression()} >= ?2) AND EXISTS (
         SELECT 1 FROM inventory_locations l
         WHERE l.id = b.location_id AND l.active = 1
       )
       ORDER BY ${sellableExpression()} DESC, b.location_id
       LIMIT 1`
    )
    .bind(variantId, quantity)
    .first<{ locationId: string }>()
  if (!row) return null
  return row.locationId
}

async function markAttempt(
  database: D1Database,
  attemptId: string,
  state: 'reserved' | 'completed' | 'failed' | 'compensated',
  failureReason: string | null,
  now: string,
  reservationId?: string,
  reservationExpiresAt?: string
) {
  await database
    .prepare(
      `UPDATE checkout_attempts
       SET state = ?2, failure_reason = ?3, reservation_id = COALESCE(?4, reservation_id),
           reservation_expires_at = COALESCE(?5, reservation_expires_at), updated_at = ?6
       WHERE id = ?1`
    )
    .bind(attemptId, state, failureReason, reservationId ?? null, reservationExpiresAt ?? null, now)
    .run()
}

async function compensateAttempt(
  database: D1Database,
  attempt: { id: string; reservation_id: string | null },
  now: string,
  inventory: CheckoutInventoryGateway
) {
  const reservationKey = attempt.reservation_id ?? `${attempt.id}:reserve`
  const reservationExists = await database
    .prepare('SELECT 1 AS ok FROM inventory_reservations WHERE id = ?1')
    .bind(reservationKey)
    .first<{ ok: number }>()
  if (reservationExists) {
    await inventory.release({
      correlationId: `compensate:${attempt.id}`,
      idempotencyKey: reservationKey,
      now,
      reason: 'Checkout attempt compensated'
    })
  }
  await markAttempt(database, attempt.id, 'compensated', 'released after failure window', now)
}

/** Idempotent sweeper: never touches attempts whose order was finalised. */
export async function compensateStaleAttempts(
  database: D1Database,
  input: { at: string },
  inventory: CheckoutInventoryGateway = directInventoryGateway(database)
): Promise<{ compensatedCount: number }> {
  assertCanonicalInstant(input.at, 'at')
  const reservingCutoff = plusSeconds(input.at, -RESERVING_GRACE_SECONDS)
  const stale = (
    await database
      .prepare(
        `SELECT id, reservation_id
         FROM checkout_attempts
         WHERE state IN ('reserving', 'reserved')
           AND order_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM orders WHERE orders.attempt_id = checkout_attempts.id)
           AND (
             (state = 'reserved' AND reservation_expires_at <= ?1)
             OR (
               state = 'reserving' AND (
                 (EXISTS (
                   SELECT 1 FROM inventory_reservations r WHERE r.id = checkout_attempts.id || ':reserve'
                 ) AND reservation_expires_at <= ?1)
                 OR (NOT EXISTS (
                   SELECT 1 FROM inventory_reservations r WHERE r.id = checkout_attempts.id || ':reserve'
                 ) AND updated_at <= ?2)
               )
             )
           )`
      )
      .bind(input.at, reservingCutoff)
      .all<{ id: string; reservation_id: string | null }>()
  ).results
  for (const attempt of stale) await compensateAttempt(database, attempt, input.at, inventory)
  return { compensatedCount: stale.length }
}

async function buildOrderView(database: D1Database, orderId: string) {
  const header = await database
    .prepare(
      `SELECT id, status, currency, total_net_cents AS totalNetCents,
              total_tax_cents AS totalTaxCents, total_gross_cents AS totalGrossCents,
              shipping_net_cents AS shippingNetCents, shipping_tax_cents AS shippingTaxCents,
              shipping_gross_cents AS shippingGrossCents, shipping_method_code AS shippingMethodCode,
              shipping_eta_min_days AS etaMinDays, shipping_eta_max_days AS etaMaxDays,
              reservation_expires_at AS reservationExpiresAt, created_at AS createdAt
       FROM orders WHERE id = ?1`
    )
    .bind(orderId)
    .first<Record<string, unknown>>()
  if (!header) return null
  const lines = (
    await database
      .prepare(
        `SELECT line_index AS lineIndex, variant_id AS variantId, sku, name, quantity,
                unit_gross_cents AS unitGrossCents, net_cents AS netCents, tax_cents AS taxCents,
                gross_cents AS grossCents, tax_rate_basis_points AS taxRateBasisPoints
         FROM order_lines WHERE order_id = ?1 ORDER BY line_index`
      )
      .bind(orderId)
      .all()
  ).results
  return { ...header, lines }
}

/** W3 recovery helper: store the reconstructed answer if the row never got it. */
function addressInsert(
  database: D1Database,
  orderId: string,
  table: 'order_shipping_address' | 'order_billing_address',
  address: AddressInput,
  now: string
) {
  const isShipping = table === 'order_shipping_address'
  const country = address.countryCode ?? 'ES'
  const common = [
    orderId,
    address.recipientName.trim(),
    address.line1,
    address.line2 ?? null,
    address.city.trim(),
    address.province ?? null,
    address.postalCode,
    country
  ]
  if (isShipping)
    return database
      .prepare(
        `INSERT INTO order_shipping_address (
           order_id, recipient_name, line1, line2, city, province, postal_code, country_code,
           phone, company_name, tax_id, instructions, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
      )
      .bind(
        ...common,
        address.phone ?? null,
        optionalCheckoutText(address.companyName, 2, 160, 'companyName'),
        optionalTaxId(address.taxId, 'taxId', country),
        optionalCheckoutText(address.instructions, 1, 500, 'instructions'),
        now
      )
  return database
    .prepare(
      `INSERT INTO order_billing_address (
         order_id, recipient_name, line1, line2, city, province, postal_code, country_code,
         nif, company_name, instructions, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
    )
    .bind(
      ...common,
      optionalTaxId(address.nif ?? address.taxId, 'nif', country),
      optionalCheckoutText(address.companyName, 2, 160, 'companyName'),
      optionalCheckoutText(address.instructions, 1, 500, 'instructions'),
      now
    )
}

function normalizeBillingFromShipping(shipping: AddressInput): AddressInput {
  return { ...shipping, phone: undefined }
}

/**
 * El plan de envíos que el cliente aceptó (todo junto o un envío por plazo) queda inmutable
 * con el pedido. Un pedido dividido deja además constancia del consentimiento y del porte
 * extra, que es lo que lee la operativa de envíos parciales (ORD-021).
 */
function shipmentPlanStatements(
  database: D1Database,
  orderId: string,
  selected: ShippingOptionSnapshot,
  now: string,
  customerId: string | null
): D1PreparedStatement[] {
  const shipments = selected.shipments ?? []
  if (!shipments.length) return []
  const mode = selected.shipmentMode ?? 'together'
  const statements = shipments.map((shipment) =>
    database
      .prepare(
        `INSERT INTO order_shipment_plans (
           order_id, shipment_index, mode, lead_days, eta_from, eta_to,
           net_cents, tax_cents, gross_cents, lines_json, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
      )
      .bind(
        orderId,
        shipment.index,
        mode,
        shipment.leadDays,
        shipment.from,
        shipment.to,
        shipment.netCents,
        shipment.taxCents,
        shipment.grossCents,
        JSON.stringify(shipment.lines),
        now
      )
  )
  if (mode === 'split' && shipments.length > 1)
    statements.push(
      database
        .prepare(
          `INSERT INTO order_split_shipment_preferences (
             order_id, customer_accepts_split, accepted_extra_shipping_cents, shipping_cost_payer,
             customer_consent_at, customer_id, version, created_at, updated_at
           ) VALUES (?1, 1, ?2, 'customer', ?3, ?4, 1, ?3, ?3)
           ON CONFLICT(order_id) DO NOTHING`
        )
        .bind(
          orderId,
          shipments.slice(1).reduce((sum, shipment) => sum + shipment.grossCents, 0),
          now,
          customerId
        )
    )
  return statements
}

type RevalidationOutcome = Extract<PlaceOrderResult, { outcome: 'revalidation_required' }>

// Applied to every saved line, including W2 recovery. Snapshots record a past
// contract; they cannot authorize a new sale after governing evidence expires.
const invalidQuotePublication = `EXISTS (SELECT 1 FROM checkout_quote_lines ql
  JOIN variants v ON v.id = ql.variant_id JOIN products p ON p.id = v.product_id
  JOIN categories c ON c.id = p.category_id
  WHERE ql.quote_id = ?3 AND (v.status <> 'published' OR p.status <> 'published'
    OR c.status <> 'published' OR NOT ${publicationValidityExpression('p')}))`

async function quotePublicationsCurrent(database: D1Database, quoteId: string): Promise<boolean> {
  const row = await database
    .prepare(`SELECT NOT ${invalidQuotePublication.replaceAll('?3', '?1')} AS valid`)
    .bind(quoteId)
    .first<{ valid: number }>()
  if (!row) throw new CartInfrastructureError('Unable to validate quote publications')
  return row.valid === 1
}

function revalidate(database: D1Database, input: PlaceOrderInput, reason: string): RevalidationOutcome {
  void database
  return { outcome: 'revalidation_required', reason }
}

function revalidateWith(
  _database: D1Database,
  input: PlaceOrderInput,
  reason: string,
  freshQuote: QuoteSnapshot
): RevalidationOutcome {
  return { freshQuote, outcome: 'revalidation_required', reason }
}

function revalidateShippingOnly(database: D1Database, input: PlaceOrderInput, reason: string): RevalidationOutcome {
  void database
  return { freshShippingOptions: { hint: 'request new shipping options' }, outcome: 'revalidation_required', reason }
}

interface MarketOrder {
  selection: MarketCheckoutSelection
  profile: NonNullable<Awaited<ReturnType<typeof loadCheckoutMarketProfile>>>
  ledger: ReturnType<typeof calculateMarketLedger>
  presentment: ReturnType<typeof calculateCheckoutMarket>
  view: Record<string, unknown>
}

/**
 * Reads the live market profile (never client prices) and the catalog's activation of the market.
 * Stale versions or terms ask the buyer to revalidate; unsupported markets or methods are invalid input.
 */
async function resolveMarketOrder(
  database: D1Database,
  selection: MarketCheckoutSelection,
  lines: Array<{ netCents: number }>
): Promise<{ outcome: 'ok'; order: MarketOrder } | { outcome: 'revalidate'; reason: string }> {
  const [profile, catalog] = await Promise.all([
    loadCheckoutMarketProfile(database, selection.market),
    database
      .prepare('SELECT 1 AS active FROM catalog_markets WHERE code = ?1 AND is_active = 1')
      .bind(selection.market)
      .first<{ active: number }>()
      .catch(() => null)
  ])
  if (!profile || !catalog) throw new CartError('invalid_input', 'market is not available for checkout')
  if (!profile.paymentMethods.includes(selection.paymentMethod))
    throw new CartError('invalid_input', 'payment method is not available in this market')
  if (profile.version !== selection.version) return { outcome: 'revalidate', reason: 'market_changed' }
  if (profile.termsVersion !== selection.termsVersion) return { outcome: 'revalidate', reason: 'terms_changed' }
  const goodsNet = lines.reduce((sum, line) => sum + line.netCents, 0)
  const ledger = calculateMarketLedger(profile, goodsNet)
  const presentment = calculateCheckoutMarket(profile, goodsNet)
  return {
    outcome: 'ok',
    order: {
      selection,
      profile,
      ledger,
      presentment,
      view: {
        market: profile.market,
        currency: profile.currency,
        version: profile.version,
        termsVersion: profile.termsVersion,
        paymentMethod: selection.paymentMethod,
        exchangeNumerator: profile.exchangeNumerator,
        exchangeDenominator: profile.exchangeDenominator,
        goodsNetMinor: presentment.goodsNetMinor,
        goodsTaxMinor: presentment.goodsTaxMinor,
        shippingNetMinor: presentment.shippingNetMinor,
        shippingTaxMinor: presentment.shippingTaxMinor,
        totalMinor: presentment.totalMinor
      }
    }
  }
}

function marketSnapshotInsert(database: D1Database, orderId: string, order: MarketOrder, now: string) {
  const v = order.view
  return database
    .prepare(
      `INSERT INTO order_market_snapshots (
         order_id, market, market_version, currency, exchange_numerator, exchange_denominator, terms_version, payment_method,
         ledger_goods_net_cents, ledger_goods_tax_cents, ledger_shipping_net_cents, ledger_shipping_tax_cents,
         goods_net_minor, goods_tax_minor, shipping_net_minor, shipping_tax_minor, total_minor, created_at
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)`
    )
    .bind(
      orderId,
      v.market,
      v.version,
      v.currency,
      v.exchangeNumerator,
      v.exchangeDenominator,
      v.termsVersion,
      v.paymentMethod,
      order.ledger.goodsNetMinor,
      order.ledger.goodsTaxMinor,
      order.ledger.shippingNetMinor,
      order.ledger.shippingTaxMinor,
      v.goodsNetMinor,
      v.goodsTaxMinor,
      v.shippingNetMinor,
      v.shippingTaxMinor,
      v.totalMinor,
      now
    )
}

// ---------------------------------------------------------------------------
// Public saga entry point
// ---------------------------------------------------------------------------

export async function placeOrder(
  database: D1Database,
  input: PlaceOrderInput,
  inventory: CheckoutInventoryGateway = directInventoryGateway(database),
  freeShippingThresholdCents: number | null = null,
  /** SEC-036: trusted Worker secret. When present, an applied coupon is assessed (fail closed) before ordering. */
  options: {
    promoFraudPepper?: string
    storeCreditRedemptionEnabled?: boolean
    STORE_CREDIT_REDEMPTION_ENABLED?: string
  } = {}
): Promise<PlaceOrderResult> {
  assertCommandKey(input.idempotencyKey)
  assertCommandKey(input.correlationId, 'correlationId')
  assertCanonicalInstant(input.now, 'now')
  assertAddress(input.shippingAddress, true)
  const billingAddress = input.billingAddress ?? normalizeBillingFromShipping(input.shippingAddress)
  assertAddress(billingAddress, false)
  const contactEmail = input.contactEmail.trim().toLowerCase()
  if (contactEmail.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail))
    throw new CartError('invalid_input', 'contactEmail is required')
  const contactName = optionalCheckoutText(input.contactName, 2, 120, 'contactName')
  const contactPhone = optionalCheckoutText(input.contactPhone, 6, 24, 'contactPhone')
  if (contactPhone && !/^[0-9 +()-]{6,24}$/.test(contactPhone))
    throw new CartError('invalid_input', 'contactPhone is invalid')
  const buyerCompanyName = optionalCheckoutText(input.buyerCompanyName, 2, 160, 'buyerCompanyName')
  const destinationCountry = input.shippingAddress.countryCode ?? 'ES'
  const buyerTaxId = optionalTaxId(input.buyerTaxId, 'buyerTaxId', destinationCountry)
  const marketParsed = input.marketCheckout === undefined ? null : marketSelectionSchema.safeParse(input.marketCheckout)
  if (marketParsed && !marketParsed.success) throw new CartError('invalid_input', 'marketCheckout is invalid')
  const marketSelection = marketParsed?.success ? marketParsed.data : null
  if (destinationCountry !== 'ES' && !marketSelection)
    throw new CartError('invalid_input', 'marketCheckout is required for this destination')
  if (marketSelection && marketSelection.market !== destinationCountry)
    throw new CartError('invalid_input', 'marketCheckout does not match the destination country')
  const purchaseOrderReference = normalizeOrderPurchaseOrderReference(input.purchaseOrderReference)
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new CartError('invalid_input', 'expectedVersion must be a positive integer')
  if (input.consentTos !== true || input.consentPrivacy !== true)
    throw new CartError('invalid_input', 'tos and privacy consents are mandatory')
  if (!Number.isSafeInteger(input.selectedOptionIndex) || input.selectedOptionIndex < 0)
    throw new CartError('invalid_input', 'selectedOptionIndex is invalid')
  if (typeof input.selectedOptionHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.selectedOptionHash))
    throw new CartError('invalid_input', 'selectedOptionHash is invalid')
  if (
    input.expectedTotalGrossCents !== undefined &&
    (!Number.isSafeInteger(input.expectedTotalGrossCents) || input.expectedTotalGrossCents < 0)
  )
    throw new CartError('invalid_input', 'expectedTotalGrossCents is invalid')

  if (input.paymentMethod !== undefined && input.paymentMethod !== 'credit')
    throw new CartError('invalid_input', 'paymentMethod is invalid')
  const storeCreditCents = isStoreCreditRedemptionEnabled(options) ? input.storeCreditCents : undefined
  if (storeCreditCents !== undefined) {
    if (!Number.isSafeInteger(storeCreditCents) || storeCreditCents < 1)
      throw new CartError('invalid_input', 'storeCreditCents must be a positive integer')
    if (!input.ownerSession) throw new CartError('invalid_input', 'storeCreditCents requires a signed-in customer')
    if (input.paymentMethod === 'credit')
      throw new CartError('invalid_input', 'storeCreditCents cannot be combined with credit terms')
    if (marketSelection) throw new CartError('invalid_input', 'storeCreditCents is not available for market checkout')
  }
  const customerId = input.ownerSession ? await activeOrderCustomerId(database, input.ownerSession, input.now) : null
  if (input.ownerSession && !customerId) throw new CartError('unauthorized', 'Customer session is no longer active')
  const salesQuote = input.salesQuote
    ? await readSalesQuoteCheckoutAuthority(
        database,
        input.ownerSession ?? null,
        input.salesQuote,
        input.cartId,
        input.quoteId,
        input.now
      )
    : null
  const authorizationStarted = Date.now()
  const releaseOrder = async (result: PlaceOrderResult): Promise<PlaceOrderResult> => {
    const response = await addOrderToken(result, input.token)
    if (input.ownerSession) {
      const instant = new Date(Date.parse(input.now) + Math.max(0, Date.now() - authorizationStarted))
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z')
      if ((await activeOrderCustomerId(database, input.ownerSession, instant)) !== customerId)
        throw new CartError('unauthorized', 'Customer session is no longer active')
    }
    return response
  }

  const payload = {
    billingAddress,
    consentPrivacy: input.consentPrivacy,
    consentTos: input.consentTos,
    contactEmail,
    contactName,
    contactPhone,
    buyerCompanyName,
    buyerTaxId,
    ...(purchaseOrderReference !== null ? { purchaseOrderReference } : {}),
    ...(customerId ? { customerId } : {}),
    ...(input.paymentMethod === 'credit' ? { paymentMethod: 'credit' } : {}),
    ...(storeCreditCents !== undefined ? { storeCreditCents } : {}),
    ...(marketSelection ? { marketCheckout: marketSelection } : {}),
    ...(input.salesQuote ? { salesQuote: input.salesQuote } : {}),
    expectedVersion: input.expectedVersion,
    quoteId: input.quoteId,
    selectedOptionHash: input.selectedOptionHash,
    selectedOptionIndex: input.selectedOptionIndex,
    expectedTotalGrossCents: input.expectedTotalGrossCents,
    shippingAddress: input.shippingAddress,
    shippingQuoteId: input.shippingQuoteId
  }
  const hash = await canonicalPayloadHash(payload)
  const cartView = await getCart(database, { cartId: input.cartId, token: input.token })
  const cached = await findCheckoutCommand(database, input.cartId, input.idempotencyKey)
  const cachedReplay = replayOrConflict<PlaceOrderResult>(cached, hash)
  if (cachedReplay) return releaseOrder(cachedReplay)

  type Attempt = {
    correlation_id: string
    created_at: string
    id: string
    order_id: string | null
    payload_hash: string
    reservation_expires_at: string | null
    reservation_id: string | null
    reservation_lines_json: string | null
    state: string
  }
  let attempt = await database
    .prepare(
      `SELECT id, state, reservation_id, reservation_expires_at, reservation_lines_json,
              order_id, payload_hash, correlation_id, created_at
       FROM checkout_attempts WHERE cart_id = ?1 AND command_key = ?2`
    )
    .bind(input.cartId, input.idempotencyKey)
    .first<Attempt>()
  if (attempt && attempt.payload_hash !== hash)
    throw new CartError('conflict', 'Command key reused with a different checkout payload')
  if (attempt?.state === 'completed' && attempt.order_id) {
    const view = await buildOrderView(database, attempt.order_id)
    if (!view) throw new CartInfrastructureError('completed checkout has no order')
    return releaseOrder({ outcome: 'order_created', body: view })
  }
  if (attempt?.state === 'failed' || attempt?.state === 'compensated')
    return { detail: attempt.state, outcome: 'out_of_stock' }
  if (cartView.status !== 'active') return { outcome: 'not_active', status: cartView.status }
  if (cartView.version !== input.expectedVersion)
    return { outcome: 'version_conflict', currentVersion: cartView.version }

  const creditTerms =
    input.paymentMethod === 'credit' && customerId
      ? await database
          .prepare(
            `SELECT c.id companyId,t.payment_days paymentDays,t.version
        FROM companies c JOIN customers customer ON customer.id=c.customer_id
        JOIN b2b_credit_terms t ON t.company_id=c.id
        WHERE c.customer_id=?1 AND c.status='approved' AND customer.status='active'
          AND t.blocked=0 AND t.payment_days IN(15,30,60)`
          )
          .bind(customerId)
          .first<{ companyId: string; paymentDays: number; version: number }>()
      : null
  if (input.paymentMethod === 'credit' && !creditTerms) return { outcome: 'credit_unavailable' }

  const quoteRow = await database
    .prepare('SELECT cart_id, cart_version, expires_at FROM checkout_quotes WHERE id = ?1')
    .bind(input.quoteId)
    .first<{ cart_id: string; cart_version: number; expires_at: string | null }>()
  if (!quoteRow || quoteRow.cart_id !== input.cartId) throw new CartError('not_found', 'Quote not found for this cart')
  const shippingRow = await database
    .prepare(
      `SELECT cart_id, cart_version, destination_hash, options_json, expires_at
       FROM shipping_quotes WHERE id = ?1`
    )
    .bind(input.shippingQuoteId)
    .first<{
      cart_id: string
      cart_version: number
      destination_hash: string
      options_json: string
      expires_at: string
    }>()
  if (!shippingRow || shippingRow.cart_id !== input.cartId)
    throw new CartError('not_found', 'Shipping snapshot not found for this cart')
  const storedOptions = JSON.parse(shippingRow.options_json) as ShippingOptionSnapshot[]
  const selected = storedOptions.find((option) => option.optionIndex === input.selectedOptionIndex)
  if (!selected || selected.optionHash !== input.selectedOptionHash)
    return revalidate(database, input, 'selected_option_missing')
  const storedQuoteLines = await loadQuoteLines(database, input.quoteId)
  if (!storedQuoteLines.length) return { outcome: 'empty_cart' }
  if (
    salesQuote &&
    (salesQuote.lines.length !== storedQuoteLines.length ||
      salesQuote.lines.some(
        (line) =>
          !storedQuoteLines.some(
            (stored) =>
              stored.variantId === line.variantId &&
              stored.quantity === line.quantity &&
              stored.unitGrossCents === line.unitGrossCents &&
              stored.priceVersionId === line.priceVersionId &&
              stored.taxRateBasisPoints === line.taxRateBasisPoints &&
              stored.netCents === line.amounts.netCents &&
              stored.taxCents === line.amounts.taxCents &&
              stored.grossCents === line.amounts.grossCents &&
              stored.discountGrossCents === 0
          )
      ) ||
      salesQuote.definition.shippingMethod !== selected.methodCode ||
      salesQuote.shipping?.grossCents !== selected.grossCents ||
      salesQuote.shipping?.netCents !== selected.netCents ||
      salesQuote.shipping?.taxCents !== selected.taxCents)
  )
    throw new SalesQuoteError('quote_changed')
  // Redsys cannot charge a zero-value order. Do not consume stock or a coupon
  // while a separate, explicitly no-payment completion flow is unavailable.
  if (storedQuoteLines.reduce((sum, line) => sum + line.grossCents, selected.grossCents) <= 0) {
    if (attempt) await compensateAttempt(database, attempt, input.now, inventory)
    return { outcome: 'revalidation_required', reason: 'payment_total_non_positive' }
  }
  if (
    storeCreditCents !== undefined &&
    storeCreditCents >= storedQuoteLines.reduce((sum, line) => sum + line.grossCents, selected.grossCents)
  )
    throw new CartError('invalid_input', 'storeCreditCents must leave an amount to charge')
  // Precedence: a quote carries either a coupon (checkout_quote_promotions) or automatic discounts
  // (checkout_quote_auto_discounts), never both (0155 triggers). Evidence is immutable per quote.
  const lineDiscountTotal = storedQuoteLines.reduce((sum, line) => sum + line.discountGrossCents, 0)
  const autoDiscounts = lineDiscountTotal > 0 ? await readQuoteAutoDiscountEvidence(database, input.quoteId) : null
  if (autoDiscounts && autoDiscounts.discountGrossCents !== lineDiscountTotal)
    throw new CartInfrastructureError('unconfirmed_quote_auto_discounts')
  const appliedPromotion =
    lineDiscountTotal > 0 && !autoDiscounts ? await readAppliedOrderPromotion(database, input.quoteId) : null
  const lineDiscountColumn = Boolean(appliedPromotion || autoDiscounts)
  if (appliedPromotion && !(await promotionAvailableForOrder(database, appliedPromotion, customerId, input.now))) {
    if (attempt) await compensateAttempt(database, attempt, input.now, inventory)
    return revalidate(database, input, 'promotion_changed')
  }
  if (appliedPromotion && customerId && input.ownerSession && 'promoFraudPepper' in options) {
    let withheld: boolean
    try {
      if (typeof options.promoFraudPepper !== 'string' || options.promoFraudPepper.length < 32)
        throw new CartInfrastructureError('promo fraud gate is not configured')
      withheld = await promotionBenefitBlocked(database, {
        customerId,
        identityId: input.ownerSession.identityId,
        couponCode: appliedPromotion.rule.code,
        shippingAddress: input.shippingAddress,
        pepper: options.promoFraudPepper,
        now: input.now
      })
    } catch (error) {
      if (attempt) await compensateAttempt(database, attempt, input.now, inventory)
      throw error
    }
    if (withheld) {
      if (attempt) await compensateAttempt(database, attempt, input.now, inventory)
      return revalidate(database, input, 'promotion_changed')
    }
  }
  if (!(await quotePublicationsCurrent(database, input.quoteId))) {
    if (attempt) await compensateAttempt(database, attempt, input.now, inventory)
    return revalidate(database, input, 'publication_changed')
  }

  let marketOrder: MarketOrder | null = null
  if (marketSelection) {
    const resolved = await resolveMarketOrder(database, marketSelection, storedQuoteLines)
    if (resolved.outcome === 'revalidate') {
      if (attempt) await compensateAttempt(database, attempt, input.now, inventory)
      return revalidate(database, input, resolved.reason)
    }
    marketOrder = resolved.order
  }
  const ledgerShipping = marketOrder
    ? {
        netCents: marketOrder.ledger.shippingNetMinor,
        taxCents: marketOrder.ledger.shippingTaxMinor,
        grossCents: marketOrder.ledger.shippingNetMinor + marketOrder.ledger.shippingTaxMinor
      }
    : selected

  let reservationLines: ReservationLineInput[]
  let reservationExpiresAt: string
  if (!attempt) {
    if (
      !quoteRow.expires_at ||
      quoteRow.expires_at <= input.now ||
      quoteRow.cart_version !== input.expectedVersion ||
      shippingRow.expires_at <= input.now ||
      shippingRow.cart_version !== input.expectedVersion
    )
      return revalidate(database, input, 'snapshot_or_version_changed')

    const liveQuote = await quoteCart(database, {
      cartId: input.cartId,
      correlationId: input.correlationId,
      expectedVersion: input.expectedVersion,
      idempotencyKey: `revalidate:${await sha256Hex(`${input.idempotencyKey}:${input.now}`)}`,
      now: input.now,
      token: input.token,
      ownerSession: input.ownerSession,
      ...(appliedPromotion ? { couponCode: appliedPromotion.rule.code } : {})
    })
    if (liveQuote.outcome === 'empty_cart') return { outcome: 'empty_cart' }
    if (liveQuote.outcome !== 'quoted') return revalidate(database, input, 'cart_state_changed')
    if (liveQuote.quote.lines.length !== storedQuoteLines.length)
      return revalidateWith(database, input, 'line_count_changed', liveQuote.quote)
    for (const stored of storedQuoteLines) {
      const live = liveQuote.quote.lines.find((entry) => entry.variantId === stored.variantId)
      if (!live) return revalidateWith(database, input, 'line_removed', liveQuote.quote)
      if (
        live.quantity !== stored.quantity ||
        live.taxRateBasisPoints !== stored.taxRateBasisPoints ||
        (!salesQuote &&
          (live.unitGrossCents !== stored.unitGrossCents ||
            live.priceVersionId !== stored.priceVersionId ||
            live.netCents !== stored.netCents ||
            live.taxCents !== stored.taxCents ||
            live.grossCents !== stored.grossCents)) ||
        (live.discountGrossCents ?? 0) !== stored.discountGrossCents
      )
        return revalidateWith(database, input, 'pricing_or_quantity_changed', liveQuote.quote)
      if (live.availableQuantity < stored.quantity && !live.backorderAllowed)
        return revalidateWith(database, input, 'insufficient_availability', liveQuote.quote)
      const rules = await database
        .prepare(
          'SELECT minimum_quantity AS m, maximum_quantity AS mx, quantity_increment AS inc FROM variants WHERE id = ?1'
        )
        .bind(stored.variantId)
        .first<{ inc: number; m: number; mx: number | null }>()
      if (!rules) return revalidateWith(database, input, 'variant_removed', liveQuote.quote)
      try {
        validateQuantity(stored.quantity, {
          maximumQuantity: rules.mx,
          minimumQuantity: rules.m,
          quantityIncrement: rules.inc
        })
      } catch {
        return revalidateWith(database, input, 'quantity_rule_violation', liveQuote.quote)
      }
    }

    const freshDestination = { city: input.shippingAddress.city, postalCode: input.shippingAddress.postalCode }
    const freshPolicy = await resolveFreeShippingPolicy(database, {
      cartId: input.cartId,
      postalCode: freshDestination.postalCode,
      now: input.now,
      legacyThresholdCents: freeShippingThresholdCents,
      ownerSession: input.ownerSession,
      hasSalesQuote: Boolean(input.salesQuote)
    })
    const freshShipping = await resolveShippingOptions(database, {
      cartId: input.cartId,
      destination: freshDestination,
      now: input.now,
      freeShippingThresholdCents: freshPolicy ? freshPolicy.thresholdGrossCents : freeShippingThresholdCents,
      ...(freshPolicy ? { allowFreeShipping: freshPolicy.allowFree } : {}),
      salesQuote: input.salesQuote,
      ownerSession: input.ownerSession
    })
    const freshOptions = await withOptionHashes(freshShipping.options)
    if (
      freshShipping.destinationHash !== shippingRow.destination_hash ||
      (await destinationHash(freshDestination)) !== shippingRow.destination_hash ||
      !freshOptions.some((option) => option.optionHash === selected.optionHash)
    )
      return revalidateShippingOnly(database, input, 'shipping_option_changed')
    if (
      input.expectedTotalGrossCents !== undefined &&
      (marketOrder
        ? marketOrder.presentment.totalMinor !== input.expectedTotalGrossCents
        : (salesQuote
            ? storedQuoteLines.reduce((sum, line) => sum + line.grossCents, 0)
            : liveQuote.quote.totals.grossCents) +
            selected.grossCents !==
          input.expectedTotalGrossCents)
    )
      return revalidateWith(database, input, 'display_total_changed', liveQuote.quote)

    reservationLines = []
    for (const stored of storedQuoteLines) {
      const locationId = await pickLocation(database, stored.variantId, stored.quantity)
      if (!locationId) return { outcome: 'out_of_stock', detail: 'no single location covers one line' }
      reservationLines.push({ locationId, quantity: stored.quantity, variantId: stored.variantId })
    }
    const attemptId = crypto.randomUUID()
    reservationExpiresAt = plusSeconds(input.now, RESERVATION_TTL_SECONDS)
    const attemptInsert = database
      .prepare(
        `INSERT INTO checkout_attempts (
           id, cart_id, command_key, state, reservation_expires_at, reservation_lines_json,
           correlation_id, payload_hash, created_at, updated_at
         ) VALUES (?1, ?2, ?3, 'reserving', ?4, ?5, ?6, ?7, ?8, ?8)`
      )
      .bind(
        attemptId,
        input.cartId,
        input.idempotencyKey,
        reservationExpiresAt,
        JSON.stringify(reservationLines),
        input.correlationId,
        hash,
        input.now
      )
    if (creditTerms && customerId) {
      const amount = storedQuoteLines.reduce((sum, line) => sum + line.grossCents, selected.grossCents)
      if (!Number.isSafeInteger(amount) || amount < 1) throw new CartError('invalid_input', 'Invalid credit amount')
      try {
        await database.batch([
          attemptInsert,
          database
            .prepare(
              `INSERT INTO b2b_credit_reservations
             (attempt_id,company_id,customer_id,amount_cents,payment_days,terms_version,created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)`
            )
            .bind(
              attemptId,
              creditTerms.companyId,
              customerId,
              amount,
              creditTerms.paymentDays,
              creditTerms.version,
              input.now
            )
        ])
      } catch (error) {
        if (error instanceof Error && error.message.includes('b2b_credit_limit_exceeded'))
          return { outcome: 'credit_limit_exceeded' }
        if (error instanceof Error && error.message.includes('b2b_credit_unavailable'))
          return { outcome: 'credit_unavailable' }
        throw error
      }
    } else {
      await attemptInsert.run()
    }

    attempt = {
      id: attemptId,
      correlation_id: input.correlationId,
      created_at: input.now,
      order_id: null,
      payload_hash: hash,
      reservation_expires_at: reservationExpiresAt,
      reservation_id: null,
      reservation_lines_json: JSON.stringify(reservationLines),
      state: 'reserving'
    }
  } else {
    // W2 can outlive a campaign revision, price or session. Recover the SAME
    // intent only while its full discounted economic contract is still valid.
    if (appliedPromotion) {
      const fresh = await quoteCart(database, {
        cartId: input.cartId,
        token: input.token,
        expectedVersion: input.expectedVersion,
        idempotencyKey: `revalidate-promotion:${crypto.randomUUID()}`,
        correlationId: input.correlationId,
        now: input.now,
        couponCode: appliedPromotion.rule.code,
        ownerSession: input.ownerSession
      })
      if (
        fresh.outcome !== 'quoted' ||
        !fresh.quote.promotion?.applied ||
        fresh.quote.lines.length !== storedQuoteLines.length ||
        storedQuoteLines.some(
          (line) =>
            !fresh.quote.lines.some(
              (live) =>
                live.variantId === line.variantId &&
                live.quantity === line.quantity &&
                live.priceVersionId === line.priceVersionId &&
                live.unitGrossCents === line.unitGrossCents &&
                live.netCents === line.netCents &&
                live.taxCents === line.taxCents &&
                live.grossCents === line.grossCents &&
                (live.discountGrossCents ?? 0) === line.discountGrossCents
            )
        )
      ) {
        await compensateAttempt(database, attempt, input.now, inventory)
        return revalidate(database, input, 'promotion_changed')
      }
    }
    if (autoDiscounts) {
      const fresh = await quoteCart(database, {
        cartId: input.cartId,
        token: input.token,
        expectedVersion: input.expectedVersion,
        idempotencyKey: `revalidate-pricing:${crypto.randomUUID()}`,
        correlationId: input.correlationId,
        now: input.now,
        ownerSession: input.ownerSession
      })
      if (
        fresh.outcome !== 'quoted' ||
        fresh.quote.lines.length !== storedQuoteLines.length ||
        storedQuoteLines.some(
          (line) =>
            !fresh.quote.lines.some(
              (live) =>
                live.variantId === line.variantId &&
                live.quantity === line.quantity &&
                live.priceVersionId === line.priceVersionId &&
                live.unitGrossCents === line.unitGrossCents &&
                live.netCents === line.netCents &&
                live.taxCents === line.taxCents &&
                live.grossCents === line.grossCents &&
                (live.discountGrossCents ?? 0) === line.discountGrossCents
            )
        )
      ) {
        await compensateAttempt(database, attempt, input.now, inventory)
        return revalidate(database, input, 'pricing_changed')
      }
    }
    if (!attempt.reservation_expires_at || !attempt.reservation_lines_json)
      throw new CartInfrastructureError('checkout attempt is missing its reservation plan')
    reservationExpiresAt = attempt.reservation_expires_at
    reservationLines = JSON.parse(attempt.reservation_lines_json) as ReservationLineInput[]
  }

  // PRI-018: plan the credit before any stock is reserved (a recovered saga re-plans against live grants).
  let creditPlan: CheckoutCreditPlan | null = null
  if (storeCreditCents !== undefined) {
    if (!customerId) throw new CartError('unauthorized', 'Customer session is no longer active')
    creditPlan = await planCheckoutRedemption(database, customerId, storeCreditCents, input.now)
    if (!creditPlan) {
      await compensateAttempt(database, attempt, input.now, inventory)
      return revalidate(database, input, 'store_credit_unavailable')
    }
  }

  if (reservationExpiresAt <= input.now) {
    await compensateAttempt(database, attempt, input.now, inventory)
    return { outcome: 'out_of_stock', detail: 'checkout reservation expired' }
  }

  let reservationId = attempt.reservation_id
  if (attempt.state === 'reserving') {
    let reserved: ReserveResult
    try {
      reserved = await inventory.reserve({
        correlationId: attempt.correlation_id,
        expiresAt: reservationExpiresAt,
        idempotencyKey: `${attempt.id}:reserve`,
        lines: reservationLines,
        now: attempt.created_at,
        reason: 'checkout acceptance'
      })
    } catch (error) {
      if (error instanceof InventoryError && error.code === 'insufficient_stock') {
        await markAttempt(database, attempt.id, 'failed', error.message.slice(0, 160), input.now)
        return { outcome: 'out_of_stock', detail: error.message }
      }
      throw new CartInfrastructureError(`inventory reservation failed: ${(error as Error).message}`)
    }
    if (reserved.outcome === 'conflict' || (reserved.outcome === 'replayed' && reserved.status !== 'reserved'))
      throw new CartInfrastructureError('inventory reservation replay is not active')
    reservationId = reserved.reservationId
    await markAttempt(database, attempt.id, 'reserved', null, input.now, reservationId, reservationExpiresAt)
  }
  if (!reservationId) throw new CartInfrastructureError('reserved checkout has no reservation id')
  const activeReservation = await database
    .prepare(
      `SELECT 1 AS ok FROM inventory_reservations
       WHERE id = ?1 AND status = 'reserved' AND expires_at > ?2`
    )
    .bind(reservationId, input.now)
    .first<{ ok: number }>()
  if (!activeReservation) {
    await compensateAttempt(database, { id: attempt.id, reservation_id: reservationId }, input.now, inventory)
    return { outcome: 'out_of_stock', detail: 'checkout reservation is no longer active' }
  }

  const orderId = crypto.randomUUID()
  const orderToken = await deriveOrderToken(input.token, orderId)
  const goodsNet = storedQuoteLines.reduce((sum, line) => sum + line.netCents, 0)
  const goodsTax = storedQuoteLines.reduce((sum, line) => sum + line.taxCents, 0)
  const goodsGross = storedQuoteLines.reduce((sum, line) => sum + line.grossCents, 0)
  // Market orders carry the profile's EUR ledger amounts; the quote's Spanish VAT/carrier fee does not apply.
  const ledgerGoodsTax = marketOrder ? marketOrder.ledger.goodsTaxMinor : goodsTax
  const totalNet = goodsNet + ledgerShipping.netCents
  const totalTax = ledgerGoodsTax + ledgerShipping.taxCents
  const totalGross = marketOrder ? totalNet + totalTax : goodsGross + selected.grossCents
  const orderViewBody: Record<string, unknown> = {
    ...(purchaseOrderReference !== null ? { purchaseOrderReference } : {}),
    createdAt: input.now,
    currency: 'EUR',
    etaMaxDays: selected.etaMaxDays,
    etaMinDays: selected.etaMinDays,
    id: orderId,
    lines: storedQuoteLines.map((stored, index) => ({
      grossCents: stored.grossCents,
      lineIndex: index,
      name: stored.name,
      netCents: stored.netCents,
      quantity: stored.quantity,
      sku: stored.sku,
      taxCents: stored.taxCents,
      taxRateBasisPoints: stored.taxRateBasisPoints,
      unitGrossCents: stored.unitGrossCents,
      variantId: stored.variantId,
      ...(lineDiscountColumn ? { discountGrossCents: stored.discountGrossCents } : {})
    })),
    reservationExpiresAt,
    shippingGrossCents: ledgerShipping.grossCents,
    shippingMethodCode: selected.methodCode,
    ...(selected.shipments?.length
      ? { shipmentMode: selected.shipmentMode ?? 'together', shipments: selected.shipments }
      : {}),
    status: 'awaiting_payment',
    ...(creditTerms
      ? {
          paymentMethod: 'transferencia',
          paymentDays: creditTerms.paymentDays,
          paymentDueAt: plusSeconds(input.now, creditTerms.paymentDays * 86400)
        }
      : {}),
    totalGrossCents: totalGross,
    totalNetCents: totalNet,
    totalTaxCents: totalTax,
    ...(creditPlan
      ? { storeCreditCents: creditPlan.totalCents, amountDueCents: totalGross - creditPlan.totalCents }
      : {}),
    ...(marketOrder ? { market: marketOrder.view } : {})
  }
  const redemption = creditPlan
    ? await checkoutRedemptionStatements(database, {
        plan: creditPlan,
        actorId: input.ownerSession!.identityId,
        orderId,
        attemptId: attempt.id,
        now: input.now
      })
    : null
  const freeShipping = await readShippingFreeEvidence(database, input.shippingQuoteId)
  const pricingFacts = {
    now: input.now,
    quoteId: input.quoteId,
    shippingQuoteId: input.shippingQuoteId,
    coupon: appliedPromotion
      ? {
          ruleId: appliedPromotion.rule.id,
          version: appliedPromotion.rule.version,
          code: appliedPromotion.rule.code,
          ruleHash: appliedPromotion.ruleHash,
          discountGrossCents: appliedPromotion.discountGrossCents
        }
      : null,
    b2bContractLines: storedQuoteLines
      .filter((line) => line.priceVersionId.startsWith('b2b:'))
      .map((line) => ({ variantId: line.variantId, priceVersionId: line.priceVersionId })),
    creditTerms: creditTerms
      ? { companyId: creditTerms.companyId, paymentDays: creditTerms.paymentDays, termsVersion: creditTerms.version }
      : null,
    autoDiscounts,
    freeShipping,
    shipping: {
      methodCode: selected.methodCode,
      rateVersion: selected.rateVersion,
      netCents: ledgerShipping.netCents,
      grossCents: ledgerShipping.grossCents,
      optionHash: selected.optionHash
    },
    storeCredit: creditPlan
      ? {
          totalCents: creditPlan.totalCents,
          commandKey: redemption!.commandKey,
          allocations: creditPlan.allocations,
          accountVersionBefore: creditPlan.accountVersion
        }
      : null,
    goodsGrossCents: goodsGross,
    goodsDiscountGrossCents: lineDiscountTotal,
    orderTotalGrossCents: totalGross
  }
  const pricingSnapshot = snapshotRequired(pricingFacts) ? await buildOrderPricingSnapshot(pricingFacts) : null
  const storedResult: PlaceOrderResult = { body: orderViewBody, outcome: 'order_created' }
  const orderEventId = crypto.randomUUID()
  const emailOutbox = await prepareEmailOutboxEnqueue(database, {
    sourceEventId: orderEventId,
    sourceKind: 'order',
    sourceId: orderId,
    eventType: 'order.created',
    now: input.now
  })
  const calendarEligibility = await shippingCalendarCurrentPredicate(database, selected.eta, selected.etaValidUntil)
  const approvedCompany =
    customerId && !salesQuote
      ? await database
          .prepare("SELECT 1 AS approved FROM companies WHERE customer_id=?1 AND status='approved'")
          .bind(customerId)
          .first()
      : null
  const b2bCurrentVersion =
    customerId && approvedCompany && !salesQuote
      ? inlineEffectivePricingSql(effectiveB2BVersionIdExpression('variant', '?11'), input.now)
      : null
  const creditEligibility = `EXISTS(SELECT 1 FROM b2b_credit_reservations r
    JOIN companies company ON company.id=r.company_id AND company.customer_id=r.customer_id
    JOIN customers customer ON customer.id=company.customer_id
    JOIN b2b_credit_terms terms ON terms.company_id=company.id
    WHERE r.attempt_id=?1 AND company.status='approved' AND customer.status='active'
      AND terms.blocked=0 AND terms.payment_days=r.payment_days AND terms.version=r.terms_version
      AND terms.credit_limit_cents >= COALESCE((SELECT SUM(open.outstanding_cents)
        FROM b2b_credit_open_amounts open WHERE open.company_id=r.company_id AND
        (open.order_id IS NOT NULL OR (open.state IN('reserving','reserved') AND open.reservation_expires_at>?2))),0))`
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO orders (
             id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status,
             reservation_id, reservation_expires_at, currency,
             total_net_cents, total_tax_cents, total_gross_cents,
             shipping_net_cents, shipping_tax_cents, shipping_gross_cents,
             shipping_method_code, shipping_rate_version, shipping_eta_min_days, shipping_eta_max_days,
             contact_email, contact_email_hash, consent_tos, consent_privacy,
             correlation_id, created_at, updated_at, customer_id,
             contact_name, contact_phone, buyer_company_name, buyer_tax_id${purchaseOrderReference !== null ? ', purchase_order_reference' : ''}
           ) SELECT
             ?1, ?2, ?3, ?4, ?5, ?6, 'awaiting_payment', ?7, ?8, 'EUR',
             ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
             ?19, ?20, 1, 1, ?21, ?22, ?22, ?23, ?28, ?29, ?30, ?31${purchaseOrderReference !== null ? ', ?32' : ''}
           WHERE ?23 IS NULL OR EXISTS (
             SELECT 1 FROM auth_sessions s JOIN identities i ON i.id = s.identity_id
             JOIN customers c ON c.id = i.customer_id AND c.status = 'active'
             WHERE s.id = ?24 AND s.identity_id = ?25 AND s.session_version = ?26
               AND i.session_version = s.session_version AND i.status = 'active'
               AND i.email_verified_at IS NOT NULL AND i.email_verified_at <= ?27
               AND s.revoked_at IS NULL AND s.created_at <= ?27 AND s.expires_at > ?27
               AND c.id = ?23
           )`
        )
        .bind(
          orderId,
          input.cartId,
          input.quoteId,
          input.shippingQuoteId,
          attempt.id,
          await sha256Hex(orderToken),
          reservationId,
          reservationExpiresAt,
          totalNet,
          totalTax,
          totalGross,
          ledgerShipping.netCents,
          ledgerShipping.taxCents,
          ledgerShipping.grossCents,
          selected.methodCode,
          selected.rateVersion,
          selected.etaMinDays,
          selected.etaMaxDays,
          contactEmail,
          await sha256Hex(contactEmail),
          input.correlationId,
          input.now,
          customerId,
          input.ownerSession?.sessionId ?? null,
          input.ownerSession?.identityId ?? null,
          input.ownerSession?.sessionVersion ?? null,
          new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          contactName,
          contactPhone,
          buyerCompanyName,
          buyerTaxId,
          ...(purchaseOrderReference !== null ? [purchaseOrderReference] : [])
        ),
      ...storedQuoteLines.map((stored, index) =>
        database
          .prepare(
            `INSERT INTO order_lines (
               order_id, line_index, variant_id, sku, name, quantity,
               unit_gross_cents, net_cents, tax_cents, gross_cents, tax_rate_basis_points,
               price_version_id, location_id, created_at${lineDiscountColumn ? ', discount_gross_cents' : ''}
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14${lineDiscountColumn ? ', ?15' : ''})`
          )
          .bind(
            orderId,
            index,
            stored.variantId,
            stored.sku,
            stored.name,
            stored.quantity,
            stored.unitGrossCents,
            stored.netCents,
            stored.taxCents,
            stored.grossCents,
            stored.taxRateBasisPoints,
            stored.priceVersionId,
            reservationLines[index]!.locationId,
            input.now,
            ...(lineDiscountColumn ? [stored.discountGrossCents] : [])
          )
      ),
      ...(appliedPromotion
        ? promotionOrderStatements(database, { orderId, quoteId: input.quoteId, now: input.now })
        : []),
      ...(pricingSnapshot ? [orderPricingSnapshotStatement(database, orderId, pricingSnapshot, input.now)] : []),
      ...(redemption ? redemption.statements : []),
      addressInsert(database, orderId, 'order_shipping_address', input.shippingAddress, input.now),
      addressInsert(database, orderId, 'order_billing_address', billingAddress, input.now),
      ...shipmentPlanStatements(database, orderId, selected, input.now, customerId),
      ...(marketOrder ? [marketSnapshotInsert(database, orderId, marketOrder, input.now)] : []),
      database
        .prepare(
          `INSERT INTO order_events (id, order_id, event_type, payload_json, correlation_id, created_at)
           VALUES (?1, ?2, 'order.created', ?3, ?4, ?5)`
        )
        .bind(
          orderEventId,
          orderId,
          JSON.stringify({
            attemptId: attempt.id,
            reservationId,
            ...(creditTerms
              ? {
                  paymentMethod: 'transferencia',
                  paymentDays: creditTerms.paymentDays,
                  paymentDueAt: plusSeconds(input.now, creditTerms.paymentDays * 86400)
                }
              : {})
          }),
          input.correlationId,
          input.now
        ),
      emailOutbox.statement,
      database
        .prepare(
          `UPDATE carts SET status = 'converted', converted_quote_id = ?2, converted_at = ?3,
                    version = version + 1, updated_at = ?3
           WHERE id = ?1 AND status = 'active' AND version = ?4`
        )
        .bind(input.cartId, input.quoteId, input.now, input.expectedVersion),
      database
        .prepare(
          `UPDATE checkout_attempts
           SET state = 'completed', order_id = ?2, updated_at = ?3
           WHERE id = ?1 AND state = 'reserved' AND reservation_id = ?4 AND payload_hash = ?5`
        )
        .bind(attempt.id, orderId, input.now, reservationId, hash),
      database
        .prepare(
          `INSERT INTO checkout_commands (
             cart_id, command_id, kind, payload_hash, response_status, response_body,
             correlation_id, created_at
           ) VALUES (?1, ?2, 'checkout', ?3, 200, ?4, ?5, ?6)`
        )
        .bind(input.cartId, input.idempotencyKey, hash, JSON.stringify(storedResult), input.correlationId, input.now),
      ...(input.paymentMethod === 'credit'
        ? [
            database
              .prepare(
                `INSERT INTO carts(id,token_hash,status,version,expires_at,correlation_id,created_at,updated_at)
            SELECT 'credit-guard:'||?1,printf('%.0f',0),'guard-impossible',1,'2026-01-01T00:00:00Z',?1,?2,?2
            WHERE NOT ${creditEligibility} OR NOT EXISTS(
              SELECT 1 FROM orders purchase JOIN b2b_credit_reservations credit ON credit.attempt_id=purchase.attempt_id
              WHERE purchase.id=?3 AND credit.customer_id=purchase.customer_id AND credit.amount_cents=purchase.total_gross_cents
            )`
              )
              .bind(attempt.id, input.now, orderId)
          ]
        : []),
      ...(input.salesQuote
        ? await salesQuoteCompletionStatements(
            database,
            input.ownerSession!,
            input.salesQuote,
            input.cartId,
            input.quoteId,
            orderId,
            input.now
          )
        : []),
      database
        .prepare(
          `INSERT INTO carts (
             id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at
           ) SELECT 'checkout-guard:' || ?1, printf('%.0f', 0), 'guard-impossible', 1,
                    '2026-01-01T00:00:00Z', ?2, ?3, ?3
           WHERE NOT EXISTS (
             SELECT 1 FROM orders o JOIN checkout_attempts a ON a.order_id = o.id
             WHERE o.id = ?4 AND o.attempt_id = ?5 AND a.state = 'completed'
               AND a.reservation_id = ?6 AND a.payload_hash = ?7
           ) OR NOT EXISTS (
             SELECT 1 FROM carts WHERE id = ?8 AND status = 'converted'
               AND converted_quote_id = ?9 AND version = ?10 + 1
           ) OR NOT EXISTS (
             SELECT 1 FROM checkout_commands
             WHERE cart_id = ?8 AND command_id = ?1 AND payload_hash = ?7
           )
           OR ${invalidQuotePublication.replaceAll('?3', '?9')}
           OR NOT ${calendarEligibility}
           ${customerId && !salesQuote ? "OR EXISTS(SELECT 1 FROM companies company WHERE company.customer_id=?11 AND company.status='approved') <> ?12" : ''}
           ${b2bCurrentVersion ? `OR EXISTS (SELECT 1 FROM checkout_quote_lines line JOIN variants variant ON variant.id=line.variant_id WHERE line.quote_id=?9 AND line.price_version_id<>${b2bCurrentVersion})` : ''}
           LIMIT 1`
        )
        .bind(
          input.idempotencyKey,
          input.correlationId,
          input.now,
          orderId,
          attempt.id,
          reservationId,
          hash,
          input.cartId,
          input.quoteId,
          input.expectedVersion,
          ...(customerId && !salesQuote ? [customerId, approvedCompany ? 1 : 0] : [])
        )
    ])
  } catch (error) {
    // Another writer spent, froze or voided the credit after it was planned: the whole order rolled back.
    if (
      creditPlan &&
      error instanceof Error &&
      /pricing_version_conflict|pricing_credit_unusable|pricing_over_redeem|UNIQUE constraint failed: (pricing_commands|store_credit_ledger)|remaining_cents/.test(
        error.message
      )
    ) {
      await compensateAttempt(database, { id: attempt.id, reservation_id: reservationId }, input.now, inventory)
      return revalidate(database, input, 'store_credit_unavailable')
    }
    if (input.paymentMethod === 'credit' && isD1CheckConstraintFailure(error)) {
      const stillValid = await database
        .prepare(`SELECT ${creditEligibility} AS valid`)
        .bind(attempt.id, input.now)
        .first<{ valid: number }>()
      if (!stillValid?.valid) {
        await compensateAttempt(database, { id: attempt.id, reservation_id: reservationId }, input.now, inventory)
        return { outcome: 'credit_unavailable' }
      }
    }
    if (input.salesQuote) {
      try {
        await readSalesQuoteCheckoutAuthority(
          database,
          input.ownerSession ?? null,
          input.salesQuote,
          input.cartId,
          input.quoteId,
          new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
        )
      } catch (authorityError) {
        if (
          authorityError instanceof SalesQuoteError &&
          ['quote_not_approved', 'quote_expired', 'quote_changed', 'unauthenticated', 'not_found'].includes(
            authorityError.code
          )
        ) {
          await compensateAttempt(database, { id: attempt.id, reservation_id: reservationId }, input.now, inventory)
          throw authorityError
        }
      }
    }
    if (marketSelection) {
      const latest = await loadCheckoutMarketProfile(database, marketSelection.market)
      if (
        !latest ||
        latest.version !== marketSelection.version ||
        latest.termsVersion !== marketSelection.termsVersion
      ) {
        await compensateAttempt(database, { id: attempt.id, reservation_id: reservationId }, input.now, inventory)
        return revalidate(database, input, 'market_changed')
      }
    }
    // Only an actual constraint rollback may be classified as evidence drift;
    // infrastructure outages remain 500 and keep the persisted saga recoverable.
    if (
      isD1CheckConstraintFailure(error) &&
      !(await database.prepare(`SELECT ${calendarEligibility} AS valid`).first<{ valid: number }>())?.valid
    ) {
      await compensateAttempt(database, { id: attempt.id, reservation_id: reservationId }, input.now, inventory)
      return revalidateShippingOnly(database, input, 'shipping_option_changed')
    }
    if (isD1CheckConstraintFailure(error) && !(await quotePublicationsCurrent(database, input.quoteId))) {
      await compensateAttempt(database, attempt, input.now, inventory)
      return revalidate(database, input, 'publication_changed')
    }
    if (
      isD1CheckConstraintFailure(error) &&
      appliedPromotion &&
      !(await promotionAvailableForOrder(database, appliedPromotion, customerId, input.now))
    ) {
      await compensateAttempt(database, { id: attempt.id, reservation_id: reservationId }, input.now, inventory)
      return revalidate(database, input, 'promotion_changed')
    }
    throw new CartInfrastructureError(`checkout finalisation failed: ${(error as Error).message}`)
  }
  return releaseOrder(storedResult)
}

export async function deriveOrderToken(cartToken: string, orderId: string): Promise<string> {
  return sha256Hex(`neteco:order-access:v1\u0000${cartToken}\u0000${orderId}`)
}

async function addOrderToken(result: PlaceOrderResult, cartToken: string): Promise<PlaceOrderResult> {
  if (result.outcome !== 'order_created') return result
  const orderId = result.body.id
  if (typeof orderId !== 'string') throw new CartInfrastructureError('order response has no id')
  return {
    outcome: 'order_created',
    body: { ...result.body, orderToken: await deriveOrderToken(cartToken, orderId) }
  }
}

export const ORDER_VIEW_COLUMNS = `id, status, currency, contact_email AS contactEmail,
  contact_name AS contactName, contact_phone AS contactPhone,
  buyer_company_name AS buyerCompanyName, buyer_tax_id AS buyerTaxId,
  total_net_cents AS totalNetCents, total_tax_cents AS totalTaxCents,
  total_gross_cents AS totalGrossCents, shipping_method_code AS shippingMethodCode,
  reservation_expires_at AS reservationExpiresAt, created_at AS createdAt`

/** Internal snapshot loader, not an authorization boundary. The caller must
 * select this exact order header under current D1 authority and recheck that
 * authority after the asynchronous reads before releasing the snapshot. */
export async function loadOrderView(database: D1Database, orderId: string, header: Record<string, unknown>) {
  const lines = (
    await database
      .prepare(
        `SELECT line_index AS lineIndex, variant_id AS variantId, sku, name, quantity,
                unit_gross_cents AS unitGrossCents, net_cents AS netCents, tax_cents AS taxCents,
                gross_cents AS grossCents, tax_rate_basis_points AS taxRateBasisPoints
         FROM order_lines WHERE order_id = ?1 ORDER BY line_index`
      )
      .bind(orderId)
      .all()
  ).results
  const payment = await database
    .prepare(
      `SELECT status, paid_gross_cents AS paidGrossCents, updated_at AS updatedAt
       FROM order_payment_states WHERE order_id = ?1`
    )
    .bind(orderId)
    .first<{ status: string; paidGrossCents: number; updatedAt: string }>()
  const shippingAddress = await database
    .prepare(
      `SELECT recipient_name AS recipientName, company_name AS companyName,
              tax_id AS taxId, line1, line2, city, province, postal_code AS postalCode,
              country_code AS countryCode, phone, instructions
       FROM order_shipping_address WHERE order_id = ?1`
    )
    .bind(orderId)
    .first<Record<string, unknown>>()
  const billingAddress = await database
    .prepare(
      `SELECT recipient_name AS recipientName, company_name AS companyName,
              nif, line1, line2, city, province, postal_code AS postalCode,
              country_code AS countryCode, instructions
       FROM order_billing_address WHERE order_id = ?1`
    )
    .bind(orderId)
    .first<Record<string, unknown>>()
  const purchaseOrderReference = await readOrderPurchaseOrderReference(database, orderId)
  return {
    ...header,
    ...(purchaseOrderReference !== null ? { purchaseOrderReference } : {}),
    lines,
    shippingAddress,
    billingAddress,
    payment: payment ?? { status: 'awaiting_payment', paidGrossCents: 0 }
  }
}

/** Guest bearer access expires after 24 hours and can be revoked at logout. */
export async function getOrderView(database: D1Database, input: { orderId: string; token: string; now: string }) {
  const authorizationStarted = Date.now()
  assertCanonicalInstant(input.now, 'now')
  const tokenHash = await sha256Hex(input.token)
  const cutoff = plusSeconds(input.now, -24 * 60 * 60)
  const headerQuery = database.prepare(
    `SELECT ${ORDER_VIEW_COLUMNS} FROM orders
       WHERE id = ?1 AND token_hash = ?2 AND access_revoked_at IS NULL
         AND created_at <= ?3 AND created_at > ?4`
  )
  const header = await headerQuery.bind(input.orderId, tokenHash, input.now, cutoff).first<Record<string, unknown>>()
  if (!header) return null
  const snapshot = await loadOrderView(database, input.orderId, header)
  const finalNow = new Date(Date.parse(input.now) + Math.max(0, Date.now() - authorizationStarted))
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
  const current = await headerQuery
    .bind(input.orderId, tokenHash, finalNow, plusSeconds(finalNow, -24 * 60 * 60))
    .first<Record<string, unknown>>()
  return current ? snapshot : null
}

/** Account access is independent of a guest token and rechecks ownership and
 * current session state in the same D1 query that selects the order header.
 */
export async function getCustomerOwnedOrderView(
  database: D1Database,
  input: { orderId: string; claims: VerifiedSessionClaims | null; now: string; customerId?: string }
) {
  const authorizationStarted = Date.now()
  assertCanonicalInstant(input.now, 'now')
  const customerId = input.customerId ?? (await activeOrderCustomerId(database, input.claims, input.now))
  if (!customerId || !input.claims) return null
  const headerQuery = database.prepare(
    `SELECT ${ORDER_VIEW_COLUMNS} FROM orders
       WHERE id = ?1 AND customer_id = ?2
         AND EXISTS (
           SELECT 1 FROM auth_sessions s
           JOIN identities i ON i.id = s.identity_id
           JOIN customers c ON c.id = i.customer_id AND c.status = 'active'
           WHERE s.id = ?3 AND s.identity_id = ?4 AND s.session_version = ?5
             AND i.session_version = s.session_version AND i.status = 'active'
             AND i.email_verified_at IS NOT NULL AND i.email_verified_at <= ?6
             AND s.revoked_at IS NULL AND s.created_at <= ?6 AND s.expires_at > ?6
             AND c.id = orders.customer_id
         )`
  )
  const header = await headerQuery
    .bind(
      input.orderId,
      customerId,
      input.claims.sessionId,
      input.claims.identityId,
      input.claims.sessionVersion,
      input.now
    )
    .first<Record<string, unknown>>()
  if (!header) return null
  const snapshot = await loadOrderView(database, input.orderId, header)
  const finalNow = new Date(Date.parse(input.now) + Math.max(0, Date.now() - authorizationStarted))
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
  const current = await headerQuery
    .bind(
      input.orderId,
      customerId,
      input.claims.sessionId,
      input.claims.identityId,
      input.claims.sessionVersion,
      finalNow
    )
    .first<Record<string, unknown>>()
  return current ? snapshot : null
}
