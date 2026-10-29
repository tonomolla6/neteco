-- Migration 0111_experiments_ab_testing.sql
-- DAT-017: A/B testing with server-side or stable assignment (hypotheses, primary metric/guardrails, size/duration, SRM, decision, result archive).
-- DAT-018: Experiment registry (prevents uncontrolled overlapping tests, searchable owner, segment, changes, and results).
-- MKT-011: Message and offer experimentation (hypotheses, holdout groups, margin floor, unsubscribes/complaints, Core Web Vitals guardrails).

CREATE TABLE experiments (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  key TEXT NOT NULL UNIQUE CHECK(length(key) BETWEEN 3 AND 80 AND key NOT GLOB '*[^a-z0-9_-]*'),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 3 AND 200),
  hypothesis TEXT NOT NULL CHECK(length(trim(hypothesis)) BETWEEN 10 AND 2000),
  experiment_type TEXT NOT NULL CHECK(experiment_type IN ('ab_test', 'message_offer', 'feature_gate')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'running', 'paused', 'concluded', 'archived')),
  owner_id TEXT NOT NULL REFERENCES identities(id),
  owner_email TEXT NOT NULL CHECK(length(owner_email) BETWEEN 5 AND 254),
  target_surface TEXT NOT NULL CHECK(target_surface IN ('homepage_hero', 'product_detail', 'cart_offer', 'checkout_incentive', 'category_banner', 'global')),
  target_segment TEXT NOT NULL CHECK(target_segment IN ('all', 'b2b_only', 'b2c_only', 'new_visitors', 'repeat_customers')),
  exclusive_group TEXT CHECK(exclusive_group IS NULL OR (length(exclusive_group) BETWEEN 3 AND 64 AND exclusive_group NOT GLOB '*[^a-z0-9_-]*')),
  primary_metric TEXT NOT NULL CHECK(primary_metric IN ('conversion_rate', 'revenue_per_visitor', 'click_through_rate', 'average_order_value', 'retention_rate')),
  guardrails_json TEXT NOT NULL CHECK(json_valid(guardrails_json)),
  traffic_allocation_percent INTEGER NOT NULL DEFAULT 100 CHECK(traffic_allocation_percent BETWEEN 1 AND 100),
  min_sample_size INTEGER NOT NULL DEFAULT 100 CHECK(min_sample_size >= 20),
  min_duration_days INTEGER NOT NULL DEFAULT 7 CHECK(min_duration_days BETWEEN 1 AND 180),
  start_date TEXT CHECK(start_date IS NULL OR start_date = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', start_date), '')),
  end_date TEXT CHECK(end_date IS NULL OR end_date = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', end_date), '')),
  holdout_percent INTEGER NOT NULL DEFAULT 0 CHECK(holdout_percent BETWEEN 0 AND 50),
  changes_description TEXT NOT NULL DEFAULT '',
  decision TEXT CHECK(decision IS NULL OR decision IN ('variant_a_winner', 'variant_b_winner', 'custom_variant_winner', 'no_winner_inconclusive', 'stopped_guardrail_breach', 'rolled_back')),
  decision_rationale TEXT CHECK(decision_rationale IS NULL OR length(trim(decision_rationale)) <= 2000),
  decided_at TEXT CHECK(decided_at IS NULL OR decided_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', decided_at), '')),
  decided_by TEXT REFERENCES identities(id),
  archived_at TEXT CHECK(archived_at IS NULL OR archived_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', archived_at), '')),
  archived_results_json TEXT CHECK(archived_results_json IS NULL OR json_valid(archived_results_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  created_by TEXT NOT NULL REFERENCES identities(id)
) STRICT;

CREATE INDEX idx_experiments_status ON experiments(status);
CREATE INDEX idx_experiments_surface_segment ON experiments(target_surface, target_segment, status);
CREATE INDEX idx_experiments_owner ON experiments(owner_id);

CREATE TRIGGER experiments_version_guard BEFORE UPDATE ON experiments
WHEN NEW.id IS NOT OLD.id OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'experiment_version_conflict'); END;

CREATE TABLE experiment_variants (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  variant_key TEXT NOT NULL CHECK(length(variant_key) BETWEEN 1 AND 50 AND variant_key NOT GLOB '*[^a-z0-9_-]*'),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  is_control INTEGER NOT NULL DEFAULT 0 CHECK(is_control IN (0, 1)),
  is_holdout INTEGER NOT NULL DEFAULT 0 CHECK(is_holdout IN (0, 1)),
  weight INTEGER NOT NULL DEFAULT 50 CHECK(weight BETWEEN 1 AND 1000),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (experiment_id, variant_key)
) STRICT;

CREATE TABLE experiment_assignments (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  unit_type TEXT NOT NULL CHECK(unit_type IN ('visitor_id', 'customer_id', 'session_id')),
  unit_id TEXT NOT NULL CHECK(length(unit_id) BETWEEN 8 AND 128),
  variant_key TEXT NOT NULL CHECK(length(variant_key) BETWEEN 1 AND 50),
  assigned_at TEXT NOT NULL CHECK(assigned_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', assigned_at), '')),
  UNIQUE (experiment_id, unit_type, unit_id)
) STRICT;

CREATE INDEX idx_assignments_exp_variant ON experiment_assignments(experiment_id, variant_key);

CREATE TRIGGER experiment_assignments_no_update BEFORE UPDATE ON experiment_assignments
BEGIN SELECT RAISE(ABORT, 'experiment_assignment_immutable'); END;

CREATE TRIGGER experiment_assignments_no_delete BEFORE DELETE ON experiment_assignments
BEGIN SELECT RAISE(ABORT, 'experiment_assignment_immutable'); END;

CREATE TABLE experiment_metrics_events (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  variant_key TEXT NOT NULL CHECK(length(variant_key) BETWEEN 1 AND 50),
  unit_type TEXT NOT NULL CHECK(unit_type IN ('visitor_id', 'customer_id', 'session_id')),
  unit_id TEXT NOT NULL CHECK(length(unit_id) BETWEEN 8 AND 128),
  event_type TEXT NOT NULL CHECK(event_type IN ('exposure', 'conversion', 'order_placed', 'click', 'unsubscribe', 'complaint', 'web_vital_lcp', 'web_vital_cls', 'web_vital_inp')),
  event_value REAL NOT NULL DEFAULT 0.0,
  margin_basis_points INTEGER CHECK(margin_basis_points IS NULL OR margin_basis_points BETWEEN -10000 AND 10000),
  metadata_json TEXT CHECK(metadata_json IS NULL OR json_valid(metadata_json)),
  recorded_at TEXT NOT NULL CHECK(recorded_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', recorded_at), ''))
) STRICT;

CREATE INDEX idx_metrics_exp_variant_event ON experiment_metrics_events(experiment_id, variant_key, event_type);

CREATE TRIGGER experiment_metrics_no_update BEFORE UPDATE ON experiment_metrics_events
BEGIN SELECT RAISE(ABORT, 'experiment_metric_immutable'); END;

CREATE TRIGGER experiment_metrics_no_delete BEFORE DELETE ON experiment_metrics_events
BEGIN SELECT RAISE(ABORT, 'experiment_metric_immutable'); END;

CREATE TABLE experiment_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36 AND replace(command_id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create_experiment', 'update_experiment', 'start_experiment', 'pause_experiment', 'record_decision', 'archive_experiment')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  result_version INTEGER NOT NULL CHECK(result_version >= 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (actor_id, idempotency_key),
  UNIQUE (experiment_id, result_version)
) STRICT;

CREATE TRIGGER experiment_commands_no_update BEFORE UPDATE ON experiment_commands
BEGIN SELECT RAISE(ABORT, 'experiment_command_immutable'); END;

CREATE TRIGGER experiment_commands_no_delete BEFORE DELETE ON experiment_commands
BEGIN SELECT RAISE(ABORT, 'experiment_command_immutable'); END;
