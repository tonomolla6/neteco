import { createHash } from 'node:crypto'
import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { requestNewsletterSubscription } from '../../services/newsletter'
import { identityProfile, startAuthenticatedSession } from '../../utils/auth-session'
import { enforceRateLimit } from '../../utils/rate-limit'
import { sensitiveRateLimit } from '../../utils/abuse-limit'
import { encryptSecret, hashOpaqueToken, randomOpaqueToken } from '../../utils/secrets'
import { validateRuntimeConfiguration } from '../../utils/runtime-config'

const passwordSchema = z
  .string()
  .min(12, 'La contraseña debe tener al menos 12 caracteres')
  .max(128)
  .regex(/[a-záéíóúñ]/i, 'La contraseña debe contener una letra')
  .regex(/\d/, 'La contraseña debe contener un número')

const schema = z
  .object({
    name: z.string().trim().min(2).max(160),
    email: z.string().trim().email().max(254),
    password: passwordSchema,
    phone: z.string().trim().max(32).optional(),
    company: z.string().trim().max(160).optional(),
    termsAccepted: z.literal(true),
    newsletter: z.boolean().default(false)
  })
  .strict()

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  await enforceRateLimit(event, sensitiveRateLimit('register', body.email))
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
      if (body.company) {
        const [company] = await transaction<{ id: string }[]>`
          INSERT INTO companies (legal_name, trade_name, status)
          VALUES (${body.company}, ${body.company}, 'pending') RETURNING id
        `
        if (!company) throw new Error('Company insert returned no row')
        await transaction`
          INSERT INTO company_locations (company_id, name, code, billing_email)
          VALUES (${company.id}, 'Sede principal', 'MAIN', ${normalizedEmail})
        `
        await transaction`
          INSERT INTO company_members (company_id, identity_id, role, status, accepted_at)
          VALUES (${company.id}, ${identity.id}, 'company_admin', 'active', now())
        `
      }
      await transaction`
        INSERT INTO customer_preferences (customer_id, purpose, channel, enabled)
        VALUES (${customer.id}, 'transactional', 'email', true),
               (${customer.id}, 'newsletter', 'email', false)
      `
      const accountTextHash = createHash('sha256').update('account-terms-2026-08-12').digest('hex')
      await transaction`
        INSERT INTO consent_events (customer_id, purpose, channel, action, policy_version, text_hash, source)
        VALUES (${customer.id}, 'account_terms', 'web', 'granted', 'account-terms-2026-08-12',
                ${accountTextHash}, 'registration')
      `
      if (body.newsletter) {
        await requestNewsletterSubscription(transaction, {
          email: normalizedEmail,
          customerId: customer.id,
          source: 'registration',
          correlationId,
          secrets: {
            tokenPepper: runtime.auth.tokenPepper,
            encryptionKey: runtime.auth.encryptionKey
          }
        })
      }
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
