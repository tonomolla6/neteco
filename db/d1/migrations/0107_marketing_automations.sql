-- MKT-015 + MKT-018 + MKT-019: Automated marketing lifecycle series.
-- MKT-015: Welcome series (professional value, categories, local service, customer preferences, optional controlled discount).
-- MKT-018: Inactivity win-back (purchase cycle window, strict exclusions of open incidents, debt and unsubscriptions, margin guard).
-- MKT-019: Useful post-purchase (safety, chemical dilution protocols, estimated replenishment, strict separation of transactional vs commercial streams).
-- Append-only command journal, CAS versions, strict idempotency, and immutable delivery records.

CREATE TABLE marketing_automation_policies (
  id TEXT PRIMARY KEY CHECK(id = 'global'),
  version INTEGER NOT NULL CHECK(version >= 1),
  welcome_series_enabled INTEGER NOT NULL CHECK(welcome_series_enabled IN (0, 1)),
  welcome_discount_enabled INTEGER NOT NULL CHECK(welcome_discount_enabled IN (0, 1)),
  welcome_discount_percent INTEGER NOT NULL CHECK(welcome_discount_percent BETWEEN 1 AND 30),
  welcome_discount_max_cents INTEGER NOT NULL CHECK(welcome_discount_max_cents BETWEEN 100 AND 10000),
  welcome_min_order_cents INTEGER NOT NULL CHECK(welcome_min_order_cents BETWEEN 1000 AND 50000),
  welcome_margin_floor_basis_points INTEGER NOT NULL CHECK(welcome_margin_floor_basis_points BETWEEN 1000 AND 5000),
  winback_enabled INTEGER NOT NULL CHECK(winback_enabled IN (0, 1)),
  winback_inactivity_days INTEGER NOT NULL CHECK(winback_inactivity_days BETWEEN 14 AND 365),
  winback_cooldown_days INTEGER NOT NULL CHECK(winback_cooldown_days BETWEEN 14 AND 365),
  winback_discount_percent INTEGER NOT NULL CHECK(winback_discount_percent BETWEEN 1 AND 25),
  winback_discount_max_cents INTEGER NOT NULL CHECK(winback_discount_max_cents BETWEEN 100 AND 10000),
  winback_margin_floor_basis_points INTEGER NOT NULL CHECK(winback_margin_floor_basis_points BETWEEN 1000 AND 5000),
  postpurchase_enabled INTEGER NOT NULL CHECK(postpurchase_enabled IN (0, 1)),
  postpurchase_delay_hours INTEGER NOT NULL CHECK(postpurchase_delay_hours BETWEEN 0 AND 168),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  updated_by TEXT NOT NULL REFERENCES identities(id)
) STRICT;

CREATE TRIGGER marketing_automation_policies_no_delete BEFORE DELETE ON marketing_automation_policies
BEGIN SELECT RAISE(ABORT, 'marketing_automation_policy_immutable'); END;

CREATE TRIGGER marketing_automation_policies_update_guard BEFORE UPDATE ON marketing_automation_policies
WHEN NEW.id IS NOT OLD.id OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'marketing_automation_policy_version_conflict'); END;

CREATE TABLE marketing_automation_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36 AND replace(command_id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('update_policy', 'dispatch_welcome', 'save_preferences', 'evaluate_winback', 'dispatch_postpurchase')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  applied_version INTEGER NOT NULL CHECK(applied_version >= 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (actor_id, idempotency_key)
) STRICT;

CREATE TRIGGER marketing_automation_commands_no_update BEFORE UPDATE ON marketing_automation_commands
BEGIN SELECT RAISE(ABORT, 'marketing_automation_command_immutable'); END;

CREATE TRIGGER marketing_automation_commands_no_delete BEFORE DELETE ON marketing_automation_commands
BEGIN SELECT RAISE(ABORT, 'marketing_automation_command_immutable'); END;

CREATE TABLE marketing_welcome_dispatches (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  step TEXT NOT NULL CHECK(step IN ('professional_value', 'categories_overview', 'local_service', 'preferences_prompt', 'welcome_discount')),
  discount_code TEXT CHECK(discount_code IS NULL OR (length(discount_code) BETWEEN 3 AND 32 AND discount_code NOT GLOB '*[^A-Z0-9_-]*')),
  discount_cents_cap INTEGER CHECK(discount_cents_cap IS NULL OR discount_cents_cap > 0),
  min_order_cents INTEGER CHECK(min_order_cents IS NULL OR min_order_cents > 0),
  margin_floor_basis_points INTEGER CHECK(margin_floor_basis_points IS NULL OR margin_floor_basis_points BETWEEN 1000 AND 5000),
  status TEXT NOT NULL CHECK(status IN ('delivered', 'skipped', 'suppressed')),
  recipient_email_hash TEXT NOT NULL CHECK(length(recipient_email_hash) = 64 AND recipient_email_hash NOT GLOB '*[^0-9a-f]*'),
  dispatched_at TEXT NOT NULL CHECK(dispatched_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', dispatched_at), '')),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (customer_id, step)
) STRICT;

CREATE TRIGGER marketing_welcome_dispatches_no_update BEFORE UPDATE ON marketing_welcome_dispatches
BEGIN SELECT RAISE(ABORT, 'marketing_welcome_dispatch_immutable'); END;

CREATE TRIGGER marketing_welcome_dispatches_no_delete BEFORE DELETE ON marketing_welcome_dispatches
BEGIN SELECT RAISE(ABORT, 'marketing_welcome_dispatch_immutable'); END;

CREATE TABLE marketing_customer_preferences (
  customer_id TEXT PRIMARY KEY REFERENCES customers(id),
  preferred_categories TEXT NOT NULL CHECK(json_valid(preferred_categories) AND json_type(preferred_categories) = 'array'),
  frequency TEXT NOT NULL CHECK(frequency IN ('weekly', 'biweekly', 'monthly')),
  channel TEXT NOT NULL CHECK(channel IN ('email', 'sms', 'portal')),
  technical_content_opt_in INTEGER NOT NULL CHECK(technical_content_opt_in IN (0, 1)),
  version INTEGER NOT NULL CHECK(version >= 1),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;

CREATE TRIGGER marketing_customer_preferences_no_delete BEFORE DELETE ON marketing_customer_preferences
BEGIN SELECT RAISE(ABORT, 'marketing_customer_preferences_no_delete'); END;

CREATE TRIGGER marketing_customer_preferences_update_guard BEFORE UPDATE ON marketing_customer_preferences
WHEN NEW.customer_id IS NOT OLD.customer_id OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'marketing_customer_preferences_version_conflict'); END;

CREATE TABLE marketing_winback_evaluations (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  last_order_id TEXT REFERENCES orders(id),
  last_order_at TEXT CHECK(last_order_at IS NULL OR last_order_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', last_order_at), '')),
  days_inactive INTEGER NOT NULL CHECK(days_inactive >= 0),
  eligibility_status TEXT NOT NULL CHECK(eligibility_status IN ('eligible', 'excluded_incidents', 'excluded_debt', 'excluded_suppressed', 'excluded_cooldown', 'dispatched')),
  exclusion_reason TEXT CHECK(exclusion_reason IS NULL OR length(exclusion_reason) BETWEEN 1 AND 255),
  discount_code TEXT CHECK(discount_code IS NULL OR (length(discount_code) BETWEEN 3 AND 32 AND discount_code NOT GLOB '*[^A-Z0-9_-]*')),
  discount_percent INTEGER CHECK(discount_percent IS NULL OR discount_percent BETWEEN 1 AND 25),
  discount_max_cents INTEGER CHECK(discount_max_cents IS NULL OR discount_max_cents > 0),
  margin_floor_basis_points INTEGER CHECK(margin_floor_basis_points IS NULL OR margin_floor_basis_points BETWEEN 1000 AND 5000),
  dispatched_at TEXT CHECK(dispatched_at IS NULL OR dispatched_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', dispatched_at), '')),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_marketing_winback_cust ON marketing_winback_evaluations(customer_id, created_at DESC);

CREATE TRIGGER marketing_winback_evaluations_no_update BEFORE UPDATE ON marketing_winback_evaluations
BEGIN SELECT RAISE(ABORT, 'marketing_winback_evaluation_immutable'); END;

CREATE TRIGGER marketing_winback_evaluations_no_delete BEFORE DELETE ON marketing_winback_evaluations
BEGIN SELECT RAISE(ABORT, 'marketing_winback_evaluation_immutable'); END;

CREATE TABLE marketing_postpurchase_dispatches (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  order_id TEXT NOT NULL REFERENCES orders(id),
  customer_id TEXT REFERENCES customers(id),
  stream_type TEXT NOT NULL CHECK(stream_type IN ('transactional_safety_usage', 'commercial_replenishment')),
  status TEXT NOT NULL CHECK(status IN ('delivered', 'skipped_no_consent', 'suppressed')),
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  has_marketing_consent INTEGER NOT NULL CHECK(has_marketing_consent IN (0, 1)),
  dispatched_at TEXT NOT NULL CHECK(dispatched_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', dispatched_at), '')),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (order_id, stream_type)
) STRICT;

CREATE TRIGGER marketing_postpurchase_dispatches_no_update BEFORE UPDATE ON marketing_postpurchase_dispatches
BEGIN SELECT RAISE(ABORT, 'marketing_postpurchase_dispatch_immutable'); END;

CREATE TRIGGER marketing_postpurchase_dispatches_no_delete BEFORE DELETE ON marketing_postpurchase_dispatches
BEGIN SELECT RAISE(ABORT, 'marketing_postpurchase_dispatch_immutable'); END;

CREATE TABLE marketing_automation_guards (
  command_id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK(valid = 1)
) STRICT;
