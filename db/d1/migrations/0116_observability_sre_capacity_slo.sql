-- Migration: 0116_observability_sre_capacity_slo.sql
-- OBS-025: Error budget in release decisions (feature freezes on budget exhaustion, transparent diagnostics).
-- OBS-026: Cloudflare capacity planning (peak load, CPU/subrequests, D1 rows, DO hotspots, R2, Queues, CDN, providers headroom and pre-campaign test).
-- OBS-028: B2B account & contract SLOs (measurable promises, auditable exclusions, reporting & alerting, operational capacity verification).

-- ---------------------------------------------------------------------------
-- OBS-025: Error Budget & Release Gate
-- ---------------------------------------------------------------------------

CREATE TABLE sre_sli_measurements (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  journey TEXT NOT NULL CHECK(journey IN ('storefront', 'checkout_orders', 'catalog_api', 'critical_mutations', 'payments_webhooks', 'jobs_queues')),
  window_start TEXT NOT NULL CHECK(window_start = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', window_start), '')),
  window_end TEXT NOT NULL CHECK(window_end = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', window_end), '') AND window_end >= window_start),
  total_events INTEGER NOT NULL CHECK(total_events >= 0),
  failed_events INTEGER NOT NULL CHECK(failed_events >= 0 AND failed_events <= total_events),
  target_slo_ratio REAL NOT NULL CHECK(target_slo_ratio > 0 AND target_slo_ratio <= 1.0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  recorded_at TEXT NOT NULL CHECK(recorded_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', recorded_at), '')),
  recorded_by TEXT NOT NULL REFERENCES identities(id)
) STRICT;

CREATE INDEX idx_sli_journey_window ON sre_sli_measurements(journey, window_end DESC);

CREATE TABLE sre_error_budget_policies (
  journey TEXT PRIMARY KEY CHECK(journey IN ('storefront', 'checkout_orders', 'catalog_api', 'critical_mutations', 'payments_webhooks', 'jobs_queues')),
  target_slo_ratio REAL NOT NULL CHECK(target_slo_ratio > 0 AND target_slo_ratio <= 1.0),
  warning_burn_rate REAL NOT NULL CHECK(warning_burn_rate > 0),
  freeze_burn_rate REAL NOT NULL CHECK(freeze_burn_rate >= warning_burn_rate),
  min_remaining_budget_percent REAL NOT NULL,
  freeze_action TEXT NOT NULL DEFAULT 'block_features' CHECK(freeze_action IN ('block_features', 'reliability_only', 'allow_all')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  updated_by TEXT NOT NULL REFERENCES identities(id)
) STRICT;

-- Default policies based on docs/operations/support-and-slo.md
-- Initial identities seed will be linked or referenced.

CREATE TABLE sre_release_decisions (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  release_version TEXT NOT NULL CHECK(length(trim(release_version)) BETWEEN 1 AND 64),
  release_type TEXT NOT NULL CHECK(release_type IN ('feature', 'reliability_fix', 'hotfix', 'rollback', 'infrastructure')),
  commit_hash TEXT NOT NULL CHECK(length(trim(commit_hash)) >= 7),
  requested_by TEXT NOT NULL REFERENCES identities(id),
  status TEXT NOT NULL CHECK(status IN ('approved', 'blocked_budget_exhausted', 'overridden_emergency')),
  budget_status_summary TEXT NOT NULL CHECK(json_valid(budget_status_summary)),
  justification TEXT CHECK(justification IS NULL OR length(trim(justification)) >= 5),
  overridden_by TEXT REFERENCES identities(id),
  overridden_at TEXT CHECK(overridden_at IS NULL OR overridden_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', overridden_at), '')),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_release_decisions_created ON sre_release_decisions(created_at DESC);
CREATE INDEX idx_release_decisions_version ON sre_release_decisions(release_version);

CREATE TABLE sre_release_decision_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('evaluate_release', 'record_sli_measurement', 'emergency_override', 'update_budget_policy')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  result_version INTEGER NOT NULL CHECK(result_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (actor_id, idempotency_key)
) STRICT;

CREATE TRIGGER sre_release_decision_commands_no_update BEFORE UPDATE ON sre_release_decision_commands
BEGIN SELECT RAISE(ABORT, 'sre_release_command_immutable'); END;

CREATE TRIGGER sre_release_decision_commands_no_delete BEFORE DELETE ON sre_release_decision_commands
BEGIN SELECT RAISE(ABORT, 'sre_release_command_immutable'); END;


-- ---------------------------------------------------------------------------
-- OBS-026: Cloudflare Capacity Planning
-- ---------------------------------------------------------------------------

CREATE TABLE cloudflare_capacity_metrics (
  resource_key TEXT PRIMARY KEY CHECK(resource_key IN (
    'worker_cpu_ms',
    'worker_subrequests',
    'd1_rows_read_daily',
    'd1_rows_written_daily',
    'd1_storage_bytes',
    'do_connections_hotspot',
    'r2_class_a_operations_monthly',
    'r2_class_b_operations_monthly',
    'r2_storage_bytes',
    'queues_backlog_messages',
    'workflows_active_instances',
    'cdn_edge_bandwidth_gb',
    'provider_redsys_tps',
    'provider_beply_rate_limit'
  )),
  quota_limit REAL NOT NULL CHECK(quota_limit > 0),
  current_baseline REAL NOT NULL CHECK(current_baseline >= 0),
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 32),
  cost_per_million_units REAL NOT NULL DEFAULT 0.0 CHECK(cost_per_million_units >= 0),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  updated_by TEXT NOT NULL REFERENCES identities(id)
) STRICT;

CREATE TABLE cloudflare_campaign_capacity_plans (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  campaign_name TEXT NOT NULL CHECK(length(trim(campaign_name)) BETWEEN 3 AND 100),
  start_time TEXT NOT NULL CHECK(start_time = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', start_time), '')),
  end_time TEXT NOT NULL CHECK(end_time = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', end_time), '') AND end_time >= start_time),
  projected_peak_multiplier REAL NOT NULL CHECK(projected_peak_multiplier >= 1.0),
  projected_visitors_peak INTEGER NOT NULL CHECK(projected_visitors_peak > 0),
  projected_orders_hour INTEGER NOT NULL CHECK(projected_orders_hour >= 0),
  status TEXT NOT NULL CHECK(status IN ('draft', 'simulated_passed', 'simulated_warning', 'simulated_failed', 'approved')),
  headroom_verdict TEXT NOT NULL CHECK(headroom_verdict IN ('healthy', 'warning_headroom_low', 'critical_quota_exhausted')),
  min_headroom_percent REAL NOT NULL,
  min_headroom_resource TEXT NOT NULL,
  estimated_cloudflare_cost_eur REAL NOT NULL CHECK(estimated_cloudflare_cost_eur >= 0),
  bottlenecks_json TEXT NOT NULL CHECK(json_valid(bottlenecks_json)),
  mitigations_json TEXT NOT NULL CHECK(json_valid(mitigations_json)),
  created_by TEXT NOT NULL REFERENCES identities(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_campaign_plans_created ON cloudflare_campaign_capacity_plans(created_at DESC);

CREATE TABLE cloudflare_capacity_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('simulate_campaign', 'update_metric_baseline', 'approve_campaign_plan')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  result_version INTEGER NOT NULL CHECK(result_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (actor_id, idempotency_key)
) STRICT;

CREATE TRIGGER cloudflare_capacity_commands_no_update BEFORE UPDATE ON cloudflare_capacity_commands
BEGIN SELECT RAISE(ABORT, 'cloudflare_capacity_command_immutable'); END;

CREATE TRIGGER cloudflare_capacity_commands_no_delete BEFORE DELETE ON cloudflare_capacity_commands
BEGIN SELECT RAISE(ABORT, 'cloudflare_capacity_command_immutable'); END;


-- ---------------------------------------------------------------------------
-- OBS-028: B2B Account & Contract SLOs
-- ---------------------------------------------------------------------------

CREATE TABLE b2b_account_sla_tiers (
  tier_code TEXT PRIMARY KEY CHECK(tier_code IN ('standard', 'premium_b2b', 'enterprise_vip')),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 100),
  availability_slo_target REAL NOT NULL CHECK(availability_slo_target > 0 AND availability_slo_target <= 1.0),
  api_p95_latency_ms INTEGER NOT NULL CHECK(api_p95_latency_ms > 0),
  support_response_max_minutes INTEGER NOT NULL CHECK(support_response_max_minutes > 0),
  dispatch_lead_hours INTEGER NOT NULL CHECK(dispatch_lead_hours > 0),
  required_dedicated_manager INTEGER NOT NULL CHECK(required_dedicated_manager IN (0, 1)),
  required_min_headroom_percent REAL NOT NULL CHECK(required_min_headroom_percent >= 0),
  penalty_credit_percent_per_breach REAL NOT NULL CHECK(penalty_credit_percent_per_breach >= 0)
) STRICT;

INSERT OR IGNORE INTO b2b_account_sla_tiers (
  tier_code, name, availability_slo_target, api_p95_latency_ms, support_response_max_minutes, dispatch_lead_hours, required_dedicated_manager, required_min_headroom_percent, penalty_credit_percent_per_breach
) VALUES
  ('standard', 'B2B Estándar', 0.995, 800, 120, 48, 0, 10.0, 0.0),
  ('premium_b2b', 'B2B Premium', 0.999, 400, 30, 24, 0, 20.0, 5.0),
  ('enterprise_vip', 'B2B Enterprise VIP', 0.9995, 250, 15, 12, 1, 30.0, 10.0);

CREATE TABLE b2b_contract_slos (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  company_name TEXT NOT NULL CHECK(length(trim(company_name)) BETWEEN 2 AND 200),
  contract_ref TEXT NOT NULL UNIQUE CHECK(length(contract_ref) BETWEEN 4 AND 64),
  tier_code TEXT NOT NULL REFERENCES b2b_account_sla_tiers(tier_code),
  availability_target REAL NOT NULL CHECK(availability_target > 0 AND availability_target <= 1.0),
  api_p95_latency_target_ms INTEGER NOT NULL CHECK(api_p95_latency_target_ms > 0),
  support_response_target_min INTEGER NOT NULL CHECK(support_response_target_min > 0),
  dispatch_lead_target_hours INTEGER NOT NULL CHECK(dispatch_lead_target_hours > 0),
  status TEXT NOT NULL CHECK(status IN ('draft', 'operational_check_pending', 'active', 'suspended_capacity', 'terminated')),
  operational_capacity_verified INTEGER NOT NULL DEFAULT 0 CHECK(operational_capacity_verified IN (0, 1)),
  operational_check_notes TEXT,
  billing_period_start TEXT NOT NULL CHECK(billing_period_start = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', billing_period_start), '')),
  billing_period_end TEXT NOT NULL CHECK(billing_period_end = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', billing_period_end), '') AND billing_period_end >= billing_period_start),
  created_by TEXT NOT NULL REFERENCES identities(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_b2b_contract_customer ON b2b_contract_slos(customer_id);
CREATE INDEX idx_b2b_contract_status ON b2b_contract_slos(status);

CREATE TABLE b2b_slo_event_records (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  contract_id TEXT NOT NULL REFERENCES b2b_contract_slos(id),
  event_date TEXT NOT NULL CHECK(length(event_date) = 10),
  service_journey TEXT NOT NULL CHECK(service_journey IN ('b2b_portal', 'b2b_api_orders', 'priority_fulfillment', 'dedicated_support')),
  total_transactions INTEGER NOT NULL CHECK(total_transactions >= 0),
  successful_transactions INTEGER NOT NULL CHECK(successful_transactions >= 0 AND successful_transactions <= total_transactions),
  p95_latency_ms INTEGER NOT NULL CHECK(p95_latency_ms >= 0),
  downtime_minutes INTEGER NOT NULL DEFAULT 0 CHECK(downtime_minutes >= 0),
  support_tickets_count INTEGER NOT NULL DEFAULT 0 CHECK(support_tickets_count >= 0),
  support_breaches_count INTEGER NOT NULL DEFAULT 0 CHECK(support_breaches_count >= 0 AND support_breaches_count <= support_tickets_count),
  fulfillment_dispatches_count INTEGER NOT NULL DEFAULT 0 CHECK(fulfillment_dispatches_count >= 0),
  fulfillment_delays_count INTEGER NOT NULL DEFAULT 0 CHECK(fulfillment_delays_count >= 0 AND fulfillment_delays_count <= fulfillment_dispatches_count),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_b2b_events_contract_date ON b2b_slo_event_records(contract_id, event_date);

CREATE TABLE b2b_slo_exclusions (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  contract_id TEXT NOT NULL REFERENCES b2b_contract_slos(id),
  reason_category TEXT NOT NULL CHECK(reason_category IN ('scheduled_maintenance', 'customer_fault', 'force_majeure', 'upstream_provider_outage')),
  start_time TEXT NOT NULL CHECK(start_time = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', start_time), '')),
  end_time TEXT NOT NULL CHECK(end_time = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', end_time), '') AND end_time >= start_time),
  excluded_downtime_minutes INTEGER NOT NULL CHECK(excluded_downtime_minutes > 0),
  justification TEXT NOT NULL CHECK(length(trim(justification)) BETWEEN 10 AND 1000),
  approved_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_b2b_exclusions_contract ON b2b_slo_exclusions(contract_id);

CREATE TABLE b2b_slo_compliance_reports (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  contract_id TEXT NOT NULL REFERENCES b2b_contract_slos(id),
  report_month TEXT NOT NULL CHECK(length(report_month) = 7),
  availability_achieved REAL NOT NULL,
  target_availability REAL NOT NULL,
  availability_compliant INTEGER NOT NULL CHECK(availability_compliant IN (0, 1)),
  latency_p95_achieved_ms INTEGER NOT NULL,
  latency_compliant INTEGER NOT NULL CHECK(latency_compliant IN (0, 1)),
  support_compliant INTEGER NOT NULL CHECK(support_compliant IN (0, 1)),
  fulfillment_compliant INTEGER NOT NULL CHECK(fulfillment_compliant IN (0, 1)),
  overall_compliant INTEGER NOT NULL CHECK(overall_compliant IN (0, 1)),
  total_downtime_minutes INTEGER NOT NULL CHECK(total_downtime_minutes >= 0),
  excluded_downtime_minutes INTEGER NOT NULL CHECK(excluded_downtime_minutes >= 0),
  net_chargeable_downtime_minutes INTEGER NOT NULL CHECK(net_chargeable_downtime_minutes >= 0),
  penalty_credit_eur REAL NOT NULL DEFAULT 0.0 CHECK(penalty_credit_eur >= 0),
  alert_level TEXT NOT NULL CHECK(alert_level IN ('nominal', 'warning_risk_of_breach', 'breached')),
  generated_at TEXT NOT NULL CHECK(generated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', generated_at), ''))
) STRICT;

CREATE INDEX idx_b2b_reports_contract_month ON b2b_slo_compliance_reports(contract_id, report_month);

CREATE TABLE b2b_contract_slo_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create_contract', 'verify_operational_capacity', 'record_slo_event', 'record_exclusion', 'generate_compliance_report')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  result_version INTEGER NOT NULL CHECK(result_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (actor_id, idempotency_key)
) STRICT;

CREATE TRIGGER b2b_contract_slo_commands_no_update BEFORE UPDATE ON b2b_contract_slo_commands
BEGIN SELECT RAISE(ABORT, 'b2b_contract_slo_command_immutable'); END;

CREATE TRIGGER b2b_contract_slo_commands_no_delete BEFORE DELETE ON b2b_contract_slo_commands
BEGIN SELECT RAISE(ABORT, 'b2b_contract_slo_command_immutable'); END;
