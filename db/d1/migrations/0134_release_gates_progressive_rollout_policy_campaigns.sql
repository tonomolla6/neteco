-- Migration 0134: CIC-028 Alpha-to-Beta checklist promotion gate,
--                 CIC-029 Progressive rollout by traffic/client/zone with guardrails & rollback,
--                 CIC-030 Cloudflare Policy-as-Code & drift gate,
--                 CIC-031 Independent & secure campaign content pipeline with perf/a11y checks.

-- ---------------------------------------------------------------------------
-- 1. CIC-028: Promoción Alpha->Beta por checklist firmado y evidencia adjunta
-- ---------------------------------------------------------------------------

CREATE TABLE alpha_beta_promotions (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  release_version TEXT NOT NULL CHECK(length(trim(release_version)) BETWEEN 1 AND 64),
  target_phase TEXT NOT NULL DEFAULT 'Beta' CHECK(target_phase = 'Beta'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'in_review', 'approved', 'promoted', 'rejected')),
  checklist_summary_json TEXT NOT NULL CHECK(json_valid(checklist_summary_json)),
  p0_defects_count INTEGER NOT NULL DEFAULT 0 CHECK(p0_defects_count >= 0),
  p1_defects_count INTEGER NOT NULL DEFAULT 0 CHECK(p1_defects_count >= 0),
  evidence_bundle_json TEXT NOT NULL CHECK(json_valid(evidence_bundle_json)),
  evidence_hash TEXT NOT NULL CHECK(length(evidence_hash) = 64),
  promoted_at TEXT CHECK(promoted_at IS NULL OR (length(promoted_at) = 20 AND promoted_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', promoted_at), ''))),
  rejection_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  created_by TEXT NOT NULL REFERENCES identities(id)
) STRICT;

CREATE INDEX idx_alpha_beta_promotions_status ON alpha_beta_promotions(status, release_version);

CREATE TABLE alpha_beta_promotion_signoffs (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  promotion_id TEXT NOT NULL REFERENCES alpha_beta_promotions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('business', 'legal', 'release_manager')),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  signature_hash TEXT NOT NULL CHECK(length(signature_hash) = 64),
  statement TEXT NOT NULL CHECK(length(trim(statement)) BETWEEN 5 AND 1000),
  signed_at TEXT NOT NULL CHECK(signed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', signed_at), '')),
  UNIQUE(promotion_id, role)
) STRICT;

CREATE INDEX idx_promotion_signoffs_promo ON alpha_beta_promotion_signoffs(promotion_id, role);

CREATE TABLE alpha_beta_promotion_commands (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  command_id TEXT NOT NULL UNIQUE CHECK(length(command_id) BETWEEN 6 AND 128),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create_promotion', 'update_checklist', 'submit_signoff', 'promote_release', 'reject_promotion')),
  promotion_id TEXT NOT NULL REFERENCES alpha_beta_promotions(id),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE TRIGGER alpha_beta_promotion_commands_no_update BEFORE UPDATE ON alpha_beta_promotion_commands
BEGIN SELECT RAISE(ABORT, 'alpha_beta_promotion_commands_immutable'); END;

CREATE TRIGGER alpha_beta_promotion_commands_no_delete BEFORE DELETE ON alpha_beta_promotion_commands
BEGIN SELECT RAISE(ABORT, 'alpha_beta_promotion_commands_immutable'); END;

-- ---------------------------------------------------------------------------
-- 2. CIC-029: Despliegue progresivo por tráfico/cliente/zona y guardrails
-- ---------------------------------------------------------------------------

CREATE TABLE progressive_rollouts (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  feature_key TEXT NOT NULL CHECK(length(trim(feature_key)) BETWEEN 2 AND 64),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 3 AND 120),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'paused', 'tripped', 'rolled_back', 'promoted_full')),
  traffic_percentage INTEGER NOT NULL DEFAULT 0 CHECK(traffic_percentage BETWEEN 0 AND 100),
  cohorts_json TEXT NOT NULL CHECK(json_valid(cohorts_json)),
  zones_json TEXT NOT NULL CHECK(json_valid(zones_json)),
  guardrails_json TEXT NOT NULL CHECK(json_valid(guardrails_json)),
  beta_scope_notice_json TEXT NOT NULL CHECK(json_valid(beta_scope_notice_json)),
  trip_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  created_by TEXT NOT NULL REFERENCES identities(id)
) STRICT;

CREATE INDEX idx_progressive_rollouts_feature ON progressive_rollouts(feature_key, status);

CREATE TABLE rollout_guardrail_evaluations (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  rollout_id TEXT NOT NULL REFERENCES progressive_rollouts(id) ON DELETE CASCADE,
  window_start TEXT NOT NULL CHECK(length(window_start) = 20 AND window_start = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', window_start), '')),
  window_end TEXT NOT NULL CHECK(length(window_end) = 20 AND window_end = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', window_end), '') AND window_end >= window_start),
  sample_count INTEGER NOT NULL CHECK(sample_count >= 0),
  error_count INTEGER NOT NULL CHECK(error_count >= 0 AND error_count <= sample_count),
  error_rate_percent REAL NOT NULL CHECK(error_rate_percent >= 0.0 AND error_rate_percent <= 100.0),
  p95_latency_ms INTEGER NOT NULL CHECK(p95_latency_ms >= 0),
  breached INTEGER NOT NULL CHECK(breached IN (0, 1)),
  breach_details_json TEXT NOT NULL CHECK(json_valid(breach_details_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_rollout_guardrail_evals ON rollout_guardrail_evaluations(rollout_id, created_at DESC);

CREATE TABLE rollout_commands (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  command_id TEXT NOT NULL UNIQUE CHECK(length(command_id) BETWEEN 6 AND 128),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create_rollout', 'update_rollout', 'record_metrics', 'manual_rollback', 'promote_full')),
  rollout_id TEXT NOT NULL REFERENCES progressive_rollouts(id),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE TRIGGER rollout_commands_no_update BEFORE UPDATE ON rollout_commands
BEGIN SELECT RAISE(ABORT, 'rollout_commands_immutable'); END;

CREATE TRIGGER rollout_commands_no_delete BEFORE DELETE ON rollout_commands
BEGIN SELECT RAISE(ABORT, 'rollout_commands_immutable'); END;

-- ---------------------------------------------------------------------------
-- 3. CIC-030: Cloudflare Policy-as-Code y detección de drift crítico
-- ---------------------------------------------------------------------------

CREATE TABLE cloudflare_policy_audits (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  target_environment TEXT NOT NULL CHECK(target_environment IN ('preview', 'staging', 'production')),
  policy_version TEXT NOT NULL CHECK(length(trim(policy_version)) BETWEEN 1 AND 32),
  passed INTEGER NOT NULL CHECK(passed IN (0, 1)),
  blockers_count INTEGER NOT NULL CHECK(blockers_count >= 0),
  warnings_count INTEGER NOT NULL CHECK(warnings_count >= 0),
  rules_evaluated_count INTEGER NOT NULL CHECK(rules_evaluated_count > 0),
  violations_json TEXT NOT NULL CHECK(json_valid(violations_json)),
  manifest_hash TEXT NOT NULL CHECK(length(manifest_hash) = 64),
  has_critical_drift INTEGER NOT NULL DEFAULT 0 CHECK(has_critical_drift IN (0, 1)),
  drift_summary_json TEXT CHECK(drift_summary_json IS NULL OR json_valid(drift_summary_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  created_by TEXT NOT NULL REFERENCES identities(id)
) STRICT;

CREATE INDEX idx_cf_policy_audits_env ON cloudflare_policy_audits(target_environment, created_at DESC);

CREATE TABLE cloudflare_policy_commands (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  command_id TEXT NOT NULL UNIQUE CHECK(length(command_id) BETWEEN 6 AND 128),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('run_policy_audit', 'run_drift_audit', 'acknowledge_violations')),
  audit_id TEXT NOT NULL REFERENCES cloudflare_policy_audits(id),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE TRIGGER cloudflare_policy_commands_no_update BEFORE UPDATE ON cloudflare_policy_commands
BEGIN SELECT RAISE(ABORT, 'cloudflare_policy_commands_immutable'); END;

CREATE TRIGGER cloudflare_policy_commands_no_delete BEFORE DELETE ON cloudflare_policy_commands
BEGIN SELECT RAISE(ABORT, 'cloudflare_policy_commands_immutable'); END;

-- ---------------------------------------------------------------------------
-- 4. CIC-031: Pipeline de campañas/contenido independiente y seguro
-- ---------------------------------------------------------------------------

CREATE TABLE campaign_content_pipeline (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  campaign_slug TEXT NOT NULL UNIQUE CHECK(length(trim(campaign_slug)) BETWEEN 2 AND 100),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 2 AND 200),
  current_version INTEGER NOT NULL DEFAULT 1 CHECK(current_version >= 1),
  published_version INTEGER CHECK(published_version IS NULL OR published_version >= 1),
  previous_published_version INTEGER CHECK(previous_published_version IS NULL OR previous_published_version >= 1),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'qa_pending', 'qa_approved', 'scheduled', 'published', 'rolled_back')),
  publish_at TEXT CHECK(publish_at IS NULL OR (length(publish_at) = 20 AND publish_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', publish_at), ''))),
  unpublish_at TEXT CHECK(unpublish_at IS NULL OR (length(unpublish_at) = 20 AND unpublish_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', unpublish_at), '') AND (publish_at IS NULL OR unpublish_at >= publish_at))),
  document_json TEXT NOT NULL CHECK(json_valid(document_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  created_by TEXT NOT NULL REFERENCES identities(id)
) STRICT;

CREATE INDEX idx_campaign_content_pipeline_slug ON campaign_content_pipeline(campaign_slug, status);

CREATE TABLE campaign_pipeline_checks (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  pipeline_id TEXT NOT NULL REFERENCES campaign_content_pipeline(id) ON DELETE CASCADE,
  content_version INTEGER NOT NULL CHECK(content_version >= 1),
  check_type TEXT NOT NULL CHECK(check_type IN ('performance', 'accessibility', 'qa_review')),
  passed INTEGER NOT NULL CHECK(passed IN (0, 1)),
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
  violations_json TEXT NOT NULL CHECK(json_valid(violations_json)),
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  actor_id TEXT REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_campaign_pipeline_checks ON campaign_pipeline_checks(pipeline_id, content_version, check_type);

CREATE TABLE campaign_pipeline_commands (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  command_id TEXT NOT NULL UNIQUE CHECK(length(command_id) BETWEEN 6 AND 128),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('save_draft', 'run_checks', 'qa_signoff', 'schedule_publication', 'publish_now', 'rollback_published')),
  pipeline_id TEXT NOT NULL REFERENCES campaign_content_pipeline(id),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE TRIGGER campaign_pipeline_commands_no_update BEFORE UPDATE ON campaign_pipeline_commands
BEGIN SELECT RAISE(ABORT, 'campaign_pipeline_commands_immutable'); END;

CREATE TRIGGER campaign_pipeline_commands_no_delete BEFORE DELETE ON campaign_pipeline_commands
BEGIN SELECT RAISE(ABORT, 'campaign_pipeline_commands_immutable'); END;
