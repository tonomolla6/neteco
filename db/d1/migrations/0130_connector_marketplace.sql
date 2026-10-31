-- Migration: 0130_connector_marketplace.sql
-- INT-023: Internal governed connector marketplace.
-- Acceptance: Permissions, review, scopes, installation, secrets, metrics, and clean uninstallation; no arbitrary plugins.

CREATE TABLE connector_catalog (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 3 AND 64 AND id NOT GLOB '*[^a-z0-9_-]*'),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 100),
  category TEXT NOT NULL CHECK(category IN ('erp', 'carrier', 'payment', 'crm', 'accounting', 'marketing', 'analytics', 'webhook')),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 5 AND 1000),
  version TEXT NOT NULL CHECK(length(version) BETWEEN 1 AND 32),
  provider_type TEXT NOT NULL CHECK(provider_type IN ('internal_adapter', 'webhook_outbound', 'rest_sync', 'edi_batch')),
  allowed_scopes TEXT NOT NULL CHECK(json_valid(allowed_scopes)),
  config_schema_json TEXT NOT NULL CHECK(json_valid(config_schema_json)),
  governance_status TEXT NOT NULL DEFAULT 'draft' CHECK(governance_status IN ('draft', 'in_review', 'approved', 'rejected', 'deprecated')),
  review_notes TEXT CHECK(review_notes IS NULL OR length(review_notes) <= 1000),
  reviewed_by TEXT REFERENCES identities(id),
  reviewed_at TEXT CHECK(reviewed_at IS NULL OR reviewed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', reviewed_at), '')),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_connector_catalog_category_status ON connector_catalog(category, governance_status);

CREATE TABLE connector_installations (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  connector_id TEXT NOT NULL REFERENCES connector_catalog(id),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 2 AND 100),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'uninstalled')),
  granted_scopes TEXT NOT NULL CHECK(json_valid(granted_scopes)),
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  installed_by TEXT NOT NULL REFERENCES identities(id),
  installed_at TEXT NOT NULL CHECK(installed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', installed_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= installed_at),
  uninstalled_at TEXT CHECK(uninstalled_at IS NULL OR uninstalled_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', uninstalled_at), '')),
  uninstalled_by TEXT REFERENCES identities(id)
) STRICT;

CREATE UNIQUE INDEX idx_connector_installations_active_unique ON connector_installations(connector_id) WHERE status != 'uninstalled';
CREATE INDEX idx_connector_installations_status ON connector_installations(status, updated_at DESC);

CREATE TRIGGER connector_installation_version_check BEFORE UPDATE ON connector_installations
WHEN (OLD.status = 'uninstalled' AND NEW.status != 'uninstalled') OR NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'connector_installation_version_conflict'); END;

CREATE TABLE connector_secrets (
  installation_id TEXT NOT NULL REFERENCES connector_installations(id) ON DELETE CASCADE,
  secret_key TEXT NOT NULL CHECK(length(secret_key) BETWEEN 1 AND 64 AND secret_key NOT GLOB '*[^a-zA-Z0-9_-]*'),
  secret_hash TEXT NOT NULL CHECK(length(secret_hash) = 64 AND secret_hash NOT GLOB '*[^0-9a-f]*'),
  masked_preview TEXT NOT NULL CHECK(length(masked_preview) BETWEEN 3 AND 64),
  encrypted_value TEXT NOT NULL CHECK(length(encrypted_value) >= 16),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  updated_by TEXT NOT NULL REFERENCES identities(id),
  PRIMARY KEY (installation_id, secret_key)
) STRICT;

CREATE INDEX idx_connector_secrets_installation ON connector_secrets(installation_id);

CREATE TABLE connector_metric_events (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  installation_id TEXT NOT NULL REFERENCES connector_installations(id),
  operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK(status IN ('success', 'failure', 'timeout')),
  latency_ms INTEGER NOT NULL CHECK(latency_ms >= 0),
  error_code TEXT CHECK(error_code IS NULL OR length(error_code) <= 64),
  invoked_at TEXT NOT NULL CHECK(invoked_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', invoked_at), '')),
  invoked_by TEXT REFERENCES identities(id)
) STRICT;

CREATE INDEX idx_connector_metric_events_history ON connector_metric_events(installation_id, invoked_at DESC);
CREATE TRIGGER connector_metric_events_no_update BEFORE UPDATE ON connector_metric_events BEGIN SELECT RAISE(ABORT, 'connector_metric_immutable'); END;
CREATE TRIGGER connector_metric_events_no_delete BEFORE DELETE ON connector_metric_events BEGIN SELECT RAISE(ABORT, 'connector_metric_immutable'); END;

CREATE TABLE connector_commands (
  actor_id TEXT NOT NULL REFERENCES identities(id),
  command_id TEXT NOT NULL CHECK(length(command_id) = 36),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  action TEXT NOT NULL CHECK(action IN ('catalog_propose', 'catalog_review', 'install', 'configure', 'rotate_secret', 'pause', 'resume', 'uninstall', 'dispatch')),
  resource_id TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  PRIMARY KEY (actor_id, command_id)
) STRICT;

CREATE TRIGGER connector_commands_no_update BEFORE UPDATE ON connector_commands BEGIN SELECT RAISE(ABORT, 'connector_command_immutable'); END;
CREATE TRIGGER connector_commands_no_delete BEFORE DELETE ON connector_commands BEGIN SELECT RAISE(ABORT, 'connector_command_immutable'); END;

CREATE TABLE connector_audit_events (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  command_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('catalog_propose', 'catalog_review', 'install', 'configure', 'rotate_secret', 'pause', 'resume', 'uninstall', 'dispatch')),
  resource_id TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_connector_audit_events_resource ON connector_audit_events(resource_id, created_at DESC);
CREATE TRIGGER connector_audit_events_no_update BEFORE UPDATE ON connector_audit_events BEGIN SELECT RAISE(ABORT, 'connector_audit_immutable'); END;
CREATE TRIGGER connector_audit_events_no_delete BEFORE DELETE ON connector_audit_events BEGIN SELECT RAISE(ABORT, 'connector_audit_immutable'); END;
