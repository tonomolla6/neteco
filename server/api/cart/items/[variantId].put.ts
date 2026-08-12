import { z } from 'zod'
import { mutateServerCart } from '../../../services/cart'

const paramsSchema = z.object({ variantId: z.coerce.number().int().positive() })
const bodySchema = z.object({
  quantity: z.number().int().positive().max(999),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().uuid()
})

export default defineEventHandler(async (event) => {
  const params = await getValidatedRouterParams(event, paramsSchema.parse)
  const body = await readValidatedBody(event, bodySchema.parse)
  return mutateServerCart(event, { ...body, variantId: params.variantId, operation: 'set' })
})
