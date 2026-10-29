-- Bounded by authenticated identities and server-defined scopes; no raw IPs,
-- emails or per-request keys. A scope reuses its row when its window expires.
CREATE TABLE identity_rate_limits (
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 100),
  used INTEGER NOT NULL CHECK (used >= 1),
  window_started_at INTEGER NOT NULL CHECK (window_started_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > window_started_at),
  PRIMARY KEY(identity_id, scope)
) STRICT;
