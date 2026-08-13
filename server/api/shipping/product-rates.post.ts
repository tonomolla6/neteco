import { z } from 'zod'
import { quoteProductDelivery } from '../../services/shipping'

const schema = z
  .object({
    variantId: z.string().uuid(),
    quantity: z.number().int().positive().max(10_000),
    postalCode: z
      .string()
      .trim()
      .regex(/^\d{5}$/),
    city: z.string().trim().min(2).max(120)
  })
  .strict()

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  return quoteProductDelivery(body)
})
