import { useDatabase } from '../../db/client'
import { scheduleVariantPrice } from '../../services/pricing'
import { priceScheduleSchema } from '../../utils/price-input'

export default defineEventHandler(async (event) => {
  const administrator = await requireAdmin(event)
  const body = await readValidatedBody(event, priceScheduleSchema.parse)
  const validFrom = new Date(body.validFrom)
  if (validFrom < new Date(Date.now() - 30_000)) {
    throw createError({ statusCode: 422, statusMessage: 'La fecha de vigencia no puede estar en el pasado' })
  }
  const sql = useDatabase()
  const result = await sql.begin((transaction) =>
    scheduleVariantPrice(transaction, {
      ...body,
      validFrom,
      actorId: administrator.id,
      correlationId: event.context.correlationId ?? crypto.randomUUID()
    })
  )
  setResponseStatus(event, 201)
  return result
})
