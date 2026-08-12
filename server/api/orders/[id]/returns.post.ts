import { z } from 'zod'
import { requestReturn } from '../../../services/returns'

const schema = z.object({
  reason: z.string().trim().min(5).max(500),
  lines: z
    .array(z.object({ orderLineId: z.string().uuid(), quantity: z.number().int().positive() }))
    .min(1)
    .max(100),
  idempotencyKey: z.string().uuid()
})

export default defineEventHandler(async (event) => {
  const orderNumber = String(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, schema.parse)
  const result = await requestReturn(event, { ...body, orderNumber })
  setResponseStatus(event, result.duplicate ? 200 : 201)
  return result
})
