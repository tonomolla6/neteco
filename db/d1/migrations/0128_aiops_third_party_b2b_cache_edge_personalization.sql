-- Migration: 0128_aiops_third_party_b2b_cache_edge_personalization.sql
-- OBS-030: AIOps limited to recommendation (anomaly correlation -> runbook proposal; humans approve; precision measured).
-- PER-022: Third-party optimisation by value (A/B impact vs cost; removal of pixels/widgets without return).
-- PER-023: B2B catalogue cache/query isolation (hit-rate statistics; keys are derived in code, never stored raw).
-- PER-025: Limited edge personalisation (enabled only with evidence; deterministic fallback; bounded cache variants).
-- Depends only on 0014 (identities). No dependency on other pending migrations.

CREATE TABLE perf_insight_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  domain TEXT NOT NULL CHECK(domain IN ('aiops', 'third_party', 'edge_personalization')),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 64),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (domain, actor_id, idempotency_key)
) STRICT;

CREATE TRIGGER perf_insight_commands_no_update BEFORE UPDATE ON perf_insight_commands
BEGIN SELECT RAISE(ABORT, 'perf_insight_command_immutable'); END;
CREATE TRIGGER perf_insight_commands_no_delete BEFORE DELETE ON perf_insight_commands
BEGIN SELECT RAISE(ABORT, 'perf_insight_command_immutable'); END;

-- ---------------------------------------------------------------------------
-- OBS-030
-- ---------------------------------------------------------------------------

CREATE TABLE aiops_signals (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  kind TEXT NOT NULL CHECK(kind IN ('error_rate', 'latency_p95', 'queue_backlog', 'db_errors', 'payment_failures', 'provider_timeout', 'deploy', 'saturation')),
  service TEXT NOT NULL CHECK(service IN ('storefront', 'checkout', 'payments', 'fulfillment', 'search', 'database', 'queues', 'auth', 'cdn')),
  severity TEXT NOT NULL CHECK(severity IN ('low', 'medium', 'high', 'critical')),
  metric_value REAL NOT NULL,
  threshold_value REAL NOT NULL,
  observed_at TEXT NOT NULL CHECK(observed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', observed_at), '')),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_aiops_signals_observed ON aiops_signals(observed_at DESC);

CREATE TRIGGER aiops_signals_no_update BEFORE UPDATE ON aiops_signals
BEGIN SELECT RAISE(ABORT, 'aiops_signal_immutable'); END;
CREATE TRIGGER aiops_signals_no_delete BEFORE DELETE ON aiops_signals
BEGIN SELECT RAISE(ABORT, 'aiops_signal_immutable'); END;

CREATE TABLE aiops_recommendations (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  correlation_key TEXT NOT NULL UNIQUE CHECK(length(correlation_key) = 64),
  signal_ids_json TEXT NOT NULL CHECK(json_valid(signal_ids_json)),
  services_json TEXT NOT NULL CHECK(json_valid(services_json)),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 500),
  runbook_id TEXT NOT NULL CHECK(length(runbook_id) BETWEEN 1 AND 64),
  runbook_steps_json TEXT NOT NULL CHECK(json_valid(runbook_steps_json)),
  destructive INTEGER NOT NULL CHECK(destructive IN (0, 1)),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  status TEXT NOT NULL CHECK(status IN ('proposed', 'approved', 'rejected')),
  decision_reason TEXT CHECK(decision_reason IS NULL OR length(decision_reason) BETWEEN 10 AND 500),
  decided_by TEXT REFERENCES identities(id),
  decided_at TEXT CHECK(decided_at IS NULL OR decided_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', decided_at), '')),
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending', 'true_positive', 'false_positive')),
  outcome_by TEXT REFERENCES identities(id),
  outcome_at TEXT CHECK(outcome_at IS NULL OR outcome_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', outcome_at), '')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  CHECK(status = 'proposed' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)),
  CHECK(outcome = 'pending' OR (outcome_by IS NOT NULL AND outcome_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_aiops_recommendations_created ON aiops_recommendations(created_at DESC);

-- ---------------------------------------------------------------------------
-- PER-022
-- ---------------------------------------------------------------------------

CREATE TABLE third_party_scripts (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  vendor TEXT NOT NULL CHECK(length(trim(vendor)) BETWEEN 2 AND 80),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 80),
  kind TEXT NOT NULL CHECK(kind IN ('pixel', 'widget', 'analytics', 'chat', 'ab_testing', 'other')),
  monthly_cost_cents INTEGER NOT NULL CHECK(monthly_cost_cents >= 0),
  load_ms_p75 INTEGER NOT NULL CHECK(load_ms_p75 >= 0),
  status TEXT NOT NULL CHECK(status IN ('active', 'removed')),
  removal_reason TEXT CHECK(removal_reason IS NULL OR length(removal_reason) BETWEEN 10 AND 500),
  removed_by TEXT REFERENCES identities(id),
  removed_at TEXT CHECK(removed_at IS NULL OR removed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', removed_at), '')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  UNIQUE (vendor, name),
  CHECK(status = 'active' OR (removal_reason IS NOT NULL AND removed_by IS NOT NULL AND removed_at IS NOT NULL))
) STRICT;

CREATE TABLE third_party_experiments (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  script_id TEXT NOT NULL REFERENCES third_party_scripts(id),
  period_days INTEGER NOT NULL CHECK(period_days BETWEEN 1 AND 90),
  margin_bps INTEGER NOT NULL CHECK(margin_bps BETWEEN 0 AND 10000),
  control_visitors INTEGER NOT NULL CHECK(control_visitors >= 0),
  control_conversions INTEGER NOT NULL CHECK(control_conversions >= 0 AND control_conversions <= control_visitors),
  control_revenue_cents INTEGER NOT NULL CHECK(control_revenue_cents >= 0),
  control_lcp_ms_p75 INTEGER NOT NULL CHECK(control_lcp_ms_p75 >= 0),
  treatment_visitors INTEGER NOT NULL CHECK(treatment_visitors >= 0),
  treatment_conversions INTEGER NOT NULL CHECK(treatment_conversions >= 0 AND treatment_conversions <= treatment_visitors),
  treatment_revenue_cents INTEGER NOT NULL CHECK(treatment_revenue_cents >= 0),
  treatment_lcp_ms_p75 INTEGER NOT NULL CHECK(treatment_lcp_ms_p75 >= 0),
  verdict TEXT NOT NULL CHECK(verdict IN ('keep', 'remove', 'inconclusive')),
  evaluation_json TEXT NOT NULL CHECK(json_valid(evaluation_json)),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_third_party_experiments_script ON third_party_experiments(script_id, created_at DESC);

CREATE TRIGGER third_party_experiments_no_update BEFORE UPDATE ON third_party_experiments
BEGIN SELECT RAISE(ABORT, 'third_party_experiment_immutable'); END;
CREATE TRIGGER third_party_experiments_no_delete BEFORE DELETE ON third_party_experiments
BEGIN SELECT RAISE(ABORT, 'third_party_experiment_immutable'); END;

-- ---------------------------------------------------------------------------
-- PER-023 (aggregate counters only; never stores company ids or cache keys)
-- ---------------------------------------------------------------------------

CREATE TABLE b2b_catalog_cache_stats (
  day TEXT NOT NULL CHECK(day = COALESCE(strftime('%Y-%m-%d', day), '')),
  scope TEXT NOT NULL CHECK(scope IN ('public', 'b2b')),
  hits INTEGER NOT NULL DEFAULT 0 CHECK(hits >= 0),
  misses INTEGER NOT NULL DEFAULT 0 CHECK(misses >= 0),
  isolation_rejections INTEGER NOT NULL DEFAULT 0 CHECK(isolation_rejections >= 0),
  PRIMARY KEY (day, scope)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- PER-025
-- ---------------------------------------------------------------------------

CREATE TABLE edge_personalization_rules (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  slot TEXT NOT NULL CHECK(slot GLOB '[a-z][a-z0-9_]*' AND length(slot) BETWEEN 2 AND 40),
  segment TEXT NOT NULL CHECK(segment IN ('b2c_new', 'b2c_returning', 'b2b')),
  variant_key TEXT NOT NULL CHECK(variant_key GLOB '[a-z][a-z0-9_]*' AND length(variant_key) BETWEEN 2 AND 40),
  status TEXT NOT NULL CHECK(status IN ('draft', 'enabled', 'disabled')),
  evidence_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  UNIQUE (slot, segment),
  CHECK(status <> 'enabled' OR evidence_id IS NOT NULL)
) STRICT;

CREATE TABLE edge_personalization_evidence (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  rule_id TEXT NOT NULL REFERENCES edge_personalization_rules(id),
  control_visitors INTEGER NOT NULL CHECK(control_visitors >= 0),
  control_conversions INTEGER NOT NULL CHECK(control_conversions >= 0 AND control_conversions <= control_visitors),
  treatment_visitors INTEGER NOT NULL CHECK(treatment_visitors >= 0),
  treatment_conversions INTEGER NOT NULL CHECK(treatment_conversions >= 0 AND treatment_conversions <= treatment_visitors),
  lcp_delta_ms INTEGER NOT NULL,
  cache_hit_rate_bps INTEGER NOT NULL CHECK(cache_hit_rate_bps BETWEEN 0 AND 10000),
  baseline_cache_hit_rate_bps INTEGER NOT NULL CHECK(baseline_cache_hit_rate_bps BETWEEN 0 AND 10000),
  recorded_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_edge_evidence_rule ON edge_personalization_evidence(rule_id, created_at DESC);

CREATE TRIGGER edge_personalization_evidence_no_update BEFORE UPDATE ON edge_personalization_evidence
BEGIN SELECT RAISE(ABORT, 'edge_personalization_evidence_immutable'); END;
CREATE TRIGGER edge_personalization_evidence_no_delete BEFORE DELETE ON edge_personalization_evidence
BEGIN SELECT RAISE(ABORT, 'edge_personalization_evidence_immutable'); END;
