import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { CartError, getCart, type QuoteSnapshot } from './cart'
import { credentials, readJson, safeMutationRequest } from './storefront-cart'
import { assertDestination, ShippingError, type ShippingOptionSnapshot } from './shipping'
import type { VerifiedSessionClaims } from './authorization'
import { shippingCalendarEtaSchema } from '../../shared/shipping-calendar'

interface ShippingFacadeDeps {
  database: D1Database
  dispatch: (command: Record<string, unknown>) => Promise<Response>
  edgeLimiter: RateLimit
  rateLimitPepper: string
  now?: () => string
  session?: (request: Request) => Promise<VerifiedSessionClaims | null>
  authenticationEnabled?: boolean
}

interface QuotedResponse {
  outcome: 'quoted'
  quote: QuoteSnapshot
}

interface OptionsResponse {
  outcome: 'options'
  body: {
    expiresAt: string
    options: ShippingOptionSnapshot[]
    shippingQuoteId: string
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

function safeError(response: Response, body: unknown): Response {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const code = raw.error && typeof raw.error === 'object' ? (raw.error as Record<string, unknown>).code : raw.outcome
  const safeCode =
    typeof code === 'string' &&
    [
      'unauthorized',
      'invalid_input',
      'conflict',
      'version_conflict',
      'not_active',
      'empty_cart',
      'variant_not_available'
    ].includes(code)
      ? code
      : 'internal'
  return json({ error: { code: safeCode } }, response.status >= 400 ? response.status : 500)
}

function safeJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null) as Promise<unknown>
}

function isMoney(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isQuoted(value: unknown): value is QuotedResponse {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  if (result.outcome !== 'quoted' || !result.quote || typeof result.quote !== 'object') return false
  const quote = result.quote as Record<string, unknown>
  const totals = quote.totals as Record<string, unknown> | undefined
  return (
    typeof quote.quoteId === 'string' &&
    UUID.test(quote.quoteId) &&
    typeof quote.snapshotHash === 'string' &&
    HASH.test(quote.snapshotHash) &&
    typeof quote.pricingInstant === 'string' &&
    UTC_INSTANT.test(quote.pricingInstant) &&
    Number.isSafeInteger(quote.cartVersion) &&
    (quote.cartVersion as number) >= 1 &&
    !!totals &&
    isMoney(totals.netCents) &&
    isMoney(totals.taxCents) &&
    isMoney(totals.grossCents) &&
    totals.netCents + totals.taxCents === totals.grossCents
  )
}

async function originalCartVersion(database: D1Database, cartId: string, commandId: string): Promise<number | null> {
  const stored = await database
    .prepare(
      `SELECT response_body AS responseBody FROM cart_commands
       WHERE cart_id = ?1 AND command_id = ?2 AND kind = 'quote'`
    )
    .bind(cartId, commandId)
    .first<{ responseBody: string }>()
  if (!stored) return null
  let response: unknown
  try {
    response = JSON.parse(stored.responseBody)
  } catch {
    throw new Error('Invalid persisted shipping quote response')
  }
  if (!isQuoted(response) || response.quote.cartId !== cartId)
    throw new Error('Invalid persisted shipping quote response')
  return response.quote.cartVersion
}

function isOptions(value: unknown): value is OptionsResponse {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  if (result.outcome !== 'options' || !result.body || typeof result.body !== 'object') return false
  const body = result.body as Record<string, unknown>
  return (
    typeof body.shippingQuoteId === 'string' &&
    UUID.test(body.shippingQuoteId) &&
    typeof body.expiresAt === 'string' &&
    UTC_INSTANT.test(body.expiresAt) &&
    Array.isArray(body.options) &&
    body.options.length > 0 &&
    body.options.every((option: unknown) => {
      if (!option || typeof option !== 'object') return false
      const value = option as Record<string, unknown>
      return (
        ['pickup', 'own_delivery', 'parcel'].includes(String(value.methodCode)) &&
        ['parcel', 'pallet', 'adr'].includes(String(value.serviceProfile)) &&
        value.currency === 'EUR' &&
        typeof value.optionHash === 'string' &&
        HASH.test(value.optionHash) &&
        Number.isSafeInteger(value.optionIndex) &&
        (value.optionIndex as number) >= 0 &&
        Number.isSafeInteger(value.etaMinDays) &&
        (value.etaMinDays as number) >= 0 &&
        Number.isSafeInteger(value.etaMaxDays) &&
        (value.etaMaxDays as number) >= (value.etaMinDays as number) &&
        (value.etaMaxDays as number) <= 365 &&
        (value.eta === undefined || shippingCalendarEtaSchema.safeParse(value.eta).success) &&
        isMoney(value.netCents) &&
        isMoney(value.taxCents) &&
        isMoney(value.grossCents) &&
        isMoney(value.taxRateBasisPoints) &&
        value.taxRateBasisPoints <= 10_000 &&
        value.netCents + value.taxCents === value.grossCents
      )
    })
  )
}

function rateLabel(option: ShippingOptionSnapshot): string {
  if (option.methodCode === 'pickup') return 'Recogida en almacén'
  if (option.methodCode === 'own_delivery') return 'Reparto propio'
  return option.serviceProfile === 'pallet' ? 'Envío paletizado' : 'Envío peninsular'
}

/** Cookie-backed bridge for the existing checkout shipping-rate contract. */
export async function handleStorefrontShippingHttp(
  request: Request,
  deps: ShippingFacadeDeps
): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/api/shipping/rates') return null
  if (request.method !== 'POST') return json({ error: { code: 'method_not_allowed' } }, 405)
  if (!safeMutationRequest(request)) return json({ error: { code: 'forbidden' } }, 403)
  const identity = credentials(request)
  if (!identity) return json({ error: { code: 'unauthorized' } }, 401)
  const requestKey = request.headers.get('idempotency-key')
  if (!requestKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey))
    return json({ error: { code: 'invalid_input' } }, 400)
  const limit = await checkAdministrativeEdgeLimit(
    request,
    deps.edgeLimiter,
    deps.rateLimitPepper,
    'storefront-shipping'
  )
  if (limit === 'unavailable') return json({ error: { code: 'abuse_control_unavailable' } }, 503)
  if (limit === 'limited') return json({ error: { code: 'rate_limited' } }, 429)
  try {
    const body = await readJson(request)
    if (!body) return json({ error: { code: 'invalid_input' } }, 400)
    const allowed = new Set(['name', 'line1', 'postalCode', 'city', 'region', 'phone', 'couponCode'])
    if (Object.keys(body).some((key) => !allowed.has(key))) return json({ error: { code: 'invalid_input' } }, 400)
    if (body.couponCode !== undefined && body.couponCode !== null && typeof body.couponCode !== 'string')
      return json({ error: { code: 'invalid_input' } }, 400)
    const hasSession = (request.headers.get('cookie') ?? '')
      .split(';')
      .some((part) => part.trim().startsWith('neteco-session='))
    let ownerSession: VerifiedSessionClaims | null = null
    if (hasSession) {
      if (!deps.authenticationEnabled || !deps.session) return json({ error: { code: 'service_unavailable' } }, 503)
      ownerSession = await deps.session(request)
      if (!ownerSession) return json({ error: { code: 'unauthorized' } }, 401)
    }
    const destination = assertDestination({ postalCode: body.postalCode, city: body.city })
    const now = deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    const cart = await getCart(deps.database, { ...identity, now })
    const quoteKey = `storefront-quote:${requestKey}`
    // The first accepted version is part of the durable command identity. Reusing
    // the current version on retry would turn an identical request into a 409
    // after any cart mutation (or conversion), even though both snapshots exist.
    const persistedVersion = await originalCartVersion(deps.database, identity.cartId, quoteKey)
    if (persistedVersion === null && cart.status !== 'active') return json({ error: { code: 'not_active' } }, 409)
    const expectedVersion = persistedVersion ?? cart.version
    const quoteResponse = await deps.dispatch({
      type: 'quote',
      cartId: identity.cartId,
      commandId: quoteKey,
      payload: {
        cartId: identity.cartId,
        token: identity.token,
        expectedVersion,
        idempotencyKey: quoteKey,
        correlationId: 'storefront-shipping',
        now,
        ownerSession,
        ...(body.couponCode === undefined ? {} : { couponCode: body.couponCode })
      }
    })
    const quoted = await safeJson(quoteResponse)
    if (!quoteResponse.ok) return safeError(quoteResponse, quoted)
    if (!isQuoted(quoted) || quoted.quote.cartVersion !== expectedVersion)
      return json({ error: { code: 'internal' } }, 500)

    const shippingKey = `storefront-shipping:${requestKey}`
    const shippingResponse = await deps.dispatch({
      type: 'shipping-options',
      cartId: identity.cartId,
      commandId: shippingKey,
      payload: {
        cartId: identity.cartId,
        token: identity.token,
        expectedVersion,
        idempotencyKey: shippingKey,
        correlationId: 'storefront-shipping',
        destination,
        now,
        ownerSession
      }
    })
    const shipping = await safeJson(shippingResponse)
    if (!shippingResponse.ok) return safeError(shippingResponse, shipping)
    if (!isOptions(shipping)) return json({ error: { code: 'internal' } }, 500)

    const totals = quoted.quote.totals
    const rates = shipping.body.options.map((option) => ({
      serviceCode: option.methodCode,
      label: rateLabel(option),
      netCents: option.netCents,
      taxRateBasisPoints: option.taxRateBasisPoints,
      estimatedDeliveryFrom: option.eta?.status === 'estimated' ? option.eta.from : null,
      estimatedDeliveryTo: option.eta?.status === 'estimated' ? option.eta.to : null,
      etaStatus: option.eta?.status ?? 'unknown',
      etaReason:
        option.eta?.status === 'unknown'
          ? option.eta.reason
          : option.eta
            ? 'estimated_not_guaranteed'
            : 'calendar_not_configured',
      profile:
        option.methodCode === 'pickup'
          ? 'pickup'
          : option.methodCode === 'own_delivery'
            ? 'own_delivery'
            : option.serviceProfile,
      pricingVersion: quoted.quote.snapshotHash,
      subtotalNetCents: totals.netCents,
      taxCents: totals.taxCents + option.taxCents,
      totalGrossCents: totals.grossCents + option.grossCents,
      quoteId: quoted.quote.quoteId,
      shippingQuoteId: shipping.body.shippingQuoteId,
      optionIndex: option.optionIndex,
      optionHash: option.optionHash,
      expiresAt: shipping.body.expiresAt,
      shippingGrossCents: option.grossCents,
      shipmentMode: option.shipmentMode ?? 'together',
      shipments: option.shipments ?? []
    }))
    return json({
      cartVersion: expectedVersion,
      rates,
      ...(quoted.quote.promotion ? { promotion: quoted.quote.promotion } : {})
    })
  } catch (error) {
    if (error instanceof CartError || error instanceof ShippingError)
      return json(
        { error: { code: error.code } },
        error.code === 'unauthorized' ? 401 : error.code === 'invalid_input' ? 400 : 409
      )
    return json({ error: { code: 'internal' } }, 500)
  }
}
