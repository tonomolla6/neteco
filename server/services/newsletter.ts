import { createHash } from 'node:crypto'
import type { TransactionSql } from 'postgres'
import { NEWSLETTER_CONSENT_TEXT, NEWSLETTER_POLICY_VERSION } from '../../shared/newsletter'
import { encryptSecret, hashOpaqueToken, randomOpaqueToken } from '../utils/secrets'

function emailHash(email: string) {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

function consentTextHash() {
  return createHash('sha256').update(NEWSLETTER_CONSENT_TEXT).digest('hex')
}

export interface NewsletterSecrets {
  tokenPepper: string
  encryptionKey: string
}

export async function requestNewsletterSubscription(
  transaction: TransactionSql,
  input: {
    email: string
    customerId?: string | null
    source: string
    correlationId: string
    secrets: NewsletterSecrets
  }
) {
  const email = input.email.trim().toLowerCase()
  const destinationHash = emailHash(email)
  const [blocked] = await transaction<{ reason: string }[]>`
    SELECT reason FROM communication_suppressions
    WHERE channel = 'email' AND destination_hash = ${destinationHash}
      AND reason IN ('hard_bounce', 'complaint', 'manual', 'legal')
  `
  if (blocked) return { queued: false, reason: 'suppressed' as const }

  const confirmationToken = randomOpaqueToken()
  const unsubscribeToken = randomOpaqueToken()
  const confirmationExpiresAt = new Date(Date.now() + 48 * 60 * 60_000)
  const unsubscribeExpiresAt = new Date(Date.now() + 365 * 24 * 60 * 60_000)
  const [subscription] = await transaction<{ id: string; status: string }[]>`
    INSERT INTO newsletter_subscriptions (
      customer_id, email, email_hash, status, source, policy_version, consent_text_hash,
      confirmation_token_hash, confirmation_expires_at, unsubscribe_token_hash,
      unsubscribe_token_envelope, unsubscribe_expires_at, requested_at,
      confirmed_at, unsubscribed_at, updated_at
    ) VALUES (
      ${input.customerId ?? null}, ${email}, ${destinationHash}, 'pending', ${input.source},
      ${NEWSLETTER_POLICY_VERSION}, ${consentTextHash()},
      ${hashOpaqueToken(confirmationToken, input.secrets.tokenPepper)}, ${confirmationExpiresAt},
      ${hashOpaqueToken(unsubscribeToken, input.secrets.tokenPepper)},
      ${encryptSecret(unsubscribeToken, input.secrets.encryptionKey)}, ${unsubscribeExpiresAt}, now(),
      NULL, NULL, now()
    )
    ON CONFLICT (email) DO UPDATE SET
      customer_id = COALESCE(EXCLUDED.customer_id, newsletter_subscriptions.customer_id),
      status = CASE WHEN newsletter_subscriptions.status = 'active' THEN 'active' ELSE 'pending' END,
      source = EXCLUDED.source, policy_version = EXCLUDED.policy_version,
      consent_text_hash = EXCLUDED.consent_text_hash,
      confirmation_token_hash = CASE WHEN newsletter_subscriptions.status = 'active'
        THEN newsletter_subscriptions.confirmation_token_hash ELSE EXCLUDED.confirmation_token_hash END,
      confirmation_expires_at = CASE WHEN newsletter_subscriptions.status = 'active'
        THEN newsletter_subscriptions.confirmation_expires_at ELSE EXCLUDED.confirmation_expires_at END,
      unsubscribe_token_hash = CASE WHEN newsletter_subscriptions.status = 'active'
        THEN newsletter_subscriptions.unsubscribe_token_hash ELSE EXCLUDED.unsubscribe_token_hash END,
      unsubscribe_token_envelope = CASE WHEN newsletter_subscriptions.status = 'active'
        THEN newsletter_subscriptions.unsubscribe_token_envelope ELSE EXCLUDED.unsubscribe_token_envelope END,
      unsubscribe_expires_at = CASE WHEN newsletter_subscriptions.status = 'active'
        THEN newsletter_subscriptions.unsubscribe_expires_at ELSE EXCLUDED.unsubscribe_expires_at END,
      requested_at = CASE WHEN newsletter_subscriptions.status = 'active'
        THEN newsletter_subscriptions.requested_at ELSE now() END,
      unsubscribed_at = CASE WHEN newsletter_subscriptions.status = 'active'
        THEN newsletter_subscriptions.unsubscribed_at ELSE NULL END,
      updated_at = now()
    RETURNING id, status
  `
  if (!subscription) throw new Error('Newsletter subscription upsert returned no row')
  if (subscription.status === 'active') return { queued: false, reason: 'active' as const }
  await transaction`
    INSERT INTO outbox_events (
      aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
    ) VALUES (
      'newsletter_subscription', ${subscription.id}, 'newsletter.confirmation.requested',
      ${transaction.json({
        recipient: email,
        tokenEnvelope: encryptSecret(confirmationToken, input.secrets.encryptionKey),
        expiresAt: confirmationExpiresAt.toISOString(),
        policyVersion: NEWSLETTER_POLICY_VERSION
      })},
      ${input.correlationId}, ${`newsletter:${subscription.id}:confirm:${confirmationExpiresAt.toISOString()}`}
    )
  `
  return { queued: true, subscriptionId: subscription.id }
}

export async function confirmNewsletterSubscription(
  transaction: TransactionSql,
  input: { token: string; tokenPepper: string; correlationId: string }
) {
  const tokenHash = hashOpaqueToken(input.token, input.tokenPepper)
  const [subscription] = await transaction<
    {
      id: string
      customerId: string | null
      email: string
      emailHash: string
      source: string
      policyVersion: string
      consentTextHash: string
      unsubscribeTokenEnvelope: string
      unsubscribeExpiresAt: Date
    }[]
  >`
    SELECT id, customer_id AS "customerId", email::text, email_hash AS "emailHash", source,
           policy_version AS "policyVersion", consent_text_hash AS "consentTextHash",
           unsubscribe_token_envelope AS "unsubscribeTokenEnvelope",
           unsubscribe_expires_at AS "unsubscribeExpiresAt"
    FROM newsletter_subscriptions
    WHERE confirmation_token_hash = ${tokenHash} AND status = 'pending'
      AND confirmation_expires_at > now()
    FOR UPDATE
  `
  if (!subscription) return null
  const [hardSuppression] = await transaction<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM communication_suppressions
      WHERE channel = 'email' AND destination_hash = ${subscription.emailHash}
        AND reason IN ('hard_bounce', 'complaint', 'manual', 'legal')
    ) AS exists
  `
  if (hardSuppression?.exists) {
    await transaction`
      UPDATE newsletter_subscriptions SET status = 'suppressed', confirmation_token_hash = NULL,
        confirmation_expires_at = NULL, updated_at = now() WHERE id = ${subscription.id}
    `
    return null
  }
  await transaction`
    UPDATE newsletter_subscriptions SET status = 'active', confirmed_at = now(),
      confirmation_token_hash = NULL, confirmation_expires_at = NULL, unsubscribed_at = NULL, updated_at = now()
    WHERE id = ${subscription.id}
  `
  await transaction`
    DELETE FROM communication_suppressions
    WHERE channel = 'email' AND destination_hash = ${subscription.emailHash} AND reason = 'unsubscribe'
  `
  if (subscription.customerId) {
    await transaction`
      INSERT INTO customer_preferences (customer_id, purpose, channel, enabled, frequency)
      VALUES (${subscription.customerId}, 'newsletter', 'email', true, 'weekly')
      ON CONFLICT (customer_id, purpose, channel) DO UPDATE SET enabled = true, updated_at = now()
    `
  }
  await transaction`
    INSERT INTO consent_events (
      customer_id, anonymous_id, purpose, channel, action, policy_version, text_hash, source
    ) VALUES (
      ${subscription.customerId}, ${subscription.customerId ? null : subscription.id}, 'newsletter', 'email',
      'granted', ${subscription.policyVersion}, ${subscription.consentTextHash}, ${subscription.source}
    )
  `
  await transaction`
    INSERT INTO audit_log (
      actor_type, action, resource_type, resource_id, after_redacted, correlation_id
    ) VALUES (
      'customer', 'newsletter.confirmed', 'newsletter_subscription', ${subscription.id},
      ${transaction.json({ source: subscription.source, policyVersion: subscription.policyVersion })},
      ${input.correlationId}
    )
  `
  await transaction`
    INSERT INTO outbox_events (
      aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
    ) VALUES (
      'newsletter_subscription', ${subscription.id}, 'newsletter.welcome',
      ${transaction.json({
        recipient: subscription.email,
        unsubscribeTokenEnvelope: subscription.unsubscribeTokenEnvelope,
        unsubscribeExpiresAt: subscription.unsubscribeExpiresAt.toISOString()
      })},
      ${input.correlationId},
      ${`newsletter:${subscription.id}:welcome:${subscription.unsubscribeExpiresAt.toISOString()}`}
    ) ON CONFLICT (idempotency_key) DO NOTHING
  `
  return { id: subscription.id }
}

export async function unsubscribeNewsletter(
  transaction: TransactionSql,
  input: { token: string; tokenPepper: string; source: string; correlationId: string }
) {
  const tokenHash = hashOpaqueToken(input.token, input.tokenPepper)
  const [subscription] = await transaction<
    {
      id: string
      customerId: string | null
      emailHash: string
      policyVersion: string
      consentTextHash: string
      status: string
    }[]
  >`
    SELECT id, customer_id AS "customerId", email_hash AS "emailHash",
           policy_version AS "policyVersion", consent_text_hash AS "consentTextHash", status
    FROM newsletter_subscriptions
    WHERE unsubscribe_token_hash = ${tokenHash} AND unsubscribe_expires_at > now()
    FOR UPDATE
  `
  if (!subscription) return null
  if (subscription.status === 'unsubscribed') return { id: subscription.id }
  return unsubscribeLockedSubscription(transaction, {
    ...subscription,
    source: input.source,
    correlationId: input.correlationId
  })
}

async function unsubscribeLockedSubscription(
  transaction: TransactionSql,
  subscription: {
    id: string
    customerId: string | null
    emailHash: string
    policyVersion: string
    consentTextHash: string
    source: string
    correlationId: string
  }
) {
  await transaction`
    UPDATE newsletter_subscriptions SET status = 'unsubscribed', unsubscribed_at = COALESCE(unsubscribed_at, now()),
      updated_at = now() WHERE id = ${subscription.id}
  `
  await transaction`
    INSERT INTO communication_suppressions (channel, destination_hash, reason, source)
    VALUES ('email', ${subscription.emailHash}, 'unsubscribe', ${subscription.source})
    ON CONFLICT (channel, destination_hash) DO UPDATE SET
      reason = CASE
        WHEN communication_suppressions.reason IN ('hard_bounce', 'complaint', 'manual', 'legal')
          THEN communication_suppressions.reason
        ELSE 'unsubscribe'
      END,
      source = CASE
        WHEN communication_suppressions.reason IN ('hard_bounce', 'complaint', 'manual', 'legal')
          THEN communication_suppressions.source
        ELSE EXCLUDED.source
      END,
      created_at = CASE
        WHEN communication_suppressions.reason IN ('hard_bounce', 'complaint', 'manual', 'legal')
          THEN communication_suppressions.created_at
        ELSE now()
      END
  `
  if (subscription.customerId) {
    await transaction`
      UPDATE customer_preferences SET enabled = false, updated_at = now()
      WHERE customer_id = ${subscription.customerId} AND purpose = 'newsletter' AND channel = 'email'
    `
  }
  await transaction`
    INSERT INTO consent_events (
      customer_id, anonymous_id, purpose, channel, action, policy_version, text_hash, source
    ) VALUES (
      ${subscription.customerId}, ${subscription.customerId ? null : subscription.id}, 'newsletter', 'email',
      'withdrawn', ${subscription.policyVersion}, ${subscription.consentTextHash}, ${subscription.source}
    )
  `
  await transaction`
    INSERT INTO audit_log (
      actor_type, action, resource_type, resource_id, after_redacted, correlation_id
    ) VALUES (
      'customer', 'newsletter.unsubscribed', 'newsletter_subscription', ${subscription.id},
      ${transaction.json({ source: subscription.source })}, ${subscription.correlationId}
    )
  `
  return { id: subscription.id }
}

export async function unsubscribeNewsletterByCustomer(
  transaction: TransactionSql,
  input: { customerId: string; source: string; correlationId: string }
) {
  const [subscription] = await transaction<
    {
      id: string
      customerId: string
      emailHash: string
      policyVersion: string
      consentTextHash: string
      status: string
    }[]
  >`
    SELECT subscription.id, ${input.customerId}::uuid AS "customerId",
           subscription.email_hash AS "emailHash", subscription.policy_version AS "policyVersion",
           subscription.consent_text_hash AS "consentTextHash", subscription.status
    FROM newsletter_subscriptions subscription
    JOIN customers customer ON customer.id = ${input.customerId}
    WHERE subscription.customer_id = ${input.customerId}
       OR subscription.email = customer.email
    ORDER BY (subscription.customer_id = ${input.customerId}) DESC, subscription.updated_at DESC
    FOR UPDATE OF subscription
    LIMIT 1
  `
  if (!subscription) {
    await transaction`
      UPDATE customer_preferences SET enabled = false, updated_at = now()
      WHERE customer_id = ${input.customerId} AND purpose = 'newsletter' AND channel = 'email'
    `
    return null
  }
  await transaction`
    UPDATE newsletter_subscriptions SET customer_id = ${input.customerId}, updated_at = now()
    WHERE id = ${subscription.id} AND customer_id IS DISTINCT FROM ${input.customerId}
  `
  if (subscription.status === 'unsubscribed') return { id: subscription.id }
  return unsubscribeLockedSubscription(transaction, {
    ...subscription,
    source: input.source,
    correlationId: input.correlationId
  })
}
