import { useDatabase } from '../../../db/client'
import { requireCustomerAccount } from '../../../utils/account'

export default defineEventHandler(async (event) => {
  const account = await requireCustomerAccount(event)
  const sql = useDatabase()
  const addresses = await sql`
    SELECT id, kind, label, recipient_name AS "recipientName", company_name AS "companyName",
           tax_id AS "taxId", line1, line2, postal_code AS "postalCode", city, region,
           country_code AS "countryCode", phone, instructions, is_default AS "isDefault",
           created_at AS "createdAt", updated_at AS "updatedAt"
    FROM addresses
    WHERE customer_id = ${account.customerId}
    ORDER BY is_default DESC, created_at DESC
  `
  setResponseHeader(event, 'cache-control', 'private, no-store')
  return { addresses }
})
