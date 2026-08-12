import { z } from 'zod'
import { expireServerCart } from '../../services/cart'

const schema = z.object({
  expectedVersion: z.coerce.number().int().positive(),
  idempotencyKey: z.string().uuid()
})

export default defineEventHandler(async (event) => {
  const query = await getValidatedQuery(event, schema.parse)
  return expireServerCart(event, query.expectedVersion, query.idempotencyKey)
})
