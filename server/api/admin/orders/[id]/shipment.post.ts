import { z } from 'zod'
import { createOrderShipment } from '../../../../services/shipping'

const schema = z.object({ serviceCode: z.string().trim().min(2).max(80) })

export default defineEventHandler(async (event) => {
  const administrator = await requireAdmin(event)
  const body = await readValidatedBody(event, schema.parse)
  return createOrderShipment({
    publicNumber: String(getRouterParam(event, 'id')),
    serviceCode: body.serviceCode,
    actorId: administrator.id,
    correlationId: event.context.correlationId ?? crypto.randomUUID()
  })
})
