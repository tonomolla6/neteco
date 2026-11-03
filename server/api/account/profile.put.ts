import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { requireCustomerAccount } from '../../utils/account'
import { refreshAuthenticatedSession, identityProfile } from '../../utils/auth-session'

const schema = z.object({
  name: z.string().trim().min(2).max(160),
  phone: z.string().trim().max(32).nullable().optional()
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  const account = await requireCustomerAccount(event)
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  await sql.begin(async (transaction) => {
    // audit_log keeps only change facts, never the customer's name or phone (data minimisation).
    const [before] = await transaction<{ name: string | null; phone: string | null }[]>`
      SELECT name, phone FROM customers WHERE id = ${account.customerId} FOR UPDATE
    `
    await transaction`
      UPDATE customers SET name = ${body.name}, phone = ${body.phone || null}, updated_at = now()
      WHERE id = ${account.customerId}
    `
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id,
        before_redacted, after_redacted, correlation_id
      ) VALUES (
        'identity', ${account.profile.id}, 'customer.profile.updated', 'customer', ${account.customerId},
        ${transaction.json({ phonePresent: Boolean(before?.phone) })},
        ${transaction.json({
          nameChanged: (before?.name ?? null) !== body.name,
          phoneChanged: (before?.phone ?? null) !== (body.phone || null),
          phonePresent: Boolean(body.phone)
        })},
        ${correlationId}
      )
    `
  })
  const profile = await identityProfile(account.profile.id)
  if (!profile) throw new Error('Updated identity is not readable')
  const user = await refreshAuthenticatedSession(event, profile, account.mfaVerified, account.session.sessionId!)
  return { user }
})
