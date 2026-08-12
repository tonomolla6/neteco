import { useDatabase } from '../../../db/client'
import { createTotpEnrollment, generateRecoveryCodes, recoveryCodeHashes } from '../../../domain/mfa'
import { requireVerifiedIdentity } from '../../../utils/auth-session'
import { encryptSecret } from '../../../utils/secrets'
import { validateRuntimeConfiguration } from '../../../utils/runtime-config'

export default defineEventHandler(async (event) => {
  const authenticated = await requireVerifiedIdentity(event)
  if (authenticated.profile.mfaEnabled && !authenticated.mfaVerified) {
    throw createError({ statusCode: 403, statusMessage: 'Confirma primero tu MFA actual' })
  }
  const runtime = validateRuntimeConfiguration(useRuntimeConfig(event))
  const enrollment = createTotpEnrollment(authenticated.profile.email)
  const recoveryCodes = generateRecoveryCodes()
  const sql = useDatabase()
  await sql`
    INSERT INTO identity_mfa (identity_id, encrypted_secret, recovery_code_hashes, verified_at, last_used_step)
    VALUES (
      ${authenticated.profile.id}, ${encryptSecret(enrollment.secret, runtime.auth.encryptionKey)},
      ${sql.json(recoveryCodeHashes(recoveryCodes, runtime.auth.tokenPepper))}, NULL, NULL
    )
    ON CONFLICT (identity_id) DO UPDATE SET
      encrypted_secret = EXCLUDED.encrypted_secret,
      recovery_code_hashes = EXCLUDED.recovery_code_hashes,
      verified_at = NULL,
      last_used_step = NULL,
      updated_at = now()
  `
  return { uri: enrollment.uri, manualKey: enrollment.secret, recoveryCodes }
})
