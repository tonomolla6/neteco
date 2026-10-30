-- Migration 0127: MKT-037 (Personalización predictiva), MKT-038 (Optimización automática de campañas con guardrails),
--                 DAT-023 (Modelos de propensión y recomendación evaluados), TST-044 (Evaluación continua de IA y modelos)

-- 1. Personalización predictiva y preferencias de control del usuario (MKT-037)
CREATE TABLE personalization_preferences (
  customer_id TEXT PRIMARY KEY CHECK(length(customer_id) <= 64),
  opt_in INTEGER NOT NULL DEFAULT 1 CHECK(opt_in IN (0, 1)),
  allow_predictive_recommendations INTEGER NOT NULL DEFAULT 1 CHECK(allow_predictive_recommendations IN (0, 1)),
  allow_order_timing_predictions INTEGER NOT NULL DEFAULT 1 CHECK(allow_order_timing_predictions IN (0, 1)),
  excluded_categories_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(excluded_categories_json)),
  history_purged_at TEXT CHECK(history_purged_at IS NULL OR (length(history_purged_at) = 20 AND history_purged_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', history_purged_at), ''))),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

-- 2. Telemetría de incrementalidad A/B (MKT-037)
CREATE TABLE personalization_incremental_events (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  customer_id TEXT NOT NULL CHECK(length(customer_id) <= 64),
  session_id TEXT NOT NULL CHECK(length(session_id) <= 64),
  variant TEXT NOT NULL CHECK(variant IN ('test', 'holdout')),
  event_type TEXT NOT NULL CHECK(event_type IN ('impression', 'click', 'conversion')),
  product_id TEXT CHECK(product_id IS NULL OR length(product_id) <= 64),
  margin_cents INTEGER NOT NULL DEFAULT 0 CHECK(margin_cents >= -1000000),
  revenue_cents INTEGER NOT NULL DEFAULT 0 CHECK(revenue_cents >= 0),
  context_surface TEXT NOT NULL CHECK(context_surface IN ('home', 'cart', 'reorder_widget', 'catalog', 'email')),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_personalization_incremental_variant ON personalization_incremental_events(variant, event_type, created_at);
CREATE INDEX idx_personalization_incremental_customer ON personalization_incremental_events(customer_id, created_at);

-- 3. Reglas de optimización automática con guardrails (MKT-038)
CREATE TABLE campaign_optimization_rules (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  campaign_id TEXT NOT NULL CHECK(length(campaign_id) <= 64),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 3 AND 200),
  max_discount_percent INTEGER NOT NULL DEFAULT 20 CHECK(max_discount_percent BETWEEN 1 AND 50),
  frequency_cap_days INTEGER NOT NULL DEFAULT 7 CHECK(frequency_cap_days BETWEEN 1 AND 90),
  budget_cap_cents INTEGER NOT NULL CHECK(budget_cap_cents >= 1000),
  current_spend_cents INTEGER NOT NULL DEFAULT 0 CHECK(current_spend_cents >= 0),
  auto_approval_max_discount INTEGER NOT NULL DEFAULT 10 CHECK(auto_approval_max_discount BETWEEN 1 AND 50),
  kill_switch_active INTEGER NOT NULL DEFAULT 0 CHECK(kill_switch_active IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'killed', 'archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_campaign_opt_rules_campaign ON campaign_optimization_rules(campaign_id, status);

-- 4. Registro inmutable de decisiones de optimización y auditoría (MKT-038)
CREATE TABLE campaign_optimization_decisions (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  rule_id TEXT NOT NULL REFERENCES campaign_optimization_rules(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL CHECK(length(campaign_id) <= 64),
  decision_type TEXT NOT NULL CHECK(decision_type IN ('discount_tune', 'budget_reallocate', 'frequency_throttle', 'emergency_kill')),
  previous_params_json TEXT NOT NULL CHECK(json_valid(previous_params_json)),
  proposed_params_json TEXT NOT NULL CHECK(json_valid(proposed_params_json)),
  applied_params_json TEXT CHECK(applied_params_json IS NULL OR json_valid(applied_params_json)),
  guardrail_evaluation_json TEXT NOT NULL CHECK(json_valid(guardrail_evaluation_json)),
  approval_status TEXT NOT NULL CHECK(approval_status IN ('auto_applied', 'pending_approval', 'approved', 'rejected', 'killed')),
  reviewed_by TEXT CHECK(reviewed_by IS NULL OR length(reviewed_by) <= 64),
  review_notes TEXT CHECK(review_notes IS NULL OR length(review_notes) <= 1000),
  hash TEXT NOT NULL CHECK(length(hash) = 64),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_campaign_opt_decisions_campaign ON campaign_optimization_decisions(campaign_id, approval_status, created_at);
CREATE INDEX idx_campaign_opt_decisions_rule ON campaign_optimization_decisions(rule_id, created_at);

-- 5. Registro de modelos ML de propensión y recomendación (DAT-023)
CREATE TABLE ml_model_registry (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  model_name TEXT NOT NULL CHECK(length(model_name) BETWEEN 3 AND 100),
  model_version TEXT NOT NULL CHECK(length(model_version) BETWEEN 1 AND 50),
  model_type TEXT NOT NULL CHECK(model_type IN ('repurchase_propensity', 'margin_recommendation', 'catalog_copilot_assistant', 'churn_propensity')),
  status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate', 'gate_passed', 'active', 'deprecated', 'rejected')),
  objective TEXT NOT NULL CHECK(objective IN ('margin_retention', 'conversion_margin', 'factuality_safety')),
  weights_json TEXT NOT NULL DEFAULT '{"margin":0.5,"retention":0.3,"clicks":0.2}' CHECK(json_valid(weights_json)),
  fallback_strategy TEXT NOT NULL CHECK(fallback_strategy IN ('static_bestsellers', 'category_margin_top', 'rules_safety_default')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  UNIQUE(model_name, model_version)
) STRICT;

-- 6. Evaluaciones offline y online de modelos (DAT-023)
CREATE TABLE ml_model_evaluations (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  model_id TEXT NOT NULL REFERENCES ml_model_registry(id) ON DELETE CASCADE,
  eval_type TEXT NOT NULL CHECK(eval_type IN ('offline', 'online')),
  metrics_json TEXT NOT NULL CHECK(json_valid(metrics_json)),
  drift_psi REAL NOT NULL DEFAULT 0.0 CHECK(drift_psi >= 0.0),
  bias_disparate_impact REAL NOT NULL DEFAULT 1.0 CHECK(bias_disparate_impact >= 0.0),
  margin_lift_percent REAL NOT NULL DEFAULT 0.0,
  retention_lift_percent REAL NOT NULL DEFAULT 0.0,
  status TEXT NOT NULL CHECK(status IN ('healthy', 'drift_detected', 'bias_detected', 'degraded')),
  sample_size INTEGER NOT NULL CHECK(sample_size >= 0),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_ml_model_evaluations_model ON ml_model_evaluations(model_id, eval_type, created_at);

-- 7. Golden Set canónico para evaluación continua de IA (TST-044)
CREATE TABLE ai_evaluation_golden_set (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  suite_name TEXT NOT NULL CHECK(length(suite_name) BETWEEN 3 AND 100),
  test_case_id TEXT NOT NULL CHECK(length(test_case_id) BETWEEN 3 AND 100),
  category TEXT NOT NULL CHECK(category IN ('chemical_safety', 'factuality_dosages', 'bias_parity', 'performance_latency', 'fallback_recovery')),
  input_payload_json TEXT NOT NULL CHECK(json_valid(input_payload_json)),
  expected_constraints_json TEXT NOT NULL CHECK(json_valid(expected_constraints_json)),
  severity TEXT NOT NULL CHECK(severity IN ('critical', 'high', 'medium')),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(suite_name, test_case_id)
) STRICT;

-- 8. Ejecuciones de evaluación de IA y gates de paso (TST-044)
CREATE TABLE ai_evaluation_runs (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  model_id TEXT NOT NULL REFERENCES ml_model_registry(id) ON DELETE CASCADE,
  suite_name TEXT NOT NULL CHECK(length(suite_name) BETWEEN 3 AND 100),
  factuality_score REAL NOT NULL CHECK(factuality_score BETWEEN 0.0 AND 1.0),
  safety_score REAL NOT NULL CHECK(safety_score BETWEEN 0.0 AND 1.0),
  safety_violations_count INTEGER NOT NULL CHECK(safety_violations_count >= 0),
  bias_disparate_impact REAL NOT NULL CHECK(bias_disparate_impact >= 0.0),
  drift_psi REAL NOT NULL CHECK(drift_psi >= 0.0),
  latency_p50_ms REAL NOT NULL CHECK(latency_p50_ms >= 0.0),
  latency_p95_ms REAL NOT NULL CHECK(latency_p95_ms >= 0.0),
  cost_estimate_eur REAL NOT NULL CHECK(cost_estimate_eur >= 0.0),
  fallback_tested INTEGER NOT NULL CHECK(fallback_tested IN (0, 1)),
  fallback_passed INTEGER NOT NULL CHECK(fallback_passed IN (0, 1)),
  gate_verdict TEXT NOT NULL CHECK(gate_verdict IN ('passed', 'rejected')),
  gate_reasons_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(gate_reasons_json)),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_ai_eval_runs_model ON ai_evaluation_runs(model_id, gate_verdict, created_at);
