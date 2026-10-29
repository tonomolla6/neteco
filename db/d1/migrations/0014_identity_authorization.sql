-- Authorization read model matching the existing identity/session contract.
-- No default identities, credentials, roles or grants are provisioned.
CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(email) BETWEEN 3 AND 254),
  password_hash TEXT NOT NULL CHECK (length(password_hash) > 0),
  email_verified_at TEXT CHECK (email_verified_at IS NULL OR email_verified_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', email_verified_at), '')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'locked', 'disabled')),
  session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK (updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE TABLE roles (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL) STRICT;
CREATE TABLE permissions (
  code TEXT PRIMARY KEY,
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  description TEXT NOT NULL,
  UNIQUE(resource, action)
) STRICT;
CREATE TABLE role_permissions (
  role_code TEXT NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY(role_code, permission_code)
) STRICT;
CREATE TABLE identity_roles (
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  role_code TEXT NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  granted_by TEXT REFERENCES identities(id),
  granted_at TEXT NOT NULL CHECK (granted_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', granted_at), '')),
  expires_at TEXT CHECK (expires_at IS NULL OR (expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at), '') AND expires_at > granted_at)),
  PRIMARY KEY(identity_id, role_code)
) STRICT;
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  session_version INTEGER NOT NULL CHECK (session_version >= 1),
  mfa_verified INTEGER NOT NULL DEFAULT 0 CHECK (mfa_verified IN (0, 1)),
  ip_hash TEXT,
  user_agent_hash TEXT,
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  expires_at TEXT NOT NULL CHECK (expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at), '') AND expires_at > created_at),
  revoked_at TEXT CHECK (revoked_at IS NULL OR revoked_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', revoked_at), ''))
) STRICT;
CREATE INDEX auth_sessions_identity_active ON auth_sessions(identity_id, expires_at) WHERE revoked_at IS NULL;
