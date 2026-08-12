import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { enforceRateLimit } from '../../utils/rate-limit'
import { hashOpaqueToken } from '../../utils/secrets'
import { validateRuntimeConfiguration } from '../../utils/runtime-config'

const schema = z.object({
  token: z.string().min(32).max(256),
  password: z
    .string()
    .min(12)
    .max(128)
    .regex(/[a-záéíóúñ]/i)
    .regex(/\d/)
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  await enforceRateLimit(event, { scope: 'reset-password', limit: 5, windowSeconds: 900 })
  const runtime = validateRuntimeConfiguration(useRuntimeConfig(event))
  const sql = useDatabase()
  const tokenHash = hashOpaqueToken(body.token, runtime.auth.tokenPepper)
  const passwordHash = await hashPassword(body.password)
  const changed = await sql.begin(async (transaction) => {
    const [token] = await transaction<{ id: string; identityId: string }[]>`
      SELECT id, identity_id AS "identityId"
      FROM identity_tokens
      WHERE token_hash = ${tokenHash} AND purpose = 'password_reset'
        AND used_at IS NULL AND expires_at > now() AND attempts < 5
      FOR UPDATE
    `
    if (!token) return false
    await transaction`UPDATE identity_tokens SET used_at = now(), attempts = attempts + 1 WHERE id = ${token.id}`
    await transaction`
      UPDATE identities
      SET password_hash = ${passwordHash}, session_version = session_version + 1, updated_at = now()
      WHERE id = ${token.identityId}
    `
    await transaction`
      UPDATE auth_sessions SET revoked_at = now()
      WHERE identity_id = ${token.identityId} AND revoked_at IS NULL
    `
    return true
  })
  if (!changed) throw createError({ statusCode: 400, statusMessage: 'El enlace no es válido o ha caducado' })
  await clearUserSession(event)
  return { ok: true }
})
