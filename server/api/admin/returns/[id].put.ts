import { z } from 'zod'
import { RETURN_STATES } from '../../../domain/states'
import { transitionReturn } from '../../../services/returns'

const schema = z.object({
  status: z.enum(RETURN_STATES),
  reason: z.string().trim().min(3).max(500),
  resolution: z.string().trim().max(500).optional(),
  refundAmountCents: z.number().int().positive().optional()
})

export default defineEventHandler(async (event) => {
  const administrator = await requireAdmin(event)
  const body = await readValidatedBody(event, schema.parse)
  return transitionReturn({
    ...body,
    publicNumber: String(getRouterParam(event, 'id')),
    actorId: administrator.id,
    correlationId: event.context.correlationId ?? crypto.randomUUID()
  })
})
