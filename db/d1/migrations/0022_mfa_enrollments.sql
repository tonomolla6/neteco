-- A pending enrollment cannot alter an already verified factor. Secrets and
-- recovery-code hashes move into identity_mfa only after a guarded TOTP proof.
CREATE TABLE mfa_enrollments (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL UNIQUE REFERENCES identities(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  session_version INTEGER NOT NULL CHECK (session_version >= 1),
  encrypted_secret TEXT NOT NULL,
  recovery_code_hashes TEXT NOT NULL CHECK (json_valid(recovery_code_hashes) AND json_type(recovery_code_hashes) = 'array'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  expires_at TEXT NOT NULL CHECK (expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at), '') AND expires_at > created_at),
  activation_id TEXT UNIQUE
) STRICT;
CREATE INDEX mfa_enrollments_expiry ON mfa_enrollments(expires_at);
