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
import {
  assertDestination,
  destinationHash,
  hashOptions,
  resolveShippingOptions,
  withOptionHashes,
  type ShippingDestination,
  type ShippingOptionSnapshot
} from './shipping'

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

  const payload = { kind: 'shipping-options', destination, expectedVersion: input.expectedVersion }
  const hash = await canonicalPayloadHash(payload)
  // Authentication ALWAYS precedes any replay/cache consultation; a stored
  // answer for the same key+payload is then served even if the cart has since
  // expired or been converted (it is the original contractual response).
  const cartView = await getCart(database, { cartId: input.cartId, token: input.token })
  const cart = { id: input.cartId, status: cartView.status as typeof cartView.status, version: cartView.version }
  const cached = await findCheckoutCommand(database, input.cartId, input.idempotencyKey)
  const replayed = replayOrConflict<Record<string, unknown>>(cached, hash)
  if (replayed) return { outcome: 'options', body: replayed }
  if (cart.status !== 'active') return { outcome: 'not_active', status: cart.status }
  if (cart.version !== input.expectedVersion) return { outcome: 'version_conflict', currentVersion: cart.version }

  const resolved = await resolveShippingOptions(database, {
    cartId: input.cartId,
    destination,
    now: input.now
  })
  if (!resolved.options.length) return { outcome: 'empty_cart' }
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
  line1: string
  line2?: string
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
  contactEmail: string
  shippingAddress: AddressInput
  billingAddress?: AddressInput
  consentTos: boolean
  consentPrivacy: boolean
  correlationId: string
  now: string
}

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
  if (typeof value.city !== 'string' || !value.city.trim() || value.city.trim().length > 80) invalid('city is required')
  if (typeof value.province !== 'string' || !value.province.trim() || value.province.trim().length > 80)
    invalid('province is required')
  if (typeof value.postalCode !== 'string' || !/^[0-9]{5}$/.test(value.postalCode))
    invalid('postalCode must be five digits')
  if ((value.countryCode ?? 'ES') !== 'ES') invalid('countryCode must be ES in this lane')
  if (requirePhone && (typeof value.phone !== 'string' || !/^[0-9 +()-]{6,24}$/.test(value.phone)))
    invalid('phone is required')
  if (
    !requirePhone &&
    value.nif !== undefined &&
    (typeof value.nif !== 'string' || value.nif.length < 6 || value.nif.length > 20)
  )
    invalid('nif is invalid')
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
}

async function loadQuoteLines(database: D1Database, quoteId: string): Promise<StoredQuoteLine[]> {
  const { results } = await database
    .prepare(
      `SELECT q.variant_id AS variantId,
              q.quantity,
              q.sku,
              p.name,
              q.unit_gross_cents AS unitGrossCents,
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
  const columns = isShipping
    ? 'order_id, recipient_name, line1, line2, city, province, postal_code, country_code, phone, created_at'
    : 'order_id, recipient_name, line1, line2, city, province, postal_code, country_code, nif, created_at'
  return database
    .prepare(
      `INSERT INTO ${table} (
         ${columns}
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'ES', ?8, ?9)`
    )
    .bind(
      orderId,
      address.recipientName.trim(),
      address.line1,
      address.line2 ?? null,
      address.city.trim(),
      address.province ?? null,
      address.postalCode,
      isShipping ? (address.phone ?? null) : (address.nif ?? null),
      now
    )
}

function normalizeBillingFromShipping(shipping: AddressInput): AddressInput {
  return { ...shipping, phone: undefined }
}

type RevalidationOutcome = Extract<PlaceOrderResult, { outcome: 'revalidation_required' }>

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

// ---------------------------------------------------------------------------
// Public saga entry point
// ---------------------------------------------------------------------------

export async function placeOrder(
  database: D1Database,
  input: PlaceOrderInput,
  inventory: CheckoutInventoryGateway = directInventoryGateway(database)
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
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new CartError('invalid_input', 'expectedVersion must be a positive integer')
  if (input.consentTos !== true || input.consentPrivacy !== true)
    throw new CartError('invalid_input', 'tos and privacy consents are mandatory')
  if (!Number.isSafeInteger(input.selectedOptionIndex) || input.selectedOptionIndex < 0)
    throw new CartError('invalid_input', 'selectedOptionIndex is invalid')
  if (typeof input.selectedOptionHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.selectedOptionHash))
    throw new CartError('invalid_input', 'selectedOptionHash is invalid')

  const payload = {
    billingAddress,
    consentPrivacy: input.consentPrivacy,
    consentTos: input.consentTos,
    contactEmail,
    expectedVersion: input.expectedVersion,
    quoteId: input.quoteId,
    selectedOptionHash: input.selectedOptionHash,
    selectedOptionIndex: input.selectedOptionIndex,
    shippingAddress: input.shippingAddress,
    shippingQuoteId: input.shippingQuoteId
  }
  const hash = await canonicalPayloadHash(payload)
  const cartView = await getCart(database, { cartId: input.cartId, token: input.token })
  const cached = await findCheckoutCommand(database, input.cartId, input.idempotencyKey)
  const cachedReplay = replayOrConflict<PlaceOrderResult>(cached, hash)
  if (cachedReplay) return addOrderToken(cachedReplay, input.token)

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
    return addOrderToken({ outcome: 'order_created', body: view }, input.token)
  }
  if (attempt?.state === 'failed' || attempt?.state === 'compensated')
    return { detail: attempt.state, outcome: 'out_of_stock' }
  if (cartView.status !== 'active') return { outcome: 'not_active', status: cartView.status }
  if (cartView.version !== input.expectedVersion)
    return { outcome: 'version_conflict', currentVersion: cartView.version }

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
      token: input.token
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
        live.unitGrossCents !== stored.unitGrossCents ||
        live.priceVersionId !== stored.priceVersionId ||
        live.taxRateBasisPoints !== stored.taxRateBasisPoints
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
    const freshShipping = await resolveShippingOptions(database, {
      cartId: input.cartId,
      destination: freshDestination,
      now: input.now
    })
    const freshOptions = await withOptionHashes(freshShipping.options)
    if (
      freshShipping.destinationHash !== shippingRow.destination_hash ||
      (await destinationHash(freshDestination)) !== shippingRow.destination_hash ||
      !freshOptions.some((option) => option.optionHash === selected.optionHash)
    )
      return revalidateShippingOnly(database, input, 'shipping_option_changed')

    reservationLines = []
    for (const stored of storedQuoteLines) {
      const locationId = await pickLocation(database, stored.variantId, stored.quantity)
      if (!locationId) return { outcome: 'out_of_stock', detail: 'no single location covers one line' }
      reservationLines.push({ locationId, quantity: stored.quantity, variantId: stored.variantId })
    }
    const attemptId = crypto.randomUUID()
    reservationExpiresAt = plusSeconds(input.now, RESERVATION_TTL_SECONDS)
    await database
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
      .run()
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
    if (!attempt.reservation_expires_at || !attempt.reservation_lines_json)
      throw new CartInfrastructureError('checkout attempt is missing its reservation plan')
    reservationExpiresAt = attempt.reservation_expires_at
    reservationLines = JSON.parse(attempt.reservation_lines_json) as ReservationLineInput[]
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
  const totalNet = goodsNet + selected.netCents
  const totalTax = goodsTax + selected.taxCents
  const totalGross = goodsGross + selected.grossCents
  const orderViewBody: Record<string, unknown> = {
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
      variantId: stored.variantId
    })),
    reservationExpiresAt,
    shippingGrossCents: selected.grossCents,
    shippingMethodCode: selected.methodCode,
    status: 'awaiting_payment',
    totalGrossCents: totalGross,
    totalNetCents: totalNet,
    totalTaxCents: totalTax
  }
  const storedResult: PlaceOrderResult = { body: orderViewBody, outcome: 'order_created' }
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
             correlation_id, created_at, updated_at
           ) VALUES (
             ?1, ?2, ?3, ?4, ?5, ?6, 'awaiting_payment', ?7, ?8, 'EUR',
             ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
             ?19, ?20, 1, 1, ?21, ?22, ?22
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
          selected.netCents,
          selected.taxCents,
          selected.grossCents,
          selected.methodCode,
          selected.rateVersion,
          selected.etaMinDays,
          selected.etaMaxDays,
          contactEmail,
          await sha256Hex(contactEmail),
          input.correlationId,
          input.now
        ),
      ...storedQuoteLines.map((stored, index) =>
        database
          .prepare(
            `INSERT INTO order_lines (
               order_id, line_index, variant_id, sku, name, quantity,
               unit_gross_cents, net_cents, tax_cents, gross_cents, tax_rate_basis_points,
               price_version_id, location_id, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
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
            input.now
          )
      ),
      addressInsert(database, orderId, 'order_shipping_address', input.shippingAddress, input.now),
      addressInsert(database, orderId, 'order_billing_address', billingAddress, input.now),
      database
        .prepare(
          `INSERT INTO order_events (id, order_id, event_type, payload_json, correlation_id, created_at)
           VALUES (?1, ?2, 'order.created', ?3, ?4, ?5)`
        )
        .bind(
          crypto.randomUUID(),
          orderId,
          JSON.stringify({ attemptId: attempt.id, reservationId }),
          input.correlationId,
          input.now
        ),
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
          input.expectedVersion
        )
    ])
  } catch (error) {
    throw new CartInfrastructureError(`checkout finalisation failed: ${(error as Error).message}`)
  }
  return addOrderToken(storedResult, input.token)
}

async function deriveOrderToken(cartToken: string, orderId: string): Promise<string> {
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

export async function getOrderView(database: D1Database, input: { orderId: string; token: string }) {
  const tokenHash = await sha256Hex(input.token)
  const header = await database
    .prepare(
      `SELECT id, status, currency, total_net_cents AS totalNetCents,
              total_tax_cents AS totalTaxCents, total_gross_cents AS totalGrossCents,
              shipping_method_code AS shippingMethodCode,
              reservation_expires_at AS reservationExpiresAt, created_at AS createdAt
       FROM orders WHERE id = ?1 AND token_hash = ?2`
    )
    .bind(input.orderId, tokenHash)
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
      .bind(input.orderId)
      .all()
  ).results
  return { ...header, lines }
}
