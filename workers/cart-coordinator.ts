import {
  CartError,
  CartInfrastructureError,
  assertCartAuthorized,
  canonicalPayloadHash,
  clearCart,
  createCart,
  expireCart,
  quoteCart,
  setCartLine,
  type QuoteRequestInput,
  type SetLineInput
} from './catalog/cart'
import {
  placeOrder,
  requestShippingOptions,
  type CheckoutInventoryGateway,
  type PlaceOrderInput
} from './catalog/checkout'
import { INVENTORY_COORDINATOR_NAME, InventoryError, type ReserveResult, type SimpleResult } from './catalog/inventory'
import type { ShippingDestination } from './catalog/shipping'
import { assertDestination } from './catalog/shipping'
import type { VerifiedSessionClaims } from './catalog/authorization'
import { shippingCommercialPolicy } from '../server/utils/shipping-policy'
import { catalogPolicyUuidSchema } from '../shared/catalog-publication-policy'
import {
  cartRecoveryResumeInputSchema,
  type CartRecoveryResumeInput,
  type CartRecoveryReceipt
} from '../shared/cart-recovery'
import {
  CartRecoveryError,
  readD1CartRecoveryResumeAuthority,
  resumeD1CartRecovery,
  type CartRecoveryCartGrant
} from './marketing/cart-recovery'
import { productWatchHmacKey } from './runtime/product-watch'

/**
 * CartCoordinator partitions work ONE Durable Object instance PER CART.
 *
 * Partitioning key: `cartDoName(cartId)` maps each cart id to exactly one
 * instance name deterministically (`cart:${cartId}`). Different carts map to
 * different instances and therefore run fully in parallel; every command for
 * the same cart lands on the same instance, which serialises them (maxInFlight
 * = 1 per cart) and makes optimistic-concurrency conflicts impossible to lose.
 *
 * The object stores ONLY successful idempotent command responses (unbounded —
 * replays must survive any number of later commands) and expiry bookkeeping.
 * Cache fingerprints exclude credentials; the cart itself lives in D1 and
 * remains the single source of truth.
 */

export function cartDoName(cartId: string): string {
  if (!cartId || cartId.length > 200) throw new CartError('invalid_input', 'cartId is invalid')
  return `cart:${cartId}`
}

function isValidKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !hasControl(value)
}

function hasControl(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

function isCanonicalInstant(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
}

function isSessionClaims(value: unknown): value is VerifiedSessionClaims {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const claims = value as Record<string, unknown>
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return (
    typeof claims.identityId === 'string' &&
    uuid.test(claims.identityId) &&
    typeof claims.sessionId === 'string' &&
    uuid.test(claims.sessionId) &&
    Number.isSafeInteger(claims.sessionVersion) &&
    (claims.sessionVersion as number) > 0
  )
}

export interface CoordinatorDeps {
  database: D1Database
  /** Internal only: the recovery core reauthorizes every attempt and replay. */
  resumeRecovery?: (
    claims: VerifiedSessionClaims,
    input: CartRecoveryResumeInput,
    commandId: string,
    cartId: string
  ) => Promise<{ receipt: CartRecoveryReceipt; cart: CartRecoveryCartGrant }>
  inventory?: CheckoutInventoryGateway
  /** Trusted Worker environment policy; never read from a cart command. */
  freeShippingThresholdCents?: number | null
  /** SEC-036 trusted secret for the checkout coupon-fraud gate; never read from a cart command. */
  promoFraudPepper?: string
  /** Feature flag gating store credit redemption in checkout; disabled unless explicitly enabled. */
  storeCreditRedemptionEnabled?: boolean
  /** Durable per-command responses; unbounded by design. */
  getResponse: (commandId: string) => Promise<{ payloadHash: string; status: number; body: unknown } | undefined>
  putResponse: (commandId: string, value: { payloadHash: string; status: number; body: unknown }) => Promise<void>
  setAlarm: (atMs: number | null) => Promise<void>
  /** Remembers which cart this instance owns for alarm rescheduling. */
  putAlarmCartId?: (cartId: string) => Promise<void>
}

interface RawCommand {
  type?: unknown
  commandId?: unknown
  cartId?: unknown
  payload?: unknown
}

function parseMutatePayload(payload: unknown): { ok: true; input: SetLineInput } | { ok: false; message: string } {
  if (typeof payload !== 'object' || payload === null) return { ok: false, message: 'payload must be an object' }
  const raw = payload as Record<string, unknown>
  if (!isValidKey(raw.idempotencyKey)) return { ok: false, message: 'idempotencyKey is invalid' }
  if (!isValidKey(raw.token)) return { ok: false, message: 'token is invalid' }
  if (!isValidKey(raw.correlationId)) return { ok: false, message: 'correlationId is invalid' }
  if (!isCanonicalInstant(raw.now)) return { ok: false, message: 'now must be canonical ISO-8601 UTC' }
  if (!Number.isSafeInteger(raw.expectedVersion) || (raw.expectedVersion as number) < 1)
    return { ok: false, message: 'expectedVersion must be a positive integer' }
  if (!Number.isSafeInteger(raw.quantity) || (raw.quantity as number) < 0 || (raw.quantity as number) > 999)
    return { ok: false, message: 'quantity must be an integer between 0 and 999' }
  return {
    ok: true,
    input: {
      cartId: raw.cartId as string,
      correlationId: raw.correlationId as string,
      expectedVersion: raw.expectedVersion as number,
      idempotencyKey: raw.idempotencyKey as string,
      now: raw.now as string,
      quantity: raw.quantity as number,
      token: raw.token as string,
      variantId: typeof raw.variantId === 'string' ? raw.variantId : ''
    }
  }
}

function parseQuotePayload(payload: unknown): { ok: true; input: QuoteRequestInput } | { ok: false; message: string } {
  if (typeof payload !== 'object' || payload === null) return { ok: false, message: 'payload must be an object' }
  const raw = payload as Record<string, unknown>
  if (!isValidKey(raw.idempotencyKey)) return { ok: false, message: 'idempotencyKey is invalid' }
  if (!isValidKey(raw.token)) return { ok: false, message: 'token is invalid' }
  if (!isValidKey(raw.correlationId)) return { ok: false, message: 'correlationId is invalid' }
  if (!isCanonicalInstant(raw.now)) return { ok: false, message: 'now must be canonical ISO-8601 UTC' }
  if (!Number.isSafeInteger(raw.expectedVersion) || (raw.expectedVersion as number) < 1)
    return { ok: false, message: 'expectedVersion must be a positive integer' }
  if (raw.couponCode !== undefined && raw.couponCode !== null && typeof raw.couponCode !== 'string')
    return { ok: false, message: 'couponCode is invalid' }
  if (raw.ownerSession !== undefined && raw.ownerSession !== null && !isSessionClaims(raw.ownerSession))
    return { ok: false, message: 'ownerSession is invalid' }
  return {
    ok: true,
    input: {
      cartId: raw.cartId as string,
      correlationId: raw.correlationId as string,
      expectedVersion: raw.expectedVersion as number,
      idempotencyKey: raw.idempotencyKey as string,
      now: raw.now as string,
      token: raw.token as string,
      ...(raw.couponCode === undefined ? {} : { couponCode: raw.couponCode as string | null }),
      ...(raw.ownerSession === undefined ? {} : { ownerSession: raw.ownerSession as VerifiedSessionClaims | null })
    }
  }
}

function parseCheckoutPayload(
  cartId: string,
  payload: unknown
): { ok: true; input: PlaceOrderInput } | { ok: false; message: string } {
  if (typeof payload !== 'object' || payload === null) return { ok: false, message: 'payload must be an object' }
  const raw = payload as Record<string, unknown>
  for (const key of [
    'idempotencyKey',
    'token',
    'correlationId',
    'contactEmail',
    'quoteId',
    'shippingQuoteId',
    'selectedOptionHash'
  ] as const)
    if (typeof raw[key] !== 'string' || (raw[key] as string).length === 0)
      return { ok: false, message: `${key} is required` }
  if (!isCanonicalInstant(raw.now)) return { ok: false, message: 'now must be canonical ISO-8601 UTC' }
  if (!Number.isSafeInteger(raw.expectedVersion) || (raw.expectedVersion as number) < 1)
    return { ok: false, message: 'expectedVersion must be a positive integer' }
  if (!Number.isSafeInteger(raw.selectedOptionIndex) || (raw.selectedOptionIndex as number) < 0)
    return { ok: false, message: 'selectedOptionIndex is invalid' }
  if (
    raw.expectedTotalGrossCents !== undefined &&
    (!Number.isSafeInteger(raw.expectedTotalGrossCents) || (raw.expectedTotalGrossCents as number) < 0)
  )
    return { ok: false, message: 'expectedTotalGrossCents is invalid' }
  if (raw.consentTos !== true || raw.consentPrivacy !== true) return { ok: false, message: 'consents are mandatory' }
  if (typeof raw.shippingAddress !== 'object' || raw.shippingAddress === null)
    return { ok: false, message: 'shippingAddress is required' }
  for (const key of [
    'contactName',
    'contactPhone',
    'buyerCompanyName',
    'buyerTaxId',
    'purchaseOrderReference'
  ] as const)
    if (raw[key] !== undefined && typeof raw[key] !== 'string') return { ok: false, message: `${key} must be a string` }
  if (raw.paymentMethod !== undefined && raw.paymentMethod !== 'credit')
    return { ok: false, message: 'paymentMethod is invalid' }
  if (raw.marketCheckout !== undefined) {
    const selected = raw.marketCheckout as Record<string, unknown> | null
    if (
      typeof selected !== 'object' ||
      selected === null ||
      Array.isArray(selected) ||
      Object.keys(selected).some((key) => !['market', 'version', 'termsVersion', 'paymentMethod'].includes(key)) ||
      typeof selected.market !== 'string' ||
      !/^[A-Z]{2}$/.test(selected.market) ||
      !Number.isSafeInteger(selected.version) ||
      (selected.version as number) < 1 ||
      typeof selected.termsVersion !== 'string' ||
      !/^[a-zA-Z0-9_-]{3,100}$/.test(selected.termsVersion) ||
      !['card', 'bank_transfer', 'credit'].includes(selected.paymentMethod as string)
    )
      return { ok: false, message: 'marketCheckout is invalid' }
  }
  if (raw.ownerSession !== undefined && raw.ownerSession !== null && !isSessionClaims(raw.ownerSession))
    return { ok: false, message: 'ownerSession is invalid' }
  if (raw.salesQuote !== undefined) {
    if (!raw.salesQuote || typeof raw.salesQuote !== 'object' || Array.isArray(raw.salesQuote))
      return { ok: false, message: 'salesQuote is invalid' }
    const ref = raw.salesQuote as Record<string, unknown>
    if (
      Object.keys(ref).some((key) => !['quoteId', 'version', 'approvedHash'].includes(key)) ||
      typeof ref.quoteId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(ref.quoteId) ||
      !Number.isSafeInteger(ref.version) ||
      (ref.version as number) < 1 ||
      typeof ref.approvedHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(ref.approvedHash)
    )
      return { ok: false, message: 'salesQuote is invalid' }
  }
  return {
    ok: true,
    input: {
      billingAddress: raw.billingAddress as PlaceOrderInput['billingAddress'],
      cartId,
      consentPrivacy: true,
      consentTos: true,
      contactEmail: raw.contactEmail as string,
      contactName: raw.contactName as string | undefined,
      contactPhone: raw.contactPhone as string | undefined,
      buyerCompanyName: raw.buyerCompanyName as string | undefined,
      buyerTaxId: raw.buyerTaxId as string | undefined,
      purchaseOrderReference: raw.purchaseOrderReference as string | undefined,
      correlationId: raw.correlationId as string,
      expectedVersion: raw.expectedVersion as number,
      idempotencyKey: raw.idempotencyKey as string,
      now: raw.now as string,
      quoteId: raw.quoteId as string,
      selectedOptionHash: raw.selectedOptionHash as string,
      selectedOptionIndex: raw.selectedOptionIndex as number,
      expectedTotalGrossCents: raw.expectedTotalGrossCents as number | undefined,
      shippingAddress: raw.shippingAddress as PlaceOrderInput['shippingAddress'],
      shippingQuoteId: raw.shippingQuoteId as string,
      token: raw.token as string,
      ownerSession: raw.ownerSession as VerifiedSessionClaims | null | undefined,
      ...(raw.paymentMethod === 'credit' ? { paymentMethod: 'credit' as const } : {}),
      ...(raw.marketCheckout === undefined
        ? {}
        : { marketCheckout: raw.marketCheckout as PlaceOrderInput['marketCheckout'] }),
      ...(raw.salesQuote === undefined ? {} : { salesQuote: raw.salesQuote as PlaceOrderInput['salesQuote'] })
    }
  }
}

export async function handleCartCommand(
  command: RawCommand,
  deps: CoordinatorDeps
): Promise<{ status: number; body: Record<string, unknown>; rescheduleForCartId?: string }> {
  if (!isValidKey(command.commandId)) return { status: 400, body: { error: { code: 'invalid_input' } } }

  let result: { status: number; body: Record<string, unknown>; rescheduleForCartId?: string }
  let cacheHash: string | null = null
  try {
    switch (command.type) {
      case 'cart-recovery-resume': {
        const payload = command.payload
        if (
          !catalogPolicyUuidSchema.safeParse(command.commandId).success ||
          !catalogPolicyUuidSchema.safeParse(command.cartId).success ||
          !payload ||
          typeof payload !== 'object' ||
          Array.isArray(payload) ||
          Object.keys(payload).some((key) => !['claims', 'input'].includes(key))
        )
          return { status: 400, body: { error: { code: 'invalid_input' } } }
        const raw = payload as Record<string, unknown>,
          input = cartRecoveryResumeInputSchema.safeParse(raw.input)
        if (!isSessionClaims(raw.claims) || !input.success)
          return { status: 400, body: { error: { code: 'invalid_input' } } }
        if (!deps.resumeRecovery) return { status: 503, body: { error: { code: 'service_unavailable' } } }
        // The internal response contains freshly derived HttpOnly possession.
        // It must never enter this object's durable command-response cache.
        const resumed = await deps.resumeRecovery(raw.claims, input.data, command.commandId, command.cartId as string)
        return { status: 200, body: resumed as unknown as Record<string, unknown> }
      }
      case 'create': {
        if (!isValidKey(command.cartId) || !isCanonicalInstant((command.payload as Record<string, unknown>)?.now))
          return { status: 400, body: { error: { code: 'invalid_input' } } }
        const created = await createCart(deps.database, {
          cartId: command.cartId,
          correlationId: ((command.payload as Record<string, unknown>).correlationId as string) ?? 'api',
          now: (command.payload as Record<string, unknown>).now as string
        })
        result = {
          status: 201,
          body: created as unknown as Record<string, unknown>,
          rescheduleForCartId: created.cartId
        }
        break
      }
      case 'add':
      case 'mutate': {
        if (!isValidKey(command.cartId)) return { status: 400, body: { error: { code: 'invalid_input' } } }
        const parsed = parseMutatePayload(command.payload)
        if (!parsed.ok || parsed.input.cartId !== command.cartId)
          return { status: 400, body: { error: { code: 'invalid_input' } } }
        await assertCartAuthorized(deps.database, parsed.input.cartId, parsed.input.token)
        cacheHash = await canonicalPayloadHash({
          cartId: parsed.input.cartId,
          expectedVersion: parsed.input.expectedVersion,
          quantity: parsed.input.quantity,
          type: command.type,
          variantId: parsed.input.variantId
        })
        const cached = await deps.getResponse(command.commandId)
        if (cached)
          return cached.payloadHash === cacheHash
            ? { status: cached.status, body: cached.body as Record<string, unknown> }
            : { status: 409, body: { error: { code: 'conflict' } } }
        const outcome = await setCartLine(deps.database, {
          ...parsed.input,
          ...(command.type === 'add' ? { mode: 'add' as const } : {})
        })
        const status = outcome.outcome === 'applied' ? 200 : 409
        result = {
          status,
          body: outcome as unknown as Record<string, unknown>,
          rescheduleForCartId: command.cartId as string
        }
        break
      }
      case 'clear': {
        if (!isValidKey(command.cartId)) return { status: 400, body: { error: { code: 'invalid_input' } } }
        const parsed = parseQuotePayload(command.payload)
        if (!parsed.ok || parsed.input.cartId !== command.cartId)
          return { status: 400, body: { error: { code: 'invalid_input' } } }
        await assertCartAuthorized(deps.database, parsed.input.cartId, parsed.input.token)
        cacheHash = await canonicalPayloadHash({
          cartId: parsed.input.cartId,
          expectedVersion: parsed.input.expectedVersion,
          type: 'clear'
        })
        const cached = await deps.getResponse(command.commandId)
        if (cached)
          return cached.payloadHash === cacheHash
            ? { status: cached.status, body: cached.body as Record<string, unknown> }
            : { status: 409, body: { error: { code: 'conflict' } } }
        const outcome = await clearCart(deps.database, parsed.input)
        result = {
          status: outcome.outcome === 'applied' ? 200 : 409,
          body: outcome as unknown as Record<string, unknown>,
          rescheduleForCartId: command.cartId
        }
        break
      }
      case 'quote': {
        if (!isValidKey(command.cartId)) return { status: 400, body: { error: { code: 'invalid_input' } } }
        const parsed = parseQuotePayload(command.payload)
        if (!parsed.ok || parsed.input.cartId !== command.cartId)
          return { status: 400, body: { error: { code: 'invalid_input' } } }
        await assertCartAuthorized(deps.database, parsed.input.cartId, parsed.input.token)
        // Private and coupon replays always check LIVE customer authority and the durable
        // payload (normalized code + server-resolved owner), never the DO cache.
        cacheHash =
          parsed.input.couponCode || parsed.input.ownerSession
            ? null
            : await canonicalPayloadHash({
                cartId: parsed.input.cartId,
                expectedVersion: parsed.input.expectedVersion,
                type: 'quote'
              })
        const cached = cacheHash ? await deps.getResponse(command.commandId) : undefined
        if (cached)
          return cached.payloadHash === cacheHash
            ? { status: cached.status, body: cached.body as Record<string, unknown> }
            : { status: 409, body: { error: { code: 'conflict' } } }
        const outcome = await quoteCart(deps.database, parsed.input)
        const status = outcome.outcome === 'quoted' ? 200 : outcome.outcome === 'empty_cart' ? 422 : 409
        result = { status, body: outcome as unknown as Record<string, unknown> }
        break
      }
      case 'shipping-options': {
        if (!isValidKey(command.cartId)) return { status: 400, body: { error: { code: 'invalid_input' } } }
        const raw = (command.payload ?? {}) as Record<string, unknown>
        const parsed = parseQuotePayload({ ...raw, cartId: command.cartId })
        if (!parsed.ok || parsed.input.cartId !== command.cartId)
          return { status: 400, body: { error: { code: 'invalid_input' } } }
        let destination: ShippingDestination
        try {
          destination = assertDestination(raw.destination)
        } catch {
          return { status: 400, body: { error: { code: 'invalid_input' } } }
        }
        await assertCartAuthorized(deps.database, parsed.input.cartId, parsed.input.token)
        cacheHash = parsed.input.ownerSession
          ? null
          : await canonicalPayloadHash({
              cartId: parsed.input.cartId,
              destination,
              expectedVersion: parsed.input.expectedVersion,
              type: 'shipping-options'
            })
        const cached = cacheHash ? await deps.getResponse(command.commandId) : undefined
        if (cached)
          return cached.payloadHash === cacheHash
            ? { status: cached.status, body: cached.body as Record<string, unknown> }
            : { status: 409, body: { error: { code: 'conflict' } } }
        const outcome = await requestShippingOptions(deps.database, {
          ...parsed.input,
          destination,
          freeShippingThresholdCents: deps.freeShippingThresholdCents
        })
        const status = outcome.outcome === 'options' ? 200 : outcome.outcome === 'empty_cart' ? 422 : 409
        result = { status, body: outcome as unknown as Record<string, unknown> }
        break
      }
      case 'checkout': {
        if (!isValidKey(command.cartId)) return { status: 400, body: { error: { code: 'invalid_input' } } }
        const parsedCheckout = parseCheckoutPayload(command.cartId, command.payload)
        if (!parsedCheckout.ok) return { status: 400, body: { error: { code: 'invalid_input' } } }
        await assertCartAuthorized(deps.database, command.cartId, parsedCheckout.input.token)
        // Checkout responses contain the one-time order access token. They are
        // replayed from D1 and deterministically re-derived, never persisted in
        // this DO's response cache.
        const outcome = await placeOrder(
          deps.database,
          parsedCheckout.input,
          deps.inventory,
          deps.freeShippingThresholdCents,
          {
            ...(deps.promoFraudPepper === undefined ? {} : { promoFraudPepper: deps.promoFraudPepper }),
            ...(deps.storeCreditRedemptionEnabled === undefined
              ? {}
              : { storeCreditRedemptionEnabled: deps.storeCreditRedemptionEnabled })
          }
        )
        const status =
          outcome.outcome === 'order_created'
            ? 200
            : outcome.outcome === 'out_of_stock' ||
                outcome.outcome === 'credit_unavailable' ||
                outcome.outcome === 'credit_limit_exceeded'
              ? 409
              : outcome.outcome === 'revalidation_required'
                ? 409
                : 422
        result = { status, body: outcome as unknown as Record<string, unknown> }
        break
      }
      default:
        return { status: 400, body: { error: { code: 'invalid_input' } } }
    }
  } catch (error) {
    if (error instanceof CartRecoveryError) {
      const status =
        error.code === 'invalid_input'
          ? 400
          : error.code === 'unauthenticated'
            ? 401
            : ['email_unverified', 'mfa_required', 'consent_required'].includes(error.code)
              ? 403
              : error.code === 'not_found'
                ? 404
                : ['conflict', 'version_conflict', 'cart_unavailable'].includes(error.code)
                  ? 409
                  : 503
      return { status, body: { error: { code: error.code } } }
    }
    if (error instanceof CartInfrastructureError || !(error instanceof CartError))
      return { status: 500, body: { error: { code: 'internal' } } }
    if (error instanceof CartError)
      return {
        status:
          error.code === 'invalid_input'
            ? 400
            : error.code === 'unauthorized'
              ? 401
              : error.code === 'empty_cart'
                ? 422
                : error.code === 'variant_not_available'
                  ? 422
                  : 409,
        body: { error: { code: error.code } }
      }
    // Infrastructure failures are NEVER presented as business outcomes.
    return { status: 500, body: { error: { code: 'internal' } } }
  }

  if (cacheHash && result.status >= 200 && result.status < 300)
    await deps.putResponse(command.commandId, {
      body: result.body,
      payloadHash: cacheHash,
      status: result.status
    })
  if (result.rescheduleForCartId) await scheduleCartExpiry(deps, result.rescheduleForCartId)
  return result
}

/** Schedules THIS cart's expiry alarm from live D1 data; stale alarms are no-ops. */
export async function scheduleCartExpiry(deps: CoordinatorDeps, cartId: string): Promise<void> {
  const row = await deps.database
    .prepare("SELECT expires_at AS due FROM carts WHERE id = ?1 AND status = 'active'")
    .bind(cartId)
    .first<{ due: string }>()
  await deps.setAlarm(row?.due ? Date.parse(row.due) : null)
  await deps.putAlarmCartId?.(cartId)
}

/** Same canonical transport used by carts and private commercial conversion. */
export function createCheckoutInventoryGateway(namespace: CloudflareEnv['INVENTORY']): CheckoutInventoryGateway {
  const command = async <T>(type: 'reserve' | 'release', payload: unknown): Promise<T> => {
    const stub = namespace.get(namespace.idFromName(INVENTORY_COORDINATOR_NAME))
    const raw = payload as { idempotencyKey: string }
    const operation = payload as { now?: string }
    const commandId =
      type === 'reserve' ? `${type}:${raw.idempotencyKey}` : `${type}:${raw.idempotencyKey}:${operation.now ?? ''}`
    const response = await stub.fetch('https://inventory.internal/command', {
      body: JSON.stringify({ commandId, payload, type }),
      headers: { 'content-type': 'application/json' },
      method: 'POST'
    })
    const body = (await response.json()) as Record<string, unknown>
    if (response.status >= 500) throw new Error('inventory coordinator unavailable')
    if ('error' in body) {
      const error = body.error as { code?: string; message?: string }
      if (error.code === 'insufficient_stock')
        throw new InventoryError('insufficient_stock', error.message ?? 'Insufficient inventory')
      throw new Error(`inventory coordinator rejected command: ${error.code ?? 'unknown'}`)
    }
    return body as T
  }
  return {
    release: (input) => command<SimpleResult>('release', input),
    reserve: (input) => command<ReserveResult>('reserve', input)
  }
}

export class CartCoordinator implements DurableObject {
  private serial = Promise.resolve()

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: CloudflareEnv
  ) {}

  private runSerially<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation)
    this.serial = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'POST' || url.pathname !== '/command')
      return Response.json({ error: { code: 'not_found' } }, { status: 404 })

    let command: RawCommand
    try {
      command = (await request.json()) as RawCommand
    } catch {
      return Response.json({ error: { code: 'invalid_input', message: 'body must be JSON' } }, { status: 400 })
    }

    let outcome: Awaited<ReturnType<typeof handleCartCommand>>
    try {
      outcome = await this.runSerially(() =>
        handleCartCommand(command, {
          database: this.env.DB,
          resumeRecovery: this.recoveryGateway(),
          inventory: this.env.INVENTORY ? this.inventoryGateway() : undefined,
          freeShippingThresholdCents: this.freeShippingThreshold(),
          promoFraudPepper: this.env.AUTH_RATE_LIMIT_PEPPER,
          storeCreditRedemptionEnabled:
            (this.env as CloudflareEnv & { STORE_CREDIT_REDEMPTION_ENABLED?: string })
              .STORE_CREDIT_REDEMPTION_ENABLED === 'true',
          getResponse: (commandId) => this.state.storage.get(`cmd:${commandId}`),
          putResponse: (commandId, value) => this.state.storage.put(`cmd:${commandId}`, value),
          setAlarm: (atMs) => (atMs === null ? this.state.storage.deleteAlarm() : this.state.storage.setAlarm(atMs)),
          putAlarmCartId: (cartId) => this.state.storage.put('alarmCartId', cartId)
        })
      )
    } catch {
      return Response.json({ error: { code: 'internal' } }, { status: 500 })
    }
    return Response.json(outcome.body, { status: outcome.status })
  }

  /** Expire only this object's cart; a stale alarm is gated by expires_at. */
  async alarm(): Promise<void> {
    await this.runSerially(async () => {
      // Cloudflare returns null from getAlarm() while this handler is running.
      // The durable cart identity and D1's live expiry gate remain authoritative.
      // https://developers.cloudflare.com/durable-objects/api/alarms/#getalarm
      const cartId = await this.state.storage.get<string>('alarmCartId')
      if (!cartId) {
        await this.state.storage.deleteAlarm()
        return
      }
      await expireCart(this.env.DB, {
        cartId,
        at: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
      })
      // An early or obsolete wake-up cannot expire a renewed cart; re-arm from
      // current D1 data rather than the already-consumed platform alarm.
      await scheduleCartExpiry(this.dependencies(), cartId)
    })
  }

  private dependencies(): CoordinatorDeps {
    return {
      database: this.env.DB,
      inventory: this.env.INVENTORY ? this.inventoryGateway() : undefined,
      freeShippingThresholdCents: this.freeShippingThreshold(),
      promoFraudPepper: this.env.AUTH_RATE_LIMIT_PEPPER,
      getResponse: (commandId) => this.state.storage.get(`cmd:${commandId}`),
      putResponse: (commandId, value) => this.state.storage.put(`cmd:${commandId}`, value),
      setAlarm: (atMs) => (atMs === null ? this.state.storage.deleteAlarm() : this.state.storage.setAlarm(atMs))
    }
  }

  private recoveryGateway(): CoordinatorDeps['resumeRecovery'] {
    if (this.env.CART_RECOVERY_ENABLED !== 'true' || this.env.AUTH_ENABLED !== 'true') return undefined
    const hmacKey = productWatchHmacKey(this.env)
    return async (claims, input, commandId, cartId) => {
      const options = { hmacKey }
      const authority = await readD1CartRecoveryResumeAuthority(this.env.DB, claims, input, options)
      if (authority.cartId !== cartId) throw new CartRecoveryError('not_found')
      return resumeD1CartRecovery(this.env.DB, claims, input, commandId, options)
    }
  }

  private freeShippingThreshold(): number | null {
    return shippingCommercialPolicy({
      APP_ENV: this.env.APP_ENV,
      FREE_SHIPPING_THRESHOLD_CENTS: this.env.FREE_SHIPPING_THRESHOLD_CENTS
    } as NodeJS.ProcessEnv).freeShippingThresholdCents
  }

  private inventoryGateway(): CheckoutInventoryGateway {
    return createCheckoutInventoryGateway(this.env.INVENTORY)
  }
}
