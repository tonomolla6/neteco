import { createHash } from 'node:crypto'
import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { requestNewsletterSubscription, unsubscribeNewsletterByCustomer } from '../../services/newsletter'
import { requireCustomerAccount } from '../../utils/account'
import { validateRuntimeConfiguration } from '../../utils/runtime-config'

const policyVersion = 'communications-2026-08-12'
const schema = z
  .object({
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
  .superRefine((body, context) => {
    const seen = new Set<string>()
    body.preferences.forEach((preference, index) => {
      const key = `${preference.purpose}:${preference.channel}`
      if (seen.has(key)) {
        context.addIssue({ code: 'custom', path: ['preferences', index], message: 'Preferencia duplicada' })
      }
      seen.add(key)
      if (preference.purpose === 'newsletter' && preference.channel !== 'email') {
        context.addIssue({
          code: 'custom',
          path: ['preferences', index, 'channel'],
          message: 'La newsletter solo está disponible por email'
        })
      }
    })
  })

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  const account = await requireCustomerAccount(event)
  const runtime = validateRuntimeConfiguration(useRuntimeConfig(event))
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  await sql.begin(async (transaction) => {
    const [customer] = await transaction<{ email: string | null }[]>`
      SELECT email::text FROM customers WHERE id = ${account.customerId} FOR UPDATE
    `
    for (const preference of body.preferences) {
      if (preference.purpose === 'newsletter') {
        if (preference.enabled) {
          if (!customer?.email) throw createError({ statusCode: 409, statusMessage: 'La cuenta no tiene email' })
          const result = await requestNewsletterSubscription(transaction, {
            email: customer.email,
            customerId: account.customerId,
            source: 'account_preferences',
            correlationId,
            secrets: {
              tokenPepper: runtime.auth.tokenPepper,
              encryptionKey: runtime.auth.encryptionKey
            }
          })
          await transaction`
            INSERT INTO customer_preferences (customer_id, purpose, channel, enabled, frequency, topics)
            VALUES (
              ${account.customerId}, 'newsletter', 'email', ${'reason' in result && result.reason === 'active'},
              ${preference.frequency}, ${transaction.json(preference.topics)}
            )
            ON CONFLICT (customer_id, purpose, channel) DO UPDATE SET
              enabled = EXCLUDED.enabled, frequency = EXCLUDED.frequency,
              topics = EXCLUDED.topics, updated_at = now()
          `
        } else {
          await unsubscribeNewsletterByCustomer(transaction, {
            customerId: account.customerId,
            source: 'account_preferences',
            correlationId
          })
        }
        continue
      }
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
