-- Pre-auth subjects are HMACs, never email addresses or raw network addresses.
CREATE TABLE authentication_rate_limits (
  subject_hash TEXT NOT NULL CHECK (length(subject_hash) = 64 AND subject_hash NOT GLOB '*[^0-9a-f]*'),
  scope TEXT NOT NULL,
  used INTEGER NOT NULL CHECK (used >= 1),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  PRIMARY KEY (subject_hash, scope)
) STRICT;
CREATE INDEX authentication_rate_limits_expiry ON authentication_rate_limits(expires_at);
