import { useDatabase } from '../../db/client'
import { requireCustomerAccount } from '../../utils/account'

export default defineEventHandler(async (event) => {
  const account = await requireCustomerAccount(event)
  const sql = useDatabase()
  const preferences = await sql`
    SELECT purpose, channel, enabled, frequency, topics, updated_at AS "updatedAt"
    FROM customer_preferences WHERE customer_id = ${account.customerId}
    ORDER BY purpose, channel
  `
  return { preferences }
})
