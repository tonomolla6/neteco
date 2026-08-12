import { z } from 'zod'
import { createOrder } from '../../services/orders'

const trimmed = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum)
const schema = z.object({
  customer: z.object({
    name: trimmed(2, 160),
    company: z.string().trim().max(160).optional().default(''),
    nif: z.string().trim().max(32).optional().default(''),
    email: z.string().trim().email().max(254),
    phone: trimmed(6, 32),
    address: trimmed(4, 240),
    zip: trimmed(4, 12),
    city: trimmed(2, 120),
    province: z.string().trim().max(120).optional().default('Valencia'),
    notes: z.string().trim().max(500).optional().default('')
  }),
  shippingMethod: z.enum(['reparto', 'envio', 'recogida']),
  paymentMethod: z.enum(['tarjeta', 'bizum', 'transferencia']),
  items: z
    .array(z.object({ variantId: z.number().int().positive(), qty: z.number().int().min(1).max(999) }))
    .min(1)
    .max(100),
  idempotencyKey: z.string().uuid(),
  guestToken: z.string().uuid(),
  termsAccepted: z.literal(true)
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  const order = await createOrder({
    ...body,
    correlationId: event.context.correlationId ?? crypto.randomUUID()
  })
  setCookie(event, 'neteco-order-access', `${order.id}.${order.token}`, {
    httpOnly: true,
    secure: process.env.APP_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30
  })
  setResponseStatus(event, 201)
  return order
})
