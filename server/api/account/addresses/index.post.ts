import { useDatabase } from '../../../db/client'
import { validateAddress } from '../../../domain/customer'
import { requireCustomerAccount } from '../../../utils/account'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).then(validateAddress)
  const account = await requireCustomerAccount(event)
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const address = await sql.begin(async (transaction) => {
    if (body.isDefault) {
      await transaction`
        UPDATE addresses SET is_default = false, updated_at = now()
        WHERE customer_id = ${account.customerId} AND is_default
          AND (
            ${body.kind} = 'both' OR kind = 'both' OR kind = ${body.kind}
          )
      `
    }
    const [created] = await transaction<{ id: string }[]>`
      INSERT INTO addresses (
        customer_id, kind, label, recipient_name, company_name, tax_id, line1, line2,
        postal_code, city, region, country_code, phone, instructions, is_default
      ) VALUES (
        ${account.customerId}, ${body.kind}, ${body.label}, ${body.recipientName},
        ${body.companyName || null}, ${body.taxId || null}, ${body.line1}, ${body.line2 || null},
        ${body.postalCode.toUpperCase()}, ${body.city}, ${body.region}, ${body.countryCode},
        ${body.phone || null}, ${body.instructions || null}, ${body.isDefault}
      ) RETURNING id
    `
    if (!created) throw new Error('Address insert returned no row')
    await transaction`
      INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id, after_redacted, correlation_id)
      VALUES ('identity', ${account.profile.id}, 'customer.address.created', 'address', ${created.id},
              ${transaction.json({ kind: body.kind, countryCode: body.countryCode, isDefault: body.isDefault })},
              ${correlationId})
    `
    return created
  })
  setResponseStatus(event, 201)
  return { id: address.id }
})
