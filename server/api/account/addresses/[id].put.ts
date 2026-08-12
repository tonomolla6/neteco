import { z } from 'zod'
import { useDatabase } from '../../../db/client'
import { validateAddress } from '../../../domain/customer'
import { requireCustomerAccount } from '../../../utils/account'

const paramsSchema = z.object({ id: z.string().uuid() })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const body = await readBody(event).then(validateAddress)
  const account = await requireCustomerAccount(event)
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  await sql.begin(async (transaction) => {
    const [before] = await transaction<{ id: string; kind: string; isDefault: boolean }[]>`
      SELECT id, kind, is_default AS "isDefault" FROM addresses
      WHERE id = ${id} AND customer_id = ${account.customerId} FOR UPDATE
    `
    if (!before) throw createError({ statusCode: 404, statusMessage: 'Dirección no encontrada' })
    if (body.isDefault) {
      await transaction`
        UPDATE addresses SET is_default = false, updated_at = now()
        WHERE customer_id = ${account.customerId} AND id <> ${id} AND is_default
          AND (
            ${body.kind} = 'both' OR kind = 'both' OR kind = ${body.kind}
          )
      `
    }
    await transaction`
      UPDATE addresses SET
        kind = ${body.kind}, label = ${body.label}, recipient_name = ${body.recipientName},
        company_name = ${body.companyName || null}, tax_id = ${body.taxId || null},
        line1 = ${body.line1}, line2 = ${body.line2 || null}, postal_code = ${body.postalCode.toUpperCase()},
        city = ${body.city}, region = ${body.region}, country_code = ${body.countryCode},
        phone = ${body.phone || null}, instructions = ${body.instructions || null},
        is_default = ${body.isDefault}, updated_at = now()
      WHERE id = ${id} AND customer_id = ${account.customerId}
    `
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id, before_redacted, after_redacted, correlation_id
      ) VALUES (
        'identity', ${account.profile.id}, 'customer.address.updated', 'address', ${id},
        ${transaction.json(before)},
        ${transaction.json({ kind: body.kind, countryCode: body.countryCode, isDefault: body.isDefault })},
        ${correlationId}
      )
    `
  })
  return { ok: true }
})
