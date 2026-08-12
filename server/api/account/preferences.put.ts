import { createHash } from 'node:crypto'
import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { requireCustomerAccount } from '../../utils/account'

const policyVersion = 'communications-2026-08-12'
const schema = z.object({
  preferences: z
    .array(
      z.object({
        purpose: z.enum(['newsletter', 'product_updates', 'replenishment']),
        channel: z.enum(['email', 'sms', 'whatsapp']),
        enabled: z.boolean(),
        frequency: z.enum(['immediate', 'weekly', 'monthly']).default('immediate'),
        topics: z.array(z.string().trim().min(1).max(60)).max(20).default([])
      })
    )
    .max(9)
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  const account = await requireCustomerAccount(event)
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  await sql.begin(async (transaction) => {
    for (const preference of body.preferences) {
      await transaction`
        INSERT INTO customer_preferences (customer_id, purpose, channel, enabled, frequency, topics)
        VALUES (
          ${account.customerId}, ${preference.purpose}, ${preference.channel}, ${preference.enabled},
          ${preference.frequency}, ${transaction.json(preference.topics)}
        )
        ON CONFLICT (customer_id, purpose, channel) DO UPDATE SET
          enabled = EXCLUDED.enabled, frequency = EXCLUDED.frequency,
          topics = EXCLUDED.topics, updated_at = now()
      `
      const consentText = `${preference.purpose}:${preference.channel}:${preference.enabled}:${preference.frequency}`
      await transaction`
        INSERT INTO consent_events (
          customer_id, purpose, channel, action, policy_version, text_hash, source
        ) VALUES (
          ${account.customerId}, ${preference.purpose}, ${preference.channel},
          ${preference.enabled ? 'granted' : 'withdrawn'}, ${policyVersion},
          ${createHash('sha256').update(consentText).digest('hex')}, 'account_preferences'
        )
      `
    }
    await transaction`
      INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id, correlation_id)
      VALUES ('identity', ${account.profile.id}, 'customer.preferences.updated', 'customer',
              ${account.customerId}, ${correlationId})
    `
  })
  return { ok: true }
})
