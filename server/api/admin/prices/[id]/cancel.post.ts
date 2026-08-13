import { z } from 'zod'
import { useDatabase } from '../../../../db/client'
import { cancelScheduledVariantPrice } from '../../../../services/pricing'

const schema = z.object({ reason: z.string().trim().min(3).max(500) }).strict()

export default defineEventHandler(async (event) => {
  const administrator = await requireAdmin(event)
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, schema.parse)
  const sql = useDatabase()
  return sql.begin((transaction) =>
    cancelScheduledVariantPrice(transaction, {
      id,
      actorId: administrator.id,
      reason: body.reason,
      correlationId: event.context.correlationId ?? crypto.randomUUID()
    })
  )
})
