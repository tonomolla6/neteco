import { createHash } from 'node:crypto'
import { z } from 'zod'
import { encryptSecret, hashOpaqueToken, randomOpaqueToken } from '../../server/utils/secrets'
import { SENSITIVE_RATE_LIMIT_POLICIES } from '../../server/utils/abuse-limit'
import { NEWSLETTER_CONSENT_TEXT, NEWSLETTER_POLICY_VERSION } from '../../shared/newsletter'
import type { NewsletterSecrets } from '../marketing/newsletter'
import { isIdentityEmailMailbox, isIdentityEmailDisplayName } from '../communications/identity-email'
import { consumeIdentityQuota } from './identity-quota'
import { hashWorkerPassword, verifyWorkerPassword } from './password'
import { verifySessionCookie } from './session-cookie'
import type { SessionCookieConfiguration } from './session-cookie'
import { preparePasswordResetSecurityNotice } from '../communications/identity-security-email'
import { prepareAccountSecurityNotice } from '../communications/account-security-notices'

export const ACCOUNT_TERMS_POLICY_VERSION = 'account-terms-2026-08-12'
export const ACCOUNT_TERMS_CONSENT_TEXT = 'Acepto las condiciones de la cuenta y la política de privacidad de NETECO.'
export const lifecyclePasswordSchema = z
  .string()
  .min(12)
  .max(128)
  .regex(/[a-záéíóúñ]/i)
  .regex(/\d/)
const emailSchema = z
  .string()
  .trim()
  .email()
  .max(254)
  .refine(isIdentityEmailMailbox)
  .transform((email) => email.toLowerCase())
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const lifecycleRegisterSchema = z
  .object({
    name: z.string().trim().min(2).max(160).refine(isIdentityEmailDisplayName),
    email: emailSchema,
    password: lifecyclePasswordSchema,
    phone: z
      .string()
      .trim()
      .max(32)
      .refine((phone) => !phone || phone.length >= 6)
      .optional(),
    company: z.string().trim().max(160).optional(),
    termsAccepted: z.literal(true),
    newsletter: z.boolean().default(false)
  })
  .strict()
export const lifecycleForgotSchema = z.object({ email: emailSchema }).strict()
export const lifecycleResetSchema = z.object({ token: tokenSchema, password: lifecyclePasswordSchema }).strict()
export const lifecycleVerifySchema = z.object({ token: tokenSchema }).strict()
export const lifecycleEmailChangeSchema = z
  .object({ email: emailSchema, currentPassword: z.string().min(1).max(128) })
  .strict()

export interface IdentityLifecycleSecrets {
  tokenPepper: string
  encryptionKey: string
  newsletterSecrets?: NewsletterSecrets
}
type RegisterInput = z.input<typeof lifecycleRegisterSchema>
type ChangeResult =
  | { ok: true }
  | {
      ok: false
      code:
        | 'unauthenticated'
        | 'mfa_required'
        | 'invalid_password'
        | 'email_unavailable'
        | 'same_email'
        | 'conflict'
        | 'rate_limited'
      retryAfter?: number
    }
type TokenRow = {
  id: string
  identity_id: string
  purpose: 'verify_email' | 'email_change' | 'password_reset'
  recipient: string
  session_version: number
  password_hash: string
  previous_email: string
}

export function validateIdentityLifecycleSecrets(secrets: IdentityLifecycleSecrets) {
  if (
    typeof secrets.tokenPepper !== 'string' ||
    secrets.tokenPepper.length < 32 ||
    secrets.tokenPepper.startsWith('local-only-')
  )
    throw new Error('invalid_identity_lifecycle_pepper')
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(secrets.encryptionKey) ||
    atob(secrets.encryptionKey).length !== 32 ||
    /^A{43}=$/.test(secrets.encryptionKey)
  )
    throw new Error('invalid_identity_lifecycle_encryption')
}
function instant(value?: string) {
  const now = value ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const timestamp = Date.parse(now)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, 'Z') !== now)
    throw new Error('invalid_identity_lifecycle_instant')
  return { now, timestamp }
}
function expires(timestamp: number, ttl: number) {
  return new Date(timestamp + ttl).toISOString().replace(/\.\d{3}Z$/, 'Z')
}
function expectedGuardFailure(cause: unknown) {
  for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
    if (/identity_lifecycle_atomic_guard|account_security_notice_atomic_guard/.test(cause.message)) return true
    cause = cause.cause
  }
  return false
}
function duplicateEmail(cause: unknown) {
  return cause instanceof Error && /UNIQUE constraint failed: identities\.email\b/.test(cause.message)
}
function marker(database: D1Database, operationId: string) {
  return [
    database
      .prepare(
        `INSERT INTO identity_lifecycle_guards(id, valid) VALUES (?1,
      CASE WHEN EXISTS(SELECT 1 FROM identity_lifecycle_events WHERE id = ?1) THEN 1 ELSE 0 END)`
      )
      .bind(operationId),
    database.prepare('DELETE FROM identity_lifecycle_guards WHERE id = ?').bind(operationId)
  ]
}
const ownsOperation = 'EXISTS(SELECT 1 FROM identity_lifecycle_events WHERE id = ?)'
const eligibleIdentity = `i.status IN ('pending', 'active') AND c.status = 'active' AND i.created_at <= ?1`
const sourceSession = `EXISTS(SELECT 1 FROM auth_sessions s LEFT JOIN identity_mfa m ON m.identity_id = i.id
  WHERE s.id = t.authorization_session_id AND s.identity_id = i.id AND s.session_version = i.session_version
    AND s.revoked_at IS NULL AND s.created_at <= ?1 AND s.expires_at > ?1
    AND m.verified_at IS t.authorization_mfa_verified_at AND (m.verified_at IS NULL OR s.mfa_verified = 1))`
const usableToken = `t.used_at IS NULL AND t.revoked_at IS NULL AND t.created_at <= ?1 AND t.expires_at > ?1
  AND t.session_version = i.session_version AND ${eligibleIdentity}
  AND ((t.purpose IN ('verify_email', 'password_reset') AND t.recipient = lower(i.email))
    OR (t.purpose = 'email_change' AND t.recipient <> lower(i.email) AND ${sourceSession}))`

async function newsletterStatement(database: D1Database, email: string, timestamp: number, secrets: NewsletterSecrets) {
  if (!(secrets.hmacKey instanceof Uint8Array) || secrets.hmacKey.length < 32)
    throw new Error('invalid_newsletter_secret')
  // Exactly the established newsletter namespace/key: no authentication-token reuse.
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || email.includes('..'))
    throw new Error('invalid_newsletter_email')
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(secrets.hmacKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`neteco:newsletter:email:v1:${email}`))
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const now = Math.floor(timestamp / 1000)
  return database
    .prepare(
      `INSERT INTO newsletter_subscriptions
    (id, email_normalized, email_hash, status, consent_text, consent_version, consent_source,
      request_id, request_key, requested_at, confirmation_expires_at)
    SELECT ?1, ?2, ?3, 'pending', ?4, ?5, 'registration', ?6, ?7, ?8, ?9
      WHERE NOT EXISTS(SELECT 1 FROM newsletter_suppressions WHERE email_hash = ?3)
    ON CONFLICT(email_normalized) DO UPDATE SET consent_text = excluded.consent_text,
      consent_version = excluded.consent_version, consent_source = excluded.consent_source,
      request_id = excluded.request_id, request_key = excluded.request_key,
      requested_at = excluded.requested_at, confirmation_expires_at = excluded.confirmation_expires_at
    WHERE newsletter_subscriptions.status = 'pending' AND newsletter_subscriptions.confirmation_expires_at <= ?8
      AND NOT EXISTS(SELECT 1 FROM newsletter_suppressions WHERE email_hash = ?3)`
    )
    .bind(
      crypto.randomUUID(),
      email,
      hash,
      NEWSLETTER_CONSENT_TEXT,
      NEWSLETTER_POLICY_VERSION,
      crypto.randomUUID(),
      crypto.randomUUID(),
      now,
      now + 48 * 3600
    )
}

/** Creates a fresh customer, never an email-match ownership link or company location.
 * Consent, pending identity, password-authenticated session and both delivery jobs
 * commit together. The returned claims are internal; no link token is returned.
 */
export async function registerD1Identity(
  database: D1Database,
  input: RegisterInput,
  secrets: IdentityLifecycleSecrets,
  nowInput?: string
) {
  validateIdentityLifecycleSecrets(secrets)
  const body = lifecycleRegisterSchema.parse(input)
  if (body.newsletter && !secrets.newsletterSecrets) throw new Error('newsletter_configuration_unavailable')
  const { now, timestamp } = instant(nowInput)
  const newsletter = body.newsletter
    ? await newsletterStatement(database, body.email, timestamp, secrets.newsletterSecrets!)
    : null
  const passwordHash = await hashWorkerPassword(body.password)
  const customerId = crypto.randomUUID(),
    identityId = crypto.randomUUID(),
    sessionId = crypto.randomUUID(),
    tokenId = crypto.randomUUID(),
    operationId = crypto.randomUUID()
  const token = randomOpaqueToken()
  const sessionExpiresAt = expires(timestamp, 3600_000)
  try {
    await database.batch([
      database
        .prepare('INSERT INTO customers(id, name, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind(customerId, body.name, body.phone || null, now, now),
      database
        .prepare(
          `INSERT INTO identities(id, customer_id, email, password_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`
        )
        .bind(identityId, customerId, body.email, passwordHash, now, now),
      database.prepare(
        `INSERT INTO roles(code, name, description) VALUES ('customer', 'Cliente', 'Cuenta de cliente') ON CONFLICT(code) DO NOTHING`
      ),
      database
        .prepare(`INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES (?, 'customer', ?)`)
        .bind(identityId, now),
      ...(body.company
        ? [
            database
              .prepare(
                `INSERT INTO companies(id, customer_id, legal_name, trade_name, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'pending', ?, ?)`
              )
              .bind(crypto.randomUUID(), customerId, body.company, body.company, now, now)
          ]
        : []),
      database
        .prepare(
          `INSERT INTO identity_legal_acceptances(identity_id, policy_version, consent_text, text_hash, source, accepted_at) VALUES (?, ?, ?, ?, 'registration', ?)`
        )
        .bind(
          identityId,
          ACCOUNT_TERMS_POLICY_VERSION,
          ACCOUNT_TERMS_CONSENT_TEXT,
          createHash('sha256').update(ACCOUNT_TERMS_CONSENT_TEXT).digest('hex'),
          now
        ),
      ...(newsletter ? [newsletter] : []),
      database
        .prepare(
          `INSERT INTO identity_lifecycle_tokens(id, identity_id, purpose, token_hash, token_envelope, recipient, session_version, created_at, expires_at) VALUES (?, ?, 'verify_email', ?, ?, ?, 1, ?, ?)`
        )
        .bind(
          tokenId,
          identityId,
          hashOpaqueToken(token, secrets.tokenPepper),
          encryptSecret(token, secrets.encryptionKey),
          body.email,
          now,
          expires(timestamp, 24 * 3600_000)
        ),
      database
        .prepare(
          `INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at, last_seen_at) VALUES (?, ?, 1, 0, ?, ?, ?)`
        )
        .bind(sessionId, identityId, now, sessionExpiresAt, now),
      database
        .prepare(
          `INSERT INTO identity_lifecycle_events(id, identity_id, event_type, created_at) VALUES (?, ?, 'registered', ?)`
        )
        .bind(operationId, identityId, now),
      ...marker(database, operationId)
    ])
  } catch (cause) {
    if (duplicateEmail(cause)) return { ok: false as const, code: 'email_unavailable' as const }
    throw cause
  }
  return { ok: true as const, sessionId, identityId, sessionVersion: 1, expiresAt: sessionExpiresAt }
}

/** Generic acceptance: ineligible/unknown addresses issue nothing, indistinguishably.
 * Issuance supersedes the previous reset link and commits its durable job atomically.
 */
export async function requestD1PasswordReset(
  database: D1Database,
  input: z.input<typeof lifecycleForgotSchema>,
  secrets: IdentityLifecycleSecrets,
  nowInput?: string
) {
  validateIdentityLifecycleSecrets(secrets)
  const body = lifecycleForgotSchema.parse(input)
  const { now, timestamp } = instant(nowInput)
  const identity = await database
    .prepare(
      `SELECT i.id, i.password_hash, i.session_version FROM identities i JOIN customers c ON c.id = i.customer_id WHERE lower(i.email) = ?2 AND ${eligibleIdentity}`
    )
    .bind(now, body.email)
    .first<{ id: string; password_hash: string; session_version: number }>()
  if (!identity) return { accepted: true as const }
  const operationId = crypto.randomUUID(),
    tokenId = crypto.randomUUID(),
    token = randomOpaqueToken()
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO identity_lifecycle_events(id, identity_id, event_type, created_at)
        SELECT ?2, i.id, 'password_reset_requested', ?1 FROM identities i JOIN customers c ON c.id = i.customer_id
        WHERE i.id = ?3 AND i.password_hash = ?4 AND i.session_version = ?5 AND lower(i.email) = ?6 AND ${eligibleIdentity}`
        )
        .bind(now, operationId, identity.id, identity.password_hash, identity.session_version, body.email),
      database
        .prepare(
          `UPDATE identity_lifecycle_tokens SET revoked_at = ? WHERE identity_id = ? AND purpose = 'password_reset' AND used_at IS NULL AND revoked_at IS NULL AND ${ownsOperation}`
        )
        .bind(now, identity.id, operationId),
      database
        .prepare(
          `INSERT INTO identity_lifecycle_tokens(id, identity_id, purpose, token_hash, token_envelope, recipient, session_version, created_at, expires_at)
        SELECT ?, ?, 'password_reset', ?, ?, ?, ?, ?, ? WHERE ${ownsOperation}`
        )
        .bind(
          tokenId,
          identity.id,
          hashOpaqueToken(token, secrets.tokenPepper),
          encryptSecret(token, secrets.encryptionKey),
          body.email,
          identity.session_version,
          now,
          expires(timestamp, 30 * 60_000),
          operationId
        ),
      ...marker(database, operationId)
    ])
  } catch (cause) {
    if (!expectedGuardFailure(cause)) throw cause
  }
  return { accepted: true as const }
}

/** Password and MFA proof is required to request a change; both are revalidated
 * in-batch after scrypt, so a logout/reset/enrollment during hashing writes nothing.
 */
export async function requestD1EmailChange(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration & IdentityLifecycleSecrets,
  input: z.input<typeof lifecycleEmailChangeSchema>,
  nowInput?: string
): Promise<ChangeResult> {
  validateIdentityLifecycleSecrets(configuration)
  const body = lifecycleEmailChangeSchema.parse(input)
  const claims = await verifySessionCookie(request, configuration)
  if (!claims) return { ok: false, code: 'unauthenticated' }
  const { now, timestamp } = instant(nowInput)
  const current = await database
    .prepare(
      `SELECT i.email, i.password_hash, m.verified_at AS mfa_enabled, s.mfa_verified
    FROM auth_sessions s JOIN identities i ON i.id = s.identity_id JOIN customers c ON c.id = i.customer_id
    LEFT JOIN identity_mfa m ON m.identity_id = i.id
    WHERE s.id = ?2 AND s.identity_id = ?3 AND s.session_version = ?4 AND i.session_version = s.session_version
      AND s.revoked_at IS NULL AND s.created_at <= ?1 AND s.expires_at > ?1 AND ${eligibleIdentity}`
    )
    .bind(now, claims.sessionId, claims.identityId, claims.sessionVersion)
    .first<{ email: string; password_hash: string; mfa_enabled: string | null; mfa_verified: number }>()
  if (!current) return { ok: false, code: 'unauthenticated' }
  if (current.mfa_enabled && !current.mfa_verified) return { ok: false, code: 'mfa_required' }
  const quota = await consumeIdentityQuota(database, {
    identityId: claims.identityId,
    scope: 'account-email-change',
    ...SENSITIVE_RATE_LIMIT_POLICIES['account-email-change'],
    now: Math.floor(timestamp / 1000)
  })
  if (!quota.allowed) return { ok: false, code: 'rate_limited', retryAfter: quota.retryAfter }
  if (!(await verifyWorkerPassword(current.password_hash, body.currentPassword)))
    return { ok: false, code: 'invalid_password' }
  if (body.email === current.email.toLowerCase()) return { ok: false, code: 'same_email' }
  if (await database.prepare('SELECT id FROM identities WHERE email = ?').bind(body.email).first())
    return { ok: false, code: 'email_unavailable' }
  const operationId = crypto.randomUUID(),
    tokenId = crypto.randomUUID(),
    token = randomOpaqueToken()
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO identity_lifecycle_events(id, identity_id, event_type, created_at)
        SELECT ?2, i.id, 'email_change_requested', ?1 FROM identities i JOIN customers c ON c.id = i.customer_id
        JOIN auth_sessions s ON s.identity_id = i.id LEFT JOIN identity_mfa m ON m.identity_id = i.id
        WHERE i.id = ?3 AND i.password_hash = ?4 AND i.session_version = ?5 AND ${eligibleIdentity}
          AND s.id = ?6 AND s.session_version = i.session_version AND s.revoked_at IS NULL AND s.created_at <= ?1 AND s.expires_at > ?1
          AND m.verified_at IS ?7 AND (m.verified_at IS NULL OR s.mfa_verified = 1)
          AND NOT EXISTS(SELECT 1 FROM identities WHERE email = ?8)`
        )
        .bind(
          now,
          operationId,
          claims.identityId,
          current.password_hash,
          claims.sessionVersion,
          claims.sessionId,
          current.mfa_enabled,
          body.email
        ),
      database
        .prepare(
          `UPDATE identity_lifecycle_tokens SET revoked_at = ? WHERE identity_id = ? AND purpose = 'email_change' AND used_at IS NULL AND revoked_at IS NULL AND ${ownsOperation}`
        )
        .bind(now, claims.identityId, operationId),
      database
        .prepare(
          `INSERT INTO identity_lifecycle_tokens(id, identity_id, purpose, token_hash, token_envelope, recipient, session_version, authorization_session_id, authorization_mfa_verified_at, created_at, expires_at)
        SELECT ?, ?, 'email_change', ?, ?, ?, ?, ?, ?, ?, ? WHERE ${ownsOperation}`
        )
        .bind(
          tokenId,
          claims.identityId,
          hashOpaqueToken(token, configuration.tokenPepper),
          encryptSecret(token, configuration.encryptionKey),
          body.email,
          claims.sessionVersion,
          claims.sessionId,
          current.mfa_enabled,
          now,
          expires(timestamp, 30 * 60_000),
          operationId
        ),
      ...marker(database, operationId)
    ])
  } catch (cause) {
    if (expectedGuardFailure(cause)) return { ok: false, code: 'conflict' }
    throw cause
  }
  return { ok: true }
}

async function findToken(
  database: D1Database,
  token: string,
  pepper: string,
  purpose: 'reset' | 'verify',
  now: string
) {
  return database
    .prepare(
      `SELECT t.id, t.identity_id, t.purpose, t.recipient, t.session_version, i.password_hash, i.email AS previous_email
    FROM identity_lifecycle_tokens t JOIN identities i ON i.id = t.identity_id JOIN customers c ON c.id = i.customer_id
    WHERE t.token_hash = ?2 AND ${usableToken} AND ${purpose === 'reset' ? "t.purpose = 'password_reset'" : "t.purpose IN ('verify_email', 'email_change')"}`
    )
    .bind(now, hashOpaqueToken(token, pepper))
    .first<TokenRow>()
}

async function consumeToken(
  database: D1Database,
  token: TokenRow,
  now: string,
  newPasswordHash?: string,
  secrets?: IdentityLifecycleSecrets
) {
  const operationId = crypto.randomUUID()
  const type =
    token.purpose === 'password_reset'
      ? 'password_reset'
      : token.purpose === 'email_change'
        ? 'email_changed'
        : 'email_verified'
  const rotates = token.purpose !== 'verify_email'
  if (rotates && !Number.isSafeInteger(token.session_version + 1)) throw new Error('session_version_overflow')
  // Reset revokes the old version's verification proof too. Renew it atomically
  // for an unverified account so password recovery cannot strand it as pending.
  const freshVerification = token.purpose === 'password_reset' ? randomOpaqueToken() : null
  if (freshVerification && !secrets) throw new Error('missing_reset_verification_configuration')
  const securityNotice =
    token.purpose === 'password_reset'
      ? await preparePasswordResetSecurityNotice(database, { operationId, identityId: token.identity_id, now })
      : null
  const previousEmailNotice =
    token.purpose === 'email_change'
      ? await prepareAccountSecurityNotice(database, {
          eventId: crypto.randomUUID(),
          identityId: token.identity_id,
          kind: 'email_changed',
          recipient: token.previous_email,
          sessionVersion: token.session_version,
          now,
          audience: 'previous',
          domainEventId: operationId
        })
      : []
  const currentEmailNotice =
    token.purpose === 'email_change'
      ? await prepareAccountSecurityNotice(database, {
          eventId: crypto.randomUUID(),
          identityId: token.identity_id,
          kind: 'email_changed',
          recipient: token.recipient,
          sessionVersion: token.session_version + 1,
          now,
          audience: 'current',
          domainEventId: operationId
        })
      : []
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO identity_lifecycle_events(id, identity_id, token_id, event_type, created_at)
        SELECT ?2, i.id, t.id, ?3, ?1 FROM identity_lifecycle_tokens t JOIN identities i ON i.id = t.identity_id
        JOIN customers c ON c.id = i.customer_id WHERE t.id = ?4 AND t.purpose = ?5 AND i.password_hash = ?6 AND ${usableToken}
          AND (t.purpose <> 'email_change' OR NOT EXISTS(SELECT 1 FROM identities occupied WHERE occupied.email = t.recipient AND occupied.id <> i.id))`
        )
        .bind(now, operationId, type, token.id, token.purpose, token.password_hash),
      database
        .prepare(`UPDATE identity_lifecycle_tokens SET used_at = ? WHERE id = ? AND ${ownsOperation}`)
        .bind(now, token.id, operationId),
      ...previousEmailNotice,
      database
        .prepare(
          token.purpose === 'password_reset'
            ? `UPDATE identities SET password_hash = ?, session_version = session_version + 1, updated_at = ? WHERE id = ? AND ${ownsOperation}`
            : token.purpose === 'email_change'
              ? `UPDATE identities SET email = ?, email_verified_at = ?, status = CASE WHEN status = 'pending' THEN 'active' ELSE status END, session_version = session_version + 1, updated_at = ? WHERE id = ? AND ${ownsOperation}`
              : `UPDATE identities SET email_verified_at = COALESCE(email_verified_at, ?), status = CASE WHEN status = 'pending' THEN 'active' ELSE status END, updated_at = ? WHERE id = ? AND ${ownsOperation}`
        )
        .bind(
          ...(token.purpose === 'password_reset'
            ? [newPasswordHash!, now, token.identity_id, operationId]
            : token.purpose === 'email_change'
              ? [token.recipient, now, now, token.identity_id, operationId]
              : [now, now, token.identity_id, operationId])
        ),
      ...currentEmailNotice,
      ...(rotates
        ? [
            database
              .prepare(
                `UPDATE auth_sessions SET revoked_at = ? WHERE identity_id = ? AND revoked_at IS NULL AND ${ownsOperation}`
              )
              .bind(now, token.identity_id, operationId),
            database
              .prepare(
                `UPDATE identity_lifecycle_tokens SET revoked_at = ? WHERE identity_id = ? AND used_at IS NULL AND revoked_at IS NULL AND ${ownsOperation}`
              )
              .bind(now, token.identity_id, operationId)
          ]
        : []),
      ...(freshVerification
        ? [
            database
              .prepare(
                `INSERT INTO identity_lifecycle_tokens
            (id, identity_id, purpose, token_hash, token_envelope, recipient, session_version, created_at, expires_at)
            SELECT ?1, i.id, 'verify_email', ?2, ?3, lower(i.email), i.session_version, ?4, ?5
              FROM identities i JOIN customers c ON c.id = i.customer_id
              WHERE i.id = ?6 AND i.email_verified_at IS NULL AND i.status IN ('pending', 'active')
                AND c.status = 'active' AND ${ownsOperation}`
              )
              .bind(
                crypto.randomUUID(),
                hashOpaqueToken(freshVerification, secrets!.tokenPepper),
                encryptSecret(freshVerification, secrets!.encryptionKey),
                now,
                expires(Date.parse(now), 24 * 3600_000),
                token.identity_id,
                operationId
              )
          ]
        : []),
      ...(securityNotice ? [securityNotice] : []),
      ...marker(database, operationId)
    ])
  } catch (cause) {
    if (expectedGuardFailure(cause)) return { ok: false as const, code: 'invalid_token' as const }
    if (duplicateEmail(cause)) return { ok: false as const, code: 'email_unavailable' as const }
    throw cause
  }
  return { ok: true as const, emailChanged: token.purpose === 'email_change' }
}

export async function resetD1Password(
  database: D1Database,
  input: z.input<typeof lifecycleResetSchema>,
  secrets: IdentityLifecycleSecrets,
  nowInput?: string
) {
  validateIdentityLifecycleSecrets(secrets)
  const body = lifecycleResetSchema.parse(input),
    { now } = instant(nowInput)
  const token = await findToken(database, body.token, secrets.tokenPepper, 'reset', now)
  if (!token) return { ok: false as const, code: 'invalid_token' as const }
  return consumeToken(database, token, now, await hashWorkerPassword(body.password), secrets)
}

/** Link possession proves email only: never issues a password/MFA session. */
export async function verifyD1Email(
  database: D1Database,
  input: z.input<typeof lifecycleVerifySchema>,
  secrets: IdentityLifecycleSecrets,
  nowInput?: string
) {
  validateIdentityLifecycleSecrets(secrets)
  const body = lifecycleVerifySchema.parse(input),
    { now } = instant(nowInput)
  const token = await findToken(database, body.token, secrets.tokenPepper, 'verify', now)
  if (!token) return { ok: false as const, code: 'invalid_token' as const }
  if (
    token.purpose === 'email_change' &&
    (await database
      .prepare('SELECT id FROM identities WHERE email = ? AND id <> ?')
      .bind(token.recipient, token.identity_id)
      .first())
  )
    return { ok: false as const, code: 'email_unavailable' as const }
  const result = await consumeToken(database, token, now)
  return result.ok ? { ...result, identityId: token.identity_id } : result
}
