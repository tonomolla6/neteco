CREATE TABLE newsletter_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  email citext NOT NULL,
  email_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'unsubscribed', 'suppressed')),
  source text NOT NULL CHECK (length(source) BETWEEN 2 AND 80),
  policy_version text NOT NULL,
  consent_text_hash text NOT NULL,
  confirmation_token_hash text,
  confirmation_expires_at timestamptz,
  unsubscribe_token_hash text,
  unsubscribe_token_envelope text,
  unsubscribe_expires_at timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email),
  CHECK (
    status <> 'pending'
    OR (confirmation_token_hash IS NOT NULL AND confirmation_expires_at IS NOT NULL)
  ),
  CHECK (
    status <> 'active'
    OR (confirmed_at IS NOT NULL AND unsubscribe_token_hash IS NOT NULL
      AND unsubscribe_token_envelope IS NOT NULL AND unsubscribe_expires_at IS NOT NULL)
  )
);

CREATE INDEX newsletter_subscriptions_status_idx ON newsletter_subscriptions (status, updated_at);
CREATE INDEX newsletter_subscriptions_customer_idx ON newsletter_subscriptions (customer_id)
  WHERE customer_id IS NOT NULL;

COMMENT ON TABLE newsletter_subscriptions IS
  'Double opt-in lifecycle. Raw action tokens are never persisted; unsubscribe token envelopes are encrypted.';

INSERT INTO newsletter_subscriptions (
  customer_id, email, email_hash, status, source, policy_version, consent_text_hash,
  confirmation_token_hash, confirmation_expires_at, requested_at, confirmed_at
)
SELECT customer.id, customer.email,
       encode(digest(lower(customer.email::text), 'sha256'), 'hex'),
       'suppressed', 'legacy_preference', 'communications-2026-08-12',
       encode(digest('newsletter-2026-08-12', 'sha256'), 'hex'),
       encode(digest(gen_random_uuid()::text, 'sha256'), 'hex'), now() - interval '1 second',
       preference.updated_at, preference.updated_at
FROM customer_preferences preference
JOIN customers customer ON customer.id = preference.customer_id
WHERE preference.purpose = 'newsletter' AND preference.channel = 'email'
  AND preference.enabled AND customer.email IS NOT NULL
ON CONFLICT (email) DO NOTHING;

UPDATE customer_preferences
SET enabled = false, updated_at = now()
WHERE purpose = 'newsletter' AND channel = 'email' AND enabled;
