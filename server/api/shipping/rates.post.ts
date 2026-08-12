import { z } from 'zod'
import { getServerCart } from '../../services/cart'
import { quoteCartShipping } from '../../services/shipping'

const schema = z.object({
  name: z.string().trim().min(2).max(160),
  line1: z.string().trim().min(4).max(240),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}$/),
  city: z.string().trim().min(2).max(120),
  region: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(6).max(32)
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  const cart = await getServerCart(event, false)
  if (!cart) throw createError({ statusCode: 404, statusMessage: 'Carrito no encontrado' })
  const rates = await quoteCartShipping(cart.id, { ...body, countryCode: 'ES' })
  return { cartVersion: cart.version, rates }
})
