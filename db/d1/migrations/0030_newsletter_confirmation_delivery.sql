-- The requested-consent event and its delivery job commit in the same D1 transaction.
-- No address, signed token or message body is copied into the job.
CREATE TABLE newsletter_confirmation_deliveries (
  request_id TEXT PRIMARY KEY REFERENCES newsletter_consent_events(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'manual_review')),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  claimed_at INTEGER CHECK (claimed_at IS NULL OR claimed_at >= created_at),
  finished_at INTEGER CHECK (finished_at IS NULL OR finished_at >= created_at),
  provider_message_id TEXT CHECK (provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 200),
  CHECK (status != 'sending' OR claimed_at IS NOT NULL),
  CHECK (status NOT IN ('sent', 'skipped', 'manual_review') OR finished_at IS NOT NULL),
  CHECK (status != 'sent' OR provider_message_id IS NOT NULL)
) STRICT;
CREATE INDEX newsletter_confirmation_deliveries_pending
  ON newsletter_confirmation_deliveries(status, created_at);

CREATE TRIGGER newsletter_confirmation_delivery_requested
AFTER INSERT ON newsletter_consent_events
WHEN NEW.event_type = 'requested'
BEGIN
  INSERT INTO newsletter_confirmation_deliveries(request_id, status, created_at)
  VALUES (NEW.id, 'pending', NEW.occurred_at);
END;

-- Exact, D1-backed budgets complement the native per-location edge limiter.
-- Only keyed digests of canonical IPs are stored; no raw IP or email.
CREATE TABLE newsletter_request_limits (
  subject_hash TEXT NOT NULL CHECK (length(subject_hash) = 64),
  scope TEXT NOT NULL CHECK (scope IN ('subscribe', 'confirm', 'unsubscribe')),
  used INTEGER NOT NULL CHECK (used BETWEEN 1 AND 100),
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  PRIMARY KEY (subject_hash, scope)
) STRICT;
CREATE INDEX newsletter_request_limits_expiry ON newsletter_request_limits(expires_at);
