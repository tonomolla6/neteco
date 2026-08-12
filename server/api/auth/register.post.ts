import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { identityProfile, startAuthenticatedSession } from '../../utils/auth-session'
import { enforceRateLimit } from '../../utils/rate-limit'
import { encryptSecret, hashOpaqueToken, randomOpaqueToken } from '../../utils/secrets'
import { validateRuntimeConfiguration } from '../../utils/runtime-config'

const passwordSchema = z
  .string()
  .min(12, 'La contraseña debe tener al menos 12 caracteres')
  .max(128)
  .regex(/[a-záéíóúñ]/i, 'La contraseña debe contener una letra')
  .regex(/\d/, 'La contraseña debe contener un número')

const schema = z.object({
  name: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(254),
  password: passwordSchema,
  phone: z.string().trim().max(32).optional(),
  company: z.string().trim().max(160).optional()
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  await enforceRateLimit(event, { scope: 'register', subject: body.email, limit: 3, windowSeconds: 3600 })
  const runtime = validateRuntimeConfiguration(useRuntimeConfig(event))
  const sql = useDatabase()
  const normalizedEmail = body.email.toLowerCase()
  const passwordHash = await hashPassword(body.password)
  const verificationToken = randomOpaqueToken()
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000)
  const correlationId = event.context.correlationId ?? crypto.randomUUID()

  let profileId: string
  try {
    profileId = await sql.begin(async (transaction) => {
      const [customer] = await transaction<{ id: string }[]>`
        INSERT INTO customers (email, name, phone)
        VALUES (${normalizedEmail}, ${body.name}, ${body.phone || null})
        ON CONFLICT (email) WHERE email IS NOT NULL AND merged_into_id IS NULL DO UPDATE SET
          name = EXCLUDED.name, phone = COALESCE(EXCLUDED.phone, customers.phone), updated_at = now()
        RETURNING id
      `
      if (!customer) throw new Error('Customer insert returned no row')
      const [identity] = await transaction<{ id: string }[]>`
        INSERT INTO identities (customer_id, email, password_hash, status)
        VALUES (${customer.id}, ${normalizedEmail}, ${passwordHash}, 'pending')
        RETURNING id
      `
      if (!identity) throw new Error('Identity insert returned no row')
      await transaction`
        INSERT INTO identity_roles (identity_id, role_code) VALUES (${identity.id}, 'customer')
      `
      await transaction`
        INSERT INTO identity_tokens (identity_id, purpose, token_hash, expires_at)
        VALUES (
          ${identity.id}, 'verify_email',
          ${hashOpaqueToken(verificationToken, runtime.auth.tokenPepper)}, ${expiresAt}
        )
      `
      await transaction`
        INSERT INTO outbox_events (
          aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
        ) VALUES (
          'identity', ${identity.id}, 'identity.verification.requested',
          ${transaction.json({
            recipient: normalizedEmail,
            name: body.name,
            tokenEnvelope: encryptSecret(verificationToken, runtime.auth.encryptionKey),
            expiresAt: expiresAt.toISOString()
          })}, ${correlationId}, ${`identity:${identity.id}:verify:${expiresAt.toISOString()}`}
        )
      `
      return identity.id
    })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw createError({ statusCode: 409, statusMessage: 'Ya existe una cuenta con ese email' })
    }
    throw error
  }
  const profile = await identityProfile(profileId)
  if (!profile) throw new Error('Registered identity is not readable')
  const user = await startAuthenticatedSession(event, profile, false)
  setResponseStatus(event, 201)
  return { user, verificationRequired: true }
})
