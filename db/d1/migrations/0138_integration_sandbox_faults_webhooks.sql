-- Migration: 0138_integration_sandbox_faults_webhooks.sql
-- Requirements:
-- INT-018: Pruebas de contrato periódicas contra sandbox.
-- INT-019: Fault injection de integraciones.
-- INT-021: Webhooks salientes para clientes.

-- INT-018: Cuotas de llamadas a sandbox para prevenir costes descontrolados o rate-limiting
CREATE TABLE sandbox_contract_quotas (
  provider TEXT PRIMARY KEY CHECK(provider IN ('beply', 'redsys', 'carrier', 'generic')),
  daily_limit INTEGER NOT NULL CHECK(daily_limit > 0),
  hourly_limit INTEGER NOT NULL CHECK(hourly_limit > 0),
  daily_used INTEGER NOT NULL DEFAULT 0 CHECK(daily_used >= 0),
  hourly_used INTEGER NOT NULL DEFAULT 0 CHECK(hourly_used >= 0),
  window_date TEXT NOT NULL CHECK(length(window_date) = 10),
  window_hour TEXT NOT NULL CHECK(length(window_hour) = 13),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;

-- INT-018: Historial de ejecuciones de pruebas de contrato con detección de drift
CREATE TABLE sandbox_contract_runs (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  provider TEXT NOT NULL CHECK(provider IN ('beply', 'redsys', 'carrier', 'generic')),
  suite_name TEXT NOT NULL CHECK(length(suite_name) BETWEEN 2 AND 100),
  status TEXT NOT NULL CHECK(status IN ('passed', 'drift_detected', 'quota_exceeded', 'failed')),
  duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
  synthetic_seed TEXT NOT NULL CHECK(length(synthetic_seed) >= 4),
  quota_consumed INTEGER NOT NULL DEFAULT 1 CHECK(quota_consumed >= 0),
  drift_count INTEGER NOT NULL DEFAULT 0 CHECK(drift_count >= 0),
  drift_summary_json TEXT NOT NULL CHECK(json_valid(drift_summary_json)),
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  triggered_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_sandbox_contract_runs_provider ON sandbox_contract_runs(provider, created_at DESC);
CREATE INDEX idx_sandbox_contract_runs_status ON sandbox_contract_runs(status, created_at DESC);

-- INT-018: Alertas de drift en contratos de proveedor
CREATE TABLE sandbox_drift_alerts (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  run_id TEXT NOT NULL REFERENCES sandbox_contract_runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('beply', 'redsys', 'carrier', 'generic')),
  severity TEXT NOT NULL CHECK(severity IN ('warning', 'critical')),
  drift_type TEXT NOT NULL CHECK(drift_type IN ('schema_mismatch', 'missing_field', 'status_code_changed', 'checksum_drift', 'semantic_drift')),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 5 AND 1000),
  diff_json TEXT NOT NULL CHECK(json_valid(diff_json)),
  acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0, 1)),
  acknowledged_at TEXT CHECK(acknowledged_at IS NULL OR acknowledged_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', acknowledged_at), '')),
  acknowledged_by TEXT REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_sandbox_drift_alerts_status ON sandbox_drift_alerts(acknowledged, created_at DESC);

-- INT-019: Reglas gobernadas de inyección de fallos
CREATE TABLE integration_fault_rules (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  provider TEXT NOT NULL CHECK(provider IN ('beply', 'redsys', 'carrier', 'webhook', 'all')),
  operation TEXT NOT NULL CHECK(length(operation) BETWEEN 2 AND 64),
  fault_type TEXT NOT NULL CHECK(fault_type IN ('timeout', 'http_500', 'http_401', 'partial_payload', 'duplicate', 'latency')),
  parameters_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(parameters_json)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE TRIGGER integration_fault_rules_version_check
BEFORE UPDATE ON integration_fault_rules
WHEN NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'integration_fault_rule_version_conflict');
END;

-- INT-019: Logs de simulaciones de fallos y prueba de no corrupción
CREATE TABLE integration_fault_logs (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  rule_id TEXT REFERENCES integration_fault_rules(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK(provider IN ('beply', 'redsys', 'carrier', 'webhook', 'all')),
  operation TEXT NOT NULL CHECK(length(operation) BETWEEN 2 AND 64),
  fault_injected TEXT NOT NULL CHECK(fault_injected IN ('timeout', 'http_500', 'http_401', 'partial_payload', 'duplicate', 'latency')),
  recovered INTEGER NOT NULL CHECK(recovered IN (0, 1)),
  recovery_action TEXT NOT NULL CHECK(recovery_action IN ('retried', 'idempotent_cached', 'clean_rejection', 'dlq_routed', 'fallback_executed')),
  state_consistent INTEGER NOT NULL CHECK(state_consistent IN (0, 1)),
  audit_details_json TEXT NOT NULL CHECK(json_valid(audit_details_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_integration_fault_logs_created ON integration_fault_logs(created_at DESC);

-- INT-021: Suscripciones a webhooks salientes con soporte de rotación de secretos
CREATE TABLE outbound_webhook_subscriptions (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  owner_id TEXT NOT NULL REFERENCES identities(id),
  url TEXT NOT NULL CHECK(length(url) BETWEEN 8 AND 2048),
  topics_json TEXT NOT NULL CHECK(json_valid(topics_json)),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 2 AND 255),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'disabled')),
  primary_secret TEXT NOT NULL CHECK(length(primary_secret) >= 32),
  secondary_secret TEXT CHECK(secondary_secret IS NULL OR length(secondary_secret) >= 32),
  secondary_secret_expires_at TEXT CHECK(secondary_secret_expires_at IS NULL OR secondary_secret_expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', secondary_secret_expires_at), '')),
  secret_rotated_at TEXT CHECK(secret_rotated_at IS NULL OR secret_rotated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', secret_rotated_at), '')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_outbound_webhook_subscriptions_owner ON outbound_webhook_subscriptions(owner_id, status);

CREATE TRIGGER outbound_webhook_subscriptions_version_check
BEFORE UPDATE ON outbound_webhook_subscriptions
WHEN NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'outbound_webhook_subscription_version_conflict');
END;

-- INT-021: Cola de entregas salientes, reintentos y DLQ
CREATE TABLE outbound_webhook_deliveries (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  subscription_id TEXT NOT NULL REFERENCES outbound_webhook_subscriptions(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL CHECK(length(event_id) >= 4),
  topic TEXT NOT NULL CHECK(length(topic) BETWEEN 3 AND 64),
  payload_version TEXT NOT NULL CHECK(payload_version IN ('v1', '2026-10-01')),
  minimized_payload_json TEXT NOT NULL CHECK(json_valid(minimized_payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'retrying', 'dead_letter', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts > 0),
  next_attempt_at TEXT NOT NULL CHECK(next_attempt_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', next_attempt_at), '')),
  delivered_at TEXT CHECK(delivered_at IS NULL OR delivered_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', delivered_at), '')),
  last_http_status INTEGER CHECK(last_http_status IS NULL OR (last_http_status >= 100 AND last_http_status <= 599)),
  last_error TEXT CHECK(last_error IS NULL OR length(last_error) <= 1000),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_outbound_webhook_deliveries_pending ON outbound_webhook_deliveries(status, next_attempt_at) WHERE status IN ('pending', 'retrying');
CREATE INDEX idx_outbound_webhook_deliveries_sub ON outbound_webhook_deliveries(subscription_id, created_at DESC);

CREATE TRIGGER outbound_webhook_deliveries_version_check
BEFORE UPDATE ON outbound_webhook_deliveries
WHEN NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'outbound_webhook_delivery_version_conflict');
END;

-- INT-021: Historial append-only de intentos de entrega de webhooks
CREATE TABLE outbound_webhook_delivery_logs (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  delivery_id TEXT NOT NULL REFERENCES outbound_webhook_deliveries(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK(attempt_number >= 1),
  target_url TEXT NOT NULL CHECK(length(target_url) BETWEEN 8 AND 2048),
  http_status INTEGER NOT NULL CHECK(http_status >= 0 AND http_status <= 599),
  latency_ms INTEGER NOT NULL CHECK(latency_ms >= 0),
  error_message TEXT CHECK(error_message IS NULL OR length(error_message) <= 1000),
  request_headers_json TEXT NOT NULL CHECK(json_valid(request_headers_json)),
  response_snippet TEXT CHECK(response_snippet IS NULL OR length(response_snippet) <= 1000),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_outbound_webhook_delivery_logs_delivery ON outbound_webhook_delivery_logs(delivery_id, attempt_number ASC);

-- Comandos e idempotencia de webhooks salientes
CREATE TABLE outbound_webhook_commands (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 4 AND 128),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (actor_id, idempotency_key)
) STRICT;

-- Semillas iniciales de roles, permisos y cuotas
INSERT OR IGNORE INTO roles (code, name, description) VALUES
  ('admin', 'Administrador', 'Rol administrador');

INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
  ('integrations.manage', 'integrations', 'manage', 'Administración de integraciones, contratos sandbox, fault injection y webhooks');

INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
  ('admin', 'integrations.manage');

INSERT OR IGNORE INTO sandbox_contract_quotas (provider, daily_limit, hourly_limit, daily_used, hourly_used, window_date, window_hour, version, updated_at) VALUES
  ('beply', 100, 20, 0, 0, '2026-10-29', '2026-10-29T12', 1, '2026-10-29T12:00:00Z'),
  ('redsys', 200, 40, 0, 0, '2026-10-29', '2026-10-29T12', 1, '2026-10-29T12:00:00Z'),
  ('carrier', 150, 30, 0, 0, '2026-10-29', '2026-10-29T12', 1, '2026-10-29T12:00:00Z'),
  ('generic', 100, 20, 0, 0, '2026-10-29', '2026-10-29T12', 1, '2026-10-29T12:00:00Z');
