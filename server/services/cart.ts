import { createError, deleteCookie, getCookie, setCookie, type H3Event } from 'h3'
import type { TransactionSql } from 'postgres'
import { validateQuantity } from '../domain/money'
import { useDatabase } from '../db/client'
import { hashOpaqueToken, randomOpaqueToken } from '../utils/secrets'

const CART_COOKIE = 'neteco-cart'
const CART_TTL_SECONDS = 60 * 60 * 24 * 90

interface CartReference {
  id: string
  version: number
  customer_id: string | null
  status: string
}

export interface ServerCartItem {
  productId: number
  slug: string
  name: string
  brand: string
  variantId: number
  format: string
  sku: string
  price: number
  qty: number
  visual: { type: string; color: string }
  image: string | null
  minimumQuantity: number
  maximumQuantity: number | null
  quantityIncrement: number
}

export interface ServerCart {
  id: string
  version: number
  status: string
  expiresAt: string
  items: ServerCartItem[]
  count: number
  subtotal: number
}

function cartCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.APP_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: CART_TTL_SECONDS
  }
}

async function optionalCustomerId(event: H3Event) {
  const session = await getUserSession(event)
  if (!session.user?.id) return null
  const sql = useDatabase()
  const [identity] = await sql<{ customer_id: string | null }[]>`
    SELECT customer_id FROM identities WHERE id = ${session.user.id}
  `
  return identity?.customer_id ?? null
}

function publicTokenHash(event: H3Event, token: string) {
  const runtime = useRuntimeConfig(event)
  return hashOpaqueToken(token, String(runtime.auth.tokenPepper))
}

async function findCart(event: H3Event, customerId: string | null) {
  const sql = useDatabase()
  const token = getCookie(event, CART_COOKIE)
  if (token) {
    const [cart] = await sql<CartReference[]>`
      SELECT id, version, customer_id, status
      FROM carts
      WHERE public_token_hash = ${publicTokenHash(event, token)}
        AND status = 'active' AND expires_at > now()
    `
    if (cart && (!cart.customer_id || !customerId || cart.customer_id === customerId)) return cart
  }
  if (!customerId) return null
  const [cart] = await sql<CartReference[]>`
    SELECT id, version, customer_id, status
    FROM carts
    WHERE customer_id = ${customerId} AND status = 'active' AND expires_at > now()
    ORDER BY updated_at DESC
    LIMIT 1
  `
  return cart ?? null
}

async function createCart(event: H3Event, customerId: string | null) {
  const sql = useDatabase()
  const token = randomOpaqueToken()
  const [cart] = await sql<CartReference[]>`
    INSERT INTO carts (public_token_hash, customer_id, expires_at)
    VALUES (${publicTokenHash(event, token)}, ${customerId}, now() + interval '90 days')
    RETURNING id, version, customer_id, status
  `
  if (!cart) throw new Error('Cart creation returned no row')
  setCookie(event, CART_COOKIE, token, cartCookieOptions())
  return cart
}

async function bindCart(event: H3Event, cart: CartReference, customerId: string | null) {
  const sql = useDatabase()
  let current = cart
  if (customerId && !cart.customer_id) {
    const [bound] = await sql<CartReference[]>`
      UPDATE carts SET customer_id = ${customerId}, updated_at = now()
      WHERE id = ${cart.id} AND customer_id IS NULL
      RETURNING id, version, customer_id, status
    `
    if (bound) current = bound
  }
  if (!getCookie(event, CART_COOKIE)) {
    const token = randomOpaqueToken()
    const [rotated] = await sql<CartReference[]>`
      UPDATE carts SET public_token_hash = ${publicTokenHash(event, token)}, updated_at = now()
      WHERE id = ${current.id}
      RETURNING id, version, customer_id, status
    `
    if (!rotated) throw new Error('Cart token rotation returned no row')
    current = rotated
    setCookie(event, CART_COOKIE, token, cartCookieOptions())
  }
  return current
}

async function cartReference(event: H3Event, create: boolean) {
  const customerId = await optionalCustomerId(event)
  const existing = await findCart(event, customerId)
  if (existing) return bindCart(event, existing, customerId)
  if (!create) return null
  return createCart(event, customerId)
}

async function readCart(cart: CartReference): Promise<ServerCart> {
  const sql = useDatabase()
  const [header] = await sql<{ id: string; version: number; status: string; expires_at: Date }[]>`
    SELECT id, version, status, expires_at FROM carts WHERE id = ${cart.id}
  `
  if (!header) throw createError({ statusCode: 404, statusMessage: 'Carrito no encontrado' })
  const items = await sql<ServerCartItem[]>`
    SELECT p.legacy_id AS "productId", p.slug, p.name, COALESCE(b.name, '') AS brand,
           v.legacy_id AS "variantId", v.format, v.sku, v.price_gross_cents AS price,
           ci.quantity AS qty,
           jsonb_build_object(
             'type', COALESCE(p.attributes->'visual'->>'type', 'bottle'),
             'color', COALESCE(p.attributes->'visual'->>'color', '#64748b')
           ) AS visual,
           COALESCE(v.image, (
             SELECT asset.source_url
             FROM product_media media
             JOIN media_assets asset ON asset.id = media.asset_id
             WHERE media.product_id = p.id AND (media.variant_id IS NULL OR media.variant_id = v.id)
               AND media.role = 'primary' AND asset.rights_status = 'approved'
               AND asset.quarantine_status = 'clean'
             ORDER BY media.variant_id NULLS LAST, media.sort_order
             LIMIT 1
           ), p.attributes ->> 'image') AS image,
           v.minimum_quantity AS "minimumQuantity", v.maximum_quantity AS "maximumQuantity",
           v.quantity_increment AS "quantityIncrement"
    FROM cart_items ci
    JOIN variants v ON v.id = ci.variant_id
    JOIN products p ON p.id = v.product_id
    LEFT JOIN brands b ON b.id = p.brand_id
    WHERE ci.cart_id = ${cart.id}
    ORDER BY ci.added_at, ci.id
  `
  return {
    id: header.id,
    version: header.version,
    status: header.status,
    expiresAt: header.expires_at.toISOString(),
    items,
    count: items.reduce((total, item) => total + item.qty, 0),
    subtotal: items.reduce((total, item) => total + item.price * item.qty, 0)
  }
}

export async function getServerCart(event: H3Event, create = true) {
  const cart = await cartReference(event, create)
  return cart ? readCart(cart) : null
}

interface CartMutation {
  expectedVersion: number
  idempotencyKey: string
  operation: 'add' | 'set' | 'remove' | 'clear'
  variantId?: number
  quantity?: number
}

async function lockedCart(transaction: TransactionSql, cartId: string, expectedVersion: number) {
  const [cart] = await transaction<CartReference[]>`
    SELECT id, version, customer_id, status FROM carts WHERE id = ${cartId} FOR UPDATE
  `
  if (!cart || cart.status !== 'active') throw createError({ statusCode: 409, statusMessage: 'Carrito no activo' })
  if (cart.version !== expectedVersion) {
    throw createError({ statusCode: 409, statusMessage: 'El carrito ha cambiado; se ha actualizado su contenido' })
  }
  return cart
}

async function validateVariant(transaction: TransactionSql, legacyId: number, quantity: number) {
  const [variant] = await transaction<
    { id: string; minimum_quantity: number; maximum_quantity: number | null; quantity_increment: number }[]
  >`
    SELECT v.id, v.minimum_quantity, v.maximum_quantity, v.quantity_increment
    FROM variants v JOIN products p ON p.id = v.product_id
    WHERE v.legacy_id = ${legacyId} AND v.status = 'published' AND p.status = 'published'
  `
  if (!variant) throw createError({ statusCode: 404, statusMessage: 'Variante no disponible' })
  validateQuantity(quantity, {
    minimumQuantity: variant.minimum_quantity,
    maximumQuantity: variant.maximum_quantity,
    quantityIncrement: variant.quantity_increment
  })
  return variant
}

export async function mutateServerCart(event: H3Event, input: CartMutation) {
  const reference = await cartReference(event, true)
  if (!reference) throw new Error('Cart reference is unavailable')
  const sql = useDatabase()
  await sql.begin('isolation level serializable', async (transaction) => {
    const [prior] = await transaction<{ resulting_version: number }[]>`
      SELECT resulting_version FROM cart_operations
      WHERE cart_id = ${reference.id} AND idempotency_key = ${input.idempotencyKey}
    `
    if (prior) return
    const cart = await lockedCart(transaction, reference.id, input.expectedVersion)

    if (input.operation === 'clear') {
      await transaction`DELETE FROM cart_items WHERE cart_id = ${cart.id}`
    } else {
      if (input.variantId === undefined) throw new Error('Cart variant is required')
      if (input.operation === 'remove') {
        await transaction`
          DELETE FROM cart_items
          WHERE cart_id = ${cart.id}
            AND variant_id = (SELECT id FROM variants WHERE legacy_id = ${input.variantId})
        `
      } else {
        if (input.quantity === undefined) throw new Error('Cart quantity is required')
        const [current] = await transaction<{ quantity: number }[]>`
          SELECT ci.quantity
          FROM cart_items ci JOIN variants v ON v.id = ci.variant_id
          WHERE ci.cart_id = ${cart.id} AND v.legacy_id = ${input.variantId}
        `
        const quantity = input.operation === 'add' ? (current?.quantity ?? 0) + input.quantity : input.quantity
        const variant = await validateVariant(transaction, input.variantId, quantity)
        await transaction`
          INSERT INTO cart_items (cart_id, variant_id, quantity)
          VALUES (${cart.id}, ${variant.id}, ${quantity})
          ON CONFLICT (cart_id, variant_id) DO UPDATE SET quantity = EXCLUDED.quantity
        `
      }
    }
    const nextVersion = cart.version + 1
    await transaction`
      UPDATE carts SET version = ${nextVersion}, expires_at = now() + interval '90 days', updated_at = now()
      WHERE id = ${cart.id}
    `
    await transaction`
      INSERT INTO cart_operations (cart_id, idempotency_key, operation, resulting_version)
      VALUES (${cart.id}, ${input.idempotencyKey}, ${input.operation}, ${nextVersion})
    `
  })
  const current = await getServerCart(event, false)
  if (!current) throw new Error('Mutated cart is unavailable')
  return current
}

export async function expireServerCart(event: H3Event, expectedVersion: number, idempotencyKey: string) {
  const cart = await cartReference(event, false)
  if (!cart) return null
  const current = await mutateServerCart(event, { expectedVersion, idempotencyKey, operation: 'clear' })
  const sql = useDatabase()
  await sql`UPDATE carts SET status = 'abandoned', updated_at = now() WHERE id = ${current.id}`
  deleteCookie(event, CART_COOKIE, { path: '/' })
  return { ok: true }
}
