import { z } from 'zod'
import { mutateServerCart } from '../../services/cart'

const schema = z.object({
  variantId: z.number().int().positive(),
  quantity: z.number().int().positive().max(999),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().uuid()
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  return mutateServerCart(event, { ...body, operation: 'add' })
})
