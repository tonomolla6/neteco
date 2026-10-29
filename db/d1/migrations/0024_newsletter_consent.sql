-- D1 is the source of truth for email newsletter consent. Sending is out of scope.
-- A withdrawn address is deliberately not reactivated by this first vertical.
CREATE TABLE newsletter_subscriptions (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL UNIQUE CHECK (
    length(email_normalized) BETWEEN 3 AND 254 AND email_normalized = lower(trim(email_normalized))
  ),
  email_hash TEXT NOT NULL UNIQUE CHECK (length(email_hash) = 64),
  purpose TEXT NOT NULL DEFAULT 'newsletter' CHECK (purpose = 'newsletter'),
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel = 'email'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'unsubscribed', 'suppressed')),
  consent_text TEXT NOT NULL CHECK (length(trim(consent_text)) BETWEEN 1 AND 2048),
  consent_version TEXT NOT NULL CHECK (length(trim(consent_version)) BETWEEN 1 AND 80),
  consent_source TEXT NOT NULL CHECK (length(trim(consent_source)) BETWEEN 1 AND 100),
  request_id TEXT NOT NULL UNIQUE,
  request_key TEXT NOT NULL UNIQUE,
  requested_at INTEGER NOT NULL CHECK (requested_at > 0),
  confirmation_expires_at INTEGER NOT NULL CHECK (confirmation_expires_at > requested_at),
  confirmed_at INTEGER CHECK (confirmed_at IS NULL OR confirmed_at >= requested_at),
  unsubscribed_at INTEGER CHECK (unsubscribed_at IS NULL OR unsubscribed_at >= requested_at),
  CHECK (status != 'confirmed' OR confirmed_at IS NOT NULL),
  CHECK (status != 'pending' OR confirmed_at IS NULL),
  CHECK (status != 'unsubscribed' OR unsubscribed_at IS NOT NULL)
) STRICT;

-- Suppressions contain no raw address. The keyed digest is shared by all email
-- marketing decisions, including an eventual external provider integration.
CREATE TABLE newsletter_suppressions (
  email_hash TEXT PRIMARY KEY CHECK (length(email_hash) = 64),
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel = 'email'),
  reason TEXT NOT NULL CHECK (reason IN ('unsubscribe', 'hard_bounce', 'complaint', 'manual', 'legal')),
  source TEXT NOT NULL CHECK (length(trim(source)) BETWEEN 1 AND 100),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;

-- Immutable evidence snapshots; no email, IP, token or user-agent is copied here.
CREATE TABLE newsletter_consent_events (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES newsletter_subscriptions(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('requested', 'confirmed', 'unsubscribed', 'suppressed')),
  request_key TEXT UNIQUE,
  consent_text TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  consent_source TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose = 'newsletter'),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  CHECK ((event_type = 'requested') = (request_key IS NOT NULL))
) STRICT;
CREATE INDEX newsletter_consent_events_subscription_time
  ON newsletter_consent_events(subscription_id, occurred_at);
CREATE TRIGGER newsletter_events_no_update BEFORE UPDATE ON newsletter_consent_events
BEGIN SELECT RAISE(ABORT, 'newsletter_events_immutable'); END;
CREATE TRIGGER newsletter_events_no_delete BEFORE DELETE ON newsletter_consent_events
BEGIN SELECT RAISE(ABORT, 'newsletter_events_immutable'); END;

CREATE TRIGGER newsletter_subscription_no_delete BEFORE DELETE ON newsletter_subscriptions
BEGIN SELECT RAISE(ABORT, 'newsletter_subscription_immutable'); END;
CREATE TRIGGER newsletter_subscription_guard BEFORE UPDATE ON newsletter_subscriptions
BEGIN
  SELECT CASE WHEN NEW.id != OLD.id OR NEW.email_normalized != OLD.email_normalized
    OR NEW.email_hash != OLD.email_hash OR NEW.purpose != OLD.purpose OR NEW.channel != OLD.channel
    THEN RAISE(ABORT, 'newsletter_identity_immutable') END;
  SELECT CASE WHEN NOT (
    (OLD.status = 'pending' AND NEW.status IN ('pending', 'confirmed', 'unsubscribed', 'suppressed'))
    OR (OLD.status = 'confirmed' AND NEW.status IN ('confirmed', 'unsubscribed', 'suppressed'))
    OR (OLD.status = 'suppressed' AND NEW.status IN ('suppressed', 'unsubscribed'))
    OR (OLD.status = 'unsubscribed' AND NEW.status = 'unsubscribed')
  ) THEN RAISE(ABORT, 'newsletter_transition_forbidden') END;
  SELECT CASE WHEN (OLD.status != 'pending' OR NEW.request_id = OLD.request_id) AND (
    NEW.request_id != OLD.request_id OR NEW.request_key != OLD.request_key
    OR NEW.consent_text != OLD.consent_text OR NEW.consent_version != OLD.consent_version
    OR NEW.consent_source != OLD.consent_source OR NEW.requested_at != OLD.requested_at
    OR NEW.confirmation_expires_at != OLD.confirmation_expires_at
  ) THEN RAISE(ABORT, 'newsletter_consent_immutable') END;
  SELECT CASE WHEN NEW.request_id != OLD.request_id AND (
    NEW.status != 'pending' OR OLD.confirmation_expires_at > NEW.requested_at
  ) THEN RAISE(ABORT, 'newsletter_refresh_forbidden') END;
  SELECT CASE WHEN NEW.status = 'confirmed' AND EXISTS (
    SELECT 1 FROM newsletter_suppressions WHERE email_hash = NEW.email_hash
  ) THEN RAISE(ABORT, 'newsletter_suppressed') END;
  SELECT CASE WHEN NEW.status = 'suppressed' AND NOT EXISTS (
    SELECT 1 FROM newsletter_suppressions WHERE email_hash = NEW.email_hash
  ) THEN RAISE(ABORT, 'newsletter_suppression_missing') END;
END;
CREATE TRIGGER newsletter_subscription_no_suppressed_insert BEFORE INSERT ON newsletter_subscriptions
WHEN EXISTS (SELECT 1 FROM newsletter_suppressions WHERE email_hash = NEW.email_hash)
BEGIN SELECT RAISE(ABORT, 'newsletter_suppressed'); END;

CREATE TRIGGER newsletter_requested_insert AFTER INSERT ON newsletter_subscriptions
BEGIN
  INSERT INTO newsletter_consent_events
    (id, subscription_id, event_type, request_key, consent_text, consent_version, consent_source, purpose, occurred_at)
  VALUES (NEW.request_id, NEW.id, 'requested', NEW.request_key,
    NEW.consent_text, NEW.consent_version, NEW.consent_source, NEW.purpose, NEW.requested_at);
END;
CREATE TRIGGER newsletter_requested_refresh AFTER UPDATE OF request_id ON newsletter_subscriptions
WHEN NEW.request_id != OLD.request_id
BEGIN
  INSERT INTO newsletter_consent_events
    (id, subscription_id, event_type, request_key, consent_text, consent_version, consent_source, purpose, occurred_at)
  VALUES (NEW.request_id, NEW.id, 'requested', NEW.request_key,
    NEW.consent_text, NEW.consent_version, NEW.consent_source, NEW.purpose, NEW.requested_at);
END;
CREATE TRIGGER newsletter_confirmed_event AFTER UPDATE OF status ON newsletter_subscriptions
WHEN OLD.status = 'pending' AND NEW.status = 'confirmed'
BEGIN
  INSERT INTO newsletter_consent_events
    (id, subscription_id, event_type, consent_text, consent_version, consent_source, purpose, occurred_at)
  VALUES (lower(hex(randomblob(16))), NEW.id, 'confirmed', NEW.consent_text,
    NEW.consent_version, NEW.consent_source, NEW.purpose, NEW.confirmed_at);
END;
CREATE TRIGGER newsletter_unsubscribed_event AFTER UPDATE OF status ON newsletter_subscriptions
WHEN OLD.status != 'unsubscribed' AND NEW.status = 'unsubscribed'
BEGIN
  INSERT INTO newsletter_consent_events
    (id, subscription_id, event_type, consent_text, consent_version, consent_source, purpose, occurred_at)
  VALUES (lower(hex(randomblob(16))), NEW.id, 'unsubscribed', NEW.consent_text,
    NEW.consent_version, NEW.consent_source, NEW.purpose, NEW.unsubscribed_at);
  INSERT INTO newsletter_suppressions(email_hash, reason, source, created_at, updated_at)
  VALUES (NEW.email_hash, 'unsubscribe', 'newsletter_link', NEW.unsubscribed_at, NEW.unsubscribed_at)
  ON CONFLICT(email_hash) DO NOTHING;
END;
CREATE TRIGGER newsletter_suppressed_event AFTER UPDATE OF status ON newsletter_subscriptions
WHEN OLD.status IN ('pending', 'confirmed') AND NEW.status = 'suppressed'
BEGIN
  INSERT INTO newsletter_consent_events
    (id, subscription_id, event_type, consent_text, consent_version, consent_source, purpose, occurred_at)
  VALUES (lower(hex(randomblob(16))), NEW.id, 'suppressed', NEW.consent_text,
    NEW.consent_version, NEW.consent_source, NEW.purpose,
    (SELECT created_at FROM newsletter_suppressions WHERE email_hash = NEW.email_hash));
END;
CREATE TRIGGER newsletter_suppression_insert AFTER INSERT ON newsletter_suppressions
BEGIN
  UPDATE newsletter_subscriptions SET status = 'suppressed'
  WHERE email_hash = NEW.email_hash AND status IN ('pending', 'confirmed');
END;
