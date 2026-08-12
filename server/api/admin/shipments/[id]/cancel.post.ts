import { z } from 'zod'
import { cancelOrderShipment } from '../../../../services/shipping'

const schema = z.object({ reason: z.string().trim().min(3).max(500) })

export default defineEventHandler(async (event) => {
  const administrator = await requireAdmin(event)
  const body = await readValidatedBody(event, schema.parse)
  return cancelOrderShipment(
    String(getRouterParam(event, 'id')),
    administrator.id,
    event.context.correlationId ?? crypto.randomUUID(),
    body.reason
  )
})
