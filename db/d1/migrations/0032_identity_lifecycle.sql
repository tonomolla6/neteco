-- Identity links are opaque, single-use and encrypted only for durable delivery.
-- Their recipient is contractual: a change-email link never derives it later.
CREATE TABLE identity_lifecycle_tokens (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identities(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'password_reset', 'email_change')),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  token_envelope TEXT NOT NULL CHECK (length(token_envelope) BETWEEN 60 AND 512 AND token_envelope LIKE 'v1.%'),
  recipient TEXT NOT NULL CHECK (length(recipient) BETWEEN 3 AND 254 AND recipient = lower(trim(recipient))),
  session_version INTEGER NOT NULL CHECK (session_version >= 1),
  authorization_session_id TEXT REFERENCES auth_sessions(id),
  authorization_mfa_verified_at TEXT CHECK (authorization_mfa_verified_at IS NULL OR authorization_mfa_verified_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', authorization_mfa_verified_at), '')),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  expires_at TEXT NOT NULL CHECK (expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at), '') AND expires_at > created_at),
  used_at TEXT CHECK (used_at IS NULL OR (used_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', used_at), '') AND used_at >= created_at)),
  revoked_at TEXT CHECK (revoked_at IS NULL OR (revoked_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', revoked_at), '') AND revoked_at >= created_at)),
  CHECK (used_at IS NULL OR revoked_at IS NULL),
  CHECK ((purpose = 'email_change') = (authorization_session_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX identity_lifecycle_one_open_token
  ON identity_lifecycle_tokens(identity_id, purpose) WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE identity_lifecycle_deliveries (
  token_id TEXT PRIMARY KEY REFERENCES identity_lifecycle_tokens(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'preparing', 'sending', 'sent', 'retryable', 'manual_review', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  next_attempt_at TEXT NOT NULL CHECK (next_attempt_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', next_attempt_at), '')),
  lease_token TEXT,
  lease_until TEXT CHECK (lease_until IS NULL OR lease_until = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', lease_until), '')),
  provider_message_id TEXT CHECK (provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 200),
  last_error_code TEXT CHECK (last_error_code IS NULL OR (length(last_error_code) BETWEEN 1 AND 80 AND last_error_code NOT GLOB '*[^a-z0-9_]*')),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK (updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;
CREATE INDEX identity_lifecycle_deliveries_due ON identity_lifecycle_deliveries(state, next_attempt_at);
CREATE TRIGGER identity_lifecycle_delivery_insert AFTER INSERT ON identity_lifecycle_tokens
BEGIN
  INSERT INTO identity_lifecycle_deliveries(token_id, next_attempt_at, created_at, updated_at)
  VALUES (NEW.id, NEW.created_at, NEW.created_at, NEW.created_at);
END;

-- Immutable evidence contains no password, email, token, body, IP or user-agent.
CREATE TABLE identity_legal_acceptances (
  identity_id TEXT PRIMARY KEY REFERENCES identities(id),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 80),
  consent_text TEXT NOT NULL CHECK (length(consent_text) BETWEEN 1 AND 2048),
  text_hash TEXT NOT NULL CHECK (length(text_hash) = 64 AND text_hash NOT GLOB '*[^0-9a-f]*'),
  source TEXT NOT NULL CHECK (source = 'registration'),
  accepted_at TEXT NOT NULL CHECK (accepted_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', accepted_at), ''))
) STRICT;
CREATE TRIGGER identity_legal_acceptances_no_update BEFORE UPDATE ON identity_legal_acceptances
BEGIN SELECT RAISE(ABORT, 'identity_legal_acceptances_immutable'); END;
CREATE TRIGGER identity_legal_acceptances_no_delete BEFORE DELETE ON identity_legal_acceptances
BEGIN SELECT RAISE(ABORT, 'identity_legal_acceptances_immutable'); END;

-- The random event id is also the caller's in-batch mutation marker. A second
-- consumer cannot reuse another caller's marker even within the same second.
CREATE TABLE identity_lifecycle_events (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identities(id),
  token_id TEXT REFERENCES identity_lifecycle_tokens(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('registered', 'password_reset_requested', 'email_change_requested', 'email_verified', 'email_changed', 'password_reset')),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE UNIQUE INDEX identity_lifecycle_token_consumed ON identity_lifecycle_events(token_id)
  WHERE event_type IN ('email_verified', 'email_changed', 'password_reset');
CREATE TRIGGER identity_lifecycle_events_no_update BEFORE UPDATE ON identity_lifecycle_events
BEGIN SELECT RAISE(ABORT, 'identity_lifecycle_events_immutable'); END;
CREATE TRIGGER identity_lifecycle_events_no_delete BEFORE DELETE ON identity_lifecycle_events
BEGIN SELECT RAISE(ABORT, 'identity_lifecycle_events_immutable'); END;

-- A failed final guard aborts the entire D1.batch; successful rows are deleted
-- in that batch. Never catch an unrelated database outage as a failed guard.
CREATE TABLE identity_lifecycle_guards (
  id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CONSTRAINT identity_lifecycle_atomic_guard CHECK (valid = 1)
) STRICT;
