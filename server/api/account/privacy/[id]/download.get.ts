import { z } from 'zod'
import { useDatabase } from '../../../../db/client'
import { requireCustomerAccount } from '../../../../utils/account'

const paramsSchema = z.object({ id: z.string().uuid() })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const account = await requireCustomerAccount(event)
  const sql = useDatabase()
  const [request] = await sql<{ id: string }[]>`
    SELECT id FROM privacy_requests
    WHERE id = ${id} AND customer_id = ${account.customerId}
      AND request_type = 'export' AND status = 'completed'
  `
  if (!request) throw createError({ statusCode: 404, statusMessage: 'Exportación no disponible' })
  const [profile, addresses, orders, consents, preferences, favorites] = await Promise.all([
    sql`SELECT email::text, name, phone, status, created_at AS "createdAt" FROM customers WHERE id = ${account.customerId}`,
    sql`SELECT kind, label, recipient_name AS "recipientName", company_name AS "companyName", tax_id AS "taxId",
               line1, line2, postal_code AS "postalCode", city, region, country_code AS "countryCode",
               phone, instructions, is_default AS "isDefault" FROM addresses WHERE customer_id = ${account.customerId}`,
    sql`SELECT public_number AS id, order_status AS "orderStatus", payment_status AS "paymentStatus",
               total_gross_cents AS "totalCents", currency, created_at AS "createdAt"
        FROM orders WHERE customer_id = ${account.customerId} ORDER BY created_at`,
    sql`SELECT purpose, channel, action, policy_version AS "policyVersion", source, created_at AS "createdAt"
        FROM consent_events WHERE customer_id = ${account.customerId} ORDER BY created_at`,
    sql`SELECT purpose, channel, enabled, frequency, topics, updated_at AS "updatedAt"
        FROM customer_preferences WHERE customer_id = ${account.customerId}`,
    sql`SELECT list.name, variant.sku, item.quantity, item.created_at AS "createdAt"
        FROM favorite_lists list JOIN favorite_items item ON item.list_id = list.id
        JOIN variants variant ON variant.id = item.variant_id WHERE list.customer_id = ${account.customerId}`
  ])
  setResponseHeader(event, 'content-type', 'application/json; charset=utf-8')
  setResponseHeader(event, 'content-disposition', `attachment; filename="neteco-datos-${id}.json"`)
  setResponseHeader(event, 'cache-control', 'private, no-store')
  return JSON.stringify(
    {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      profile,
      addresses,
      orders,
      consents,
      preferences,
      favorites
    },
    null,
    2
  )
})
