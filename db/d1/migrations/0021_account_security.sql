-- Device visibility and a redacted security trail. Session and identity rows
-- remain authoritative; this table never contains passwords, tokens or IPs.
ALTER TABLE auth_sessions ADD COLUMN last_seen_at TEXT CHECK (
  last_seen_at IS NULL OR
  (last_seen_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', last_seen_at), '') AND last_seen_at >= created_at)
);
UPDATE auth_sessions SET last_seen_at = created_at WHERE last_seen_at IS NULL;
CREATE INDEX auth_sessions_identity_visible ON auth_sessions(identity_id, session_version, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE identity_security_events (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  event_type TEXT NOT NULL CONSTRAINT identity_security_event_type
    CHECK (event_type IN ('password_changed', 'session_revoked')),
  target_session_id TEXT,
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE INDEX identity_security_events_identity_time ON identity_security_events(identity_id, created_at DESC);
CREATE TRIGGER identity_security_events_no_update BEFORE UPDATE ON identity_security_events
BEGIN SELECT RAISE(ABORT, 'identity_security_events_immutable'); END;
CREATE TRIGGER identity_security_events_no_delete BEFORE DELETE ON identity_security_events
BEGIN SELECT RAISE(ABORT, 'identity_security_events_immutable'); END;

CREATE TRIGGER identity_password_changed_audit AFTER UPDATE OF password_hash ON identities
WHEN OLD.password_hash <> NEW.password_hash
BEGIN
  INSERT INTO identity_security_events(id, identity_id, event_type, created_at)
  VALUES (lower(hex(randomblob(16))), NEW.id, 'password_changed', NEW.updated_at);
END;
CREATE TRIGGER identity_session_revoked_audit AFTER UPDATE OF revoked_at ON auth_sessions
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO identity_security_events(id, identity_id, event_type, target_session_id, created_at)
  VALUES (lower(hex(randomblob(16))), NEW.identity_id, 'session_revoked', NEW.id, NEW.revoked_at);
END;
