/** D1-only newsletter consent primitive. No public HTTP response may serialize `internalDelivery`.
 * The caller must deliver a confirmation link to the address through a separately
 * reviewed channel; this module neither sends mail nor enables campaigns.
 */
export interface NewsletterSecrets {
  /** Independent 32+ random bytes, supplied from a Worker secret, never source code. */
  hmacKey: Uint8Array
}

export interface NewsletterRequest {
  email: string
  purpose: 'newsletter'
  consentText: string
  consentVersion: string
  consentSource: string
  /** Server-controlled retry key, unique to this consent action; not an email or IP. */
  idempotencyKey: string
  now?: number
}

export interface NewsletterDelivery {
  /** Internal handoff only. Never return this object to an unauthenticated client. */
  email: string
  confirmationToken: string
  confirmationExpiresAt: number
}

const CONFIRMATION_TTL_SECONDS = 48 * 60 * 60
const textEncoder = new TextEncoder()
const tokenPattern = /^n1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})$/

function validNow(value: number | undefined): number {
  const now = value ?? Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(now) || now < 1_000_000_000 || now > 8_000_000_000) {
    throw new Error('invalid_newsletter_time')
  }
  return now
}

function normalizeEmail(value: string): string {
  if (typeof value !== 'string') throw new Error('invalid_newsletter_email')
  const email = value.trim().toLowerCase()
  if (email.length > 254 || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || email.includes('..')) {
    throw new Error('invalid_newsletter_email')
  }
  return email
}

function assertSecrets(secrets: NewsletterSecrets): void {
  if (!(secrets?.hmacKey instanceof Uint8Array) || secrets.hmacKey.length < 32) {
    throw new Error('invalid_newsletter_secret')
  }
}

async function hmac(secret: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, textEncoder.encode(message)))
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16))
}

async function emailHash(email: string, secrets: NewsletterSecrets): Promise<string> {
  return hex(await hmac(secrets.hmacKey, `neteco:newsletter:email:v1:${email}`))
}

async function signedToken(kind: 'confirm' | 'unsubscribe', id: string, secrets: NewsletterSecrets): Promise<string> {
  return `n1.${id}.${hex(await hmac(secrets.hmacKey, `neteco:newsletter:${kind}:v1:${id}`))}`
}

/** Privileged dispatch only: reconstruct the link from an immutable request event.
 * No signed token or recipient is persisted in the delivery outbox.
 */
export async function createNewsletterConfirmationToken(
  requestId: string,
  secrets: NewsletterSecrets
): Promise<string> {
  assertSecrets(secrets)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId))
    throw new Error('invalid_newsletter_request_id')
  return signedToken('confirm', requestId, secrets)
}

async function tokenId(
  kind: 'confirm' | 'unsubscribe',
  token: string,
  secrets: NewsletterSecrets
): Promise<string | null> {
  if (typeof token !== 'string') return null
  const match = tokenPattern.exec(token)
  if (!match) return null
  const [, id, signature] = match
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(secrets.hmacKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    new Uint8Array(fromHex(signature!)),
    textEncoder.encode(`neteco:newsletter:${kind}:v1:${id}`)
  )
  return valid ? id! : null
}

function assertRequest(input: NewsletterRequest): void {
  if (input.purpose !== 'newsletter') throw new Error('invalid_newsletter_purpose')
  if (
    typeof input.consentText !== 'string' ||
    input.consentText !== input.consentText.trim() ||
    input.consentText.length < 1 ||
    input.consentText.length > 2048
  )
    throw new Error('invalid_newsletter_consent')
  if (typeof input.consentVersion !== 'string' || !/^[a-zA-Z0-9._:-]{1,80}$/.test(input.consentVersion)) {
    throw new Error('invalid_newsletter_version')
  }
  if (typeof input.consentSource !== 'string' || !/^[a-z0-9._:-]{1,100}$/.test(input.consentSource)) {
    throw new Error('invalid_newsletter_source')
  }
  if (typeof input.idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(input.idempotencyKey)) {
    throw new Error('invalid_newsletter_idempotency_key')
  }
}

type RequestedEvent = {
  email_hash: string
  consent_text: string
  consent_version: string
  consent_source: string
  request_id: string
  current_request_id: string
  status: string
  expires_at: number
  suppressed: number
}

/** Only `accepted` is a public outcome; `internalDelivery` is privileged outbox material. */
export async function requestNewsletterConsent(
  database: D1Database,
  input: NewsletterRequest,
  secrets: NewsletterSecrets
): Promise<{ accepted: true; internalDelivery: NewsletterDelivery | null }> {
  assertSecrets(secrets)
  assertRequest(input)
  const now = validNow(input.now)
  const email = normalizeEmail(input.email)
  const digest = await emailHash(email, secrets)
  const findRequest = () =>
    database
      .prepare(
        `SELECT s.email_hash, e.consent_text, e.consent_version, e.consent_source,
      e.id AS request_id, s.request_id AS current_request_id, s.status,
      s.confirmation_expires_at AS expires_at,
      EXISTS(SELECT 1 FROM newsletter_suppressions x WHERE x.email_hash = s.email_hash) AS suppressed
     FROM newsletter_consent_events e JOIN newsletter_subscriptions s ON s.id = e.subscription_id
     WHERE e.request_key = ?1 AND e.event_type = 'requested'`
      )
      .bind(input.idempotencyKey)
      .first<RequestedEvent>()
  const replay = async (previous: RequestedEvent) => {
    if (
      previous.email_hash !== digest ||
      previous.consent_text !== input.consentText ||
      previous.consent_version !== input.consentVersion ||
      previous.consent_source !== input.consentSource
    ) {
      throw new Error('newsletter_idempotency_conflict')
    }
    return {
      accepted: true as const,
      internalDelivery:
        previous.status === 'pending' &&
        !previous.suppressed &&
        previous.current_request_id === previous.request_id &&
        previous.expires_at > now
          ? {
              email,
              confirmationToken: await signedToken('confirm', previous.request_id, secrets),
              confirmationExpiresAt: previous.expires_at
            }
          : null
    }
  }
  const previous = await findRequest()
  if (previous) return replay(previous)

  const id = crypto.randomUUID()
  const requestId = crypto.randomUUID()
  const expiresAt = now + CONFIRMATION_TTL_SECONDS
  let row: { request_id: string } | null
  try {
    row = await database
      .prepare(
        `INSERT INTO newsletter_subscriptions
      (id, email_normalized, email_hash, status, consent_text, consent_version, consent_source,
       request_id, request_key, requested_at, confirmation_expires_at)
     SELECT ?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?7, ?8, ?9, ?10
     WHERE NOT EXISTS (SELECT 1 FROM newsletter_suppressions WHERE email_hash = ?3)
     ON CONFLICT(email_normalized) DO UPDATE SET
       consent_text = excluded.consent_text,
       consent_version = excluded.consent_version,
       consent_source = excluded.consent_source,
       request_id = excluded.request_id,
       request_key = excluded.request_key,
       requested_at = excluded.requested_at,
       confirmation_expires_at = excluded.confirmation_expires_at
     WHERE newsletter_subscriptions.status = 'pending'
       AND newsletter_subscriptions.confirmation_expires_at <= ?9
       AND NOT EXISTS (SELECT 1 FROM newsletter_suppressions WHERE email_hash = ?3)
     RETURNING request_id`
      )
      .bind(
        id,
        email,
        digest,
        input.consentText,
        input.consentVersion,
        input.consentSource,
        requestId,
        input.idempotencyKey,
        now,
        expiresAt
      )
      .first<{ request_id: string }>()
  } catch (error) {
    // Another isolate may have committed the same retry key after our first read.
    const raced = await findRequest()
    if (raced) return replay(raced)
    throw error
  }
  if (!row) {
    const raced = await findRequest()
    if (raced) return replay(raced)
  }

  return {
    accepted: true,
    internalDelivery: row
      ? {
          email,
          confirmationToken: await signedToken('confirm', row.request_id, secrets),
          confirmationExpiresAt: expiresAt
        }
      : null
  }
}

/** Invalid, expired, already-used and suppressed links have the same public result. */
export async function confirmNewsletterConsent(
  database: D1Database,
  token: string,
  secrets: NewsletterSecrets,
  nowInput?: number
): Promise<{ accepted: true }> {
  assertSecrets(secrets)
  const now = validNow(nowInput)
  const id = await tokenId('confirm', token, secrets)
  if (id) {
    await database
      .prepare(
        `UPDATE newsletter_subscriptions SET status = 'confirmed', confirmed_at = ?2
       WHERE request_id = ?1 AND status = 'pending' AND confirmation_expires_at > ?2
         AND NOT EXISTS (SELECT 1 FROM newsletter_suppressions x
           WHERE x.email_hash = newsletter_subscriptions.email_hash)`
      )
      .bind(id, now)
      .run()
  }
  return { accepted: true }
}

/** The link is stable across messages, unguessable without the secret, and never stored in D1. */
export async function createNewsletterUnsubscribeToken(
  subscriptionId: string,
  secrets: NewsletterSecrets
): Promise<string> {
  assertSecrets(secrets)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(subscriptionId)) {
    throw new Error('invalid_newsletter_subscription_id')
  }
  return signedToken('unsubscribe', subscriptionId, secrets)
}

/** A successful update and suppression insert are one SQLite transaction via trigger. */
export async function unsubscribeNewsletterConsent(
  database: D1Database,
  token: string,
  secrets: NewsletterSecrets,
  nowInput?: number
): Promise<{ accepted: true }> {
  assertSecrets(secrets)
  const now = validNow(nowInput)
  const id = await tokenId('unsubscribe', token, secrets)
  if (id) {
    await database
      .prepare(
        `UPDATE newsletter_subscriptions SET status = 'unsubscribed', unsubscribed_at = ?2
       WHERE id = ?1 AND status IN ('pending', 'confirmed', 'suppressed')`
      )
      .bind(id, now)
      .run()
  }
  return { accepted: true }
}

/** Privileged bounce/complaint/manual/legal ingestion. It never clears a suppression. */
export async function suppressNewsletterEmail(
  database: D1Database,
  emailInput: string,
  reason: 'hard_bounce' | 'complaint' | 'manual' | 'legal',
  source: string,
  secrets: NewsletterSecrets,
  nowInput?: number
): Promise<void> {
  assertSecrets(secrets)
  const email = normalizeEmail(emailInput)
  const now = validNow(nowInput)
  if (!['hard_bounce', 'complaint', 'manual', 'legal'].includes(reason) || !/^[a-z0-9._:-]{1,100}$/.test(source))
    throw new Error('invalid_newsletter_suppression')
  const digest = await emailHash(email, secrets)
  await database
    .prepare(
      `INSERT INTO newsletter_suppressions(email_hash, reason, source, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(email_hash) DO UPDATE SET reason = excluded.reason,
       source = excluded.source, updated_at = excluded.updated_at
     WHERE (CASE excluded.reason WHEN 'legal' THEN 5 WHEN 'complaint' THEN 4
       WHEN 'manual' THEN 3 WHEN 'hard_bounce' THEN 2 ELSE 1 END)
       > (CASE newsletter_suppressions.reason WHEN 'legal' THEN 5 WHEN 'complaint' THEN 4
       WHEN 'manual' THEN 3 WHEN 'hard_bounce' THEN 2 ELSE 1 END)`
    )
    .bind(digest, reason, source, now)
    .run()
}

/** Fail closed at the point of any future marketing send; do not use KV as authority. */
export async function isNewsletterSendEligible(
  database: D1Database,
  emailInput: string,
  secrets: NewsletterSecrets
): Promise<boolean> {
  assertSecrets(secrets)
  const digest = await emailHash(normalizeEmail(emailInput), secrets)
  const row = await database
    .prepare(
      `SELECT 1 AS eligible FROM newsletter_subscriptions s
     WHERE s.email_hash = ?1 AND s.status = 'confirmed'
       AND NOT EXISTS (SELECT 1 FROM newsletter_suppressions x WHERE x.email_hash = s.email_hash)`
    )
    .bind(digest)
    .first<{ eligible: number }>()
  return row?.eligible === 1
}
