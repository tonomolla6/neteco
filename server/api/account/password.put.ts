import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { requireCustomerAccount } from '../../utils/account'
import { identityProfile, refreshAuthenticatedSession } from '../../utils/auth-session'
import { enforceRateLimit } from '../../utils/rate-limit'
import { sensitiveRateLimit } from '../../utils/abuse-limit'

const schema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z
    .string()
    .min(12)
    .max(128)
    .regex(/[a-záéíóúñ]/i)
    .regex(/\d/)
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  const account = await requireCustomerAccount(event)
  await enforceRateLimit(event, sensitiveRateLimit('account-password', account.profile.id))
  if (account.profile.mfaEnabled && !account.mfaVerified) {
    throw createError({ statusCode: 403, statusMessage: 'Confirma tu MFA antes de cambiar la contraseña' })
  }
  const sql = useDatabase()
  const [identity] = await sql<{ passwordHash: string; email: string }[]>`
    SELECT password_hash AS "passwordHash", email::text FROM identities WHERE id = ${account.profile.id}
  `
  if (!identity || !(await verifyPassword(identity.passwordHash, body.currentPassword))) {
    throw createError({ statusCode: 401, statusMessage: 'La contraseña actual no es correcta' })
  }
  const newHash = await hashPassword(body.newPassword)
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const newVersion = await sql.begin(async (transaction) => {
    const [updated] = await transaction<{ sessionVersion: number }[]>`
      UPDATE identities SET password_hash = ${newHash}, session_version = session_version + 1, updated_at = now()
      WHERE id = ${account.profile.id} RETURNING session_version AS "sessionVersion"
    `
    if (!updated) throw new Error('Password update returned no row')
    await transaction`
      UPDATE auth_sessions SET revoked_at = now()
      WHERE identity_id = ${account.profile.id} AND id <> ${account.session.sessionId!} AND revoked_at IS NULL
    `
    await transaction`
      UPDATE auth_sessions SET session_version = ${updated.sessionVersion}
      WHERE id = ${account.session.sessionId!} AND identity_id = ${account.profile.id}
    `
    await transaction`
      INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id, correlation_id)
      VALUES ('identity', ${account.profile.id}, 'identity.password.changed', 'identity',
              ${account.profile.id}, ${correlationId})
    `
    await transaction`
      INSERT INTO outbox_events (
        aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
      ) VALUES (
        'identity', ${account.profile.id}, 'identity.security.password_changed',
        ${transaction.json({ recipient: identity.email, occurredAt: new Date().toISOString() })},
        ${correlationId}, ${`identity:${account.profile.id}:password-changed:${correlationId}`}
      )
    `
    return updated.sessionVersion
  })
  const profile = await identityProfile(account.profile.id)
  if (!profile) throw new Error('Updated identity is not readable')
  const user = await refreshAuthenticatedSession(event, profile, account.mfaVerified, account.session.sessionId!)
  return { ok: true, sessionVersion: newVersion, user }
})
