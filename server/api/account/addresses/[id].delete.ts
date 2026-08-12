import { z } from 'zod'
import { useDatabase } from '../../../db/client'
import { requireCustomerAccount } from '../../../utils/account'

const paramsSchema = z.object({ id: z.string().uuid() })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const account = await requireCustomerAccount(event)
  const sql = useDatabase()
  const [deleted] = await sql<{ id: string }[]>`
    DELETE FROM addresses WHERE id = ${id} AND customer_id = ${account.customerId} RETURNING id
  `
  if (!deleted) throw createError({ statusCode: 404, statusMessage: 'Dirección no encontrada' })
  await sql`
    INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id, correlation_id)
    VALUES ('identity', ${account.profile.id}, 'customer.address.deleted', 'address', ${id},
            ${event.context.correlationId ?? crypto.randomUUID()})
  `
  return { ok: true }
})
