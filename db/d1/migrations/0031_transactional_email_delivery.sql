-- Queue receipt remains immutable. The new ledger owns provider-side work,
-- without copying recipients, rendered messages, access tokens or secrets.
CREATE TABLE transactional_email_deliveries (
  event_id TEXT PRIMARY KEY REFERENCES email_dispatch_inbox(event_id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'leased', 'sending', 'sent', 'manual_review')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL CHECK (
    available_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', available_at), '')
  ),
  lease_token TEXT,
  lease_until TEXT CHECK (
    lease_until IS NULL OR lease_until = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', lease_until), '')
  ),
  sending_at TEXT CHECK (
    sending_at IS NULL OR sending_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', sending_at), '')
  ),
  finished_at TEXT CHECK (
    finished_at IS NULL OR finished_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', finished_at), '')
  ),
  provider_message_id TEXT CHECK (
    provider_message_id IS NULL OR (length(provider_message_id) BETWEEN 1 AND 200
      AND provider_message_id NOT GLOB '*[^a-zA-Z0-9._:-]*')
  ),
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code IN (
    'preparation_failed', 'preparation_attempts_exhausted', 'unsupported_event',
    'source_not_found', 'invalid_source', 'provider_outcome_unknown',
    'provider_receipt_invalid', 'provider_ack_failed', 'sending_lease_expired'
  )),
  CHECK ((status IN ('leased', 'sending') AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (status NOT IN ('leased', 'sending') AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK (status <> 'sending' OR sending_at IS NOT NULL),
  CHECK (status <> 'sent' OR (finished_at IS NOT NULL AND provider_message_id IS NOT NULL)),
  CHECK (status <> 'manual_review' OR (finished_at IS NOT NULL AND last_error_code IS NOT NULL))
) STRICT;
CREATE INDEX transactional_email_due_idx
  ON transactional_email_deliveries(status, available_at, event_id);
CREATE INDEX transactional_email_lease_idx
  ON transactional_email_deliveries(status, lease_until, event_id);

-- Insert is atomic with receipt: acking Queue never discards pending work.
CREATE TRIGGER transactional_email_delivery_on_receipt AFTER INSERT ON email_dispatch_inbox
BEGIN
  INSERT INTO transactional_email_deliveries (event_id, available_at)
  VALUES (NEW.event_id, NEW.received_at);
END;

-- Preserve and backfill receipts acknowledged by the original blocked consumer.
INSERT INTO transactional_email_deliveries (event_id, available_at)
SELECT event_id, received_at FROM email_dispatch_inbox;
