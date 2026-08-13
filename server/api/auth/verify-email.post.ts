import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { identityProfile, startAuthenticatedSession } from '../../utils/auth-session'
import { enforceRateLimit } from '../../utils/rate-limit'
import { sensitiveRateLimit } from '../../utils/abuse-limit'
import { hashOpaqueToken } from '../../utils/secrets'
import { validateRuntimeConfiguration } from '../../utils/runtime-config'

const schema = z.object({ token: z.string().min(32).max(256) })

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  await enforceRateLimit(event, sensitiveRateLimit('verify-email'))
  const runtime = validateRuntimeConfiguration(useRuntimeConfig(event))
  const sql = useDatabase()
  const tokenHash = hashOpaqueToken(body.token, runtime.auth.tokenPepper)
  const verification = await sql.begin(async (transaction) => {
    const [token] = await transaction<
      Array<{
        id: string
        identityId: string
        purpose: 'verify_email' | 'email_change'
        payload: { newEmail?: string }
      }>
    >`
      SELECT id, identity_id AS "identityId", purpose, payload
      FROM identity_tokens
      WHERE token_hash = ${tokenHash} AND purpose IN ('verify_email', 'email_change')
        AND used_at IS NULL AND expires_at > now()
      FOR UPDATE
    `
    if (!token) return null
    if (token.purpose === 'email_change') {
      const newEmail = z.string().email().max(254).parse(token.payload.newEmail).toLowerCase()
      const [occupied] = await transaction<{ exists: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM identities WHERE email = ${newEmail} AND id <> ${token.identityId}) AS exists
      `
      if (occupied?.exists) throw createError({ statusCode: 409, statusMessage: 'No se puede utilizar ese email' })
      const [before] = await transaction<{ email: string; customerId: string | null }[]>`
        SELECT email::text, customer_id AS "customerId" FROM identities WHERE id = ${token.identityId} FOR UPDATE
      `
      if (!before) return null
      await transaction`
        UPDATE identities SET email = ${newEmail}, email_verified_at = now(), status = 'active',
                              session_version = session_version + 1, updated_at = now()
        WHERE id = ${token.identityId}
      `
      if (before.customerId) {
        await transaction`UPDATE customers SET email = ${newEmail}, updated_at = now() WHERE id = ${before.customerId}`
      }
      await transaction`UPDATE auth_sessions SET revoked_at = now() WHERE identity_id = ${token.identityId} AND revoked_at IS NULL`
      await transaction`UPDATE identity_tokens SET used_at = now() WHERE id = ${token.id}`
      const correlationId = event.context.correlationId ?? crypto.randomUUID()
      await transaction`
        INSERT INTO audit_log (
          actor_type, actor_id, action, resource_type, resource_id,
          before_redacted, after_redacted, correlation_id
        ) VALUES (
          'identity', ${token.identityId}, 'identity.email.changed', 'identity', ${token.identityId},
          ${transaction.json({ emailDomain: before.email.split('@')[1] ?? '' })},
          ${transaction.json({ emailDomain: newEmail.split('@')[1] ?? '' })}, ${correlationId}
        )
      `
      await transaction`
        INSERT INTO outbox_events (
          aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
        ) VALUES (
          'identity', ${token.identityId}, 'identity.security.email_changed',
          ${transaction.json({ recipient: before.email, occurredAt: new Date().toISOString() })},
          ${correlationId}, ${`identity:${token.identityId}:email-changed:${token.id}`}
        )
      `
      return { identityId: token.identityId, emailChanged: true }
    }
    await transaction`UPDATE identity_tokens SET used_at = now() WHERE id = ${token.id}`
    await transaction`
      UPDATE identities SET email_verified_at = COALESCE(email_verified_at, now()), status = 'active', updated_at = now()
      WHERE id = ${token.identityId}
    `
    return { identityId: token.identityId, emailChanged: false }
  })
  if (!verification) throw createError({ statusCode: 400, statusMessage: 'El enlace no es válido o ha caducado' })
  if (verification.emailChanged) {
    await clearUserSession(event)
    return { ok: true, emailChanged: true }
  }
  const profile = await identityProfile(verification.identityId)
  if (!profile) throw new Error('Verified identity is not readable')
  const user = await startAuthenticatedSession(event, profile, false)
  return { ok: true, user }
})
