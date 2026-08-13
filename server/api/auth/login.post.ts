import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { identityProfile, startAuthenticatedSession } from '../../utils/auth-session'
import { enforceRateLimit } from '../../utils/rate-limit'
import { sensitiveRateLimit } from '../../utils/abuse-limit'
import { hashOpaqueToken, randomOpaqueToken } from '../../utils/secrets'
import { validateRuntimeConfiguration } from '../../utils/runtime-config'

const schema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128)
})

let dummyHash: Promise<string> | undefined

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  const email = body.email.toLowerCase()
  await enforceRateLimit(event, sensitiveRateLimit('login', email))
  const runtime = validateRuntimeConfiguration(useRuntimeConfig(event))
  const sql = useDatabase()
  const [identity] = await sql<Array<{ id: string; passwordHash: string; status: string; mfaEnabled: boolean }>>`
    SELECT i.id, i.password_hash AS "passwordHash", i.status,
           mfa.verified_at IS NOT NULL AS "mfaEnabled"
    FROM identities i
    LEFT JOIN identity_mfa mfa ON mfa.identity_id = i.id
    WHERE i.email = ${email}
  `
  if (!dummyHash) dummyHash = hashPassword('Neteco-dummy-password-94720')
  const validPassword = await verifyPassword(identity?.passwordHash ?? (await dummyHash), body.password)
  if (!identity || !validPassword || !['pending', 'active'].includes(identity.status)) {
    throw createError({ statusCode: 401, statusMessage: 'Email o contraseña incorrectos' })
  }
  if (passwordNeedsReHash(identity.passwordHash)) {
    await sql`UPDATE identities SET password_hash = ${await hashPassword(body.password)}, updated_at = now() WHERE id = ${identity.id}`
  }
  const profile = await identityProfile(identity.id)
  if (!profile) throw new Error('Authenticated identity is not readable')
  if (identity.mfaEnabled) {
    const challenge = randomOpaqueToken()
    const expiresAt = new Date(Date.now() + 5 * 60_000)
    await sql.begin(async (transaction) => {
      await transaction`
        UPDATE identity_tokens SET used_at = now()
        WHERE identity_id = ${identity.id} AND purpose = 'mfa_challenge' AND used_at IS NULL
      `
      await transaction`
        INSERT INTO identity_tokens (identity_id, purpose, token_hash, expires_at)
        VALUES (${identity.id}, 'mfa_challenge', ${hashOpaqueToken(challenge, runtime.auth.tokenPepper)}, ${expiresAt})
      `
    })
    return { mfaRequired: true, challenge, expiresAt: expiresAt.toISOString() }
  }
  await sql`UPDATE identities SET last_login_at = now(), updated_at = now() WHERE id = ${identity.id}`
  const user = await startAuthenticatedSession(event, profile, false)
  return { user, mfaEnrollmentRequired: profile.roles.includes('admin') }
})
