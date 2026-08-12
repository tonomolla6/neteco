import { z } from 'zod'
import { mutateServerCart } from '../../../services/cart'

const paramsSchema = z.object({ variantId: z.coerce.number().int().positive() })
const querySchema = z.object({
  expectedVersion: z.coerce.number().int().positive(),
  idempotencyKey: z.string().uuid()
})

export default defineEventHandler(async (event) => {
  const params = await getValidatedRouterParams(event, paramsSchema.parse)
  const query = await getValidatedQuery(event, querySchema.parse)
  return mutateServerCart(event, { ...query, variantId: params.variantId, operation: 'remove' })
})
