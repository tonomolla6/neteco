import { z } from 'zod'
import { createOrder } from '../../services/orders'
import { getServerCart } from '../../services/cart'
import { isValidSpanishTaxId, normalizeSpanishTaxId } from '../../domain/spanish-tax-id'
import { useDatabase } from '../../db/client'
import { validateRuntimeConfiguration } from '../../utils/runtime-config'
import { encryptSecret } from '../../utils/secrets'
import { hashAccessToken } from '../../utils/access-token'

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
  const cart = await getServerCart(event, false)
  if (!cart || cart.id !== body.cartId) {
    throw createError({ statusCode: 404, statusMessage: 'Carrito no encontrado' })
  }
  const order = await createOrder({
    ...body,
    guestTokenEnvelope: encryptSecret(
      body.guestToken,
      validateRuntimeConfiguration(useRuntimeConfig(event)).auth.encryptionKey
    ),
    correlationId: event.context.correlationId ?? crypto.randomUUID()
  })
  const sql = useDatabase()
  await sql`
    INSERT INTO order_access_sessions (order_id, token_hash, expires_at)
    SELECT id, ${hashAccessToken(order.token)}, now() + interval '24 hours'
    FROM orders WHERE public_number = ${order.id}
    ON CONFLICT (order_id, token_hash) DO UPDATE
    SET expires_at = EXCLUDED.expires_at, revoked_at = NULL
  `
  setCookie(event, 'neteco-order-access', `${order.id}.${order.token}`, {
    httpOnly: true,
    secure: process.env.APP_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24
  })
  setResponseStatus(event, 201)
  return order
})
