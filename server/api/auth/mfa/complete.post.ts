import { z } from 'zod'
import { useDatabase } from '../../../db/client'
import { findRecoveryCode, validateTotp } from '../../../domain/mfa'
import { identityProfile, startAuthenticatedSession } from '../../../utils/auth-session'
import { enforceRateLimit } from '../../../utils/rate-limit'
import { sensitiveRateLimit } from '../../../utils/abuse-limit'
import { decryptSecret, hashOpaqueToken } from '../../../utils/secrets'
import { validateRuntimeConfiguration } from '../../../utils/runtime-config'

const schema = z.object({
  challenge: z.string().min(32).max(256),
  code: z.string().trim().min(6).max(32)
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  await enforceRateLimit(event, sensitiveRateLimit('mfa-complete'))
  const runtime = validateRuntimeConfiguration(useRuntimeConfig(event))
  const sql = useDatabase()
  const challengeHash = hashOpaqueToken(body.challenge, runtime.auth.tokenPepper)
  const [challenge] = await sql<
    Array<{
      tokenId: string
      identityId: string
      attempts: number
      encryptedSecret: string
      lastUsedStep: number | null
      recoveryHashes: string[]
    }>
  >`
    SELECT token.id AS "tokenId", token.identity_id AS "identityId", token.attempts,
           mfa.encrypted_secret AS "encryptedSecret", mfa.last_used_step AS "lastUsedStep",
           mfa.recovery_code_hashes AS "recoveryHashes"
    FROM identity_tokens token
    JOIN identity_mfa mfa ON mfa.identity_id = token.identity_id AND mfa.verified_at IS NOT NULL
    WHERE token.token_hash = ${challengeHash} AND token.purpose = 'mfa_challenge'
      AND token.used_at IS NULL AND token.expires_at > now() AND token.attempts < 6
  `
  if (!challenge) throw createError({ statusCode: 400, statusMessage: 'El reto MFA no es válido o ha caducado' })

  const secret = decryptSecret(challenge.encryptedSecret, runtime.auth.encryptionKey)
  const step = validateTotp({ secret, token: body.code, lastUsedStep: challenge.lastUsedStep })
  const recovery =
    step === null ? findRecoveryCode(body.code, challenge.recoveryHashes, runtime.auth.tokenPepper) : null
  if (step === null && !recovery) {
    await sql`UPDATE identity_tokens SET attempts = attempts + 1 WHERE id = ${challenge.tokenId}`
    throw createError({ statusCode: 401, statusMessage: 'Código MFA incorrecto' })
  }
  const consumed = await sql.begin(async (transaction) => {
    const updated = await transaction<{ id: string }[]>`
      UPDATE identity_tokens SET used_at = now(), attempts = attempts + 1
      WHERE id = ${challenge.tokenId} AND used_at IS NULL AND expires_at > now()
      RETURNING id
    `
    if (!updated[0]) return false
    if (step !== null) {
      const replaySafe = await transaction<{ identityId: string }[]>`
        UPDATE identity_mfa SET last_used_step = ${step}, updated_at = now()
        WHERE identity_id = ${challenge.identityId}
          AND (last_used_step IS NULL OR last_used_step < ${step})
        RETURNING identity_id AS "identityId"
      `
      if (!replaySafe[0]) return false
    } else {
      await transaction`
        UPDATE identity_mfa SET recovery_code_hashes = ${transaction.json(recovery!.remaining)}, updated_at = now()
        WHERE identity_id = ${challenge.identityId}
      `
    }
    await transaction`
      UPDATE identities SET last_login_at = now(), updated_at = now() WHERE id = ${challenge.identityId}
    `
    return true
  })
  if (!consumed) throw createError({ statusCode: 409, statusMessage: 'El código MFA ya se utilizó' })
  const profile = await identityProfile(challenge.identityId)
  if (!profile) throw new Error('MFA identity is not readable')
  const user = await startAuthenticatedSession(event, profile, true)
  return { user }
})
