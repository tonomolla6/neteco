import { decryptSecret, opaqueTokenMatches } from '../../server/utils/secrets'
import { isCanonicalInventoryInstant } from '../catalog/inventory'
import {
  assertIdentityEmailOrigin,
  isIdentityEmailDisplayName,
  isIdentityEmailMailbox,
  renderIdentityEmail,
  type IdentityEmailPurpose
} from './identity-email'
import type { TransactionalEmailSender } from './transactional-email-delivery'

export interface IdentityEmailDispatchConfig {
  /** Strict opt-in: absent/false never invokes the provider. */
  enabled?: boolean
  from?: string
  publicOrigin?: string
  encryptionKey?: string
  tokenPepper?: string
  now: string
  limit?: number
}

/** Counts only: no token, recipient, envelope, provider body or error text. */
export interface IdentityEmailDispatchReport {
  sent: number
  retryable: number
  manualReview: number
  cancelled: number
  lostLease: number
  disabled: boolean
}

interface TokenRow {
  id: string
  purpose: string
  token_hash: string
  token_envelope: string
  recipient: string
  created_at: string
  expires_at: string
  used_at: string | null
  revoked_at: string | null
  session_version: number
  identity_email: string | null
  identity_status: string | null
  identity_session_version: number | null
  email_verified_at: string | null
  customer_status: string | null
  customer_name: string | null
  recipient_occupied: number
  authorization_current: number
}

type PreparedIdentityMessage =
  | { state: 'manual_review' | 'cancelled'; error: string }
  | {
      row: TokenRow
      secretToken: string
      message: Parameters<TransactionalEmailSender['send']>[0]
    }

const MAX_ATTEMPTS = 10
const PREPARE_LEASE_SECONDS = 60
const SEND_LEASE_SECONDS = 900

function after(now: string, seconds: number): string {
  return new Date(new Date(now).getTime() + seconds * 1000).toISOString().replace('.000Z', 'Z')
}

function validateEnabledConfiguration(
  sender: TransactionalEmailSender | undefined,
  config: IdentityEmailDispatchConfig
) {
  if (!sender || typeof sender.send !== 'function') throw new Error('identity_email_sender_unavailable')
  if (!isIdentityEmailMailbox(config.from)) throw new Error('invalid_identity_email_from')
  assertIdentityEmailOrigin(config.publicOrigin)
  if (
    typeof config.encryptionKey !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(config.encryptionKey) ||
    atob(config.encryptionKey).length !== 32 ||
    /^A{43}=$/.test(config.encryptionKey)
  )
    throw new Error('invalid_identity_email_encryption_key')
  if (
    typeof config.tokenPepper !== 'string' ||
    config.tokenPepper.length < 32 ||
    config.tokenPepper.length > 1024 ||
    config.tokenPepper.startsWith('local-only-')
  )
    throw new Error('invalid_identity_email_token_pepper')
  return {
    sender,
    from: config.from,
    publicOrigin: config.publicOrigin,
    encryptionKey: config.encryptionKey,
    tokenPepper: config.tokenPepper
  }
}

async function prepareMessage(
  database: D1Database,
  tokenId: string,
  now: string,
  config: ReturnType<typeof validateEnabledConfiguration>
): Promise<PreparedIdentityMessage> {
  const row = await database
    .prepare(
      `SELECT t.id, t.purpose, t.token_hash, t.token_envelope, t.recipient,
              t.created_at, t.expires_at, t.used_at, t.revoked_at, t.session_version,
              i.email AS identity_email, i.status AS identity_status,
              i.session_version AS identity_session_version, i.email_verified_at,
              c.status AS customer_status, c.name AS customer_name,
              EXISTS (SELECT 1 FROM identities other
                      WHERE other.email = t.recipient AND other.id <> t.identity_id) AS recipient_occupied,
              CASE WHEN t.purpose <> 'email_change' THEN 1 ELSE EXISTS (
                SELECT 1 FROM auth_sessions s LEFT JOIN identity_mfa m ON m.identity_id = s.identity_id
                WHERE s.id = t.authorization_session_id AND s.identity_id = t.identity_id
                  AND s.revoked_at IS NULL AND s.created_at <= ?2 AND s.expires_at > ?2
                  AND s.session_version = t.session_version
                  AND m.verified_at IS t.authorization_mfa_verified_at
                  AND (m.verified_at IS NULL OR s.mfa_verified = 1)
              ) END AS authorization_current
       FROM identity_lifecycle_tokens t
       LEFT JOIN identities i ON i.id = t.identity_id
       LEFT JOIN customers c ON c.id = i.customer_id WHERE t.id = ?1`
    )
    .bind(tokenId, now)
    .first<TokenRow>()
  if (!row) return { state: 'manual_review', error: 'token_source_missing' } as const
  if (
    !['verify_email', 'password_reset', 'email_change'].includes(row.purpose) ||
    !/^[a-f0-9]{64}$/.test(row.token_hash) ||
    !isIdentityEmailMailbox(row.recipient) ||
    row.recipient !== row.recipient.toLowerCase() ||
    !isCanonicalInventoryInstant(row.created_at) ||
    !isCanonicalInventoryInstant(row.expires_at) ||
    row.expires_at <= row.created_at ||
    !Number.isSafeInteger(row.session_version) ||
    row.session_version < 1 ||
    !isIdentityEmailDisplayName(row.customer_name)
  )
    return { state: 'manual_review', error: 'invalid_token_source' } as const
  if (row.used_at !== null || row.revoked_at !== null || row.created_at > now || row.expires_at <= now)
    return { state: 'cancelled', error: 'token_unavailable' } as const
  if (
    !['pending', 'active'].includes(row.identity_status ?? '') ||
    row.customer_status !== 'active' ||
    row.identity_session_version !== row.session_version ||
    row.authorization_current !== 1
  )
    return { state: 'cancelled', error: 'identity_unavailable' } as const
  if (
    (row.purpose !== 'email_change' && row.recipient !== row.identity_email?.toLowerCase()) ||
    (row.purpose === 'verify_email' && row.email_verified_at !== null) ||
    (row.purpose === 'email_change' &&
      (row.recipient === row.identity_email?.toLowerCase() || row.recipient_occupied !== 0))
  )
    return { state: 'cancelled', error: 'recipient_unavailable' } as const
  let token: string
  try {
    token = decryptSecret(row.token_envelope, config.encryptionKey)
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !opaqueTokenMatches(token, row.token_hash, config.tokenPepper))
      return { state: 'manual_review', error: 'token_integrity_failed' } as const
  } catch {
    return { state: 'manual_review', error: 'token_integrity_failed' } as const
  }
  return {
    row,
    secretToken: token,
    message: {
      to: row.recipient,
      from: config.from,
      ...renderIdentityEmail({
        purpose: row.purpose as IdentityEmailPurpose,
        token,
        publicOrigin: config.publicOrigin,
        expiresAt: row.expires_at,
        displayName: row.customer_name
      })
    }
  } as const
}

async function settlePreparation(
  database: D1Database,
  tokenId: string,
  lease: string,
  now: string,
  state: 'manual_review' | 'cancelled',
  code: string
) {
  return database
    .prepare(
      `UPDATE identity_lifecycle_deliveries
       SET state = ?4, lease_token = NULL, lease_until = NULL,
           updated_at = ?3, last_error_code = ?5
       WHERE token_id = ?1 AND state = 'preparing' AND lease_token = ?2 RETURNING token_id`
    )
    .bind(tokenId, lease, now, state, code)
    .first()
}

/**
 * Durable local outbox without an exactly-once claim. Only pre-provider leases
 * can be reclaimed. Once sending is committed, a crash/timeout/invalid receipt
 * is ambiguous and quarantined. The existing adapter has no authoritative
 * refusal/idempotent replay API, so no thrown provider error is blindly retried.
 *
 * Token/identity eligibility is rechecked atomically when entering sending.
 * Revocation after that boundary cannot cancel an already-running external
 * network request; consumption still checks the authoritative revoked token.
 */
export async function dispatchIdentityEmailDeliveries(
  database: D1Database,
  sender: TransactionalEmailSender | undefined,
  config: IdentityEmailDispatchConfig
): Promise<IdentityEmailDispatchReport> {
  const limit = config.limit ?? 25
  if (!isCanonicalInventoryInstant(config.now) || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('invalid_identity_email_dispatch_input')
  const report: IdentityEmailDispatchReport = {
    sent: 0,
    retryable: 0,
    manualReview: 0,
    cancelled: 0,
    lostLease: 0,
    disabled: config.enabled !== true
  }
  // Validate every enabled dependency before any claim or durable mutation.
  const enabled = report.disabled ? undefined : validateEnabledConfiguration(sender, config)
  const stale = await database
    .prepare(
      `UPDATE identity_lifecycle_deliveries
       SET state = 'manual_review', lease_token = NULL, lease_until = NULL,
           updated_at = ?1, last_error_code = 'sending_lease_expired'
       WHERE token_id IN (
         SELECT token_id FROM identity_lifecycle_deliveries
         WHERE state = 'sending' AND lease_until <= ?1 ORDER BY lease_until, token_id LIMIT ?2
       ) RETURNING token_id`
    )
    .bind(config.now, limit)
    .all()
  report.manualReview += stale.results.length
  if (!enabled) return report
  const exhausted = await database
    .prepare(
      `UPDATE identity_lifecycle_deliveries
       SET state = 'manual_review', lease_token = NULL, lease_until = NULL,
           updated_at = ?1, last_error_code = 'preparation_attempts_exhausted'
       WHERE token_id IN (
         SELECT token_id FROM identity_lifecycle_deliveries WHERE attempts >= ?2
           AND (state IN ('pending', 'retryable') OR (state = 'preparing' AND lease_until <= ?1))
         ORDER BY next_attempt_at, token_id LIMIT ?3
       ) RETURNING token_id`
    )
    .bind(config.now, MAX_ATTEMPTS, limit)
    .all()
  report.manualReview += exhausted.results.length
  const candidates = (
    await database
      .prepare(
        `SELECT token_id FROM identity_lifecycle_deliveries WHERE created_at <= ?1 AND
           ((state IN ('pending', 'retryable') AND next_attempt_at <= ?1)
            OR (state = 'preparing' AND lease_until <= ?1))
         ORDER BY next_attempt_at, token_id LIMIT ?2`
      )
      .bind(config.now, limit)
      .all<{ token_id: string }>()
  ).results
  for (const { token_id: tokenId } of candidates) {
    const lease = crypto.randomUUID()
    const claim = await database
      .prepare(
        `UPDATE identity_lifecycle_deliveries
         SET state = 'preparing', lease_token = ?2, lease_until = ?3,
             attempts = attempts + 1, updated_at = ?4
         WHERE token_id = ?1 AND attempts < ?5 AND created_at <= ?4 AND
           ((state IN ('pending', 'retryable') AND next_attempt_at <= ?4)
            OR (state = 'preparing' AND lease_until <= ?4)) RETURNING attempts`
      )
      .bind(tokenId, lease, after(config.now, PREPARE_LEASE_SECONDS), config.now, MAX_ATTEMPTS)
      .first<{ attempts: number }>()
    if (!claim) continue
    let prepared: Awaited<ReturnType<typeof prepareMessage>>
    try {
      prepared = await prepareMessage(database, tokenId, config.now, enabled)
    } catch {
      const retried = await database
        .prepare(
          `UPDATE identity_lifecycle_deliveries
           SET state = CASE WHEN attempts >= ?4 THEN 'manual_review' ELSE 'retryable' END,
               next_attempt_at = ?3, lease_token = NULL, lease_until = NULL,
               updated_at = ?5, last_error_code = 'preparation_failed'
           WHERE token_id = ?1 AND state = 'preparing' AND lease_token = ?2 RETURNING state`
        )
        .bind(
          tokenId,
          lease,
          after(config.now, Math.min(3600, 30 * 2 ** (claim.attempts - 1))),
          MAX_ATTEMPTS,
          config.now
        )
        .first<{ state: string }>()
      if (!retried) report.lostLease++
      else if (retried.state === 'manual_review') report.manualReview++
      else report.retryable++
      continue
    }
    if ('error' in prepared) {
      const blocked = await settlePreparation(database, tokenId, lease, config.now, prepared.state, prepared.error)
      if (!blocked) report.lostLease++
      else if (prepared.state === 'cancelled') report.cancelled++
      else report.manualReview++
      continue
    }
    // Snapshot integrity + current eligibility are checked again at the send
    // boundary, not just at the earlier read. All comparisons stay inside D1.
    const sending = await database
      .prepare(
        `UPDATE identity_lifecycle_deliveries
         SET state = 'sending', lease_until = ?4, updated_at = ?3, last_error_code = NULL
         WHERE token_id = ?1 AND state = 'preparing' AND lease_token = ?2 AND
           EXISTS (SELECT 1 FROM identity_lifecycle_tokens t
             JOIN identities i ON i.id = t.identity_id
             JOIN customers c ON c.id = i.customer_id
             WHERE t.id = ?1 AND t.used_at IS NULL AND t.revoked_at IS NULL
               AND t.created_at <= ?3 AND t.expires_at > ?3
               AND t.session_version = i.session_version AND i.status IN ('pending', 'active')
               AND c.status = 'active' AND t.token_hash = ?5 AND t.token_envelope = ?6
               AND t.recipient = ?7 AND t.purpose = ?8
               AND ((t.purpose IN ('verify_email', 'password_reset') AND t.recipient = lower(i.email)
                     AND (t.purpose <> 'verify_email' OR i.email_verified_at IS NULL))
                 OR (t.purpose = 'email_change' AND t.recipient <> lower(i.email) AND NOT EXISTS (
                   SELECT 1 FROM identities other WHERE other.email = t.recipient AND other.id <> i.id)
                   AND EXISTS (SELECT 1 FROM auth_sessions s
                     LEFT JOIN identity_mfa m ON m.identity_id = s.identity_id
                     WHERE s.id = t.authorization_session_id AND s.identity_id = t.identity_id
                       AND s.revoked_at IS NULL AND s.created_at <= ?3 AND s.expires_at > ?3
                       AND s.session_version = t.session_version
                       AND m.verified_at IS t.authorization_mfa_verified_at
                       AND (m.verified_at IS NULL OR s.mfa_verified = 1)))))
         RETURNING token_id`
      )
      .bind(
        tokenId,
        lease,
        config.now,
        after(config.now, SEND_LEASE_SECONDS),
        prepared.row.token_hash,
        prepared.row.token_envelope,
        prepared.row.recipient,
        prepared.row.purpose
      )
      .first()
    if (!sending) {
      const cancelled = await settlePreparation(
        database,
        tokenId,
        lease,
        config.now,
        'cancelled',
        'token_no_longer_eligible'
      )
      if (cancelled) report.cancelled++
      else report.lostLease++
      continue
    }
    let errorCode = 'provider_outcome_unknown'
    try {
      const receipt = await enabled.sender.send(prepared.message)
      errorCode = 'provider_receipt_invalid'
      if (
        !receipt ||
        typeof receipt.messageId !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(receipt.messageId) ||
        receipt.messageId.includes(prepared.secretToken) ||
        receipt.messageId.includes(prepared.row.token_envelope)
      )
        throw new Error('invalid_identity_email_provider_receipt')
      errorCode = 'provider_ack_failed'
      const acknowledged = await database
        .prepare(
          `UPDATE identity_lifecycle_deliveries
           SET state = 'sent', provider_message_id = ?4, lease_token = NULL,
               lease_until = NULL, updated_at = ?3, last_error_code = NULL
           WHERE token_id = ?1 AND state = 'sending' AND lease_token = ?2 RETURNING token_id`
        )
        .bind(tokenId, lease, config.now, receipt.messageId)
        .first()
      if (acknowledged) report.sent++
      else report.lostLease++
      continue
    } catch {
      // No exception contents are persisted: even a rejection may be ambiguous
      // with this adapter's contract. sending must never re-enter pending.
    }
    try {
      const quarantined = await database
        .prepare(
          `UPDATE identity_lifecycle_deliveries
           SET state = 'manual_review', lease_token = NULL, lease_until = NULL,
               updated_at = ?3, last_error_code = ?4
           WHERE token_id = ?1 AND state = 'sending' AND lease_token = ?2 RETURNING token_id`
        )
        .bind(tokenId, lease, config.now, errorCode)
        .first()
      if (quarantined) report.manualReview++
      else report.lostLease++
    } catch {
      // The durable sending row is still non-retryable. A later sweep quarantines it.
      report.manualReview++
    }
  }
  return report
}
