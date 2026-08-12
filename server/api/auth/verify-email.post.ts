import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { identityProfile, startAuthenticatedSession } from '../../utils/auth-session'
import { enforceRateLimit } from '../../utils/rate-limit'
import { hashOpaqueToken } from '../../utils/secrets'
import { validateRuntimeConfiguration } from '../../utils/runtime-config'

const schema = z.object({ token: z.string().min(32).max(256) })

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  await enforceRateLimit(event, { scope: 'verify-email', limit: 10, windowSeconds: 900 })
  const runtime = validateRuntimeConfiguration(useRuntimeConfig(event))
  const sql = useDatabase()
  const tokenHash = hashOpaqueToken(body.token, runtime.auth.tokenPepper)
  const identityId = await sql.begin(async (transaction) => {
    const [token] = await transaction<{ id: string; identityId: string }[]>`
      SELECT id, identity_id AS "identityId"
      FROM identity_tokens
      WHERE token_hash = ${tokenHash} AND purpose = 'verify_email'
        AND used_at IS NULL AND expires_at > now()
      FOR UPDATE
    `
    if (!token) return null
    await transaction`UPDATE identity_tokens SET used_at = now() WHERE id = ${token.id}`
    await transaction`
      UPDATE identities SET email_verified_at = COALESCE(email_verified_at, now()), status = 'active', updated_at = now()
      WHERE id = ${token.identityId}
    `
    return token.identityId
  })
  if (!identityId) throw createError({ statusCode: 400, statusMessage: 'El enlace no es válido o ha caducado' })
  const profile = await identityProfile(identityId)
  if (!profile) throw new Error('Verified identity is not readable')
  const user = await startAuthenticatedSession(event, profile, false)
  return { ok: true, user }
})
