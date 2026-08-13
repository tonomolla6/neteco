import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { requireCustomerAccount } from '../../utils/account'
import { enforceRateLimit } from '../../utils/rate-limit'
import { sensitiveRateLimit } from '../../utils/abuse-limit'
import { encryptSecret, hashOpaqueToken, randomOpaqueToken } from '../../utils/secrets'
import { validateRuntimeConfiguration } from '../../utils/runtime-config'

const schema = z.object({
  email: z.string().trim().email().max(254),
  currentPassword: z.string().min(1).max(128)
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  const account = await requireCustomerAccount(event)
  await enforceRateLimit(event, sensitiveRateLimit('account-email-change', account.profile.id))
  if (account.profile.mfaEnabled && !account.mfaVerified) {
    throw createError({ statusCode: 403, statusMessage: 'Confirma tu MFA antes de cambiar el email' })
  }
  const normalizedEmail = body.email.toLowerCase()
  if (normalizedEmail === account.profile.email.toLowerCase()) {
    throw createError({ statusCode: 409, statusMessage: 'Ese ya es el email de la cuenta' })
  }
  const sql = useDatabase()
  const [identity] = await sql<{ passwordHash: string }[]>`
    SELECT password_hash AS "passwordHash" FROM identities WHERE id = ${account.profile.id}
  `
  if (!identity || !(await verifyPassword(identity.passwordHash, body.currentPassword))) {
    throw createError({ statusCode: 401, statusMessage: 'La contraseña actual no es correcta' })
  }
  const [occupied] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM identities WHERE email = ${normalizedEmail}) AS exists
  `
  if (occupied?.exists) throw createError({ statusCode: 409, statusMessage: 'No se puede utilizar ese email' })
  const runtime = validateRuntimeConfiguration(useRuntimeConfig(event))
  const token = randomOpaqueToken()
  const expiresAt = new Date(Date.now() + 30 * 60_000)
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE identity_tokens SET used_at = now()
      WHERE identity_id = ${account.profile.id} AND purpose = 'email_change' AND used_at IS NULL
    `
    await transaction`
      INSERT INTO identity_tokens (identity_id, purpose, token_hash, expires_at, payload)
      VALUES (
        ${account.profile.id}, 'email_change', ${hashOpaqueToken(token, runtime.auth.tokenPepper)},
        ${expiresAt}, ${transaction.json({ newEmail: normalizedEmail })}
      )
    `
    await transaction`
      INSERT INTO outbox_events (
        aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
      ) VALUES (
        'identity', ${account.profile.id}, 'identity.email_change.requested',
        ${transaction.json({
          recipient: normalizedEmail,
          name: account.profile.name,
          tokenEnvelope: encryptSecret(token, runtime.auth.encryptionKey),
          expiresAt: expiresAt.toISOString()
        })}, ${correlationId}, ${`identity:${account.profile.id}:email-change:${expiresAt.toISOString()}`}
      )
    `
  })
  setResponseStatus(event, 202)
  return { ok: true, message: 'Hemos enviado un enlace de confirmación al nuevo email.' }
})
