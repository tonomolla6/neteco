-- DAT-016 + DAT-024: CRM Automation Measurement & Anomaly Detection with Operator Review.
-- DAT-016: Measure delivery, clicks, incremental conversion, unsubscribes, complaints and margin per flow; holdout groups when viable.
-- DAT-024: Anomaly alerts on conversion, payment, stock, tracking and data; thresholds and runbooks avoid noise; review workflow with CAS.

-- ============================================================================
-- DAT-016: CRM Automation Holdout & Measurement
-- ============================================================================

CREATE TABLE crm_automation_holdout_policies (
  flow_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK(version >= 1),
  holdout_percentage INTEGER NOT NULL CHECK(holdout_percentage BETWEEN 0 AND 50),
  holdout_enabled INTEGER NOT NULL CHECK(holdout_enabled IN (0, 1)),
  salt TEXT NOT NULL CHECK(length(salt) >= 8),
  min_sample_size INTEGER NOT NULL CHECK(min_sample_size >= 1),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  updated_by TEXT NOT NULL REFERENCES identities(id)
) STRICT;

CREATE TRIGGER crm_automation_holdout_policies_no_delete BEFORE DELETE ON crm_automation_holdout_policies
BEGIN SELECT RAISE(ABORT, 'crm_automation_holdout_policy_immutable'); END;

CREATE TRIGGER crm_automation_holdout_policies_update_guard BEFORE UPDATE ON crm_automation_holdout_policies
WHEN NEW.flow_id IS NOT OLD.flow_id OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'crm_automation_holdout_policy_version_conflict'); END;

CREATE TABLE crm_automation_holdout_allocations (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  flow_id TEXT NOT NULL,
  step TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  group_type TEXT NOT NULL CHECK(group_type IN ('treatment', 'holdout')),
  allocated_at TEXT NOT NULL CHECK(allocated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', allocated_at), '')),
  UNIQUE (flow_id, step, customer_id)
) STRICT;

CREATE TRIGGER crm_automation_holdout_allocations_no_update BEFORE UPDATE ON crm_automation_holdout_allocations
BEGIN SELECT RAISE(ABORT, 'crm_automation_holdout_allocation_immutable'); END;

CREATE TRIGGER crm_automation_holdout_allocations_no_delete BEFORE DELETE ON crm_automation_holdout_allocations
BEGIN SELECT RAISE(ABORT, 'crm_automation_holdout_allocation_immutable'); END;

CREATE TABLE crm_automation_events (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  flow_id TEXT NOT NULL,
  step TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  group_type TEXT NOT NULL CHECK(group_type IN ('treatment', 'holdout')),
  event_type TEXT NOT NULL CHECK(event_type IN ('delivery', 'click', 'conversion', 'unsubscribe', 'complaint')),
  order_id TEXT REFERENCES orders(id),
  revenue_cents INTEGER CHECK(revenue_cents IS NULL OR revenue_cents >= 0),
  cost_cents INTEGER CHECK(cost_cents IS NULL OR cost_cents >= 0),
  margin_cents INTEGER CHECK(margin_cents IS NULL OR (revenue_cents IS NOT NULL AND cost_cents IS NOT NULL)),
  margin_basis_points INTEGER CHECK(margin_basis_points IS NULL OR margin_basis_points BETWEEN -10000 AND 10000),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  occurred_at TEXT NOT NULL CHECK(occurred_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', occurred_at), '')),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_crm_auto_events_flow ON crm_automation_events(flow_id, event_type, occurred_at);
CREATE INDEX idx_crm_auto_events_cust ON crm_automation_events(customer_id, flow_id);

CREATE TRIGGER crm_automation_events_no_update BEFORE UPDATE ON crm_automation_events
BEGIN SELECT RAISE(ABORT, 'crm_automation_event_immutable'); END;

CREATE TRIGGER crm_automation_events_no_delete BEFORE DELETE ON crm_automation_events
BEGIN SELECT RAISE(ABORT, 'crm_automation_event_immutable'); END;

CREATE TABLE crm_automation_metrics_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36 AND replace(command_id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('configure_holdout', 'record_event', 'allocate_holdout')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  applied_version INTEGER NOT NULL CHECK(applied_version >= 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (actor_id, idempotency_key)
) STRICT;

CREATE TRIGGER crm_automation_metrics_commands_no_update BEFORE UPDATE ON crm_automation_metrics_commands
BEGIN SELECT RAISE(ABORT, 'crm_automation_metrics_command_immutable'); END;

CREATE TRIGGER crm_automation_metrics_commands_no_delete BEFORE DELETE ON crm_automation_metrics_commands
BEGIN SELECT RAISE(ABORT, 'crm_automation_metrics_command_immutable'); END;

-- ============================================================================
-- DAT-024: Anomaly Detection with Noise Avoidance & Operator Review
-- ============================================================================

CREATE TABLE anomaly_detection_policies (
  dimension TEXT PRIMARY KEY CHECK(dimension IN ('conversion', 'payment', 'stock', 'tracking', 'data')),
  version INTEGER NOT NULL CHECK(version >= 1),
  warning_drop_percent INTEGER NOT NULL CHECK(warning_drop_percent BETWEEN 1 AND 100),
  critical_drop_percent INTEGER NOT NULL CHECK(critical_drop_percent BETWEEN 1 AND 100),
  min_sample_size INTEGER NOT NULL CHECK(min_sample_size >= 1),
  evaluation_window_minutes INTEGER NOT NULL CHECK(evaluation_window_minutes BETWEEN 1 AND 10080),
  cooldown_minutes INTEGER NOT NULL CHECK(cooldown_minutes BETWEEN 0 AND 1440),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  updated_by TEXT NOT NULL REFERENCES identities(id)
) STRICT;

CREATE TRIGGER anomaly_detection_policies_no_delete BEFORE DELETE ON anomaly_detection_policies
BEGIN SELECT RAISE(ABORT, 'anomaly_detection_policy_immutable'); END;

CREATE TRIGGER anomaly_detection_policies_update_guard BEFORE UPDATE ON anomaly_detection_policies
WHEN NEW.dimension IS NOT OLD.dimension OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'anomaly_detection_policy_version_conflict'); END;

CREATE TABLE anomaly_alerts (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  dimension TEXT NOT NULL CHECK(dimension IN ('conversion', 'payment', 'stock', 'tracking', 'data')),
  metric_name TEXT NOT NULL CHECK(length(metric_name) BETWEEN 3 AND 80),
  severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'critical')),
  status TEXT NOT NULL CHECK(status IN ('open', 'acknowledged', 'under_investigation', 'resolved', 'dismissed_false_positive')),
  baseline_value REAL NOT NULL CHECK(baseline_value >= 0),
  observed_value REAL NOT NULL CHECK(observed_value >= 0),
  deviation_percent REAL NOT NULL,
  sample_size INTEGER NOT NULL CHECK(sample_size >= 0),
  threshold_applied REAL NOT NULL,
  runbook_id TEXT NOT NULL CHECK(length(runbook_id) BETWEEN 3 AND 64),
  runbook_title TEXT NOT NULL CHECK(length(runbook_title) BETWEEN 3 AND 255),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 3 AND 500),
  detected_at TEXT NOT NULL CHECK(detected_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', detected_at), '')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  reviewer_id TEXT REFERENCES identities(id),
  reviewed_at TEXT CHECK(reviewed_at IS NULL OR reviewed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', reviewed_at), '')),
  review_notes TEXT CHECK(review_notes IS NULL OR length(review_notes) BETWEEN 1 AND 2000),
  resolution_action TEXT CHECK(resolution_action IS NULL OR length(resolution_action) BETWEEN 1 AND 255),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;

CREATE INDEX idx_anomaly_alerts_dim_status ON anomaly_alerts(dimension, status, detected_at DESC);

CREATE TRIGGER anomaly_alerts_no_delete BEFORE DELETE ON anomaly_alerts
BEGIN SELECT RAISE(ABORT, 'anomaly_alert_immutable'); END;

CREATE TRIGGER anomaly_alerts_update_guard BEFORE UPDATE ON anomaly_alerts
WHEN NEW.id IS NOT OLD.id OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'anomaly_alert_version_conflict'); END;

CREATE TABLE anomaly_alert_reviews (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  alert_id TEXT NOT NULL REFERENCES anomaly_alerts(id),
  reviewer_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('acknowledge', 'investigate', 'resolve', 'dismiss')),
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  notes TEXT NOT NULL CHECK(length(notes) BETWEEN 1 AND 2000),
  resolution_action TEXT CHECK(resolution_action IS NULL OR length(resolution_action) BETWEEN 1 AND 255),
  reviewed_at TEXT NOT NULL CHECK(reviewed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', reviewed_at), ''))
) STRICT;

CREATE INDEX idx_anomaly_alert_reviews_alert ON anomaly_alert_reviews(alert_id, reviewed_at DESC);

CREATE TRIGGER anomaly_alert_reviews_no_update BEFORE UPDATE ON anomaly_alert_reviews
BEGIN SELECT RAISE(ABORT, 'anomaly_alert_review_immutable'); END;

CREATE TRIGGER anomaly_alert_reviews_no_delete BEFORE DELETE ON anomaly_alert_reviews
BEGIN SELECT RAISE(ABORT, 'anomaly_alert_review_immutable'); END;

CREATE TABLE anomaly_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36 AND replace(command_id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('update_policy', 'evaluate_signal', 'review_alert')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  applied_version INTEGER NOT NULL CHECK(applied_version >= 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (actor_id, idempotency_key)
) STRICT;

CREATE TRIGGER anomaly_commands_no_update BEFORE UPDATE ON anomaly_commands
BEGIN SELECT RAISE(ABORT, 'anomaly_command_immutable'); END;

CREATE TRIGGER anomaly_commands_no_delete BEFORE DELETE ON anomaly_commands
BEGIN SELECT RAISE(ABORT, 'anomaly_command_immutable'); END;
