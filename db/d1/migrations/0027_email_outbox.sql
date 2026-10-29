-- Transactional email transport only. No recipient, body, token, provider
-- credential or marketing event is copied into this D1 outbox. The source
-- event must be durable in the same transaction as this insert.
CREATE TABLE email_outbox_events (
  id TEXT PRIMARY KEY CHECK (
    length(id) = 70 AND substr(id, 1, 6) = 'email:'
    AND substr(id, 7) NOT GLOB '*[^0-9a-f]*'
  ),
  source_event_id TEXT NOT NULL CHECK (
    length(source_event_id) = 36 AND source_event_id = lower(source_event_id)
    AND substr(source_event_id, 9, 1) = '-' AND substr(source_event_id, 14, 1) = '-'
    AND substr(source_event_id, 19, 1) = '-' AND substr(source_event_id, 24, 1) = '-'
    AND replace(source_event_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'identity.verification.requested', 'identity.password_reset.requested',
    'identity.email_change.requested', 'identity.security.password_changed',
    'identity.security.email_changed', 'order.created', 'order.confirmed',
    'order.status.updated', 'order.cancelled', 'order.cancellation.requested',
    'order.reservation.expired', 'order.shipped', 'order.delivered',
    'refund.succeeded.email', 'return.requested', 'return.status.updated',
    'support.ticket.received', 'support.ticket.reply', 'invoice.issued'
  )),
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'identity', 'order', 'refund', 'return', 'support', 'invoice'
  )),
  source_id TEXT NOT NULL CHECK (
    length(source_id) = 36 AND source_id = lower(source_id)
    AND substr(source_id, 9, 1) = '-' AND substr(source_id, 14, 1) = '-'
    AND substr(source_id, 19, 1) = '-' AND substr(source_id, 24, 1) = '-'
    AND replace(source_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  created_at TEXT NOT NULL CHECK (
    created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  ),
  UNIQUE (source_event_id, event_type)
) STRICT;

CREATE TABLE email_outbox_delivery (
  event_id TEXT PRIMARY KEY REFERENCES email_outbox_events(id),
  status TEXT NOT NULL DEFAULT 'ready' CHECK (
    status IN ('ready', 'leased', 'published', 'manual_review')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL CHECK (
    available_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', available_at), '')
  ),
  lease_token TEXT,
  lease_until TEXT CHECK (
    lease_until IS NULL OR lease_until = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', lease_until), '')
  ),
  published_at TEXT CHECK (
    published_at IS NULL OR published_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', published_at), '')
  ),
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 80
  ),
  CHECK ((status = 'leased' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (status <> 'leased' AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK (status <> 'published' OR published_at IS NOT NULL)
) STRICT;
CREATE INDEX email_outbox_due_idx ON email_outbox_delivery(status, available_at, event_id);
CREATE INDEX email_outbox_published_idx ON email_outbox_delivery(status, published_at, event_id);

-- A Queue consumer records receipt here and stops. A separately reviewed
-- provider adapter must resolve the recipient from the source of truth and
-- implement provider-side idempotency before any actual email can be sent.
CREATE TABLE email_dispatch_inbox (
  event_id TEXT PRIMARY KEY REFERENCES email_outbox_events(id),
  status TEXT NOT NULL DEFAULT 'blocked_provider' CHECK (status = 'blocked_provider'),
  received_at TEXT NOT NULL CHECK (
    received_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', received_at), '')
  )
) STRICT;

CREATE TRIGGER email_outbox_replay_guard BEFORE INSERT ON email_outbox_events
WHEN EXISTS (
  SELECT 1 FROM email_outbox_events previous
  WHERE previous.source_event_id = NEW.source_event_id
    AND previous.event_type = NEW.event_type
    AND (previous.id <> NEW.id OR previous.source_kind <> NEW.source_kind
      OR previous.source_id <> NEW.source_id OR previous.schema_version <> NEW.schema_version)
)
BEGIN SELECT RAISE(ABORT, 'email_outbox_replay_conflict'); END;

CREATE TRIGGER email_outbox_events_no_update BEFORE UPDATE ON email_outbox_events
BEGIN SELECT RAISE(ABORT, 'email_outbox_event_immutable'); END;
CREATE TRIGGER email_outbox_events_no_delete BEFORE DELETE ON email_outbox_events
BEGIN SELECT RAISE(ABORT, 'email_outbox_event_immutable'); END;
CREATE TRIGGER email_dispatch_inbox_no_update BEFORE UPDATE ON email_dispatch_inbox
BEGIN SELECT RAISE(ABORT, 'email_dispatch_receipt_immutable'); END;
CREATE TRIGGER email_dispatch_inbox_no_delete BEFORE DELETE ON email_dispatch_inbox
BEGIN SELECT RAISE(ABORT, 'email_dispatch_receipt_immutable'); END;

CREATE TRIGGER email_outbox_delivery_on_event AFTER INSERT ON email_outbox_events
BEGIN
  INSERT INTO email_outbox_delivery (event_id, available_at)
  VALUES (NEW.id, NEW.created_at);
END;
