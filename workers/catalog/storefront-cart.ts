import { selectVolumeUnitPrice, splitGross } from '../../server/domain/money'
import { MAX_CART_QUANTITY } from '../../shared/cart-limits'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { CartError, getCart, assertCartAuthorized, readCartAddOperation, type CartView } from './cart'
import { deriveOrderToken } from './checkout'
import { effectiveGovernedVersionIdExpression, inlineEffectivePricingSql } from './pricing'
import { parseVolumeTiers } from './volume-pricing'
import { publicationValidityExpression } from './publication-validity'
import { readPublicProductMedia } from '../media/public-catalog'

/** Cookie facade for the existing storefront contract; the opaque token never enters JSON. */
const COOKIE_NAME = 'neteco-cart-v2'
const RECOVERY_COOKIE_NAME = 'neteco-checkout-recovery-v1'
const COOKIE_PATTERN = /^v1\.([0-9a-f]{8}-[0-9a-f-]{27})\.([A-Za-z0-9_-]{43})$/i
const MAX_BODY_BYTES = 4096

export interface CartCredentials {
  cartId: string
  token: string
}

interface StorefrontDeps {
  database: D1Database
  dispatch: (command: Record<string, unknown>) => Promise<Response>
  edgeLimiter: RateLimit
  rateLimitPepper: string
  now?: () => string
}

interface ProjectedRow {
  productUuid: string
  variantUuid: string
  productId: number | null
  slug: string
  name: string
  brand: string
  variantId: number | null
  format: string
  sku: string
  basePrice: number
  priceTiersJson: string
  compareAtPrice: number | null
  referencePrice30d: number | null
  pricingVersion: string
  taxRateBasisPoints: number
  qty: number
  visualType: string | null
  visualColor: string | null
  minimumQuantity: number
  maximumQuantity: number | null
  quantityIncrement: number
}

function json(body: unknown, status = 200, cookies?: string | string[]): Response {
  const headers = new Headers({ 'cache-control': 'no-store' })
  for (const cookie of typeof cookies === 'string' ? [cookies] : (cookies ?? [])) headers.append('set-cookie', cookie)
  return Response.json(body, { status, headers })
}

export function credentials(request: Request): CartCredentials | null {
  const matches = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE_NAME}=`))
  if (matches.length !== 1) return null
  const matched = COOKIE_PATTERN.exec(matches[0]!.slice(COOKIE_NAME.length + 1))
  return matched ? { cartId: matched[1]!, token: matched[2]! } : null
}

export function setCartCookie(created: { cartId: string; token: string; expiresAt: string }, now: string): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(created.expiresAt) - Date.parse(now)) / 1000))
  return `${COOKIE_NAME}=v1.${created.cartId}.${created.token}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`
}

function deleteCookie(): string {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`
}

function inputError(): Response {
  return json({ error: { code: 'invalid_input' } }, 400)
}

function unauthorized(): Response {
  return json({ error: { code: 'unauthorized' } }, 401)
}

export function safeMutationRequest(request: Request): boolean {
  const origin = request.headers.get('origin')
  return origin === new URL(request.url).origin
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    total += chunk.value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(total)
  let position = 0
  for (const chunk of chunks) {
    bytes.set(chunk, position)
    position += chunk.byteLength
  }
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function validPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
  )
}

async function projectCart(
  database: D1Database,
  cart: CartView,
  now: string,
  identity: CartCredentials,
  started: number
) {
  const selectedPrice = inlineEffectivePricingSql(effectiveGovernedVersionIdExpression('v'), now)
  const { results } = await database
    .prepare(
      `SELECT p.id AS productUuid, v.id AS variantUuid,
              p.legacy_id AS productId, p.slug, p.name, COALESCE(b.name, '') AS brand,
              v.legacy_id AS variantId, v.format, v.sku,
              COALESCE(price.gross_cents, v.price_gross_cents) AS basePrice,
              COALESCE(price.volume_tiers, '[]') AS priceTiersJson,
              CASE WHEN price.id IS NULL THEN v.compare_at_gross_cents
                   ELSE price.compare_at_gross_cents END AS compareAtPrice,
              price.reference_gross_cents_30d AS referencePrice30d,
              COALESCE(price.id, 'legacy:' || v.id) AS pricingVersion,
              tax.rate_basis_points AS taxRateBasisPoints, cl.quantity AS qty,
              json_extract(p.attributes, '$.visual.type') AS visualType,
              json_extract(p.attributes, '$.visual.color') AS visualColor,
              v.minimum_quantity AS minimumQuantity,
              v.maximum_quantity AS maximumQuantity,
              v.quantity_increment AS quantityIncrement
       FROM cart_lines cl
       JOIN variants v ON v.id = cl.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN brands b ON b.id = p.brand_id
       JOIN tax_classes tax ON tax.id = v.tax_class_id
       LEFT JOIN variant_price_versions price ON price.id = ${selectedPrice} AND price.variant_id = v.id
       WHERE cl.cart_id = ?1
       ORDER BY cl.created_at, v.sku`
    )
    .bind(cart.cartId)
    .all<ProjectedRow>()
  const publishedMedia = await readPublicProductMedia(
    database,
    results.map((row) => row.productUuid)
  )
  // Media enrichment must not extend the lifetime of an earlier token proof or
  // mix old cart metadata with lines from a concurrently changed/converted cart.
  const authorizationInstant = new Date(Date.parse(now) + Math.max(0, Date.now() - started))
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
  const current = await getCart(database, { ...identity, now: authorizationInstant })
  if (current.status !== cart.status || current.version !== cart.version || current.expiresAt !== cart.expiresAt)
    throw new CartError('version_conflict', 'cart changed during projection')
  const items = results.map((row) => {
    if (!validPositiveInteger(row.productId) || !validPositiveInteger(row.variantId))
      throw new Error('Storefront cart cannot project a variant without legacy numeric IDs')
    const basePrice = Number(row.basePrice)
    const priceTiers = parseVolumeTiers(row.priceTiersJson, basePrice)
    const price = selectVolumeUnitPrice(basePrice, row.qty, priceTiers)
    const netPrice = splitGross(price, Number(row.taxRateBasisPoints)).netCents
    const lineNet = splitGross(price * row.qty, Number(row.taxRateBasisPoints)).netCents
    const photo = publishedMedia.get(row.productUuid)?.variants.get(row.variantUuid)
    return {
      productId: row.productId,
      slug: row.slug,
      name: row.name,
      brand: row.brand,
      variantId: row.variantId,
      format: row.format,
      sku: row.sku,
      price,
      basePrice,
      compareAtPrice: row.compareAtPrice,
      referencePrice30d: row.referencePrice30d,
      priceTiers,
      pricingVersion: row.pricingVersion,
      netPrice,
      lineNet,
      taxRateBasisPoints: row.taxRateBasisPoints,
      qty: row.qty,
      visual: { type: row.visualType || 'bottle', color: row.visualColor || '#64748b' },
      // A product-level or sibling-variant photo is not evidence for this SKU.
      image: photo?.image ?? null,
      imageAlt: photo?.imageAlt ?? null,
      minimumQuantity: row.minimumQuantity,
      maximumQuantity: row.maximumQuantity,
      quantityIncrement: row.quantityIncrement
    }
  })
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0)
  const subtotalNet = items.reduce((sum, item) => sum + item.lineNet, 0)
  return {
    id: cart.cartId,
    version: cart.version,
    status: cart.status,
    expiresAt: cart.expiresAt,
    items,
    count: items.reduce((sum, item) => sum + item.qty, 0),
    subtotal,
    subtotalNet,
    tax: subtotal - subtotalNet
  }
}

async function createNewCart(
  deps: StorefrontDeps,
  request: Request,
  now: string,
  recoveryCookie?: string,
  replacedConvertedCart = false
): Promise<Response> {
  const started = Date.now()
  const limit = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, deps.rateLimitPepper, 'storefront-cart')
  if (limit === 'unavailable') return json({ error: { code: 'abuse_control_unavailable' } }, 503)
  if (limit === 'limited') return json({ error: { code: 'rate_limited' } }, 429)
  const cartId = crypto.randomUUID()
  const createdResponse = await deps.dispatch({
    type: 'create',
    cartId,
    commandId: crypto.randomUUID(),
    payload: { correlationId: 'storefront', now }
  })
  if (createdResponse.status !== 201) return createdResponse
  const created = (await createdResponse.json()) as { cartId: string; token: string; expiresAt: string }
  if (created.cartId !== cartId || !created.token || !created.expiresAt)
    return json({ error: { code: 'internal' } }, 500)
  const cart = await getCart(deps.database, { cartId, token: created.token, now })
  return json(
    {
      ...(await projectCart(deps.database, cart, now, { cartId, token: created.token }, started)),
      replacedConvertedCart
    },
    200,
    [setCartCookie(created, now), ...(recoveryCookie ? [recoveryCookie] : [])]
  )
}

async function convertedCartRecoveryCookie(database: D1Database, cartId: string, cartToken: string, now: string) {
  const order = await database
    .prepare('SELECT id, created_at AS createdAt FROM orders WHERE cart_id = ?1 AND access_revoked_at IS NULL')
    .bind(cartId)
    .first<{ id: string; createdAt: string }>()
  if (!order) return undefined
  const remaining = Math.floor((Date.parse(order.createdAt) + 24 * 60 * 60 * 1000 - Date.parse(now)) / 1000)
  if (remaining <= 0) return undefined
  const token = await deriveOrderToken(cartToken, order.id)
  return `${RECOVERY_COOKIE_NAME}=v1.${order.id}.${token}; Max-Age=${remaining}; Path=/api/checkout/recover; HttpOnly; Secure; SameSite=Lax`
}

async function resolveLegacyVariant(database: D1Database, legacyId: number, availableOnly: boolean) {
  return database
    .prepare(
      `SELECT v.id, v.status AS variantStatus, p.status AS productStatus
       FROM variants v
       JOIN products p ON p.id = v.product_id
       JOIN categories c ON c.id = p.category_id
       WHERE v.legacy_id = ?1 ${
         availableOnly
           ? `AND v.status = 'published' AND p.status = 'published'
         AND c.status = 'published' AND ${publicationValidityExpression('p')}`
           : ''
       }`
    )
    .bind(legacyId)
    .first<{ id: string; variantStatus: string; productStatus: string }>()
}

/** Returns null for non-storefront paths so the existing canary routes remain intact. */
export async function handleStorefrontCartHttp(request: Request, deps: StorefrontDeps): Promise<Response | null> {
  const url = new URL(request.url)
  const isRoot = url.pathname === '/api/cart'
  const isAdd = url.pathname === '/api/cart/items'
  const itemMatch = /^\/api\/cart\/items\/([1-9]\d{0,14})$/.exec(url.pathname)
  const operationMatch = /^\/api\/cart\/operations\/([^/]+)$/.exec(url.pathname)
  if (!isRoot && !isAdd && !itemMatch && !operationMatch) return null
  if (
    !(isRoot && ['GET', 'DELETE'].includes(request.method)) &&
    !(isAdd && request.method === 'POST') &&
    !(operationMatch && request.method === 'GET') &&
    !(itemMatch && ['PUT', 'DELETE'].includes(request.method))
  )
    return json({ error: { code: 'method_not_allowed' } }, 405)
  if (request.method !== 'GET' && !safeMutationRequest(request)) return json({ error: { code: 'forbidden' } }, 403)

  const now = deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const started = Date.now()
  const identity = credentials(request)
  try {
    if (operationMatch) {
      if (!identity) return unauthorized()
      await assertCartAuthorized(deps.database, identity.cartId, identity.token)
      const limit = await checkAdministrativeEdgeLimit(
        request,
        deps.edgeLimiter,
        deps.rateLimitPepper,
        'storefront-cart'
      )
      if (limit !== 'allowed')
        return json(
          { error: { code: limit === 'limited' ? 'rate_limited' : 'unavailable' } },
          limit === 'limited' ? 429 : 503
        )
      let key: string
      try {
        key = decodeURIComponent(operationMatch[1]!)
      } catch {
        return inputError()
      }
      if (
        !validKey(key) ||
        ['variantId', 'quantity', 'expectedVersion'].some((name) => url.searchParams.getAll(name).length !== 1) ||
        [...url.searchParams.keys()].some((name) => !['variantId', 'quantity', 'expectedVersion'].includes(name))
      )
        return inputError()
      const values = ['variantId', 'quantity', 'expectedVersion'].map((name) => url.searchParams.get(name)!)
      if (values.some((value) => !/^[1-9]\d*$/.test(value))) return inputError()
      const [legacyId, quantity, expectedVersion] = values.map(Number)
      if (
        !validPositiveInteger(legacyId) ||
        !validPositiveInteger(quantity) ||
        quantity > MAX_CART_QUANTITY ||
        !validPositiveInteger(expectedVersion)
      )
        return inputError()
      const variant = await resolveLegacyVariant(deps.database, legacyId, false)
      return json(
        await readCartAddOperation(deps.database, {
          ...identity,
          idempotencyKey: key,
          variantId: variant?.id ?? `missing-legacy:${legacyId}`,
          quantity,
          expectedVersion
        })
      )
    }
    if (isRoot && request.method === 'GET') {
      if (!identity) return createNewCart(deps, request, now)
      try {
        const cart = await getCart(deps.database, { ...identity, now })
        if (cart.status !== 'active')
          return createNewCart(
            deps,
            request,
            now,
            cart.status === 'converted'
              ? await convertedCartRecoveryCookie(deps.database, identity.cartId, identity.token, now)
              : undefined,
            cart.status === 'converted'
          )
        return json(await projectCart(deps.database, cart, now, identity, started))
      } catch (error) {
        if (error instanceof CartError && error.code === 'unauthorized') return createNewCart(deps, request, now)
        throw error
      }
    }
    if (!identity) return unauthorized()
    if (isAdd && request.method === 'POST' && request.headers.has('X-Neteco-Cart-Id')) {
      // A frozen ADD must not move to a replacement cookie's cart. Authorize
      // first, without getCart(now): a mismatch must not even expire the cart.
      await assertCartAuthorized(deps.database, identity.cartId, identity.token)
      if (request.headers.get('X-Neteco-Cart-Id') !== identity.cartId) return json({ error: { code: 'conflict' } }, 409)
    }
    const current = await getCart(deps.database, { ...identity, now })
    if (current.status !== 'active' && !(isRoot && request.method === 'DELETE'))
      return json({ error: { code: 'not_active' } }, 409)

    const body = request.method === 'POST' || request.method === 'PUT' ? await readJson(request) : null
    if ((request.method === 'POST' || request.method === 'PUT') && !body) return inputError()
    const expectedVersion = body?.expectedVersion ?? Number(url.searchParams.get('expectedVersion'))
    const idempotencyKey = body?.idempotencyKey ?? url.searchParams.get('idempotencyKey')
    if (!validPositiveInteger(expectedVersion) || !validKey(idempotencyKey)) return inputError()

    let commandType: 'add' | 'mutate' | 'clear' = isAdd ? 'add' : 'mutate'
    let variantId = ''
    let quantity = 0
    if (isRoot) commandType = 'clear'
    else {
      const legacyId = isAdd ? body?.variantId : Number(itemMatch?.[1])
      if (!validPositiveInteger(legacyId)) return inputError()
      const variant = await resolveLegacyVariant(deps.database, legacyId, request.method !== 'DELETE')
      if (!variant) return json({ error: { code: 'variant_not_available' } }, 422)
      variantId = variant.id
      if (request.method !== 'DELETE') {
        if (typeof body?.quantity !== 'number' || !Number.isSafeInteger(body.quantity)) return inputError()
        quantity = body.quantity
        if (!validPositiveInteger(quantity) || quantity > MAX_CART_QUANTITY) return inputError()
      }
    }

    const outcome = await deps.dispatch({
      type: commandType,
      cartId: identity.cartId,
      commandId: idempotencyKey,
      payload: {
        cartId: identity.cartId,
        token: identity.token,
        idempotencyKey,
        expectedVersion,
        correlationId: 'storefront',
        now,
        ...(commandType === 'clear' ? {} : { variantId, quantity })
      }
    })
    if (!outcome.ok) return outcome
    if (isRoot) return json({ ok: true }, 200, deleteCookie())
    const updated = await getCart(deps.database, { ...identity, now })
    return json(await projectCart(deps.database, updated, now, identity, started))
  } catch (error) {
    if (error instanceof CartError)
      return json(
        { error: { code: error.code } },
        error.code === 'invalid_input' ? 400 : error.code === 'unauthorized' ? 401 : 409
      )
    return json({ error: { code: 'internal' } }, 500)
  }
}
