-- Migration: 0093_security_anomaly_signals.sql
-- SEC-035: Deterministic, deduplicated session and administrative security anomaly signals
-- and governed security inbox commands with CAS, idempotency, and strict PII minimization.

CREATE TABLE security_anomaly_signals (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  source_key TEXT NOT NULL UNIQUE CHECK (length(trim(source_key)) BETWEEN 3 AND 240),
  signal_type TEXT NOT NULL CHECK (
    signal_type IN (
      'admin_new_device_login',
      'mfa_change',
      'mass_export',
      'role_permission_change',
      'refund_anomaly'
    )
  ),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  reason_code TEXT NOT NULL CHECK (
    reason_code IN (
      'admin_login_new_device_fingerprint',
      'mfa_reset',
      'mfa_disabled',
      'mfa_reenrolled',
      'mfa_recovery_code_used',
      'export_row_threshold_exceeded',
      'export_window_burst_exceeded',
      'export_row_and_burst_exceeded',
      'admin_invitation_created',
      'admin_invitation_accepted',
      'admin_invitation_revoked',
      'admin_role_granted',
      'refund_amount_threshold_exceeded',
      'refund_actor_burst_exceeded',
      'refund_amount_and_burst_exceeded'
    )
  ),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  actor_id TEXT NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  actor_session_id TEXT,
  object_type TEXT NOT NULL CHECK (length(trim(object_type)) BETWEEN 2 AND 64),
  object_id TEXT NOT NULL CHECK (length(trim(object_id)) BETWEEN 1 AND 120),
  ip_hash TEXT CHECK (ip_hash IS NULL OR (length(ip_hash) = 64 AND ip_hash NOT GLOB '*[^0-9a-f]*')),
  user_agent_hash TEXT CHECK (
    user_agent_hash IS NULL OR (length(user_agent_hash) = 64 AND user_agent_hash NOT GLOB '*[^0-9a-f]*')
  ),
  device_fingerprint_hash TEXT CHECK (
    device_fingerprint_hash IS NULL
    OR (length(device_fingerprint_hash) = 64 AND device_fingerprint_hash NOT GLOB '*[^0-9a-f]*')
  ),
  context_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(context_json)
    AND json_type(context_json) = 'object'
    AND length(context_json) <= 4096
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  occurred_at TEXT NOT NULL CHECK (occurred_at GLOB '????-??-??T??:??:??*Z'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  acknowledged_at TEXT CHECK (acknowledged_at IS NULL OR acknowledged_at GLOB '????-??-??T??:??:??*Z'),
  acknowledged_by TEXT REFERENCES identities(id) ON DELETE RESTRICT,
  acknowledged_command_id TEXT,
  resolved_at TEXT CHECK (resolved_at IS NULL OR resolved_at GLOB '????-??-??T??:??:??*Z'),
  resolved_by TEXT REFERENCES identities(id) ON DELETE RESTRICT,
  resolved_command_id TEXT,
  resolution_note TEXT CHECK (resolution_note IS NULL OR length(trim(resolution_note)) BETWEEN 3 AND 500),
  CHECK (
    (
      status = 'open'
      AND acknowledged_at IS NULL
      AND acknowledged_by IS NULL
      AND acknowledged_command_id IS NULL
      AND resolved_at IS NULL
      AND resolved_by IS NULL
      AND resolved_command_id IS NULL
      AND resolution_note IS NULL
    )
    OR (
      status = 'acknowledged'
      AND acknowledged_at IS NOT NULL
      AND acknowledged_by IS NOT NULL
      AND acknowledged_command_id IS NOT NULL
      AND resolved_at IS NULL
      AND resolved_by IS NULL
      AND resolved_command_id IS NULL
      AND resolution_note IS NULL
    )
    OR (
      status = 'resolved'
      AND resolved_at IS NOT NULL
      AND resolved_by IS NOT NULL
      AND resolved_command_id IS NOT NULL
      AND resolution_note IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX idx_security_anomaly_signals_inbox
  ON security_anomaly_signals(occurred_at DESC, id DESC);

CREATE INDEX idx_security_anomaly_signals_filter_status
  ON security_anomaly_signals(status, severity, signal_type, occurred_at DESC, id DESC);

CREATE INDEX idx_security_anomaly_signals_actor
  ON security_anomaly_signals(actor_id, occurred_at DESC, id DESC);

CREATE INDEX idx_security_anomaly_signals_object
  ON security_anomaly_signals(object_id, occurred_at DESC, id DESC);

CREATE TABLE security_anomaly_commands (
  command_id TEXT PRIMARY KEY CHECK (length(command_id) = 36),
  signal_id TEXT NOT NULL REFERENCES security_anomaly_signals(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE RESTRICT,
  ip_hash TEXT CHECK (ip_hash IS NULL OR (length(ip_hash) = 64 AND ip_hash NOT GLOB '*[^0-9a-f]*')),
  user_agent_hash TEXT CHECK (
    user_agent_hash IS NULL OR (length(user_agent_hash) = 64 AND user_agent_hash NOT GLOB '*[^0-9a-f]*')
  ),
  action TEXT NOT NULL CHECK (action IN ('acknowledge', 'resolve')),
  from_status TEXT NOT NULL CHECK (from_status IN ('open', 'acknowledged')),
  to_status TEXT NOT NULL CHECK (to_status IN ('acknowledged', 'resolved')),
  expected_version INTEGER NOT NULL CHECK (expected_version >= 1),
  applied_version INTEGER NOT NULL CHECK (applied_version = expected_version + 1),
  note TEXT CHECK (note IS NULL OR length(trim(note)) BETWEEN 3 AND 500),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json) AND json_type(receipt_json) = 'object'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  CHECK (
    (action = 'acknowledge' AND from_status = 'open' AND to_status = 'acknowledged')
    OR (action = 'resolve' AND from_status IN ('open', 'acknowledged') AND to_status = 'resolved' AND note IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_security_anomaly_commands_signal
  ON security_anomaly_commands(signal_id, applied_version ASC);

CREATE INDEX idx_security_anomaly_commands_actor
  ON security_anomaly_commands(actor_id, created_at DESC, command_id DESC);

CREATE TABLE security_admin_known_devices (
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  fingerprint_hash TEXT NOT NULL CHECK (length(fingerprint_hash) = 64 AND fingerprint_hash NOT GLOB '*[^0-9a-f]*'),
  ip_hash TEXT CHECK (ip_hash IS NULL OR (length(ip_hash) = 64 AND ip_hash NOT GLOB '*[^0-9a-f]*')),
  user_agent_hash TEXT CHECK (
    user_agent_hash IS NULL OR (length(user_agent_hash) = 64 AND user_agent_hash NOT GLOB '*[^0-9a-f]*')
  ),
  first_session_id TEXT NOT NULL,
  last_session_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL CHECK (first_seen_at GLOB '????-??-??T??:??:??*Z'),
  last_seen_at TEXT NOT NULL CHECK (last_seen_at GLOB '????-??-??T??:??:??*Z'),
  seen_count INTEGER NOT NULL DEFAULT 1 CHECK (seen_count >= 1),
  PRIMARY KEY (identity_id, fingerprint_hash)
) STRICT;

CREATE INDEX idx_security_admin_known_devices_identity
  ON security_admin_known_devices(identity_id, first_seen_at ASC);

CREATE TABLE security_export_activity_log (
  export_key TEXT PRIMARY KEY CHECK (length(trim(export_key)) BETWEEN 3 AND 200),
  actor_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  session_id TEXT,
  export_kind TEXT NOT NULL CHECK (export_kind IN ('admin_audit', 'orders', 'catalog')),
  export_command_id TEXT NOT NULL CHECK (length(trim(export_command_id)) BETWEEN 1 AND 120),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0),
  ip_hash TEXT CHECK (ip_hash IS NULL OR (length(ip_hash) = 64 AND ip_hash NOT GLOB '*[^0-9a-f]*')),
  occurred_at TEXT NOT NULL CHECK (occurred_at GLOB '????-??-??T??:??:??*Z')
) STRICT;

CREATE INDEX idx_security_export_activity_actor_window
  ON security_export_activity_log(actor_id, occurred_at DESC);

CREATE TABLE security_refund_activity_log (
  refund_key TEXT PRIMARY KEY CHECK (length(trim(refund_key)) BETWEEN 3 AND 200),
  actor_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  session_id TEXT,
  refund_id TEXT NOT NULL CHECK (length(trim(refund_id)) BETWEEN 1 AND 120),
  order_id TEXT NOT NULL CHECK (length(trim(order_id)) BETWEEN 1 AND 120),
  stage TEXT NOT NULL CHECK (stage IN ('plan', 'confirm')),
  gross_cents INTEGER NOT NULL CHECK (gross_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3),
  ip_hash TEXT CHECK (ip_hash IS NULL OR (length(ip_hash) = 64 AND ip_hash NOT GLOB '*[^0-9a-f]*')),
  occurred_at TEXT NOT NULL CHECK (occurred_at GLOB '????-??-??T??:??:??*Z')
) STRICT;

CREATE INDEX idx_security_refund_activity_actor_window
  ON security_refund_activity_log(actor_id, stage, occurred_at DESC);

CREATE TRIGGER security_anomaly_commands_require_authority
BEFORE INSERT ON security_anomaly_commands
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM identities i
      JOIN auth_sessions s ON s.identity_id = i.id
      JOIN identity_mfa m ON m.identity_id = i.id
      LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.id = NEW.actor_id
        AND s.id = NEW.session_id
        AND i.status = 'active'
        AND i.email_verified_at IS NOT NULL
        AND i.email_verified_at <= NEW.created_at
        AND (i.customer_id IS NULL OR c.status = 'active')
        AND s.session_version = i.session_version
        AND s.mfa_verified = 1
        AND s.revoked_at IS NULL
        AND s.expires_at > NEW.created_at
        AND m.verified_at IS NOT NULL
        AND m.verified_at <= NEW.created_at
    )
    OR NOT EXISTS (
      SELECT 1
      FROM identity_roles ir
      JOIN role_permissions rp ON rp.role_code = ir.role_code
      WHERE ir.identity_id = NEW.actor_id
        AND ir.granted_at <= NEW.created_at
        AND (ir.expires_at IS NULL OR ir.expires_at > NEW.created_at)
        AND rp.permission_code = 'security.manage'
    )
    THEN RAISE(ABORT, 'security_anomaly_authority_required')
  END;
END;

CREATE TRIGGER security_anomaly_commands_no_update
BEFORE UPDATE ON security_anomaly_commands
BEGIN
  SELECT RAISE(ABORT, 'security_anomaly_command_immutable');
END;

CREATE TRIGGER security_anomaly_commands_no_delete
BEFORE DELETE ON security_anomaly_commands
BEGIN
  SELECT RAISE(ABORT, 'security_anomaly_command_immutable');
END;

CREATE TRIGGER security_anomaly_signals_no_delete
BEFORE DELETE ON security_anomaly_signals
BEGIN
  SELECT RAISE(ABORT, 'security_anomaly_signal_immutable');
END;

CREATE TRIGGER security_anomaly_signals_guard_update
BEFORE UPDATE ON security_anomaly_signals
BEGIN
  SELECT CASE
    WHEN OLD.id != NEW.id
      OR OLD.source_key != NEW.source_key
      OR OLD.signal_type != NEW.signal_type
      OR OLD.severity != NEW.severity
      OR OLD.reason_code != NEW.reason_code
      OR OLD.actor_id != NEW.actor_id
      OR OLD.object_type != NEW.object_type
      OR OLD.object_id != NEW.object_id
      OR OLD.occurred_at != NEW.occurred_at
      OR OLD.created_at != NEW.created_at
      OR NEW.version != OLD.version + 1
      OR OLD.status = 'resolved'
      OR (OLD.status = 'acknowledged' AND NEW.status = 'open')
    THEN RAISE(ABORT, 'security_anomaly_invalid_signal_mutation')
  END;
END;
