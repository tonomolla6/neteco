import { z } from 'zod'
import { createOrder } from '../../services/orders'
import { getServerCart } from '../../services/cart'
import { isValidSpanishTaxId, normalizeSpanishTaxId } from '../../domain/spanish-tax-id'
import { useDatabase } from '../../db/client'
import { validateRuntimeConfiguration } from '../../utils/runtime-config'
import { encryptSecret } from '../../utils/secrets'
import { hashAccessToken } from '../../utils/access-token'
import { requireVerifiedIdentity } from '../../utils/auth-session'
import { privateCookieOptions } from '../../utils/private-cookie'

const trimmed = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum)
const taxId = z
  .string()
  .trim()
  .max(32)
  .transform(normalizeSpanishTaxId)
  .refine((value) => !value || isValidSpanishTaxId(value), 'NIF, NIE o CIF no válido')
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{6,32}$/, 'Teléfono no válido')
const addressSchema = z
  .object({
    recipientName: trimmed(2, 160),
    companyName: z.string().trim().max(160).optional().default(''),
    taxId,
    line1: trimmed(4, 240),
    line2: z.string().trim().max(240).optional().default(''),
    postalCode: z
      .string()
      .trim()
      .regex(/^\d{5}$/, 'Código postal no válido'),
    city: trimmed(2, 120),
    region: trimmed(2, 120),
    countryCode: z.literal('ES'),
    phone: z.string().trim().max(32).optional().default(''),
    instructions: z.string().trim().max(500).optional().default('')
  })
  .strict()
const shippingAddressSchema = addressSchema.extend({ phone })
const schema = z
  .object({
    customer: z
      .object({
        name: trimmed(2, 160),
        company: z.string().trim().max(160).optional().default(''),
        nif: taxId,
        email: z.string().trim().email().max(254),
        phone
      })
      .strict(),
    shippingAddress: shippingAddressSchema,
    billingAddress: addressSchema,
    shippingMethod: z.enum(['reparto', 'envio', 'recogida']),
    shippingServiceCode: z.string().trim().min(1).max(80),
    expectedPricingVersion: z.string().trim().min(1).max(500),
    expectedTotalGrossCents: z.number().int().nonnegative(),
    paymentMethod: z.enum(['tarjeta', 'bizum', 'transferencia']),
    cartId: z.string().uuid(),
    cartVersion: z.number().int().positive(),
    idempotencyKey: z.string().uuid(),
    guestToken: z.string().uuid(),
    termsAccepted: z.literal(true),
    marketingConsent: z.boolean()
  })
  .strict()

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  const runtime = validateRuntimeConfiguration(useRuntimeConfig(event))
  const sql = useDatabase()
  const session = await getUserSession(event)
  const normalizedEmail = body.customer.email.toLowerCase()
  let authenticatedCustomerId: string | undefined
  if (session.user?.id) {
    const authenticated = await requireVerifiedIdentity(event)
    if (authenticated.profile.email.toLowerCase() !== normalizedEmail) {
      throw createError({ statusCode: 422, statusMessage: 'El email del pedido debe coincidir con tu cuenta' })
    }
    const [account] = await sql<{ customerId: string | null }[]>`
      SELECT customer_id AS "customerId" FROM identities WHERE id = ${authenticated.profile.id}
    `
    if (!account?.customerId) {
      throw createError({ statusCode: 409, statusMessage: 'La cuenta no tiene un cliente asociado' })
    }
    authenticatedCustomerId = account.customerId
  } else {
    const [registered] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM identities
        WHERE lower(email::text) = ${normalizedEmail} AND status IN ('pending', 'active')
      ) AS exists
    `
    if (registered?.exists) {
      throw createError({ statusCode: 409, statusMessage: 'Inicia sesión para comprar con este email' })
    }
  }
  if (body.paymentMethod === 'transferencia' && !runtime.bankTransfer.enabled) {
    throw createError({ statusCode: 422, statusMessage: 'La transferencia bancaria no está disponible' })
  }
  const cart = await getServerCart(event, false)
  if (!cart || cart.id !== body.cartId) {
    throw createError({ statusCode: 404, statusMessage: 'Carrito no encontrado' })
  }
  const order = await createOrder({
    ...body,
    authenticatedCustomerId,
    guestTokenEnvelope: encryptSecret(body.guestToken, runtime.auth.encryptionKey),
    newsletterSecrets: {
      tokenPepper: runtime.auth.tokenPepper,
      encryptionKey: runtime.auth.encryptionKey
    },
    correlationId: event.context.correlationId ?? crypto.randomUUID()
  })
  await sql`
    INSERT INTO order_access_sessions (order_id, token_hash, expires_at)
    SELECT id, ${hashAccessToken(order.token)}, now() + interval '24 hours'
    FROM orders WHERE public_number = ${order.id}
    ON CONFLICT (order_id, token_hash) DO UPDATE
    SET expires_at = EXCLUDED.expires_at, revoked_at = NULL
  `
  setCookie(event, 'neteco-order-access', `${order.id}.${order.token}`, privateCookieOptions(60 * 60 * 24))
  deleteCookie(event, 'neteco-cart', { path: '/' })
  setResponseStatus(event, 201)
  return order
})
