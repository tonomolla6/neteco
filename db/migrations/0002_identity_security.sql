-- Authentication lifecycle, revocable sessions and MFA material.

CREATE TABLE identity_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify_email', 'password_reset', 'mfa_challenge')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX identity_tokens_lookup_idx
  ON identity_tokens (purpose, token_hash, expires_at)
  WHERE used_at IS NULL;

CREATE TABLE identity_mfa (
  identity_id uuid PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  encrypted_secret text NOT NULL,
  recovery_code_hashes jsonb NOT NULL DEFAULT '[]'::jsonb,
  verified_at timestamptz,
  last_used_step bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  session_version integer NOT NULL,
  mfa_verified boolean NOT NULL DEFAULT false,
  ip_hash text,
  user_agent_hash text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_sessions_identity_active_idx
  ON auth_sessions (identity_id, expires_at)
  WHERE revoked_at IS NULL;

INSERT INTO permissions (code, resource, action, description) VALUES
  ('catalog.read', 'catalog', 'read', 'Read catalog data'),
  ('catalog.write', 'catalog', 'write', 'Create and edit catalog drafts'),
  ('catalog.publish', 'catalog', 'publish', 'Publish catalog changes'),
  ('orders.read', 'orders', 'read', 'Read orders within assigned scope'),
  ('orders.transition', 'orders', 'transition', 'Apply allowed order state transitions'),
  ('inventory.read', 'inventory', 'read', 'Read inventory'),
  ('inventory.write', 'inventory', 'write', 'Adjust and allocate inventory'),
  ('payments.read', 'payments', 'read', 'Read sanitized payment data'),
  ('payments.refund', 'payments', 'refund', 'Request refunds'),
  ('invoices.read', 'invoices', 'read', 'Read invoices'),
  ('invoices.issue', 'invoices', 'issue', 'Issue and rectify invoices'),
  ('support.manage', 'support', 'manage', 'Manage support tickets'),
  ('administration.manage', 'administration', 'manage', 'Manage identities, roles and configuration')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('customer', 'catalog.read'),
  ('support', 'catalog.read'), ('support', 'orders.read'), ('support', 'support.manage'),
  ('warehouse', 'catalog.read'), ('warehouse', 'orders.read'), ('warehouse', 'orders.transition'),
  ('warehouse', 'inventory.read'), ('warehouse', 'inventory.write'),
  ('catalog_editor', 'catalog.read'), ('catalog_editor', 'catalog.write'),
  ('publisher', 'catalog.read'), ('publisher', 'catalog.write'), ('publisher', 'catalog.publish'),
  ('finance', 'orders.read'), ('finance', 'payments.read'), ('finance', 'payments.refund'),
  ('finance', 'invoices.read'), ('finance', 'invoices.issue'),
  ('admin', 'catalog.read'), ('admin', 'catalog.write'), ('admin', 'catalog.publish'),
  ('admin', 'orders.read'), ('admin', 'orders.transition'), ('admin', 'inventory.read'),
  ('admin', 'inventory.write'), ('admin', 'payments.read'), ('admin', 'payments.refund'),
  ('admin', 'invoices.read'), ('admin', 'invoices.issue'), ('admin', 'support.manage'),
  ('admin', 'administration.manage')
ON CONFLICT (role_code, permission_code) DO NOTHING;
