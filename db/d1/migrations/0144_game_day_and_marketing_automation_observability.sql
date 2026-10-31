-- Migration: 0144_game_day_and_marketing_automation_observability.sql
-- OBS-024: Game day resilience testing before traffic expansion (outages of Beply, carrier, D1, DO, Queue, R2, Worker release; rollback/restore, alerts & coordination vs targets).
-- OBS-027: Marketing & automation observability (triggers, suppression, delivery, conversion, complaint, discount/margin and errors per workflow).

-- ---------------------------------------------------------------------------
-- OBS-024: Game Day Drills & Traffic Expansion Gate
-- ---------------------------------------------------------------------------

CREATE TABLE game_day_drills (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  cohort TEXT NOT NULL CHECK(length(trim(cohort)) BETWEEN 3 AND 160),
  status TEXT NOT NULL CHECK(status IN ('in_progress', 'passed', 'warning', 'failed', 'aborted')),
  expansion_gate TEXT NOT NULL CHECK(expansion_gate IN ('pending', 'approved', 'blocked', 'conditional')),
  lead_engineer_id TEXT NOT NULL REFERENCES identities(id),
  scenarios_total INTEGER NOT NULL CHECK(scenarios_total >= 0),
  scenarios_passed INTEGER NOT NULL CHECK(scenarios_passed >= 0),
  scenarios_failed INTEGER NOT NULL CHECK(scenarios_failed >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  notes TEXT NOT NULL DEFAULT '',
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(summary_json)),
  started_at TEXT NOT NULL CHECK(started_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', started_at), '')),
  completed_at TEXT CHECK(completed_at IS NULL OR completed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', completed_at), '')),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;

CREATE INDEX idx_game_day_drills_status ON game_day_drills(status, completed_at DESC);
CREATE INDEX idx_game_day_drills_expansion ON game_day_drills(expansion_gate, completed_at DESC);

CREATE TRIGGER game_day_drills_no_delete BEFORE DELETE ON game_day_drills
BEGIN
  SELECT RAISE(ABORT, 'game_day_drill_immutable');
END;

CREATE TRIGGER game_day_drills_update_guard BEFORE UPDATE ON game_day_drills
WHEN NEW.id IS NOT OLD.id OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'game_day_drill_version_conflict');
END;

CREATE TABLE game_day_scenario_results (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  drill_id TEXT NOT NULL REFERENCES game_day_drills(id),
  scenario_id TEXT NOT NULL CHECK(scenario_id IN ('beply_outage', 'carrier_outage', 'd1_outage', 'durable_object_outage', 'queue_outage', 'r2_outage', 'worker_deployment_failure')),
  target_detection_seconds INTEGER NOT NULL CHECK(target_detection_seconds > 0),
  actual_detection_seconds INTEGER NOT NULL CHECK(actual_detection_seconds >= 0),
  target_recovery_seconds INTEGER NOT NULL CHECK(target_recovery_seconds > 0),
  actual_recovery_seconds INTEGER NOT NULL CHECK(actual_recovery_seconds >= 0),
  target_data_loss_seconds INTEGER NOT NULL CHECK(target_data_loss_seconds >= 0),
  actual_data_loss_seconds INTEGER NOT NULL CHECK(actual_data_loss_seconds >= 0),
  alert_triggered INTEGER NOT NULL CHECK(alert_triggered IN (0, 1)),
  alert_severity TEXT NOT NULL CHECK(alert_severity IN ('warning', 'critical')),
  alert_channel TEXT NOT NULL CHECK(alert_channel IN ('slack_sre', 'pagerduty', 'email_ops')),
  rollback_restore_status TEXT NOT NULL CHECK(rollback_restore_status IN ('not_needed', 'rollback_executed', 'restore_completed', 'failed')),
  coordination_status TEXT NOT NULL CHECK(coordination_status IN ('completed', 'delayed', 'failed')),
  runbook_reference TEXT NOT NULL CHECK(length(trim(runbook_reference)) >= 3),
  status TEXT NOT NULL CHECK(status IN ('passed', 'warning', 'failed')),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json)),
  evaluated_at TEXT NOT NULL CHECK(evaluated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', evaluated_at), '')),
  UNIQUE (drill_id, scenario_id)
) STRICT;

CREATE INDEX idx_game_day_scenarios_drill ON game_day_scenario_results(drill_id, scenario_id);

CREATE TRIGGER game_day_scenario_results_no_delete BEFORE DELETE ON game_day_scenario_results
BEGIN
  SELECT RAISE(ABORT, 'game_day_scenario_result_immutable');
END;

CREATE TRIGGER game_day_scenario_results_no_update BEFORE UPDATE ON game_day_scenario_results
BEGIN
  SELECT RAISE(ABORT, 'game_day_scenario_result_immutable');
END;

CREATE TABLE game_day_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36 AND replace(command_id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create_drill', 'record_scenario', 'complete_drill')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (actor_id, idempotency_key)
) STRICT;

CREATE TRIGGER game_day_commands_no_delete BEFORE DELETE ON game_day_commands
BEGIN
  SELECT RAISE(ABORT, 'game_day_command_immutable');
END;

CREATE TRIGGER game_day_commands_no_update BEFORE UPDATE ON game_day_commands
BEGIN
  SELECT RAISE(ABORT, 'game_day_command_immutable');
END;

-- ---------------------------------------------------------------------------
-- OBS-027: Marketing & Automation Observability
-- ---------------------------------------------------------------------------

CREATE TABLE marketing_automation_observability_events (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  workflow_id TEXT NOT NULL CHECK(length(trim(workflow_id)) BETWEEN 2 AND 64),
  execution_id TEXT NOT NULL CHECK(length(trim(execution_id)) >= 3),
  event_type TEXT NOT NULL CHECK(event_type IN ('trigger', 'suppression', 'delivery', 'conversion', 'complaint', 'error')),
  channel TEXT NOT NULL CHECK(channel IN ('email', 'sms', 'push', 'portal', 'internal')),
  customer_id TEXT REFERENCES customers(id),
  suppression_reason TEXT CHECK(suppression_reason IS NULL OR length(trim(suppression_reason)) BETWEEN 2 AND 64),
  error_code TEXT CHECK(error_code IS NULL OR length(trim(error_code)) BETWEEN 2 AND 64),
  error_message TEXT CHECK(error_message IS NULL OR length(trim(error_message)) <= 500),
  discount_cents INTEGER NOT NULL DEFAULT 0 CHECK(discount_cents >= 0),
  gross_revenue_cents INTEGER NOT NULL DEFAULT 0 CHECK(gross_revenue_cents >= 0),
  cost_cents INTEGER NOT NULL DEFAULT 0 CHECK(cost_cents >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  occurred_at TEXT NOT NULL CHECK(occurred_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', occurred_at), '')),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_mkt_obs_workflow_type ON marketing_automation_observability_events(workflow_id, event_type, occurred_at DESC);
CREATE INDEX idx_mkt_obs_customer ON marketing_automation_observability_events(customer_id, occurred_at DESC);

CREATE TRIGGER marketing_automation_events_no_delete BEFORE DELETE ON marketing_automation_observability_events
BEGIN
  SELECT RAISE(ABORT, 'marketing_automation_event_immutable');
END;

CREATE TRIGGER marketing_automation_events_no_update BEFORE UPDATE ON marketing_automation_observability_events
BEGIN
  SELECT RAISE(ABORT, 'marketing_automation_event_immutable');
END;

CREATE TABLE marketing_automation_observability_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36 AND replace(command_id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('record_event')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (actor_id, idempotency_key)
) STRICT;

CREATE TRIGGER marketing_automation_observability_commands_no_delete BEFORE DELETE ON marketing_automation_observability_commands
BEGIN
  SELECT RAISE(ABORT, 'marketing_automation_observability_command_immutable');
END;

CREATE TRIGGER marketing_automation_observability_commands_no_update BEFORE UPDATE ON marketing_automation_observability_commands
BEGIN
  SELECT RAISE(ABORT, 'marketing_automation_observability_command_immutable');
END;
