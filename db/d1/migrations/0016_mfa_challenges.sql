CREATE TABLE identity_mfa (
  identity_id TEXT PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  encrypted_secret TEXT NOT NULL,
  recovery_code_hashes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(recovery_code_hashes) AND json_type(recovery_code_hashes) = 'array'),
  verified_at TEXT CHECK (verified_at IS NULL OR verified_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', verified_at), '')),
  last_used_step INTEGER CHECK (last_used_step IS NULL OR last_used_step >= 0),
  updated_at TEXT NOT NULL CHECK (updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;

-- Password verification will issue these, pinned to the identity session version.
-- The consumption marker owns all writes of the completion transaction.
CREATE TABLE mfa_challenges (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  session_version INTEGER NOT NULL CHECK (session_version >= 1),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  expires_at TEXT NOT NULL CHECK (expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at), '') AND expires_at > created_at),
  used_at TEXT CHECK (used_at IS NULL OR (used_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', used_at), '') AND used_at >= created_at)),
  consumption_id TEXT UNIQUE,
  CONSTRAINT mfa_challenge_consumption CHECK ((used_at IS NULL AND consumption_id IS NULL) OR (used_at IS NOT NULL AND consumption_id IS NOT NULL))
) STRICT;
CREATE INDEX mfa_challenges_identity_active ON mfa_challenges(identity_id, expires_at) WHERE used_at IS NULL;
