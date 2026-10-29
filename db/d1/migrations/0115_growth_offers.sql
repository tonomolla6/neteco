-- PRI-015 + PRI-022 + MKT-029: buy-X-get-Y/gift offers, holdout-based promotion
-- experiments (incremental margin) and professional lead magnets.
-- Append-only command journals, CAS versions, strict idempotency; no PII beyond the
-- minimal lead e-mail, which is redacted once the requested copy has been delivered.

-- ---------------------------------------------------------------- PRI-015
CREATE TABLE bxgy_rules (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  code TEXT NOT NULL UNIQUE CHECK(length(code) BETWEEN 3 AND 40 AND code = upper(code) AND code NOT GLOB '*[^A-Z0-9_-]*'),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 3 AND 120),
  status TEXT NOT NULL CHECK(status IN ('draft', 'active', 'paused', 'archived')),
  version INTEGER NOT NULL CHECK(version >= 1),
  trigger_variant_id TEXT NOT NULL REFERENCES variants(id),
  buy_quantity INTEGER NOT NULL CHECK(buy_quantity BETWEEN 1 AND 999),
  gift_variant_id TEXT NOT NULL REFERENCES variants(id),
  gift_quantity INTEGER NOT NULL CHECK(gift_quantity BETWEEN 1 AND 99),
  max_applications_per_order INTEGER NOT NULL CHECK(max_applications_per_order BETWEEN 1 AND 50),
  total_limit INTEGER CHECK(total_limit IS NULL OR total_limit >= 1),
  per_customer_limit INTEGER CHECK(per_customer_limit IS NULL OR per_customer_limit >= 1),
  margin_floor_basis_points INTEGER NOT NULL CHECK(margin_floor_basis_points BETWEEN 0 AND 9000),
  starts_at TEXT NOT NULL CHECK(starts_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', starts_at), '')),
  ends_at TEXT CHECK(ends_at IS NULL OR (ends_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', ends_at), '') AND ends_at > starts_at)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  updated_by TEXT NOT NULL REFERENCES identities(id)
) STRICT;

CREATE TRIGGER bxgy_rules_update_guard BEFORE UPDATE ON bxgy_rules
WHEN NEW.id IS NOT OLD.id OR NEW.code IS NOT OLD.code OR NEW.created_at IS NOT OLD.created_at
  OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'bxgy_rule_version_conflict'); END;
CREATE TRIGGER bxgy_rules_no_delete BEFORE DELETE ON bxgy_rules
BEGIN SELECT RAISE(ABORT, 'bxgy_rule_immutable'); END;

CREATE TABLE bxgy_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36 AND replace(command_id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  rule_id TEXT NOT NULL REFERENCES bxgy_rules(id),
  action TEXT NOT NULL CHECK(action IN ('create', 'update', 'set_status')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  applied_version INTEGER NOT NULL CHECK(applied_version >= 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (actor_id, idempotency_key),
  CHECK(applied_version = expected_version + 1)
) STRICT;
-- Compare-and-set inside the batch transaction: a stale writer aborts the whole batch.
CREATE TRIGGER bxgy_commands_cas BEFORE INSERT ON bxgy_commands
WHEN NEW.action <> 'create' AND COALESCE((SELECT version FROM bxgy_rules WHERE id = NEW.rule_id), -1) <> NEW.expected_version
BEGIN SELECT RAISE(ABORT, 'bxgy_version_conflict'); END;
CREATE TRIGGER bxgy_commands_no_update BEFORE UPDATE ON bxgy_commands
BEGIN SELECT RAISE(ABORT, 'bxgy_command_immutable'); END;
CREATE TRIGGER bxgy_commands_no_delete BEFORE DELETE ON bxgy_commands
BEGIN SELECT RAISE(ABORT, 'bxgy_command_immutable'); END;

-- One redemption per order. snapshot_json is the exact priced/taxed allocation used
-- at sale time, so returns never re-price from today's catalog.
CREATE TABLE bxgy_redemptions (
  order_ref TEXT PRIMARY KEY CHECK(length(order_ref) BETWEEN 8 AND 128),
  rule_id TEXT NOT NULL REFERENCES bxgy_rules(id),
  rule_version INTEGER NOT NULL CHECK(rule_version >= 1),
  customer_id TEXT REFERENCES customers(id),
  applications INTEGER NOT NULL CHECK(applications >= 1),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND length(snapshot_json) <= 65536),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE INDEX bxgy_redemptions_rule_customer ON bxgy_redemptions(rule_id, customer_id);
CREATE TRIGGER bxgy_redemptions_no_update BEFORE UPDATE ON bxgy_redemptions
BEGIN SELECT RAISE(ABORT, 'bxgy_redemption_immutable'); END;
CREATE TRIGGER bxgy_redemptions_no_delete BEFORE DELETE ON bxgy_redemptions
BEGIN SELECT RAISE(ABORT, 'bxgy_redemption_immutable'); END;

CREATE TABLE bxgy_returns (
  return_ref TEXT PRIMARY KEY CHECK(length(return_ref) BETWEEN 8 AND 128),
  order_ref TEXT NOT NULL REFERENCES bxgy_redemptions(order_ref),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  returned_json TEXT NOT NULL CHECK(json_valid(returned_json)),
  refund_gross_cents INTEGER NOT NULL CHECK(refund_gross_cents >= 0),
  clawback_gross_cents INTEGER NOT NULL CHECK(clawback_gross_cents >= 0),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE TRIGGER bxgy_returns_no_update BEFORE UPDATE ON bxgy_returns
BEGIN SELECT RAISE(ABORT, 'bxgy_return_immutable'); END;
CREATE TRIGGER bxgy_returns_no_delete BEFORE DELETE ON bxgy_returns
BEGIN SELECT RAISE(ABORT, 'bxgy_return_immutable'); END;

-- ---------------------------------------------------------------- PRI-022
CREATE TABLE promo_experiments (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  code TEXT NOT NULL UNIQUE CHECK(length(code) BETWEEN 3 AND 40 AND code = upper(code) AND code NOT GLOB '*[^A-Z0-9_-]*'),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 3 AND 120),
  promotion_code TEXT NOT NULL CHECK(length(promotion_code) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK(status IN ('draft', 'running', 'stopped', 'concluded')),
  version INTEGER NOT NULL CHECK(version >= 1),
  -- A real holdout is mandatory: at least 5 % and at most 50 % of subjects get no offer.
  holdout_basis_points INTEGER NOT NULL CHECK(holdout_basis_points BETWEEN 500 AND 5000),
  min_sample_per_arm INTEGER NOT NULL CHECK(min_sample_per_arm BETWEEN 30 AND 1000000),
  min_incremental_margin_cents INTEGER NOT NULL CHECK(min_incremental_margin_cents >= 0),
  conclusion TEXT CHECK(conclusion IS NULL OR conclusion IN ('rollout', 'no_rollout', 'inconclusive')),
  concluded_at TEXT CHECK(concluded_at IS NULL OR concluded_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', concluded_at), '')),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  updated_by TEXT NOT NULL REFERENCES identities(id),
  CHECK((status = 'concluded') = (conclusion IS NOT NULL AND concluded_at IS NOT NULL))
) STRICT;
CREATE TRIGGER promo_experiments_update_guard BEFORE UPDATE ON promo_experiments
WHEN NEW.id IS NOT OLD.id OR NEW.code IS NOT OLD.code OR NEW.created_at IS NOT OLD.created_at
  OR NEW.holdout_basis_points IS NOT OLD.holdout_basis_points
  OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
  OR OLD.status = 'concluded'
BEGIN SELECT RAISE(ABORT, 'promo_experiment_version_conflict'); END;
CREATE TRIGGER promo_experiments_no_delete BEFORE DELETE ON promo_experiments
BEGIN SELECT RAISE(ABORT, 'promo_experiment_immutable'); END;

CREATE TABLE promo_experiment_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36 AND replace(command_id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  experiment_id TEXT NOT NULL REFERENCES promo_experiments(id),
  action TEXT NOT NULL CHECK(action IN ('create', 'start', 'stop', 'conclude')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  applied_version INTEGER NOT NULL CHECK(applied_version >= 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (actor_id, idempotency_key),
  CHECK(applied_version = expected_version + 1)
) STRICT;
-- Compare-and-set inside the batch transaction: a stale writer aborts the whole batch.
CREATE TRIGGER promo_experiment_commands_cas BEFORE INSERT ON promo_experiment_commands
WHEN NEW.action <> 'create' AND COALESCE((SELECT version FROM promo_experiments WHERE id = NEW.experiment_id), -1) <> NEW.expected_version
BEGIN SELECT RAISE(ABORT, 'promo_experiment_version_conflict'); END;
CREATE TRIGGER promo_experiment_commands_no_update BEFORE UPDATE ON promo_experiment_commands
BEGIN SELECT RAISE(ABORT, 'promo_experiment_command_immutable'); END;
CREATE TRIGGER promo_experiment_commands_no_delete BEFORE DELETE ON promo_experiment_commands
BEGIN SELECT RAISE(ABORT, 'promo_experiment_command_immutable'); END;

-- subject_hash is a SHA-256 of experiment + opaque subject key: never an e-mail or name.
CREATE TABLE promo_experiment_assignments (
  experiment_id TEXT NOT NULL REFERENCES promo_experiments(id),
  subject_hash TEXT NOT NULL CHECK(length(subject_hash) = 64 AND subject_hash NOT GLOB '*[^0-9a-f]*'),
  arm TEXT NOT NULL CHECK(arm IN ('holdout', 'treatment')),
  assigned_at TEXT NOT NULL CHECK(assigned_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', assigned_at), '')),
  PRIMARY KEY (experiment_id, subject_hash)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER promo_experiment_assignments_no_update BEFORE UPDATE ON promo_experiment_assignments
BEGIN SELECT RAISE(ABORT, 'promo_experiment_assignment_immutable'); END;
CREATE TRIGGER promo_experiment_assignments_no_delete BEFORE DELETE ON promo_experiment_assignments
BEGIN SELECT RAISE(ABORT, 'promo_experiment_assignment_immutable'); END;
CREATE TRIGGER promo_experiment_assignments_running_only BEFORE INSERT ON promo_experiment_assignments
WHEN COALESCE((SELECT status FROM promo_experiments WHERE id = NEW.experiment_id), '') <> 'running'
BEGIN SELECT RAISE(ABORT, 'promo_experiment_not_running'); END;

-- Observations carry the contribution margin. revenue_gross_cents is informational only
-- and is never read by the decision rule.
CREATE TABLE promo_experiment_observations (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  experiment_id TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  order_ref TEXT NOT NULL CHECK(length(order_ref) BETWEEN 8 AND 128),
  revenue_gross_cents INTEGER NOT NULL CHECK(revenue_gross_cents >= 0),
  net_revenue_cents INTEGER NOT NULL CHECK(net_revenue_cents >= 0),
  cogs_cents INTEGER NOT NULL CHECK(cogs_cents >= 0),
  variable_cost_cents INTEGER NOT NULL CHECK(variable_cost_cents >= 0),
  margin_cents INTEGER NOT NULL CHECK(margin_cents = net_revenue_cents - cogs_cents - variable_cost_cents),
  recorded_at TEXT NOT NULL CHECK(recorded_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', recorded_at), '')),
  UNIQUE (experiment_id, order_ref),
  FOREIGN KEY (experiment_id, subject_hash) REFERENCES promo_experiment_assignments(experiment_id, subject_hash)
) STRICT;
CREATE INDEX promo_experiment_observations_subject ON promo_experiment_observations(experiment_id, subject_hash);
CREATE TRIGGER promo_experiment_observations_open_only BEFORE INSERT ON promo_experiment_observations
WHEN COALESCE((SELECT status FROM promo_experiments WHERE id = NEW.experiment_id), '') NOT IN ('running', 'stopped')
BEGIN SELECT RAISE(ABORT, 'promo_experiment_not_running'); END;
CREATE TRIGGER promo_experiment_observations_no_update BEFORE UPDATE ON promo_experiment_observations
BEGIN SELECT RAISE(ABORT, 'promo_experiment_observation_immutable'); END;
CREATE TRIGGER promo_experiment_observations_no_delete BEFORE DELETE ON promo_experiment_observations
BEGIN SELECT RAISE(ABORT, 'promo_experiment_observation_immutable'); END;

-- ---------------------------------------------------------------- MKT-029
-- Requested copies. The e-mail is needed only until the copy is sent; then it is
-- nulled (email_hash remains for de-duplication/suppression).
CREATE TABLE lead_magnet_requests (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  magnet_slug TEXT NOT NULL CHECK(length(magnet_slug) BETWEEN 3 AND 80 AND magnet_slug NOT GLOB '*[^a-z0-9-]*'),
  email TEXT CHECK(email IS NULL OR length(email) BETWEEN 6 AND 254),
  email_hash TEXT NOT NULL CHECK(length(email_hash) = 64 AND email_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK(status IN ('queued', 'sent', 'failed')),
  attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 3),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  sent_at TEXT CHECK(sent_at IS NULL OR sent_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', sent_at), '')),
  UNIQUE (magnet_slug, email_hash),
  CHECK((status = 'queued') = (email IS NOT NULL)),
  CHECK((status = 'sent') = (sent_at IS NOT NULL))
) STRICT;
CREATE INDEX lead_magnet_requests_queue ON lead_magnet_requests(status, created_at);
CREATE TRIGGER lead_magnet_requests_no_delete BEFORE DELETE ON lead_magnet_requests
BEGIN SELECT RAISE(ABORT, 'lead_magnet_request_immutable'); END;
CREATE TRIGGER lead_magnet_requests_update_guard BEFORE UPDATE ON lead_magnet_requests
WHEN NEW.id IS NOT OLD.id OR NEW.magnet_slug IS NOT OLD.magnet_slug OR NEW.email_hash IS NOT OLD.email_hash
  OR NEW.created_at IS NOT OLD.created_at OR OLD.status = 'sent' OR NEW.attempts < OLD.attempts
BEGIN SELECT RAISE(ABORT, 'lead_magnet_request_immutable'); END;

-- Marketing consent is a separate, optional, append-only evidence record. Delivery of
-- the requested copy never depends on it.
CREATE TABLE lead_magnet_consents (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  request_id TEXT NOT NULL REFERENCES lead_magnet_requests(id),
  email_hash TEXT NOT NULL CHECK(length(email_hash) = 64 AND email_hash NOT GLOB '*[^0-9a-f]*'),
  purpose TEXT NOT NULL CHECK(purpose = 'marketing_newsletter'),
  text_version TEXT NOT NULL CHECK(length(text_version) BETWEEN 3 AND 40),
  status TEXT NOT NULL CHECK(status = 'pending_confirmation'),
  given_at TEXT NOT NULL CHECK(given_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', given_at), '')),
  UNIQUE (request_id)
) STRICT;
CREATE TRIGGER lead_magnet_consents_no_update BEFORE UPDATE ON lead_magnet_consents
BEGIN SELECT RAISE(ABORT, 'lead_magnet_consent_immutable'); END;
CREATE TRIGGER lead_magnet_consents_no_delete BEFORE DELETE ON lead_magnet_consents
BEGIN SELECT RAISE(ABORT, 'lead_magnet_consent_immutable'); END;

CREATE TABLE lead_magnet_request_limits (
  subject_hash TEXT PRIMARY KEY CHECK(length(subject_hash) = 64 AND subject_hash NOT GLOB '*[^0-9a-f]*'),
  used INTEGER NOT NULL CHECK(used >= 1),
  expires_at INTEGER NOT NULL CHECK(expires_at > 0)
) STRICT;
