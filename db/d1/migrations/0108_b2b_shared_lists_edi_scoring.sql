-- Migration 0108: CUS-018 (Shared & Recurring Lists), CUS-030 (Key Client EDI/API), CUS-031 (Assisted Risk & Value Scoring)

-- 1. CUS-018: Customer Recurring & Shared Lists
CREATE TABLE customer_recurring_lists (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  owner_identity_id TEXT NOT NULL REFERENCES identities(id),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100 AND name=trim(name)),
  description TEXT CHECK(description IS NULL OR (length(trim(description)) <= 500 AND description=trim(description))),
  frequency TEXT NOT NULL CHECK(frequency IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'custom')),
  frequency_days INTEGER CHECK(frequency_days IS NULL OR frequency_days BETWEEN 1 AND 365),
  next_suggested_date TEXT CHECK(next_suggested_date IS NULL OR (next_suggested_date=COALESCE(strftime('%Y-%m-%d', next_suggested_date),''))),
  last_replenished_at TEXT CHECK(last_replenished_at IS NULL OR (last_replenished_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', last_replenished_at),''))),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at),'') AND updated_at>=created_at)
) STRICT;

CREATE INDEX customer_recurring_lists_owner_idx ON customer_recurring_lists(customer_id, status, created_at);

CREATE TRIGGER customer_recurring_lists_version BEFORE UPDATE ON customer_recurring_lists
WHEN NEW.id<>OLD.id OR NEW.customer_id<>OLD.customer_id OR NEW.owner_identity_id<>OLD.owner_identity_id OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'recurring_list_version_conflict'); END;

CREATE TABLE customer_recurring_list_collaborators (
  list_id TEXT NOT NULL REFERENCES customer_recurring_lists(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES identities(id),
  email TEXT NOT NULL CHECK(length(trim(email)) BETWEEN 3 AND 254),
  role TEXT NOT NULL CHECK(role IN ('editor', 'viewer')),
  invited_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),'')),
  PRIMARY KEY (list_id, identity_id)
) STRICT;

CREATE INDEX customer_recurring_list_collab_identity_idx ON customer_recurring_list_collaborators(identity_id);

CREATE TABLE customer_recurring_list_items (
  list_id TEXT NOT NULL REFERENCES customer_recurring_lists(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 999),
  expected_unit_gross_cents INTEGER CHECK(expected_unit_gross_cents IS NULL OR (expected_unit_gross_cents >= 0 AND expected_unit_gross_cents <= 9007199254740991)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at),'') AND updated_at>=created_at),
  PRIMARY KEY (list_id, variant_id)
) STRICT;

CREATE TRIGGER customer_recurring_items_version_insert AFTER INSERT ON customer_recurring_list_items
BEGIN UPDATE customer_recurring_lists SET version=version+1 WHERE id=NEW.list_id; END;

CREATE TRIGGER customer_recurring_items_version_update AFTER UPDATE ON customer_recurring_list_items
BEGIN UPDATE customer_recurring_lists SET version=version+1 WHERE id=NEW.list_id; END;

CREATE TRIGGER customer_recurring_items_version_delete AFTER DELETE ON customer_recurring_list_items
BEGIN UPDATE customer_recurring_lists SET version=version+1 WHERE id=OLD.list_id; END;

-- 2. CUS-030: EDI/API for Key B2B Clients
CREATE TABLE b2b_edi_clients (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120 AND name=trim(name)),
  environment TEXT NOT NULL DEFAULT 'sandbox' CHECK(environment IN ('sandbox', 'live')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'revoked')),
  supported_versions_json TEXT NOT NULL DEFAULT '["2026-01","2026-10"]' CHECK(json_valid(supported_versions_json)),
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 60 CHECK(rate_limit_per_minute BETWEEN 1 AND 10000),
  daily_request_quota INTEGER NOT NULL DEFAULT 5000 CHECK(daily_request_quota BETWEEN 10 AND 1000000),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at),'') AND updated_at>=created_at)
) STRICT;

CREATE INDEX b2b_edi_clients_company_idx ON b2b_edi_clients(company_id, status);

CREATE TRIGGER b2b_edi_clients_version BEFORE UPDATE ON b2b_edi_clients
WHEN NEW.id<>OLD.id OR NEW.company_id<>OLD.company_id OR NEW.customer_id<>OLD.customer_id OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'edi_client_version_conflict'); END;

CREATE TABLE b2b_edi_api_keys (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES b2b_edi_clients(id) ON DELETE CASCADE,
  key_prefix TEXT NOT NULL CHECK(length(key_prefix) BETWEEN 4 AND 20),
  key_hash TEXT NOT NULL UNIQUE CHECK(length(key_hash)=64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
  hmac_secret_hash TEXT NOT NULL CHECK(length(hmac_secret_hash)=64 AND hmac_secret_hash NOT GLOB '*[^0-9a-f]*'),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80 AND name=trim(name)),
  expires_at TEXT CHECK(expires_at IS NULL OR expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at),'')),
  revoked_at TEXT CHECK(revoked_at IS NULL OR (revoked_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', revoked_at),'') AND revoked_at>=created_at)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),''))
) STRICT;

CREATE INDEX b2b_edi_api_keys_client_idx ON b2b_edi_api_keys(client_id, revoked_at);

CREATE TABLE b2b_edi_idempotency (
  client_id TEXT NOT NULL REFERENCES b2b_edi_clients(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  response_status INTEGER NOT NULL CHECK(response_status BETWEEN 100 AND 599),
  response_body_json TEXT NOT NULL CHECK(json_valid(response_body_json)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),'')),
  expires_at TEXT NOT NULL CHECK(expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at),'') AND expires_at>=created_at),
  PRIMARY KEY (client_id, idempotency_key)
) STRICT;

CREATE TABLE b2b_edi_usage_logs (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES b2b_edi_clients(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL CHECK(length(endpoint) BETWEEN 1 AND 120),
  contract_version TEXT NOT NULL CHECK(length(contract_version) BETWEEN 1 AND 30),
  environment TEXT NOT NULL CHECK(environment IN ('sandbox', 'live')),
  status_code INTEGER NOT NULL CHECK(status_code BETWEEN 100 AND 599),
  latency_ms INTEGER NOT NULL CHECK(latency_ms >= 0),
  payload_size_bytes INTEGER NOT NULL CHECK(payload_size_bytes >= 0),
  error_code TEXT,
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),''))
) STRICT;

CREATE INDEX b2b_edi_usage_logs_client_time ON b2b_edi_usage_logs(client_id, created_at DESC);

-- 3. CUS-031: Assisted Risk & Value Scoring
CREATE TABLE customer_risk_scoring_profiles (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
  risk_score INTEGER NOT NULL CHECK(risk_score BETWEEN 0 AND 100),
  risk_tier TEXT NOT NULL CHECK(risk_tier IN ('low', 'moderate', 'high', 'critical')),
  value_score INTEGER NOT NULL CHECK(value_score BETWEEN 0 AND 100),
  value_tier TEXT NOT NULL CHECK(value_tier IN ('tier_a', 'tier_b', 'tier_c', 'tier_d')),
  factors_json TEXT NOT NULL CHECK(json_valid(factors_json) AND json_type(factors_json)='array'),
  recommended_credit_limit_cents INTEGER NOT NULL CHECK(recommended_credit_limit_cents >= 0),
  recommended_payment_terms TEXT NOT NULL CHECK(recommended_payment_terms IN ('prepayment', 'net_15', 'net_30', 'net_60')),
  review_status TEXT NOT NULL DEFAULT 'automatic' CHECK(review_status IN ('automatic', 'under_review', 'reviewed', 'overridden')),
  model_version TEXT NOT NULL CHECK(length(model_version) BETWEEN 1 AND 32),
  calculated_at TEXT NOT NULL CHECK(calculated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', calculated_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at),'') AND updated_at>=calculated_at),
  UNIQUE(customer_id)
) STRICT;

CREATE INDEX customer_risk_profiles_risk_tier ON customer_risk_scoring_profiles(risk_tier, review_status);

CREATE TABLE customer_risk_scoring_reviews (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  analyst_identity_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('review', 'override')),
  previous_risk_tier TEXT NOT NULL CHECK(previous_risk_tier IN ('low', 'moderate', 'high', 'critical')),
  new_risk_tier TEXT NOT NULL CHECK(new_risk_tier IN ('low', 'moderate', 'high', 'critical')),
  previous_credit_limit_cents INTEGER NOT NULL CHECK(previous_credit_limit_cents >= 0),
  new_credit_limit_cents INTEGER NOT NULL CHECK(new_credit_limit_cents >= 0),
  justification TEXT NOT NULL CHECK(length(trim(justification)) >= 10 AND justification=trim(justification)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),''))
) STRICT;

CREATE INDEX customer_risk_reviews_customer_idx ON customer_risk_scoring_reviews(customer_id, created_at DESC);

CREATE TABLE customer_risk_scoring_evaluations (
  id TEXT PRIMARY KEY,
  model_version TEXT NOT NULL CHECK(length(model_version) BETWEEN 1 AND 32),
  evaluated_at TEXT NOT NULL CHECK(evaluated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', evaluated_at),'')),
  sample_size INTEGER NOT NULL CHECK(sample_size >= 0),
  override_rate_basis_points INTEGER NOT NULL CHECK(override_rate_basis_points BETWEEN 0 AND 10000),
  high_risk_default_rate_basis_points INTEGER NOT NULL CHECK(high_risk_default_rate_basis_points BETWEEN 0 AND 10000),
  brier_score_basis_points INTEGER NOT NULL CHECK(brier_score_basis_points BETWEEN 0 AND 10000),
  quality_status TEXT NOT NULL CHECK(quality_status IN ('optimal', 'acceptable', 'drift_warning', 'recalibration_required')),
  metrics_json TEXT NOT NULL CHECK(json_valid(metrics_json))
) STRICT;
