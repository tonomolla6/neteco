import { z } from 'zod'
import { useDatabase } from '../../../db/client'
import { validateTotp } from '../../../domain/mfa'
import { identityProfile, refreshAuthenticatedSession, requireVerifiedIdentity } from '../../../utils/auth-session'
import { enforceRateLimit } from '../../../utils/rate-limit'
import { sensitiveRateLimit } from '../../../utils/abuse-limit'
import { decryptSecret } from '../../../utils/secrets'
import { validateRuntimeConfiguration } from '../../../utils/runtime-config'

const schema = z.object({ code: z.string().regex(/^\d{6}$/) })

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  await enforceRateLimit(event, sensitiveRateLimit('mfa-setup'))
  const authenticated = await requireVerifiedIdentity(event)
  const runtime = validateRuntimeConfiguration(useRuntimeConfig(event))
  const sql = useDatabase()
  const [mfa] = await sql<{ encryptedSecret: string; lastUsedStep: number | null }[]>`
    SELECT encrypted_secret AS "encryptedSecret", last_used_step AS "lastUsedStep"
    FROM identity_mfa WHERE identity_id = ${authenticated.profile.id}
  `
  if (!mfa) throw createError({ statusCode: 409, statusMessage: 'Inicia primero la configuración MFA' })
  const step = validateTotp({
    secret: decryptSecret(mfa.encryptedSecret, runtime.auth.encryptionKey),
    token: body.code,
    lastUsedStep: mfa.lastUsedStep
  })
  if (step === null) throw createError({ statusCode: 400, statusMessage: 'Código MFA incorrecto' })
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE identity_mfa SET verified_at = now(), last_used_step = ${step}, updated_at = now()
      WHERE identity_id = ${authenticated.profile.id}
        AND (last_used_step IS NULL OR last_used_step < ${step})
    `
    await transaction`
      UPDATE auth_sessions SET mfa_verified = true WHERE id = ${authenticated.session.sessionId!}
    `
  })
  const profile = await identityProfile(authenticated.profile.id)
  if (!profile) throw new Error('MFA identity is not readable')
  const user = await refreshAuthenticatedSession(event, profile, true, authenticated.session.sessionId!)
  return { ok: true, user }
})
