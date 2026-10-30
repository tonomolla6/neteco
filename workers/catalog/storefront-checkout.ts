import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import type { VerifiedSessionClaims } from './authorization'
import { CartError, getCart } from './cart'
import { deriveOrderToken, getCustomerOwnedOrderView, getOrderView, type AddressInput } from './checkout'
import { credentials, readJson, safeMutationRequest } from './storefront-cart'
import { initiateRedsysPayment, PaymentError, type PaymentRuntimeConfiguration } from './payments'
import { sha256Hex } from './inventory'
import { activeOrderCustomerId, customerFulfillmentSql } from './customer-orders'
import { fulfillmentActionSchema } from '../../shared/order-fulfillment'
import { normalizeOrderPurchaseOrderReference } from './order-customer-reference'

interface StorefrontCheckoutDeps {
  database: D1Database
  dispatch: (command: Record<string, unknown>) => Promise<Response>
  edgeLimiter: RateLimit
  rateLimitPepper: string
  paymentConfiguration: () => PaymentRuntimeConfiguration | null
  session: (request: Request) => Promise<VerifiedSessionClaims | null>
  authenticationEnabled: boolean
  /** Separate, read-only sealed guest grant; never consulted by payment. */
  readGuestOrder?: (request: Request, orderId: string) => Promise<Record<string, unknown> | null>
  now?: () => string
}

const ORDER_COOKIE = 'neteco-order-access-v2'
const RECOVERY_COOKIE = 'neteco-checkout-recovery-v1'
const ACCESS_SECONDS = 24 * 60 * 60
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/

function json(body: unknown, status = 200, cookies?: string | string[]): Response {
  const headers = new Headers({ 'cache-control': 'no-store' })
  for (const cookie of typeof cookies === 'string' ? [cookies] : (cookies ?? [])) headers.append('set-cookie', cookie)
  return Response.json(body, { status, headers })
}

function invalid(): Response {
  return json({ error: { code: 'invalid_input' } }, 400)
}

function unauthorized(): Response {
  return json({ error: { code: 'unauthorized' } }, 401)
}

function onlyKeys(body: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(body).every((key) => keys.includes(key))
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function address(value: unknown): AddressInput | null {
  const raw = record(value)
  if (
    !raw ||
    !onlyKeys(raw, [
      'recipientName',
      'companyName',
      'taxId',
      'line1',
      'line2',
      'postalCode',
      'city',
      'region',
      'countryCode',
      'phone',
      'instructions'
    ]) ||
    typeof raw.recipientName !== 'string' ||
    typeof raw.line1 !== 'string' ||
    typeof raw.postalCode !== 'string' ||
    typeof raw.city !== 'string' ||
    typeof raw.region !== 'string' ||
    ['companyName', 'taxId', 'line2', 'countryCode', 'phone', 'instructions'].some(
      (key) => raw[key] !== undefined && typeof raw[key] !== 'string'
    )
  )
    return null
  return {
    recipientName: raw.recipientName.trim(),
    companyName: text(raw.companyName)?.trim() || undefined,
    taxId: text(raw.taxId)?.trim() || undefined,
    nif: text(raw.taxId)?.trim() || undefined,
    line1: raw.line1.trim(),
    line2: text(raw.line2)?.trim() || undefined,
    postalCode: raw.postalCode.trim(),
    city: raw.city.trim(),
    province: raw.region.trim(),
    countryCode: text(raw.countryCode) || 'ES',
    phone: text(raw.phone)?.trim() || undefined,
    instructions: text(raw.instructions)?.trim() || undefined
  }
}

function credentialCookie(request: Request, name: string): { id: string; token: string } | null {
  const matches = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
  if (matches.length !== 1) return null
  const match = /^v1\.([0-9a-f-]{36})\.([0-9a-f]{64})$/i.exec(matches[0]!.slice(name.length + 1))
  return match && UUID.test(match[1]!) ? { id: match[1]!, token: match[2]! } : null
}

function orderCookie(request: Request) {
  return credentialCookie(request, ORDER_COOKIE)
}

function clearRecoveryCookie() {
  return `${RECOVERY_COOKIE}=; Max-Age=0; Path=/api/checkout/recover; HttpOnly; Secure; SameSite=Lax`
}

/** Revoke only credentials actually presented by this browser on logout. */
export async function revokeStorefrontCredentials(
  database: D1Database,
  request: Request,
  now: string
): Promise<string[]> {
  const cart = credentials(request)
  const order = orderCookie(request)
  const recovery = credentialCookie(request, RECOVERY_COOKIE)
  const statements: D1PreparedStatement[] = []
  for (const credential of [order, recovery]) {
    if (!credential) continue
    statements.push(
      database
        .prepare(
          'UPDATE orders SET access_revoked_at = ?1 WHERE id = ?2 AND token_hash = ?3 AND access_revoked_at IS NULL'
        )
        .bind(now, credential.id, await sha256Hex(credential.token))
    )
  }
  if (cart) {
    const oldHash = await sha256Hex(cart.token)
    statements.push(
      database
        .prepare(
          `UPDATE orders SET access_revoked_at = ?1
           WHERE cart_id = ?2 AND access_revoked_at IS NULL
             AND EXISTS (SELECT 1 FROM carts WHERE id = ?2 AND token_hash = ?3)`
        )
        .bind(now, cart.cartId, oldHash)
    )
    statements.push(
      database
        .prepare('UPDATE carts SET token_hash = ?1, updated_at = ?2 WHERE id = ?3 AND token_hash = ?4')
        .bind(await sha256Hex(crypto.randomUUID()), now, cart.cartId, oldHash)
    )
  }
  if (statements.length) await database.batch(statements)
  return [
    `${ORDER_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
    `neteco-cart-v2=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
    clearRecoveryCookie()
  ]
}

function setOrderCookie(id: string, token: string, createdAt: string, now: string): string {
  const remaining = Math.max(0, Math.floor((Date.parse(createdAt) + ACCESS_SECONDS * 1000 - Date.parse(now)) / 1000))
  // The SSR order page must receive this cookie before its internal /api fetch.
  return `${ORDER_COOKIE}=v1.${id}.${token}; Max-Age=${remaining}; Path=/; HttpOnly; Secure; SameSite=Lax`
}

function accessIsCurrent(createdAt: unknown, now: string): boolean {
  const created = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN
  const current = Date.parse(now)
  return (
    Number.isFinite(created) &&
    Number.isFinite(current) &&
    created <= current &&
    current < created + ACCESS_SECONDS * 1000
  )
}

function safeCheckoutFailure(response: Response, result: unknown): Response {
  const raw = record(result)
  if (raw?.outcome === 'revalidation_required' && raw.reason === 'payment_total_non_positive')
    return json({ error: { code: 'payment_total_non_positive' } }, 422)
  if (raw?.outcome === 'revalidation_required') return json({ error: { code: 'CHECKOUT_QUOTE_CHANGED' } }, 409)
  const source = record(raw?.error)
  const code = source?.code ?? raw?.outcome
  const allowed = [
    'invalid_input',
    'unauthorized',
    'conflict',
    'version_conflict',
    'not_active',
    'empty_cart',
    'out_of_stock',
    'credit_unavailable',
    'credit_limit_exceeded'
  ]
  const safe = typeof code === 'string' && allowed.includes(code) ? code : 'internal'
  return json({ error: { code: safe } }, response.status >= 400 ? response.status : 500)
}

async function edgeLimit(
  request: Request,
  deps: StorefrontCheckoutDeps,
  scope: 'storefront-checkout' | 'storefront-payment'
) {
  const result = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, deps.rateLimitPepper, scope)
  if (result === 'limited') return json({ error: { code: 'rate_limited' } }, 429)
  if (result === 'unavailable') return json({ error: { code: 'abuse_control_unavailable' } }, 503)
  return null
}

async function createOrder(request: Request, deps: StorefrontCheckoutDeps): Promise<Response> {
  if (!safeMutationRequest(request)) return json({ error: { code: 'forbidden' } }, 403)
  const identity = credentials(request)
  if (!identity) return unauthorized()
  const limit = await edgeLimit(request, deps, 'storefront-checkout')
  if (limit) return limit
  const key = request.headers.get('idempotency-key')
  if (!key || !UUID.test(key)) return invalid()
  const body = await readJson(request)
  if (
    !body ||
    !onlyKeys(body, [
      'cartId',
      'cartVersion',
      'quoteId',
      'shippingQuoteId',
      'optionIndex',
      'optionHash',
      'expectedTotalGrossCents',
      'purchaseOrderReference',
      'customer',
      'shippingAddress',
      'billingAddress',
      'paymentMethod',
      'marketCheckout',
      'termsAccepted',
      'privacyNoticePresented',
      'marketingConsent'
    ])
  )
    return invalid()
  if (body.cartId !== identity.cartId || !UUID.test(identity.cartId)) return unauthorized()
  if (
    !Number.isSafeInteger(body.cartVersion) ||
    (body.cartVersion as number) < 1 ||
    !UUID.test(String(body.quoteId ?? '')) ||
    !UUID.test(String(body.shippingQuoteId ?? '')) ||
    !Number.isSafeInteger(body.optionIndex) ||
    (body.optionIndex as number) < 0 ||
    typeof body.optionHash !== 'string' ||
    !HASH.test(body.optionHash) ||
    !Number.isSafeInteger(body.expectedTotalGrossCents) ||
    (body.expectedTotalGrossCents as number) < 0 ||
    body.termsAccepted !== true ||
    body.privacyNoticePresented !== true ||
    typeof body.marketingConsent !== 'boolean'
  )
    return invalid()
  const purchaseOrderReference = normalizeOrderPurchaseOrderReference(body.purchaseOrderReference)
  // Newsletter confirmation delivery is not wired in this lane yet. Never silently
  // accept and discard an opt-in supplied at checkout.
  if (body.marketingConsent) return json({ error: { code: 'marketing_unavailable' } }, 422)
  if (body.paymentMethod !== 'tarjeta' && body.paymentMethod !== 'bizum' && body.paymentMethod !== 'transferencia')
    return json({ error: { code: 'method_unavailable' } }, 422)
  const customer = record(body.customer)
  const shippingAddress = address(body.shippingAddress)
  const billingAddress = address(body.billingAddress)
  if (
    !customer ||
    !onlyKeys(customer, ['name', 'company', 'nif', 'email', 'phone']) ||
    typeof customer.name !== 'string' ||
    typeof customer.email !== 'string' ||
    typeof customer.phone !== 'string' ||
    ['company', 'nif'].some((field) => customer[field] !== undefined && typeof customer[field] !== 'string') ||
    !shippingAddress ||
    !billingAddress
  )
    return invalid()

  const hasSession = /(?:^|;)\s*neteco-session=/.test(request.headers.get('cookie') ?? '')
  if (hasSession && !deps.authenticationEnabled) return json({ error: { code: 'authentication_unavailable' } }, 503)
  const ownerSession = hasSession ? await deps.session(request) : null
  if (hasSession && !ownerSession) return unauthorized()
  if (body.paymentMethod === 'transferencia' && !ownerSession)
    return json({ error: { code: 'method_unavailable' } }, 422)
  // The buyer only names the market profile version and terms they saw; tax, fees and methods are re-read server-side.
  let marketCheckout: Record<string, unknown> | null = null
  if (body.marketCheckout !== undefined) {
    const selected = record(body.marketCheckout)
    if (
      !selected ||
      !onlyKeys(selected, ['market', 'version', 'termsVersion']) ||
      typeof selected.market !== 'string' ||
      !/^[A-Z]{2}$/.test(selected.market) ||
      !Number.isSafeInteger(selected.version) ||
      (selected.version as number) < 1 ||
      typeof selected.termsVersion !== 'string' ||
      !/^[a-zA-Z0-9_-]{3,100}$/.test(selected.termsVersion)
    )
      return invalid()
    // Bizum is a Spanish instrument; account transfer maps to the B2B credit method.
    if (body.paymentMethod === 'bizum') return json({ error: { code: 'method_unavailable' } }, 422)
    marketCheckout = {
      market: selected.market,
      version: selected.version,
      termsVersion: selected.termsVersion,
      paymentMethod: body.paymentMethod === 'transferencia' ? 'credit' : 'card'
    }
  }
  const now = deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  // Authentication comes before the DO's durable replay lookup.
  await getCart(deps.database, { ...identity, now })
  const completed = await deps.database
    .prepare(
      `SELECT 1 AS ready FROM checkout_attempts attempt
       JOIN orders purchase ON purchase.id = attempt.order_id
       WHERE attempt.cart_id = ?1 AND attempt.command_key = ?2 AND attempt.state = 'completed'`
    )
    .bind(identity.cartId, key)
    .first<{ ready: number }>()
  // An already-committed order must remain recoverable if the first HTTP
  // response was lost and the payment integration subsequently goes offline.
  if (!completed && body.paymentMethod !== 'transferencia') {
    const payment = deps.paymentConfiguration()
    if (!payment) return json({ error: { code: 'payments_unavailable' } }, 503)
    if (body.paymentMethod === 'bizum' && !payment.bizumEnabled)
      return json({ error: { code: 'method_unavailable' } }, 422)
  }
  const response = await deps.dispatch({
    type: 'checkout',
    cartId: identity.cartId,
    commandId: key,
    payload: {
      cartId: identity.cartId,
      token: identity.token,
      idempotencyKey: key,
      expectedVersion: body.cartVersion,
      quoteId: body.quoteId,
      shippingQuoteId: body.shippingQuoteId,
      selectedOptionIndex: body.optionIndex,
      selectedOptionHash: body.optionHash,
      expectedTotalGrossCents: body.expectedTotalGrossCents,
      contactEmail: customer.email,
      contactName: customer.name,
      contactPhone: customer.phone,
      buyerCompanyName: text(customer.company) || undefined,
      buyerTaxId: text(customer.nif) || undefined,
      ...(purchaseOrderReference === null ? {} : { purchaseOrderReference }),
      shippingAddress,
      billingAddress,
      consentTos: true,
      // The privacy notice is presented, not a marketing/data-processing opt-in.
      consentPrivacy: true,
      correlationId: 'storefront-checkout',
      now,
      ownerSession,
      ...(body.paymentMethod === 'transferencia' ? { paymentMethod: 'credit' } : {}),
      ...(marketCheckout ? { marketCheckout } : {})
    }
  })
  const result: unknown = await response.json().catch(() => null)
  if (!response.ok) return safeCheckoutFailure(response, result)
  const outcome = record(result)
  const created = record(outcome?.body)
  if (
    outcome?.outcome !== 'order_created' ||
    !created ||
    typeof created.id !== 'string' ||
    !UUID.test(created.id) ||
    typeof created.orderToken !== 'string' ||
    !HASH.test(created.orderToken)
  )
    return json({ error: { code: 'internal' } }, 500)
  if (!accessIsCurrent(created.createdAt, now)) return unauthorized()
  return json({ id: created.id }, 201, setOrderCookie(created.id, created.orderToken, created.createdAt as string, now))
}

async function readOrder(request: Request, deps: StorefrontCheckoutDeps, orderId: string): Promise<Response> {
  const credential = orderCookie(request)
  if (!UUID.test(orderId)) return unauthorized()
  const limit = await edgeLimit(request, deps, 'storefront-payment')
  if (limit) return limit
  const now = deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  let view: Record<string, unknown> | null =
    credential?.id === orderId ? await getOrderView(deps.database, { orderId, token: credential.token, now }) : null
  let owner: { claims: VerifiedSessionClaims; customerId: string } | null = null
  let sealedGuest = false
  if (!view && deps.readGuestOrder) {
    view = await deps.readGuestOrder(request, orderId)
    sealedGuest = view !== null
  }
  if (!view) {
    const hasSession = /(?:^|;)\s*neteco-session=/.test(request.headers.get('cookie') ?? '')
    if (!hasSession) return unauthorized()
    if (!deps.authenticationEnabled) return json({ error: { code: 'authentication_unavailable' } }, 503)
    const claims = await deps.session(request)
    if (!claims) return unauthorized()
    const customerId = await activeOrderCustomerId(deps.database, claims, now)
    if (!customerId) return unauthorized()
    view = await getCustomerOwnedOrderView(deps.database, { orderId, claims, now, customerId })
    if (!view) return json({ error: { code: 'not_found' } }, 404)
    owner = { claims, customerId }
  }
  const raw = view as Record<string, unknown>
  const payment = record(view.payment)
  const shipping = record(view.shippingAddress)
  const state = String(payment?.status ?? 'awaiting_payment')
  const status =
    raw.status === 'cancelled'
      ? 'cancelado'
      : state === 'paid'
        ? 'pagado'
        : state === 'stock_exception'
          ? 'incidencia_stock'
          : state === 'failed' || state === 'cancelled'
            ? 'pago_fallido'
            : state === 'processing' || state === 'provider_authorised'
              ? 'procesando_pago'
              : 'pendiente_pago'
  const lastIntent = await deps.database
    .prepare('SELECT method FROM payment_intents WHERE order_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1')
    .bind(orderId)
    .first<{ method: string }>()
  const reservation = await deps.database
    .prepare('SELECT r.status FROM orders o JOIN inventory_reservations r ON r.id = o.reservation_id WHERE o.id = ?1')
    .bind(orderId)
    .first<{ status: string }>()
  const { results: items } = await deps.database
    .prepare(
      `SELECT ol.variant_id AS id, ol.name, q.format, ol.sku,
              ol.unit_gross_cents AS price, ol.quantity AS qty, ol.line_index AS lineIndex,
              ol.net_cents AS lineNetCents, ol.tax_cents AS lineTaxCents, ol.gross_cents AS lineGrossCents
       FROM order_lines ol JOIN orders o ON o.id = ol.order_id
       LEFT JOIN checkout_quote_lines q ON q.quote_id = o.quote_id AND q.line_index = ol.line_index
       WHERE ol.order_id = ?1 ORDER BY ol.line_index`
    )
    .bind(orderId)
    .all<{
      id: string
      name: string
      format: string
      sku: string
      price: number
      qty: number
      lineIndex: number
      lineNetCents: number
      lineTaxCents: number
      lineGrossCents: number
    }>()
  const gross = Number(raw.totalGrossCents)
  const shippingGross = await deps.database
    .prepare(
      'SELECT shipping_gross_cents AS gross, shipping_net_cents AS net, shipping_tax_cents AS tax FROM orders WHERE id = ?1'
    )
    .bind(orderId)
    .first<{ gross: number; net: number; tax: number }>()
  const validCents = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  if (
    !validCents(gross) ||
    !shippingGross ||
    ![shippingGross.gross, shippingGross.net, shippingGross.tax, raw.totalNetCents, raw.totalTaxCents].every(
      validCents
    ) ||
    shippingGross.net + shippingGross.tax !== shippingGross.gross
  )
    return json({ error: { code: 'internal' } }, 500)
  const contractualItems = items.map((item) => ({
    ...item,
    lineBaseGrossCents: item.price * item.qty,
    discountGrossCents: item.price * item.qty - item.lineGrossCents
  }))
  if (
    !contractualItems.length ||
    contractualItems.some(
      (item, index) =>
        item.lineIndex !== index ||
        !Number.isSafeInteger(item.qty) ||
        item.qty < 1 ||
        ![
          item.price,
          item.lineBaseGrossCents,
          item.discountGrossCents,
          item.lineNetCents,
          item.lineTaxCents,
          item.lineGrossCents
        ].every(validCents) ||
        item.lineNetCents + item.lineTaxCents !== item.lineGrossCents
    )
  )
    return json({ error: { code: 'internal' } }, 500)
  const sum = (
    field: 'lineBaseGrossCents' | 'discountGrossCents' | 'lineNetCents' | 'lineTaxCents' | 'lineGrossCents'
  ) => contractualItems.reduce((total, item) => total + item[field], 0)
  const subtotalBaseGrossCents = sum('lineBaseGrossCents'),
    discountGrossCents = sum('discountGrossCents'),
    subtotalNetCents = sum('lineNetCents'),
    goodsTaxCents = sum('lineTaxCents'),
    goodsGrossCents = sum('lineGrossCents')
  if (
    ![subtotalBaseGrossCents, discountGrossCents, subtotalNetCents, goodsTaxCents, goodsGrossCents].every(validCents) ||
    goodsGrossCents + shippingGross.gross !== gross ||
    subtotalNetCents + shippingGross.net !== raw.totalNetCents ||
    goodsTaxCents + shippingGross.tax !== raw.totalTaxCents
  )
    return json({ error: { code: 'internal' } }, 500)
  const shippingMethod =
    raw.shippingMethodCode === 'pickup' ? 'recogida' : raw.shippingMethodCode === 'own_delivery' ? 'reparto' : 'envio'
  // Release no asynchronous snapshot until the original grant is live again.
  // The same final SELECT projects only the immutable, audit-confirmed public
  // fulfillment state; it never loads private operational reasons/evidence.
  let confirmed: { id: string | null; fulfillmentStatus: unknown } | null
  if (owner) {
    const currentClaims = await deps.session(request)
    if (
      !currentClaims ||
      currentClaims.identityId !== owner.claims.identityId ||
      currentClaims.sessionId !== owner.claims.sessionId ||
      currentClaims.sessionVersion !== owner.claims.sessionVersion
    )
      return unauthorized()
    const finalNow = deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    confirmed = await deps.database
      .prepare(
        `WITH current_owner AS MATERIALIZED (
      SELECT c.id FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
      JOIN customers c ON c.id=i.customer_id AND c.status='active'
      WHERE s.id=?4 AND s.identity_id=?5 AND s.session_version=?6
        AND i.session_version=s.session_version AND i.status='active'
        AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=?2
        AND s.revoked_at IS NULL AND s.created_at<=?2 AND s.expires_at>?2 AND c.id=?3
    ) SELECT o.id,${customerFulfillmentSql('o.id', 'o.customer_id', '?2')} AS fulfillmentStatus
      FROM current_owner authority LEFT JOIN orders o ON o.id=?1 AND o.customer_id=authority.id`
      )
      .bind(
        orderId,
        finalNow,
        owner.customerId,
        owner.claims.sessionId,
        owner.claims.identityId,
        owner.claims.sessionVersion
      )
      .first<{ id: string | null; fulfillmentStatus: unknown }>()
    if (!confirmed) return unauthorized()
    if (!confirmed.id) return json({ error: { code: 'not_found' } }, 404)
  } else if (sealedGuest) {
    const finalNow = deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    confirmed = await deps.database
      .prepare(
        `SELECT o.id,${customerFulfillmentSql('o.id', 'o.customer_id', '?2')} AS fulfillmentStatus
        FROM orders o WHERE o.id=?1`
      )
      .bind(orderId, finalNow)
      .first<{ id: string; fulfillmentStatus: unknown }>()
    const current = await deps.readGuestOrder!(request, orderId)
    if (!current || current.id !== orderId || !confirmed) return unauthorized()
  } else {
    if (!credential) return unauthorized()
    const tokenHash = await sha256Hex(credential.token)
    const finalNow = deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    const cutoff = new Date(Date.parse(finalNow) - ACCESS_SECONDS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    confirmed = await deps.database
      .prepare(
        `SELECT o.id,
      ${customerFulfillmentSql('o.id', 'o.customer_id', '?2')} AS fulfillmentStatus FROM orders o
      WHERE o.id=?1 AND o.token_hash=?3 AND o.access_revoked_at IS NULL AND o.created_at<=?2 AND o.created_at>?4`
      )
      .bind(orderId, finalNow, tokenHash, cutoff)
      .first<{ id: string; fulfillmentStatus: unknown }>()
    if (!confirmed) return unauthorized()
  }
  const fulfillment = fulfillmentActionSchema.nullable().safeParse(confirmed.fulfillmentStatus)
  if (!fulfillment.success) return json({ error: { code: 'internal' } }, 500)
  const creditContract = await deps.database
    .prepare(
      "SELECT json_extract(payload_json,'$.paymentMethod') AS method FROM order_events WHERE order_id=?1 AND event_type='order.created' LIMIT 1"
    )
    .bind(orderId)
    .first<{ method: string | null }>()
  return json({
    source: 'cloudflare',
    ...(sealedGuest ? { accessMode: 'view_only' } : {}),
    id: orderId,
    status,
    orderStatus: raw.status,
    paymentStatus: state === 'paid' ? 'captured' : state === 'provider_authorised' ? 'authorized' : state,
    inventoryStatus: reservation?.status ?? 'unknown',
    fulfillmentStatus: fulfillment.data ?? 'untracked',
    invoiceStatus: 'untracked',
    name: raw.contactName || shipping?.recipientName || '',
    company: raw.buyerCompanyName ?? shipping?.companyName ?? null,
    nif: raw.buyerTaxId ?? null,
    email: raw.contactEmail,
    phone: raw.contactPhone ?? shipping?.phone ?? '',
    address: shipping?.line1 ?? '',
    zip: shipping?.postalCode ?? '',
    city: shipping?.city ?? '',
    province: shipping?.province ?? '',
    notes: shipping?.instructions ?? null,
    ...(typeof raw.purchaseOrderReference === 'string' ? { purchaseOrderReference: raw.purchaseOrderReference } : {}),
    shippingMethod,
    paymentMethod:
      creditContract?.method === 'transferencia'
        ? 'transferencia'
        : lastIntent?.method === 'card'
          ? 'tarjeta'
          : lastIntent?.method === 'bizum'
            ? 'bizum'
            : 'pendiente',
    transferInstructions: null,
    subtotal: gross - shippingGross.gross,
    subtotalBaseGrossCents,
    discountGrossCents,
    subtotalNetCents,
    goodsTaxCents,
    shippingNetCents: shippingGross.net,
    shippingTaxCents: shippingGross.tax,
    shippingCost: shippingGross.gross,
    tax: raw.totalTaxCents,
    total: gross,
    createdAt: raw.createdAt,
    reservationExpiresAt: raw.reservationExpiresAt,
    items: contractualItems
  })
}

async function recoverOrder(request: Request, deps: StorefrontCheckoutDeps): Promise<Response> {
  const identity = credentials(request)
  const fallback = credentialCookie(request, RECOVERY_COOKIE)
  if (!identity && !fallback) return json({ orderId: null })
  const limit = await edgeLimit(request, deps, 'storefront-checkout')
  if (limit) return limit
  const now = deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  let candidate: { id: string; token: string } | null = null
  if (identity) {
    try {
      // A converted cart authenticates the original buyer even if /api/cart
      // has not replaced its cookie yet.
      await getCart(deps.database, { ...identity, now })
      const order = await deps.database
        .prepare('SELECT id FROM orders WHERE cart_id = ?1')
        .bind(identity.cartId)
        .first<{ id: string }>()
      if (order) candidate = { id: order.id, token: await deriveOrderToken(identity.token, order.id) }
    } catch (error) {
      if (!(error instanceof CartError && error.code === 'unauthorized')) throw error
    }
  }
  candidate ??= fallback
  if (!candidate) return json({ orderId: null })
  const view = await getOrderView(deps.database, { orderId: candidate.id, token: candidate.token, now })
  if (!view) return unauthorized()
  const cookies = [
    setOrderCookie(candidate.id, candidate.token, String((view as Record<string, unknown>).createdAt), now)
  ]
  if (fallback) cookies.push(clearRecoveryCookie())
  return json({ orderId: candidate.id }, 200, cookies)
}

async function activeRedirect(database: D1Database, orderId: string, method: 'card' | 'bizum', now: string) {
  const active = await database
    .prepare(
      `SELECT command.response_body AS responseBody
       FROM payment_intents intent
       JOIN order_payment_states state ON state.order_id = intent.order_id
       JOIN payment_commands command ON command.order_id = intent.order_id
         AND json_extract(command.response_body, '$.paymentIntentId') = intent.id
       WHERE intent.order_id = ?1 AND intent.method = ?2
         AND intent.status = 'redirect_ready' AND intent.expires_at > ?3
         AND state.status = 'processing' AND state.active_intent_id = intent.id
       ORDER BY intent.created_at DESC, intent.id DESC LIMIT 1`
    )
    .bind(orderId, method, now)
    .first<{ responseBody: string }>()
  if (!active) return null
  const saved = record(JSON.parse(active.responseBody) as unknown)
  const redirect = record(saved?.redirect)
  const fields = record(redirect?.fields)
  if (
    !redirect ||
    !fields ||
    redirect.method !== 'POST' ||
    typeof redirect.actionUrl !== 'string' ||
    Object.values(fields).some((value) => typeof value !== 'string')
  )
    return null
  try {
    if (new URL(redirect.actionUrl).protocol !== 'https:') return null
  } catch {
    return null
  }
  return redirect
}

async function startPayment(request: Request, deps: StorefrontCheckoutDeps): Promise<Response> {
  if (!safeMutationRequest(request)) return json({ error: { code: 'forbidden' } }, 403)
  const credential = orderCookie(request)
  if (!credential) return unauthorized()
  const limit = await edgeLimit(request, deps, 'storefront-payment')
  if (limit) return limit
  const configuration = deps.paymentConfiguration()
  if (!configuration) return json({ error: { code: 'payments_unavailable' } }, 503)
  const key = request.headers.get('idempotency-key')
  if (!key || !UUID.test(key)) return invalid()
  const body = await readJson(request)
  if (!body || !onlyKeys(body, ['orderId', 'method']) || body.orderId !== credential.id) return unauthorized()
  if (body.method !== 'tarjeta' && body.method !== 'bizum') return invalid()
  if (body.method === 'bizum' && !configuration.bizumEnabled)
    return json({ error: { code: 'method_unavailable' } }, 422)
  const now = deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const view = await getOrderView(deps.database, { orderId: credential.id, token: credential.token, now })
  if (!view || !accessIsCurrent((view as Record<string, unknown>).createdAt, now)) return unauthorized()
  const paymentState = record(view.payment)
  // Never return a bank form after authorisation, including a replayed command.
  if (['paid', 'provider_authorised', 'stock_exception'].includes(String(paymentState?.status)))
    return json({ error: { code: 'already_paid' } }, 409)
  const method = body.method === 'tarjeta' ? 'card' : 'bizum'
  let result: Awaited<ReturnType<typeof initiateRedsysPayment>>
  try {
    result = await initiateRedsysPayment(
      deps.database,
      {
        orderId: credential.id,
        orderToken: credential.token,
        method,
        now,
        correlationId: 'storefront-payment',
        idempotencyKey: key
      },
      configuration
    )
  } catch (error) {
    if (error instanceof PaymentError && error.code === 'payment_in_progress') {
      const resumed = await activeRedirect(deps.database, credential.id, method, now)
      if (resumed) return json({ ok: true, redirect: resumed }, 200)
    }
    throw error
  }
  if (result.status !== 201 || !record(result.body.redirect)) return json({ error: { code: 'internal' } }, 500)
  return json({ ok: true, redirect: result.body.redirect }, 200)
}

/** Browser-facing order/payment routes; access credentials never enter JSON. */
export async function handleStorefrontCheckoutHttp(
  request: Request,
  deps: StorefrontCheckoutDeps
): Promise<Response | null> {
  const path = new URL(request.url).pathname
  const detail = /^\/api\/orders\/([^/]+)$/.exec(path)
  if (path !== '/api/orders' && path !== '/api/checkout/pay' && path !== '/api/checkout/recover' && !detail) return null
  if (path === '/api/checkout/recover') {
    if (request.method !== 'GET') return json({ error: { code: 'method_not_allowed' } }, 405)
    try {
      return await recoverOrder(request, deps)
    } catch (error) {
      if (error instanceof CartError && error.code === 'unauthorized') return unauthorized()
      return json({ error: { code: 'internal' } }, 500)
    }
  }
  // Account order history is a separate, live-session-authenticated GET route.
  if (path === '/api/orders' && request.method === 'GET') return null
  if (detail) {
    if ((request.headers.get('authorization') ?? '').startsWith('Order ')) return null
    if (request.method !== 'GET') return null
    try {
      return await readOrder(request, deps, detail[1]!)
    } catch {
      return json({ error: { code: 'internal' } }, 500)
    }
  }
  if (request.method !== 'POST') return json({ error: { code: 'method_not_allowed' } }, 405)
  try {
    return path === '/api/orders' ? await createOrder(request, deps) : await startPayment(request, deps)
  } catch (error) {
    if (error instanceof CartError)
      return json(
        { error: { code: error.code } },
        error.code === 'unauthorized' ? 401 : error.code === 'invalid_input' ? 400 : 409
      )
    if (error instanceof PaymentError && error.code !== 'infrastructure')
      return json(
        { error: { code: error.code } },
        error.code === 'unauthorized' ? 401 : error.code === 'invalid_input' ? 400 : 409
      )
    return json({ error: { code: 'internal' } }, 500)
  }
}
