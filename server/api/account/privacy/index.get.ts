import { useDatabase } from '../../../db/client'
import { requireCustomerAccount } from '../../../utils/account'

export default defineEventHandler(async (event) => {
  const account = await requireCustomerAccount(event)
  const sql = useDatabase()
  const requests = await sql`
    SELECT id, request_type AS "requestType", status, legal_exceptions AS "legalExceptions",
           requested_at AS "requestedAt", due_at AS "dueAt", completed_at AS "completedAt"
    FROM privacy_requests WHERE customer_id = ${account.customerId}
    ORDER BY requested_at DESC LIMIT 20
  `
  return { requests }
})
