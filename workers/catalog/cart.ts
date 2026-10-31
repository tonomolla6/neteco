/**
 * Server-side cart and pre-checkout contractual quotes over D1.
 *
 * Authoritative sources are NEVER duplicated here:
 *   price      -> workers/catalog/pricing.ts (effective governed versions)
 *   tax        -> tax_classes.rate_basis_points
 *   quantity   -> server/domain/money.ts validateQuantity (single math source)
 *   rounding   -> server/domain/money.ts splitGross/calculateQuote
 *   stock/backorder -> inventory_balances + variants.backorder_allowed (observed,
 *   never reserved by a quote)
 *
 * Idempotency: every mutation and quote carries a caller key. The first byte of
 * truth is the persistent `cart_commands` table (payload-hash guarded), so
 * replays work regardless of any cache lifetime. A lost race or a failing
 * post-condition triggers the CHECK-violating guard statement, rolling back the
 * whole D1 batch: partial mutations cannot survive.
 *
 * Optimistic concurrency: commands carry expectedVersion; stale versions yield
 * version_conflict with zero effects. The client can never supply prices, tax,
 * totals, evaluation instants or stock.
 */

import {
  calculateQuote,
  selectVolumeUnitPrice,
  validateQuantity,
  type Currency,
  type QuoteLineInput
} from '../../server/domain/money'
import { MAX_CART_QUANTITY } from '../../shared/cart-limits'
import {
  effectiveB2BGrossCentsExpression,
  effectiveB2BSourceExpression,
  effectiveB2BVersionIdExpression,
  effectiveGovernedVersionIdExpression,
  inlineEffectivePricingSql
} from './pricing'
import { parseVolumeTiers } from './volume-pricing'
import { canonicalJson, sellableExpression, sha256Hex } from './inventory'
import { publicationValidityExpression } from './publication-validity'
import { isD1CheckConstraintFailure } from '../runtime/d1-errors'
import { normalizePromotionCode, type PromotionReason } from '../../shared/promotions'
import { evaluatePromotion } from './promotions'
import { readPromotion } from './promotion-lookup'
import { autoDiscountStatements, evaluateQuoteAutoDiscounts } from '../pricing/auto-discount-quote'
import { activeOrderCustomerId } from './customer-orders'
import type { VerifiedSessionClaims } from './authorization'

/** Raised when D1 itself fails; must surface as 500/internal, never business. */
export class CartInfrastructureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CartInfrastructureError'
  }
}

export type CartStatus = 'active' | 'expired' | 'converted'

export class CartError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthorized'
      | 'not_found'
      | 'conflict'
      | 'version_conflict'
      | 'not_active'
      | 'variant_not_available'
      | 'empty_cart',
    message: string
  ) {
    super(message)
    this.name = 'CartError'
  }
}

const MAX_KEY_LENGTH = 200
const MAX_CART_LINES = 100
const CART_TTL_SECONDS = 3 * 24 * 60 * 60

// Status alone is not enduring authorization to sell: use D1's execution clock.
const unavailablePublication = `v.status <> 'published' OR p.status <> 'published'
  OR c.status <> 'published' OR NOT ${publicationValidityExpression('p')}`

async function cartHasUnavailablePublication(database: D1Database, cartId: string): Promise<boolean> {
  return Boolean(
    await database
      .prepare(
        `SELECT 1 FROM cart_lines cl JOIN variants v ON v.id = cl.variant_id
        JOIN products p ON p.id = v.product_id JOIN categories c ON c.id = p.category_id
        WHERE cl.cart_id = ?1 AND (${unavailablePublication}) LIMIT 1`
      )
      .bind(cartId)
      .first()
  )
}

function constraintFailure(error: unknown): boolean {
  return isD1CheckConstraintFailure(error)
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

export function assertCommandKey(value: string, name = 'idempotencyKey') {
  if (!value || value.length > MAX_KEY_LENGTH || hasControlCharacters(value))
    throw new CartError('invalid_input', `${name} is invalid`)
}

function assertInstant(value: string, name: string) {
  // Canonical format AND real calendar instant (2026-13-45 is rejected here and,
  // defence in depth, again by the strftime round-trip CHECKs in the schema).
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString().replace(/\.\d{3}Z$/, 'Z') !== value
  )
    throw new CartError('invalid_input', `${name} must be a canonical, valid ISO-8601 UTC instant`)
}

/** Collision-resistant canonical payload fingerprint (SHA-256 over sorted JSON). */
export async function canonicalPayloadHash(payload: Record<string, unknown>): Promise<string> {
  return sha256Hex(canonicalJson(payload))
}

function generateSecretToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

interface CartRow {
  id: string
  status: CartStatus
  version: number
  expires_at: string
}

interface AuthorizedCartRow extends CartRow {
  token_hash: string
}

interface CommandRow {
  kind: string
  payload_hash: string
  response_status: number
  response_body: string
}

async function loadCart(database: D1Database, cartId: string): Promise<CartRow | null> {
  return database
    .prepare('SELECT id, status, version, expires_at FROM carts WHERE id = ?1')
    .bind(cartId)
    .first<CartRow>()
}

function hashesEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

/**
 * Uniform authorization: wrong token and unknown id are indistinguishable, so
 * the existence of a cart id is never leaked through error shapes.
 */
async function authorizeCart(database: D1Database, cartId: string, token: string): Promise<CartRow> {
  // No format pre-check on purpose: any malformed token must be indistinguishable
  // from an unknown cart so existence is never leaked.
  if (!token || token.length > 512) throw new CartError('unauthorized', 'Invalid cart credentials')
  const providedHash = await sha256Hex(token)
  const row = await database
    .prepare('SELECT id, status, version, expires_at, token_hash FROM carts WHERE id = ?1')
    .bind(cartId)
    .first<AuthorizedCartRow>()
  if (!row || !hashesEqual(row.token_hash, providedHash))
    throw new CartError('unauthorized', 'Invalid cart credentials')
  return row
}

/** Used by the coordinator before consulting its durable replay cache. */
export async function assertCartAuthorized(database: D1Database, cartId: string, token: string): Promise<void> {
  await authorizeCart(database, cartId, token)
}

async function findCommand(database: D1Database, cartId: string, commandId: string): Promise<CommandRow | null> {
  return database
    .prepare(
      'SELECT kind, payload_hash, response_status, response_body FROM cart_commands WHERE cart_id = ?1 AND command_id = ?2'
    )
    .bind(cartId, commandId)
    .first<CommandRow>()
}

function requireFreshInput<TReplay, TConflict>(
  command: CommandRow | null,
  hash: string,
  replay: () => TReplay,
  conflict: () => TConflict
): TReplay | TConflict {
  if (!command) throw new Error('unreachable')
  return command.payload_hash === hash ? replay() : conflict()
}

export interface CreateCartInput {
  cartId?: string
  correlationId: string
  now: string
}

export interface CreatedCart {
  cartId: string
  /** Returned exactly once; only its SHA-256 is ever persisted. */
  token: string
  version: number
  expiresAt: string
}

export async function createCart(database: D1Database, input: CreateCartInput): Promise<CreatedCart> {
  assertCommandKey(input.correlationId, 'correlationId')
  assertInstant(input.now, 'now')
  if (input.cartId) assertCommandKey(input.cartId, 'cartId')
  const cartId = input.cartId ?? crypto.randomUUID()
  const token = generateSecretToken()
  const expiresAt = new Date(Date.parse(input.now) + CART_TTL_SECONDS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  await database
    .prepare(
      `INSERT INTO carts (id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at)
       VALUES (?1, ?2, 'active', 1, ?3, ?4, ?5, ?5)`
    )
    .bind(cartId, await sha256Hex(token), expiresAt, input.correlationId, input.now)
    .run()
  return { cartId, token, version: 1, expiresAt }
}

export interface CartLineView {
  variantId: string
  quantity: number
  updatedAt: string
}

export interface CartView {
  cartId: string
  status: CartStatus
  version: number
  expiresAt: string
  lines: CartLineView[]
}

export async function getCart(
  database: D1Database,
  input: { cartId: string; token: string; now?: string }
): Promise<CartView> {
  let cart = await authorizeCart(database, input.cartId, input.token)
  if (input.now) {
    assertInstant(input.now, 'now')
    if (cart.status === 'active' && cart.expires_at <= input.now) {
      await expireCart(database, { at: input.now, cartId: input.cartId })
      cart = (await loadCart(database, input.cartId)) ?? cart
    }
  }
  const { results } = await database
    .prepare(
      `SELECT variant_id AS variantId, quantity, updated_at AS updatedAt
       FROM cart_lines WHERE cart_id = ?1 ORDER BY variant_id`
    )
    .bind(input.cartId)
    .all<{ variantId: string; quantity: number; updatedAt: string }>()
  return {
    cartId: cart.id,
    status: cart.status,
    version: cart.version,
    expiresAt: cart.expires_at,
    lines: results
  }
}

export interface SetLineInput {
  cartId: string
  token: string
  idempotencyKey: string
  expectedVersion: number
  variantId: string
  /** 0 removes the line; positive quantities cannot exceed MAX_CART_QUANTITY. */
  quantity: number
  /** Increment mode is resolved inside the per-cart DO, after replay lookup. */
  mode?: 'add'
  correlationId: string
  now: string
}

export type CartAddOperationReceipt = {
  source: 'cloudflare'
  cartId: string
  commandId: string
} & ({ outcome: 'applied'; appliedVersion: number } | { outcome: 'unknown'; appliedVersion: null })

/** A ledger observation, never a fresh cart read or a proof of non-commit.
 * Publication changes and cart expiry cannot erase an authorized historical ADD.
 */
export async function readCartAddOperation(
  database: D1Database,
  input: Pick<SetLineInput, 'cartId' | 'token' | 'idempotencyKey' | 'expectedVersion' | 'variantId' | 'quantity'>
): Promise<CartAddOperationReceipt> {
  assertCommandKey(input.cartId, 'cartId')
  assertCommandKey(input.idempotencyKey)
  assertCommandKey(input.variantId, 'variantId')
  assertQuantityBounds(input.quantity)
  if (input.quantity === 0 || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new CartError('invalid_input', 'Invalid ADD intent')
  await authorizeCart(database, input.cartId, input.token)
  const hash = await canonicalPayloadHash({
    kind: 'add',
    cartId: input.cartId,
    expectedVersion: input.expectedVersion,
    variantId: input.variantId,
    quantity: input.quantity
  })
  const command = await findCommand(database, input.cartId, input.idempotencyKey)
  // The asynchronous ledger/hash lookup cannot extend a revoked token proof.
  await authorizeCart(database, input.cartId, input.token)
  const identity = { source: 'cloudflare' as const, cartId: input.cartId, commandId: input.idempotencyKey }
  if (!command) return { ...identity, outcome: 'unknown', appliedVersion: null }
  if (!hashesEqual(command.payload_hash, hash)) throw new CartError('conflict', 'ADD intent differs')
  let parsed: unknown
  try {
    parsed = JSON.parse(command.response_body)
  } catch {
    throw new CartInfrastructureError('Invalid ADD receipt')
  }
  const receipt = parsed as {
    outcome?: unknown
    body?: {
      cartVersion?: unknown
      line?: { variantId?: unknown; quantity?: unknown; updatedAt?: unknown }
      removed?: unknown
      status?: unknown
    }
  } | null
  const body = receipt?.body,
    line = body?.line
  if (
    command.kind !== 'mutate' ||
    command.response_status !== 200 ||
    receipt?.outcome !== 'applied' ||
    !Number.isSafeInteger(body?.cartVersion) ||
    body!.cartVersion !== input.expectedVersion + 1 ||
    body?.removed !== false ||
    body?.status !== 'active' ||
    line?.variantId !== input.variantId ||
    !Number.isSafeInteger(line?.quantity) ||
    (line!.quantity as number) < input.quantity ||
    (line!.quantity as number) > MAX_CART_QUANTITY ||
    typeof line?.updatedAt !== 'string'
  )
    throw new CartInfrastructureError('Invalid ADD receipt')
  try {
    assertInstant(line.updatedAt, 'receipt instant')
  } catch {
    throw new CartInfrastructureError('Invalid ADD receipt')
  }
  return { ...identity, outcome: 'applied', appliedVersion: body!.cartVersion as number }
}

export type SetLineResult =
  | { outcome: 'applied'; body: Record<string, unknown> }
  | { outcome: 'conflict'; code: 'conflict' }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_active'; status: CartStatus }

function assertQuantityBounds(quantity: number) {
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > MAX_CART_QUANTITY)
    throw new CartError('invalid_input', `quantity must be an integer between 0 and ${MAX_CART_QUANTITY}`)
}

export async function setCartLine(database: D1Database, input: SetLineInput): Promise<SetLineResult> {
  assertCommandKey(input.idempotencyKey)
  assertCommandKey(input.cartId, 'cartId')
  assertCommandKey(input.variantId, 'variantId')
  assertCommandKey(input.correlationId, 'correlationId')
  assertInstant(input.now, 'now')
  assertQuantityBounds(input.quantity)
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new CartError('invalid_input', 'expectedVersion must be a positive integer')

  if (input.mode === 'add' && input.quantity === 0)
    throw new CartError('invalid_input', 'quantity must be positive for add')
  const payload = {
    kind: input.mode === 'add' ? 'add' : 'mutate',
    cartId: input.cartId,
    expectedVersion: input.expectedVersion,
    variantId: input.variantId,
    quantity: input.quantity
  }
  const payloadHash = await canonicalPayloadHash(payload)

  const cart = await authorizeCart(database, input.cartId, input.token)
  const existingCommand = await findCommand(database, input.cartId, input.idempotencyKey)
  if (existingCommand)
    return requireFreshInput(
      existingCommand,
      payloadHash,
      () => JSON.parse(existingCommand.response_body) as SetLineResult,
      () => ({ outcome: 'conflict', code: 'conflict' })
    )

  if (cart.status !== 'active') return { outcome: 'not_active', status: cart.status }
  if (cart.expires_at <= input.now) {
    await expireCart(database, { at: input.now, cartId: input.cartId })
    return { outcome: 'not_active', status: 'expired' }
  }
  if (cart.version !== input.expectedVersion) return { outcome: 'version_conflict', currentVersion: cart.version }

  const quantity =
    input.mode === 'add'
      ? ((
          await database
            .prepare('SELECT quantity FROM cart_lines WHERE cart_id = ?1 AND variant_id = ?2')
            .bind(input.cartId, input.variantId)
            .first<{ quantity: number }>()
        )?.quantity ?? 0)
      : 0
  const targetQuantity = input.mode === 'add' ? quantity + input.quantity : input.quantity
  assertQuantityBounds(targetQuantity)

  // Quantity policy is authoritative in `variants`; money.ts validates it once.
  if (targetQuantity !== 0) {
    const variant = await database
      .prepare(
        `SELECT v.minimum_quantity AS minimumQuantity,
                v.maximum_quantity AS maximumQuantity,
                v.quantity_increment AS quantityIncrement,
                v.status, p.status AS productStatus, c.status AS categoryStatus,
                ${publicationValidityExpression('p')} AS publicationValid
         FROM variants v
         JOIN products p ON p.id = v.product_id
         JOIN categories c ON c.id = p.category_id
         WHERE v.id = ?1`
      )
      .bind(input.variantId)
      .first<{
        minimumQuantity: number
        maximumQuantity: number | null
        quantityIncrement: number
        status: string
        productStatus: string
        categoryStatus: string
        publicationValid: number
      }>()
    if (
      !variant ||
      variant.status !== 'published' ||
      variant.productStatus !== 'published' ||
      variant.categoryStatus !== 'published' ||
      variant.publicationValid !== 1
    )
      throw new CartError('variant_not_available', 'Variant cannot be added to the cart')
    try {
      validateQuantity(targetQuantity, {
        maximumQuantity: variant.maximumQuantity,
        minimumQuantity: variant.minimumQuantity,
        quantityIncrement: variant.quantityIncrement
      })
    } catch {
      throw new CartError('invalid_input', 'quantity violates the variant quantity rules')
    }
  }

  const nextVersion = cart.version + 1
  const removing = targetQuantity === 0
  // The response is fully determined by the request and the new version, so it
  // is persisted atomically WITH the effects: replays return identical bytes.
  const responseBody = JSON.stringify({
    outcome: 'applied',
    body: {
      cartVersion: nextVersion,
      line: removing ? null : { quantity: targetQuantity, updatedAt: input.now, variantId: input.variantId },
      removed: removing,
      status: 'active'
    }
  } satisfies SetLineResult)
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO cart_commands (
             command_id, cart_id, kind, payload_hash, response_status, response_body,
             correlation_id, created_at
           ) VALUES (?1, ?2, 'mutate', ?3, 200, ?4, ?5, ?6)`
        )
        .bind(input.idempotencyKey, input.cartId, payloadHash, responseBody, input.correlationId, input.now),
      // Version transition is the single write gate for everything below.
      database
        .prepare(
          `UPDATE carts SET version = ?2, updated_at = ?3
           WHERE id = ?1 AND version = ?4 AND status = 'active' AND expires_at > ?3`
        )
        .bind(input.cartId, nextVersion, input.now, input.expectedVersion),
      ...(removing
        ? [
            database
              .prepare(
                `DELETE FROM cart_lines
                 WHERE cart_id = ?1 AND variant_id = ?2
                   AND EXISTS (
                     SELECT 1 FROM carts
                     WHERE id = ?1 AND version = ?3 AND status = 'active'
                   )`
              )
              .bind(input.cartId, input.variantId, nextVersion)
          ]
        : [
            database
              .prepare(
                `INSERT INTO cart_lines (cart_id, variant_id, quantity, created_at, updated_at)
                 SELECT ?1, ?2, ?3, ?4, ?4
                 WHERE EXISTS (
                   SELECT 1 FROM carts
                   WHERE id = ?1 AND version = ?5 AND status = 'active'
                 )
                 AND EXISTS (
                   SELECT 1 FROM variants v
                   JOIN products p ON p.id = v.product_id AND p.status = 'published'
                   JOIN categories c ON c.id = p.category_id AND c.status = 'published'
                   WHERE v.id = ?2 AND v.status = 'published'
                     AND ${publicationValidityExpression('p')}
                 )
                 AND (
                   EXISTS (SELECT 1 FROM cart_lines WHERE cart_id = ?1 AND variant_id = ?2)
                   OR (SELECT count(*) FROM cart_lines WHERE cart_id = ?1) < ${MAX_CART_LINES}
                 )
                 ON CONFLICT (cart_id, variant_id)
                 DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at`
              )
              .bind(input.cartId, input.variantId, targetQuantity, input.now, nextVersion)
          ]),
      // GUARD: command recorded, version advanced exactly once; otherwise the
      // impossible status violates the schema CHECK and rolls everything back.
      database
        .prepare(
          `INSERT INTO carts (id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at)
           SELECT 'cart-guard:' || ?1, '0000000000000000000000000000000000000000000000000000000000000000',
                  'guard-impossible', 1, '2026-01-01T00:00:00Z', ?2, ?3, ?3
           WHERE NOT EXISTS (
             SELECT 1 FROM cart_commands WHERE cart_id = ?5 AND command_id = ?1 AND payload_hash = ?4
           )
              OR NOT EXISTS (
             SELECT 1 FROM carts
             WHERE id = ?5 AND version = ?6 AND status = 'active' AND expires_at > ?3
           )
              OR (${removing ? 'EXISTS' : 'NOT EXISTS'} (
             SELECT 1 FROM cart_lines
             WHERE cart_id = ?5 AND variant_id = ?7${removing ? '' : ' AND quantity = ?8 AND updated_at = ?3'}
           ))
              OR (SELECT count(*) FROM cart_lines WHERE cart_id = ?5) > ${MAX_CART_LINES}
              ${
                removing
                  ? ''
                  : `OR EXISTS (SELECT 1 FROM cart_lines cl
                JOIN variants v ON v.id = cl.variant_id JOIN products p ON p.id = v.product_id
                JOIN categories c ON c.id = p.category_id
                WHERE cl.cart_id = ?5 AND cl.variant_id = ?7 AND (${unavailablePublication}))`
              }
           LIMIT 1`
        )
        .bind(
          input.idempotencyKey,
          input.correlationId,
          input.now,
          payloadHash,
          input.cartId,
          nextVersion,
          input.variantId,
          ...(removing ? [] : [targetQuantity])
        )
    ])
  } catch (batchError) {
    // Guard fired: either a same-key race or a stale version. Classify cleanly.
    const raced = await loadCart(database, input.cartId)
    const racedCommand = await findCommand(database, input.cartId, input.idempotencyKey)
    if (racedCommand)
      return requireFreshInput(
        racedCommand,
        payloadHash,
        () => JSON.parse(racedCommand.response_body) as SetLineResult,
        () => ({ outcome: 'conflict', code: 'conflict' })
      )
    if (raced?.status === 'active' && raced.expires_at <= input.now) {
      await expireCart(database, { at: input.now, cartId: input.cartId })
      return { outcome: 'not_active', status: 'expired' }
    }
    if (raced && raced.version !== input.expectedVersion)
      return { outcome: 'version_conflict', currentVersion: raced.version }
    if (!raced || raced.status !== 'active') throw new CartError('not_active', 'Cart cannot be mutated')
    if (raced.version !== input.expectedVersion) return { outcome: 'version_conflict', currentVersion: raced.version }
    if (!removing && constraintFailure(batchError)) {
      const available = await database
        .prepare(
          `SELECT 1 FROM variants v JOIN products p ON p.id = v.product_id
          JOIN categories c ON c.id = p.category_id WHERE v.id = ?1
            AND NOT (${unavailablePublication})`
        )
        .bind(input.variantId)
        .first()
      if (!available) throw new CartError('variant_not_available', 'Variant publication is no longer valid')
    }
    // Neither a guard outcome nor a race: treat as infrastructure failure.
    // The cause is preserved for server-side logs; the DO maps this to a
    // generic 500 so no D1 detail ever reaches clients.
    void batchError
    throw new CartInfrastructureError('cart mutation batch failed')
  }

  const appliedCommand = await findCommand(database, input.cartId, input.idempotencyKey)
  if (!appliedCommand) throw new Error('unreachable: command must exist after an applied batch')
  return JSON.parse(appliedCommand.response_body) as SetLineResult
}

/** Atomically empties and revokes an active cart. A replay cannot revive it. */
export async function clearCart(
  database: D1Database,
  input: Omit<SetLineInput, 'variantId' | 'quantity'>
): Promise<SetLineResult> {
  assertCommandKey(input.idempotencyKey)
  assertCommandKey(input.cartId, 'cartId')
  assertCommandKey(input.correlationId, 'correlationId')
  assertInstant(input.now, 'now')
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new CartError('invalid_input', 'expectedVersion must be a positive integer')

  const payloadHash = await canonicalPayloadHash({
    kind: 'clear',
    cartId: input.cartId,
    expectedVersion: input.expectedVersion
  })
  const cart = await authorizeCart(database, input.cartId, input.token)
  const existingCommand = await findCommand(database, input.cartId, input.idempotencyKey)
  if (existingCommand)
    return requireFreshInput(
      existingCommand,
      payloadHash,
      () => JSON.parse(existingCommand.response_body) as SetLineResult,
      () => ({ outcome: 'conflict', code: 'conflict' })
    )
  if (cart.status !== 'active') return { outcome: 'not_active', status: cart.status }
  if (cart.expires_at <= input.now) {
    await expireCart(database, { at: input.now, cartId: input.cartId })
    return { outcome: 'not_active', status: 'expired' }
  }
  if (cart.version !== input.expectedVersion) return { outcome: 'version_conflict', currentVersion: cart.version }

  const nextVersion = cart.version + 1
  const responseBody = JSON.stringify({
    outcome: 'applied',
    body: { cartVersion: nextVersion, cleared: true, status: 'expired' }
  } satisfies SetLineResult)
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO cart_commands (
             command_id, cart_id, kind, payload_hash, response_status, response_body,
             correlation_id, created_at
           ) VALUES (?1, ?2, 'mutate', ?3, 200, ?4, ?5, ?6)`
        )
        .bind(input.idempotencyKey, input.cartId, payloadHash, responseBody, input.correlationId, input.now),
      database
        .prepare(
          `UPDATE carts SET version = ?2, status = 'expired', expired_at = ?3, updated_at = ?3
           WHERE id = ?1 AND version = ?4 AND status = 'active' AND expires_at > ?3`
        )
        .bind(input.cartId, nextVersion, input.now, input.expectedVersion),
      database
        .prepare(
          `DELETE FROM cart_lines WHERE cart_id = ?1
           AND EXISTS (SELECT 1 FROM carts WHERE id = ?1 AND version = ?2 AND status = 'expired')`
        )
        .bind(input.cartId, nextVersion),
      database
        .prepare(
          `INSERT INTO carts (id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at)
           SELECT 'cart-guard:' || ?1, '0000000000000000000000000000000000000000000000000000000000000000',
                  'guard-impossible', 1, '2026-01-01T00:00:00Z', ?2, ?3, ?3
           WHERE NOT EXISTS (
             SELECT 1 FROM cart_commands WHERE cart_id = ?5 AND command_id = ?1 AND payload_hash = ?4
           ) OR NOT EXISTS (
             SELECT 1 FROM carts WHERE id = ?5 AND version = ?6 AND status = 'expired' AND expired_at = ?3
           ) OR EXISTS (SELECT 1 FROM cart_lines WHERE cart_id = ?5)
           LIMIT 1`
        )
        .bind(input.idempotencyKey, input.correlationId, input.now, payloadHash, input.cartId, nextVersion)
    ])
  } catch {
    const raced = await loadCart(database, input.cartId)
    const racedCommand = await findCommand(database, input.cartId, input.idempotencyKey)
    if (racedCommand)
      return requireFreshInput(
        racedCommand,
        payloadHash,
        () => JSON.parse(racedCommand.response_body) as SetLineResult,
        () => ({ outcome: 'conflict', code: 'conflict' })
      )
    if (raced && raced.version !== input.expectedVersion)
      return { outcome: 'version_conflict', currentVersion: raced.version }
    if (!raced || raced.status !== 'active') return { outcome: 'not_active', status: raced?.status ?? 'expired' }
    throw new CartInfrastructureError('cart clear batch failed')
  }
  return { outcome: 'applied', body: { cartVersion: nextVersion, cleared: true, status: 'expired' } }
}

export interface QuoteRequestInput {
  cartId: string
  token: string
  idempotencyKey: string
  expectedVersion: number
  correlationId: string
  now: string
  couponCode?: string | null
  /** Trusted cookie claims, never a customer ID supplied by the buyer. */
  ownerSession?: VerifiedSessionClaims | null
}

export interface QuoteLineSnapshot {
  lineIndex: number
  variantId: string
  sku: string
  name: string
  format: string
  unitLabel: string
  quantity: number
  unitGrossCents: number
  netCents: number
  taxCents: number
  grossCents: number
  taxRateBasisPoints: number
  priceVersionId: string
  availableQuantity: number
  backorderAllowed: boolean
  discountGrossCents?: number
}

export interface QuoteSnapshot {
  quoteId: string
  cartId: string
  cartVersion: number
  pricingInstant: string
  expiresAt: string
  currency: Currency
  shipping: { grossCents: 0; pending: true }
  lines: QuoteLineSnapshot[]
  totals: { netCents: number; taxCents: number; grossCents: number }
  snapshotHash: string
  promotion?: { code: string; applied: boolean; reason: PromotionReason | null; discountGrossCents: number }
  /** PRI-014: present only when automatic rules applied (customer-safe: message and amount). */
  autoDiscounts?: { discountGrossCents: number; explanations: Array<{ message: string; discountGrossCents: number }> }
}

const QUOTE_TTL_SECONDS = 30 * 60

export type QuoteResult =
  | { outcome: 'quoted'; quote: QuoteSnapshot }
  | { outcome: 'conflict'; code: 'conflict' }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_active'; status: CartStatus }
  | { outcome: 'empty_cart' }

export async function quoteCart(database: D1Database, input: QuoteRequestInput): Promise<QuoteResult> {
  assertCommandKey(input.idempotencyKey)
  assertCommandKey(input.cartId, 'cartId')
  assertCommandKey(input.correlationId, 'correlationId')
  assertInstant(input.now, 'now')
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new CartError('invalid_input', 'expectedVersion must be a positive integer')
  // The evaluation instant is ALWAYS the server-generated command instant;
  // nothing about pricing timing is ever client-controlled.
  const pricingInstant = input.now
  const expiresAt = new Date(Date.parse(input.now) + QUOTE_TTL_SECONDS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

  let couponCode: string | null = null
  try {
    if (input.couponCode !== undefined && input.couponCode !== null)
      couponCode = normalizePromotionCode(input.couponCode)
  } catch {
    throw new CartError('invalid_input', 'couponCode is invalid')
  }
  const customerId = input.ownerSession ? await activeOrderCustomerId(database, input.ownerSession, input.now) : null
  if (input.ownerSession && !customerId) throw new CartError('unauthorized', 'Customer session is no longer active')
  const payload = {
    kind: 'quote',
    cartId: input.cartId,
    expectedVersion: input.expectedVersion,
    ...(couponCode ? { couponCode, customerId } : customerId ? { customerId } : {})
  }
  const payloadHash = await canonicalPayloadHash(payload)
  const cart = await authorizeCart(database, input.cartId, input.token)
  const existingCommand = await findCommand(database, input.cartId, input.idempotencyKey)
  if (existingCommand)
    return requireFreshInput(
      existingCommand,
      payloadHash,
      () => JSON.parse(existingCommand.response_body) as QuoteResult,
      () => ({ outcome: 'conflict', code: 'conflict' })
    )

  if (cart.status !== 'active') return { outcome: 'not_active', status: cart.status }
  if (cart.expires_at <= input.now) {
    await expireCart(database, { at: input.now, cartId: input.cartId })
    return { outcome: 'not_active', status: 'expired' }
  }
  if (cart.version !== input.expectedVersion) return { outcome: 'version_conflict', currentVersion: cart.version }

  const company = customerId
    ? await database
        .prepare("SELECT 1 AS approved FROM companies WHERE customer_id=?1 AND status='approved'")
        .bind(customerId)
        .first()
    : null
  const resolved = await resolveQuoteLines(database, {
    cartId: input.cartId,
    instant: pricingInstant,
    ...(customerId && company ? { customerId } : {})
  })
  if (!resolved.length) return { outcome: 'empty_cart' }
  if (resolved.some((line) => line.unitGrossCents <= 0))
    throw new CartError('invalid_input', 'A zero-price line cannot be quoted with the current checkout contract')

  const promotion = couponCode ? await readPromotion(database, couponCode, customerId, input.now) : null
  const evaluated = promotion
    ? evaluatePromotion(promotion.rule, {
        now: input.now,
        channel: 'online',
        customerId,
        companyApproved: Boolean(company),
        redemptions: promotion.redemptions,
        lines: resolved.map((line, lineIndex) => ({
          lineIndex,
          variantId: line.variantId,
          productId: line.productId,
          categoryId: line.categoryId,
          sku: line.sku,
          quantity: line.quantity,
          baseUnitGrossCents: line.baseUnitGrossCents,
          volumeUnitGrossCents: line.unitGrossCents,
          taxRateBasisPoints: line.taxRateBasisPoints
        }))
      })
    : null

  // Precedence: an eligible coupon is the only discount source; otherwise automatic rules (PRI-014).
  const autoDiscounts = evaluated?.eligible
    ? null
    : await evaluateQuoteAutoDiscounts(database, {
        now: input.now,
        customerId,
        companyApproved: Boolean(company),
        lines: resolved.map((line) => ({
          variantId: line.variantId,
          productId: line.productId,
          categoryId: line.categoryId,
          sku: line.sku,
          quantity: line.quantity,
          unitGrossCents: line.unitGrossCents,
          costUnitNetCents: line.costUnitNetCents,
          taxRateBasisPoints: line.taxRateBasisPoints,
          priceVersionId: line.priceVersionId
        }))
      })
  const lineDiscountColumn = Boolean(evaluated?.eligible || autoDiscounts)

  const quoteInputs: QuoteLineInput[] = resolved.map((line, lineIndex) => ({
    quantity: line.quantity,
    sku: line.sku,
    taxRateBasisPoints: line.taxRateBasisPoints,
    unitGrossCents:
      evaluated?.lines.find((entry) => entry.variantId === line.variantId)?.unitGrossCents ?? line.unitGrossCents,
    variantId: line.variantId,
    discountGrossCents:
      evaluated?.lines.find((entry) => entry.variantId === line.variantId)?.discountGrossCents ??
      autoDiscounts?.discountByIndex.get(lineIndex) ??
      0
  }))
  const computed = calculateQuote({
    lines: quoteInputs,
    pricingVersion: `d1:${pricingInstant}`,
    shippingGrossCents: 0,
    shippingTaxRateBasisPoints: 0
  })

  const lines: QuoteLineSnapshot[] = resolved.map((line, index) => {
    const priced = computed.lines[index]!
    return {
      availableQuantity: line.availableQuantity,
      backorderAllowed: line.backorderAllowed,
      format: line.format,
      grossCents: priced.grossCents,
      lineIndex: index,
      name: line.name,
      netCents: priced.netCents,
      priceVersionId: line.priceVersionId,
      quantity: line.quantity,
      sku: line.sku,
      taxCents: priced.taxCents,
      taxRateBasisPoints: line.taxRateBasisPoints,
      unitGrossCents: priced.unitGrossCents,
      unitLabel: line.unitLabel,
      variantId: line.variantId,
      ...(lineDiscountColumn ? { discountGrossCents: priced.discountGrossCents } : {})
    }
  })

  const quote: QuoteSnapshot = {
    cartId: input.cartId,
    cartVersion: cart.version,
    currency: 'EUR',
    expiresAt,
    lines,
    pricingInstant,
    quoteId: crypto.randomUUID(),
    shipping: { grossCents: 0, pending: true },
    snapshotHash: '',
    totals: {
      grossCents: computed.totalGrossCents,
      netCents: computed.subtotalNetCents,
      taxCents: computed.taxCents
    }
  }
  if (couponCode)
    quote.promotion = {
      code: couponCode,
      applied: evaluated?.eligible ?? false,
      reason: evaluated ? evaluated.reason : 'unavailable',
      discountGrossCents: evaluated?.totals.discountGrossCents ?? 0
    }
  if (autoDiscounts)
    quote.autoDiscounts = {
      discountGrossCents: autoDiscounts.totalDiscountGrossCents,
      explanations: autoDiscounts.explanations
    }
  quote.snapshotHash = await canonicalPayloadHash({
    cartId: quote.cartId,
    cartVersion: quote.cartVersion,
    currency: quote.currency,
    lines: quote.lines,
    pricingInstant: quote.pricingInstant,
    expiresAt: quote.expiresAt,
    shipping: quote.shipping,
    totals: quote.totals,
    ...(quote.promotion ? { promotion: quote.promotion } : {}),
    ...(evaluated?.eligible && promotion ? { promotionRuleHash: promotion.ruleHash } : {}),
    ...(autoDiscounts
      ? { autoDiscounts: quote.autoDiscounts, autoDiscountEvidenceHash: autoDiscounts.evidenceHash }
      : {})
  })

  const b2bGuardGross =
    customerId && company ? inlineEffectivePricingSql(effectiveB2BGrossCentsExpression('v', '?6'), input.now) : ''
  const b2bGuardVersion =
    customerId && company ? inlineEffectivePricingSql(effectiveB2BVersionIdExpression('v', '?6'), input.now) : ''
  try {
    await database.batch([
      ...(customerId && input.ownerSession
        ? [
            database
              .prepare(
                `INSERT INTO carts(id,token_hash,status,version,expires_at,correlation_id,created_at,updated_at)
         SELECT 'b2b-guard:' || ?1, '0000000000000000000000000000000000000000000000000000000000000000',
           'guard-impossible',1,'2026-01-01T00:00:00Z',?2,?3,?3
         WHERE NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
           JOIN customers c ON c.id=i.customer_id AND c.status='active'
           WHERE s.id=?4 AND s.identity_id=?5 AND c.id=?6 AND s.session_version=?7
             AND i.session_version=s.session_version AND i.status='active' AND i.email_verified_at IS NOT NULL
             AND i.email_verified_at<=?3 AND s.revoked_at IS NULL AND s.created_at<=?3 AND s.expires_at>?3)
         OR EXISTS(SELECT 1 FROM companies company WHERE company.customer_id=?6 AND company.status='approved') <> ?9
         ${
           b2bGuardGross
             ? `OR EXISTS(SELECT 1 FROM json_each(?8) expected
           JOIN variants v ON v.id=json_extract(expected.value,'$.variantId')
           WHERE ${b2bGuardGross} <> json_extract(expected.value,'$.baseUnitGrossCents')
              OR ${b2bGuardVersion} <> json_extract(expected.value,'$.priceVersionId'))`
             : 'AND ?8 IS NOT NULL'
         }`
              )
              .bind(
                input.idempotencyKey,
                input.correlationId,
                input.now,
                input.ownerSession.sessionId,
                input.ownerSession.identityId,
                customerId,
                input.ownerSession.sessionVersion,
                JSON.stringify(resolved),
                company ? 1 : 0
              )
          ]
        : []),
      database
        .prepare(
          `INSERT INTO checkout_quotes (
           id, cart_id, cart_version, pricing_instant, currency, shipping_gross_cents,
           shipping_pending, total_net_cents, total_tax_cents, total_gross_cents,
           snapshot_hash, correlation_id, created_at, expires_at
         ) VALUES (?1, ?2, ?3, ?4, 'EUR', 0, 1, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
        )
        .bind(
          quote.quoteId,
          input.cartId,
          cart.version,
          pricingInstant,
          quote.totals.netCents,
          quote.totals.taxCents,
          quote.totals.grossCents,
          quote.snapshotHash,
          input.correlationId,
          input.now,
          expiresAt
        ),
      ...quote.lines.map((line) =>
        database
          .prepare(
            `INSERT INTO checkout_quote_lines (
             quote_id, line_index, variant_id, sku, name, format, unit_label, quantity,
             unit_gross_cents, net_cents, tax_cents, gross_cents, tax_rate_basis_points,
             price_version_id, available_quantity, backorder_allowed, created_at${lineDiscountColumn ? ', discount_gross_cents' : ''}
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17${lineDiscountColumn ? ', ?18' : ''})`
          )
          .bind(
            quote.quoteId,
            line.lineIndex,
            line.variantId,
            line.sku,
            line.name,
            line.format,
            line.unitLabel,
            line.quantity,
            line.unitGrossCents,
            line.netCents,
            line.taxCents,
            line.grossCents,
            line.taxRateBasisPoints,
            line.priceVersionId,
            line.availableQuantity,
            line.backorderAllowed ? 1 : 0,
            input.now,
            ...(lineDiscountColumn ? [line.discountGrossCents ?? 0] : [])
          )
      ),
      ...(autoDiscounts
        ? autoDiscountStatements(
            database,
            quote.quoteId,
            input.idempotencyKey,
            input.correlationId,
            autoDiscounts,
            input.now
          )
        : []),
      ...(evaluated?.eligible && promotion
        ? [
            database
              .prepare(
                `INSERT INTO checkout_quote_promotions(quote_id,rule_id,rule_version,rule_json,rule_hash,customer_id,discount_gross_cents)
          VALUES(?1,?2,?3,?4,?5,?6,?7)`
              )
              .bind(
                quote.quoteId,
                promotion.rule.id,
                promotion.rule.version,
                JSON.stringify(promotion.rule),
                promotion.ruleHash,
                customerId,
                evaluated.totals.discountGrossCents
              ),
            database
              .prepare(
                `INSERT INTO promotion_guards(id,valid)
          SELECT ?1,CASE WHEN EXISTS(SELECT 1 FROM promotion_rules p
            JOIN promotion_rule_versions v ON v.rule_id=p.id AND v.version=p.current_version
            WHERE p.id=?2 AND p.current_version=?3 AND v.rule_hash=?4
              AND json_extract(v.rule_json,'$.status')='active'
              AND json_extract(v.rule_json,'$.startsAt')<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
              AND (json_extract(v.rule_json,'$.endsAt') IS NULL OR json_extract(v.rule_json,'$.endsAt')>strftime('%Y-%m-%dT%H:%M:%SZ','now'))
          ) AND (?5 IS NULL OR EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
            JOIN customers c ON c.id=i.customer_id AND c.status='active'
            WHERE c.id=?5 AND s.id=?6 AND s.identity_id=?7 AND s.session_version=?8
              AND i.session_version=s.session_version AND i.status='active' AND i.email_verified_at IS NOT NULL
              AND i.email_verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND s.revoked_at IS NULL
              AND s.created_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')))
          THEN 1 ELSE 0 END`
              )
              .bind(
                `quote:${quote.quoteId}`,
                promotion.rule.id,
                promotion.rule.version,
                promotion.ruleHash,
                customerId,
                input.ownerSession?.sessionId ?? null,
                input.ownerSession?.identityId ?? null,
                input.ownerSession?.sessionVersion ?? null
              ),
            database.prepare('DELETE FROM promotion_guards WHERE id=?1').bind(`quote:${quote.quoteId}`)
          ]
        : []),
      database
        .prepare(
          `INSERT INTO cart_commands (
           command_id, cart_id, kind, payload_hash, response_status, response_body,
           correlation_id, created_at
         ) VALUES (?1, ?2, 'quote', ?3, 200, ?4, ?5, ?6)`
        )
        .bind(
          input.idempotencyKey,
          input.cartId,
          payloadHash,
          JSON.stringify({ outcome: 'quoted', quote } satisfies QuoteResult),
          input.correlationId,
          input.now
        ),
      database
        .prepare(
          `INSERT INTO carts (id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at)
         SELECT 'cart-guard:' || ?1, '0000000000000000000000000000000000000000000000000000000000000000',
                'guard-impossible', 1, '2026-01-01T00:00:00Z', ?2, ?3, ?3
         WHERE NOT EXISTS (
           SELECT 1 FROM cart_commands WHERE cart_id = ?4 AND command_id = ?1 AND kind = 'quote'
         )
            OR NOT EXISTS (
           SELECT 1 FROM carts
           WHERE id = ?4 AND version = ?5 AND status = 'active' AND expires_at > ?3
         )
            OR (SELECT count(*) FROM checkout_quote_lines WHERE quote_id = ?6)
               <> (SELECT count(*) FROM cart_lines WHERE cart_id = ?4)
            OR EXISTS (SELECT 1 FROM cart_lines cl
              JOIN variants v ON v.id = cl.variant_id JOIN products p ON p.id = v.product_id
              JOIN categories c ON c.id = p.category_id
              WHERE cl.cart_id = ?4 AND (${unavailablePublication}))
         LIMIT 1`
        )
        .bind(input.idempotencyKey, input.correlationId, input.now, input.cartId, cart.version, quote.quoteId)
    ])
  } catch (batchError) {
    // Lost a same-key race: classify through the persistent ledger.
    const racedCommand = await findCommand(database, input.cartId, input.idempotencyKey)
    if (racedCommand)
      return requireFreshInput(
        racedCommand,
        payloadHash,
        () => JSON.parse(racedCommand.response_body) as QuoteResult,
        () => ({ outcome: 'conflict', code: 'conflict' })
      )
    const raced = await loadCart(database, input.cartId)
    if (raced?.status === 'active' && raced.expires_at <= input.now) {
      await expireCart(database, { at: input.now, cartId: input.cartId })
      return { outcome: 'not_active', status: 'expired' }
    }
    if (raced && raced.version !== input.expectedVersion)
      return { outcome: 'version_conflict', currentVersion: raced.version }
    if (!raced || raced.status !== 'active') return { outcome: 'not_active', status: raced?.status ?? 'expired' }
    if (constraintFailure(batchError) && (await cartHasUnavailablePublication(database, input.cartId)))
      throw new CartError('variant_not_available', 'Cart publication is no longer valid')
    void batchError
    throw new CartInfrastructureError('cart quote batch failed')
  }

  const storedCommand = await findCommand(database, input.cartId, input.idempotencyKey)
  if (!storedCommand) throw new Error('unreachable: command must exist after an applied batch')
  return JSON.parse(storedCommand.response_body) as QuoteResult
}

export interface ResolvedLine {
  costUnitNetCents: number | null
  weightGrams: number
  profileKind: string
  minimumQuantity: number
  maximumQuantity: number | null
  quantityIncrement: number
  availableQuantity: number
  backorderAllowed: boolean
  format: string
  name: string
  priceVersionId: string
  quantity: number
  sku: string
  taxRateBasisPoints: number
  unitGrossCents: number
  volumeTiersJson: string
  unitLabel: string
  variantId: string
  variantStatus: string
  productStatus: string
  categoryStatus: string
  publicationValid: number
  productId: string
  categoryId: string
  baseUnitGrossCents: number
}

/** One aggregate query per quote: no N+1 across variants. */
async function resolveQuoteLines(
  database: D1Database,
  options: { cartId: string; instant: string; customerId?: string }
): Promise<ResolvedLine[]> {
  const { results } = await prepareQuoteLinesStatement(database, options).all<RawResolvedLine>()
  return mapQuoteLines(results)
}

export type RawResolvedLine = Omit<ResolvedLine, 'backorderAllowed' | 'baseUnitGrossCents'> & {
  backorderAllowed: number
}

/** Same canonical pricing/publication query for persisted carts and private simulations.
 * Requested lines are parameterized JSON, never a temporary cart or caller prices. */
export function prepareQuoteLinesStatement(
  database: D1Database,
  options: { instant: string; customerId?: string } & (
    { cartId: string } | { lines: Array<{ variantId: string; quantity: number }> }
  )
): D1PreparedStatement {
  const query = quoteLinesQuery(options)
  return database.prepare(query.sql).bind(...query.bindings)
}

/** Canonical prepared read shared with atomic, private recovery guards. */
export function quoteLinesQuery(
  options: { instant: string; customerId?: string } & (
    { cartId: string } | { lines: Array<{ variantId: string; quantity: number }> }
  )
): { sql: string; bindings: string[] } {
  const priceVersionFragment = inlineEffectivePricingSql(effectiveGovernedVersionIdExpression('v'), options.instant)
  const requested = 'lines' in options
  const contractual = Boolean(options.customerId)
  const gross = contractual
    ? inlineEffectivePricingSql(effectiveB2BGrossCentsExpression('v', '?2'), options.instant)
    : 'COALESCE(price.gross_cents, v.price_gross_cents)'
  const version = contractual
    ? inlineEffectivePricingSql(effectiveB2BVersionIdExpression('v', '?2'), options.instant)
    : "COALESCE(price.id, 'legacy:' || v.id)"
  const source = contractual
    ? inlineEffectivePricingSql(effectiveB2BSourceExpression('v', '?2'), options.instant)
    : "'public'"
  return {
    sql: `${requested ? "WITH requested_lines AS (SELECT json_extract(value,'$.variantId') AS variant_id,json_extract(value,'$.quantity') AS quantity FROM json_each(?1))" : ''}
       SELECT cl.variant_id AS variantId, p.id AS productId, c.id AS categoryId,
              cl.quantity,
              v.cost_net_cents AS costUnitNetCents,
              COALESCE(v.weight_grams,0) AS weightGrams,
              COALESCE(sp.kind,'parcel') AS profileKind,
              v.minimum_quantity AS minimumQuantity,
              v.maximum_quantity AS maximumQuantity,
              v.quantity_increment AS quantityIncrement,
              v.status AS variantStatus,
              p.status AS productStatus,
              c.status AS categoryStatus,
              ${publicationValidityExpression('p')} AS publicationValid,
              v.sku,
              p.name,
              v.format,
              v.unit_label AS unitLabel,
              v.backorder_allowed AS backorderAllowed,
              t.rate_basis_points AS taxRateBasisPoints,
              ${gross} AS unitGrossCents,
              CASE WHEN ${source}='public' THEN COALESCE(price.volume_tiers, '[]') ELSE '[]' END AS volumeTiersJson,
              ${version} AS priceVersionId,
              (
                SELECT TOTAL(${sellableExpression()})
                FROM inventory_balances b
                WHERE b.variant_id = v.id
              ) AS availableQuantity
       FROM ${requested ? 'requested_lines' : 'cart_lines'} cl
       JOIN variants v ON v.id = cl.variant_id
       LEFT JOIN shipping_profiles sp ON sp.id=v.shipping_profile_id
       JOIN products p ON p.id = v.product_id
       JOIN categories c ON c.id = p.category_id
       JOIN tax_classes t ON t.id = v.tax_class_id
       LEFT JOIN variant_price_versions price ON price.id = ${priceVersionFragment} AND price.variant_id = v.id
       ${requested ? '' : 'WHERE cl.cart_id = ?1'}
       ORDER BY cl.variant_id`,
    bindings: [
      requested ? JSON.stringify(options.lines) : options.cartId,
      ...(options.customerId ? [options.customerId] : [])
    ]
  }
}

export function mapQuoteLines(results: RawResolvedLine[]): ResolvedLine[] {
  const mapped = results.map((row) => ({
    ...row,
    availableQuantity: Number(row.availableQuantity),
    baseUnitGrossCents: Number(row.unitGrossCents),
    backorderAllowed: row.backorderAllowed === 1,
    unitGrossCents: selectVolumeUnitPrice(
      Number(row.unitGrossCents),
      Number(row.quantity),
      parseVolumeTiers(row.volumeTiersJson, Number(row.unitGrossCents))
    )
  }))
  if (
    mapped.some(
      (row) =>
        row.variantStatus !== 'published' ||
        row.productStatus !== 'published' ||
        row.categoryStatus !== 'published' ||
        row.publicationValid !== 1
    )
  )
    throw new CartError('variant_not_available', 'One or more cart variants are no longer available')
  return mapped
}

/** Server-priced goods gross for shipping promotions; uses the quote's exact tier resolver. */
export async function cartGoodsGrossCents(
  database: D1Database,
  cartId: string,
  instant: string,
  ownerSession?: VerifiedSessionClaims | null
): Promise<number> {
  const customerId = ownerSession ? await activeOrderCustomerId(database, ownerSession, instant) : null
  if (ownerSession && !customerId) throw new CartError('unauthorized', 'Customer session is no longer active')
  const company = customerId
    ? await database
        .prepare("SELECT 1 FROM companies WHERE customer_id=?1 AND status='approved'")
        .bind(customerId)
        .first()
    : null
  const lines = await resolveQuoteLines(database, { cartId, instant, ...(company && customerId ? { customerId } : {}) })
  if (!lines.length) throw new CartError('empty_cart', 'Cannot price shipping for an empty cart')
  const gross = lines.reduce((sum, line) => sum + line.unitGrossCents * line.quantity, 0)
  if (!Number.isSafeInteger(gross) || gross < 0) throw new CartInfrastructureError('Cart gross exceeds safe range')
  return gross
}

export interface ExpireReport {
  expiredCount: number
  at: string
}

export async function expireCart(database: D1Database, input: { cartId: string; at: string }): Promise<boolean> {
  assertCommandKey(input.cartId, 'cartId')
  assertInstant(input.at, 'at')
  await database
    .prepare(
      `UPDATE carts
       SET status = 'expired', expired_at = ?2, version = version + 1, updated_at = ?2
       WHERE id = ?1 AND status = 'active' AND expires_at <= ?2`
    )
    .bind(input.cartId, input.at)
    .run()
  const row = await loadCart(database, input.cartId)
  return row?.status === 'expired'
}

export async function expireCarts(database: D1Database, input: { at: string }): Promise<ExpireReport> {
  assertInstant(input.at, 'at')
  const before = await database
    .prepare("SELECT count(*) AS total FROM carts WHERE status = 'expired'")
    .first<{ total: number }>()
  await database
    .prepare(
      `UPDATE carts
       SET status = 'expired', expired_at = ?1, version = version + 1, updated_at = ?1
       WHERE status = 'active' AND expires_at <= ?1`
    )
    .bind(input.at)
    .run()
  const after = await database
    .prepare("SELECT count(*) AS total FROM carts WHERE status = 'expired'")
    .first<{ total: number }>()
  return { expiredCount: Number(after?.total ?? 0) - Number(before?.total ?? 0), at: input.at }
}

/** Marks a cart converted after checkout acceptance (used by later phases). */
export async function markConverted(
  database: D1Database,
  input: { cartId: string; expectedVersion: number; quoteId: string; now: string }
): Promise<void> {
  assertInstant(input.now, 'now')
  await database
    .prepare(
      `UPDATE carts
       SET status = 'converted', converted_quote_id = ?2, converted_at = ?3,
           version = version + 1, updated_at = ?3
       WHERE id = ?1 AND version = ?4 AND status = 'active' AND expires_at > ?3
         AND EXISTS (
           SELECT 1 FROM checkout_quotes quote
           WHERE quote.id = ?2 AND quote.cart_id = ?1 AND quote.cart_version = ?4
         )`
    )
    .bind(input.cartId, input.quoteId, input.now, input.expectedVersion)
    .run()
}
