import { z } from 'zod'
import { useDatabase } from '../../../db/client'
import { requireCustomerAccount } from '../../../utils/account'

const paramsSchema = z.object({ variantId: z.string().uuid() })

export default defineEventHandler(async (event) => {
  const { variantId } = await getValidatedRouterParams(event, paramsSchema.parse)
  const account = await requireCustomerAccount(event)
  const sql = useDatabase()
  const [deleted] = await sql<{ id: string }[]>`
    DELETE FROM favorite_items item USING favorite_lists list
    WHERE item.list_id = list.id AND list.customer_id = ${account.customerId}
      AND item.variant_id = ${variantId}
    RETURNING item.variant_id AS id
  `
  if (!deleted) throw createError({ statusCode: 404, statusMessage: 'Favorito no encontrado' })
  return { ok: true }
})
