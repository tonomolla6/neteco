import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { enforceRateLimit } from '../../utils/rate-limit'
import { encryptSecret, hashOpaqueToken, randomOpaqueToken } from '../../utils/secrets'
import { validateRuntimeConfiguration } from '../../utils/runtime-config'

const schema = z.object({ email: z.string().trim().email().max(254) })

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  const email = body.email.toLowerCase()
  await enforceRateLimit(event, { scope: 'forgot-password', subject: email, limit: 3, windowSeconds: 3600 })
  const runtime = validateRuntimeConfiguration(useRuntimeConfig(event))
  const sql = useDatabase()
  const [identity] = await sql<{ id: string; name: string | null }[]>`
    SELECT i.id, c.name FROM identities i LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.email = ${email} AND i.status IN ('pending', 'active')
  `
  if (identity) {
    const token = randomOpaqueToken()
    const expiresAt = new Date(Date.now() + 30 * 60_000)
    const correlationId = event.context.correlationId ?? crypto.randomUUID()
    await sql.begin(async (transaction) => {
      await transaction`
        UPDATE identity_tokens SET used_at = now()
        WHERE identity_id = ${identity.id} AND purpose = 'password_reset' AND used_at IS NULL
      `
      await transaction`
        INSERT INTO identity_tokens (identity_id, purpose, token_hash, expires_at)
        VALUES (${identity.id}, 'password_reset', ${hashOpaqueToken(token, runtime.auth.tokenPepper)}, ${expiresAt})
      `
      await transaction`
        INSERT INTO outbox_events (
          aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
        ) VALUES (
          'identity', ${identity.id}, 'identity.password_reset.requested',
          ${transaction.json({
            recipient: email,
            name: identity.name,
            tokenEnvelope: encryptSecret(token, runtime.auth.encryptionKey),
            expiresAt: expiresAt.toISOString()
          })}, ${correlationId}, ${`identity:${identity.id}:reset:${expiresAt.toISOString()}`}
        )
      `
    })
  }
  setResponseStatus(event, 202)
  return { ok: true, message: 'Si la cuenta existe, recibirás un enlace para restablecer la contraseña.' }
})
