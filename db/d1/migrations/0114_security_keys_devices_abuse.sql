-- Migration 0114: SEC-038 (B2B API keys with scopes), SEC-039 (warehouse/delivery device security),
-- SEC-040 (explainable abuse detection with human review).
-- Secrets are never stored: API keys keep only a public prefix and an HMAC-SHA256 hash; abuse subjects are
-- stored as keyed pseudonyms; devices keep posture booleans and no personal data beyond the assigned account id.

-- ---------------------------------------------------------------------------
-- SEC-038: B2B API keys
-- ---------------------------------------------------------------------------
CREATE TABLE b2b_api_keys (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80 AND name=trim(name)),
  key_prefix TEXT NOT NULL UNIQUE CHECK(length(key_prefix)=12 AND key_prefix GLOB 'ntk_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  key_hash TEXT NOT NULL CHECK(length(key_hash)=64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
  scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json) AND json_type(scopes_json)='array' AND json_array_length(scopes_json) BETWEEN 1 AND 10),
  allowed_ips_json TEXT CHECK(allowed_ips_json IS NULL OR (json_valid(allowed_ips_json) AND json_type(allowed_ips_json)='array' AND json_array_length(allowed_ips_json) BETWEEN 1 AND 20)),
  quota_per_minute INTEGER NOT NULL CHECK(quota_per_minute BETWEEN 1 AND 6000),
  quota_per_day INTEGER NOT NULL CHECK(quota_per_day BETWEEN 1 AND 1000000),
  status TEXT NOT NULL CHECK(status IN ('active','rotated','revoked')),
  expires_at TEXT NOT NULL CHECK(expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at),'')),
  revoked_at TEXT CHECK(revoked_at IS NULL OR revoked_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', revoked_at),'')),
  revoke_reason TEXT CHECK(revoke_reason IS NULL OR length(revoke_reason) BETWEEN 1 AND 200),
  rotated_to_id TEXT,
  created_by TEXT NOT NULL REFERENCES identities(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at),'') AND updated_at>=created_at),
  CHECK(expires_at>created_at),
  CHECK((status='revoked')=(revoked_at IS NOT NULL)),
  CHECK(revoked_at IS NULL OR revoked_at>=created_at)
) STRICT;

CREATE INDEX b2b_api_keys_company_idx ON b2b_api_keys(company_id, status, created_at);

CREATE TRIGGER b2b_api_keys_version BEFORE UPDATE ON b2b_api_keys
WHEN NEW.id<>OLD.id OR NEW.company_id<>OLD.company_id OR NEW.key_prefix<>OLD.key_prefix OR NEW.key_hash<>OLD.key_hash
  OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1
  OR (OLD.status='revoked' AND NEW.status<>'revoked')
BEGIN SELECT RAISE(ABORT,'b2b_api_key_version_conflict'); END;

CREATE TRIGGER b2b_api_keys_no_delete BEFORE DELETE ON b2b_api_keys
BEGIN SELECT RAISE(ABORT,'b2b_api_keys_append_only'); END;

-- Last-use and quota counters live apart from the key row so that traffic never bumps the CAS version.
CREATE TABLE b2b_api_key_last_use (
  key_id TEXT PRIMARY KEY REFERENCES b2b_api_keys(id),
  last_used_at TEXT NOT NULL CHECK(last_used_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', last_used_at),''))
) STRICT;

CREATE TABLE b2b_api_key_usage (
  key_id TEXT NOT NULL REFERENCES b2b_api_keys(id),
  bucket_kind TEXT NOT NULL CHECK(bucket_kind IN ('minute','day')),
  bucket_start TEXT NOT NULL CHECK(length(bucket_start) BETWEEN 10 AND 20),
  request_count INTEGER NOT NULL CHECK(request_count>=0),
  PRIMARY KEY(key_id, bucket_kind, bucket_start)
) STRICT;

CREATE TABLE b2b_api_key_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) BETWEEN 8 AND 64),
  kind TEXT NOT NULL CHECK(kind IN ('create','rotate','revoke','update_policy')),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  key_id TEXT NOT NULL REFERENCES b2b_api_keys(id),
  result_key_id TEXT REFERENCES b2b_api_keys(id),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),''))
) STRICT;

CREATE TABLE b2b_api_key_audit (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES b2b_api_keys(id),
  actor_identity_id TEXT REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('created','rotated','revoked','policy_updated')),
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),''))
) STRICT;

CREATE INDEX b2b_api_key_audit_key_idx ON b2b_api_key_audit(key_id, created_at);

CREATE TRIGGER b2b_api_key_audit_no_update BEFORE UPDATE ON b2b_api_key_audit
BEGIN SELECT RAISE(ABORT,'b2b_api_key_audit_append_only'); END;
CREATE TRIGGER b2b_api_key_audit_no_delete BEFORE DELETE ON b2b_api_key_audit
BEGIN SELECT RAISE(ABORT,'b2b_api_key_audit_append_only'); END;

-- ---------------------------------------------------------------------------
-- SEC-039: warehouse and delivery devices
-- ---------------------------------------------------------------------------
CREATE TABLE warehouse_devices (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 80 AND label=trim(label)),
  kind TEXT NOT NULL CHECK(kind IN ('warehouse_scanner','warehouse_tablet','delivery_phone')),
  platform TEXT NOT NULL CHECK(platform IN ('android','ios','rugged_os')),
  assigned_identity_id TEXT NOT NULL REFERENCES identities(id),
  status TEXT NOT NULL CHECK(status IN ('pending_enrollment','active','locked','lost','wipe_pending','wiped','retired')),
  disk_encrypted INTEGER CHECK(disk_encrypted IS NULL OR disk_encrypted IN (0,1)),
  screen_lock_enabled INTEGER CHECK(screen_lock_enabled IS NULL OR screen_lock_enabled IN (0,1)),
  passcode_length INTEGER CHECK(passcode_length IS NULL OR passcode_length BETWEEN 0 AND 64),
  jailbroken INTEGER CHECK(jailbroken IS NULL OR jailbroken IN (0,1)),
  last_posture_at TEXT CHECK(last_posture_at IS NULL OR last_posture_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', last_posture_at),'')),
  wipe_requested_at TEXT CHECK(wipe_requested_at IS NULL OR wipe_requested_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', wipe_requested_at),'')),
  wipe_confirmed_at TEXT CHECK(wipe_confirmed_at IS NULL OR wipe_confirmed_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', wipe_confirmed_at),'')),
  offline_key_version INTEGER NOT NULL DEFAULT 1 CHECK(offline_key_version>=1),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at),'') AND updated_at>=created_at),
  CHECK(status<>'wiped' OR wipe_confirmed_at IS NOT NULL),
  CHECK(status<>'wipe_pending' OR wipe_requested_at IS NOT NULL)
) STRICT;

-- One person, one live device per kind: no shared devices behind shared accounts.
CREATE UNIQUE INDEX warehouse_devices_live_assignment ON warehouse_devices(assigned_identity_id, kind)
WHERE status IN ('pending_enrollment','active','locked','lost','wipe_pending');
CREATE INDEX warehouse_devices_status_idx ON warehouse_devices(status, created_at);

CREATE TRIGGER warehouse_devices_version BEFORE UPDATE ON warehouse_devices
WHEN NEW.id<>OLD.id OR NEW.assigned_identity_id<>OLD.assigned_identity_id OR NEW.kind<>OLD.kind
  OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1
  OR (OLD.status IN ('wiped','retired') AND NEW.status<>OLD.status AND NOT (OLD.status='wiped' AND NEW.status='retired'))
BEGIN SELECT RAISE(ABORT,'warehouse_device_version_conflict'); END;

CREATE TRIGGER warehouse_devices_no_delete BEFORE DELETE ON warehouse_devices
BEGIN SELECT RAISE(ABORT,'warehouse_devices_append_only'); END;

CREATE TABLE warehouse_device_presence (
  device_id TEXT PRIMARY KEY REFERENCES warehouse_devices(id),
  last_seen_at TEXT NOT NULL CHECK(last_seen_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', last_seen_at),''))
) STRICT;

CREATE TABLE warehouse_device_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) BETWEEN 8 AND 64),
  kind TEXT NOT NULL CHECK(kind IN ('enroll','lock','unlock','lost','wipe','wipe_confirm','retire')),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  device_id TEXT NOT NULL REFERENCES warehouse_devices(id),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),''))
) STRICT;

CREATE TABLE warehouse_device_audit (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES warehouse_devices(id),
  actor_identity_id TEXT REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('enrolled','posture_reported','auto_locked_noncompliant','locked','unlocked','lost','wipe_requested','wipe_confirmed','retired')),
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),''))
) STRICT;

CREATE INDEX warehouse_device_audit_device_idx ON warehouse_device_audit(device_id, created_at);

CREATE TRIGGER warehouse_device_audit_no_update BEFORE UPDATE ON warehouse_device_audit
BEGIN SELECT RAISE(ABORT,'warehouse_device_audit_append_only'); END;
CREATE TRIGGER warehouse_device_audit_no_delete BEFORE DELETE ON warehouse_device_audit
BEGIN SELECT RAISE(ABORT,'warehouse_device_audit_append_only'); END;

-- ---------------------------------------------------------------------------
-- SEC-040: abuse detection
-- ---------------------------------------------------------------------------
CREATE TABLE abuse_model_versions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE CHECK(version>=1),
  weights_json TEXT NOT NULL CHECK(json_valid(weights_json) AND json_type(weights_json)='object'),
  review_threshold INTEGER NOT NULL CHECK(review_threshold BETWEEN 1 AND 99),
  hold_threshold INTEGER NOT NULL CHECK(hold_threshold BETWEEN 2 AND 100),
  status TEXT NOT NULL CHECK(status IN ('draft','active','retired')),
  created_by TEXT REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),'')),
  activated_at TEXT CHECK(activated_at IS NULL OR activated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', activated_at),'')),
  CHECK(hold_threshold>review_threshold)
) STRICT;

CREATE UNIQUE INDEX abuse_model_versions_one_active ON abuse_model_versions(status) WHERE status='active';

CREATE TRIGGER abuse_model_versions_guard BEFORE UPDATE ON abuse_model_versions
WHEN NEW.id<>OLD.id OR NEW.version<>OLD.version OR NEW.weights_json<>OLD.weights_json
  OR NEW.review_threshold<>OLD.review_threshold OR NEW.hold_threshold<>OLD.hold_threshold
  OR NOT ((OLD.status='draft' AND NEW.status='active') OR (OLD.status='active' AND NEW.status='retired') OR OLD.status=NEW.status)
BEGIN SELECT RAISE(ABORT,'abuse_model_immutable'); END;

INSERT INTO abuse_model_versions(id, version, weights_json, review_threshold, hold_threshold, status, created_by, created_at, activated_at)
VALUES ('00000000-0000-4000-8000-0000000a0001', 1,
  '{"failed_logins_1h":0.2,"orders_1h":0.12,"coupon_attempts_1h":0.14,"distinct_cards_24h":0.18,"new_account_flag":0.08,"address_mismatch_flag":0.08,"first_order_value_eur":0.1,"refund_requests_30d":0.1}',
  40, 75, 'active', NULL, '2026-10-29T00:00:00Z', '2026-10-29T00:00:00Z');

CREATE TABLE abuse_assessments (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE CHECK(length(command_id) BETWEEN 8 AND 64),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  model_version_id TEXT NOT NULL REFERENCES abuse_model_versions(id),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('identity','ip','payment','session','api_key')),
  subject_ref TEXT NOT NULL CHECK(length(subject_ref)=64 AND subject_ref NOT GLOB '*[^0-9a-f]*'),
  context TEXT NOT NULL CHECK(context IN ('login','checkout','coupon','b2b_api','account_creation')),
  features_json TEXT NOT NULL CHECK(json_valid(features_json) AND json_type(features_json)='object'),
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
  decision TEXT NOT NULL CHECK(decision IN ('allow','review','hold')),
  explanation_json TEXT NOT NULL CHECK(json_valid(explanation_json)),
  review_status TEXT NOT NULL CHECK(review_status IN ('not_required','pending','reviewed')),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),'')),
  expires_at TEXT NOT NULL CHECK(expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at),'') AND expires_at>created_at),
  CHECK((decision='allow' AND review_status='not_required') OR (decision<>'allow' AND review_status IN ('pending','reviewed')))
) STRICT;

CREATE INDEX abuse_assessments_queue_idx ON abuse_assessments(review_status, created_at);
CREATE INDEX abuse_assessments_window_idx ON abuse_assessments(model_version_id, created_at);
CREATE INDEX abuse_assessments_expiry_idx ON abuse_assessments(expires_at);

CREATE TRIGGER abuse_assessments_immutable BEFORE UPDATE ON abuse_assessments
WHEN NOT (OLD.review_status='pending' AND NEW.review_status='reviewed'
  AND NEW.id=OLD.id AND NEW.command_id=OLD.command_id AND NEW.payload_hash=OLD.payload_hash
  AND NEW.model_version_id=OLD.model_version_id AND NEW.subject_ref=OLD.subject_ref
  AND NEW.features_json=OLD.features_json AND NEW.score=OLD.score AND NEW.decision=OLD.decision
  AND NEW.explanation_json=OLD.explanation_json AND NEW.created_at=OLD.created_at AND NEW.expires_at=OLD.expires_at)
BEGIN SELECT RAISE(ABORT,'abuse_assessment_immutable'); END;

CREATE TABLE abuse_reviews (
  id TEXT NOT NULL UNIQUE,
  assessment_id TEXT PRIMARY KEY REFERENCES abuse_assessments(id) ON DELETE CASCADE,
  reviewer_identity_id TEXT NOT NULL REFERENCES identities(id),
  outcome TEXT NOT NULL CHECK(outcome IN ('confirmed_abuse','false_positive')),
  note TEXT NOT NULL CHECK(length(note) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),''))
) STRICT;

CREATE TRIGGER abuse_reviews_no_update BEFORE UPDATE ON abuse_reviews
BEGIN SELECT RAISE(ABORT,'abuse_reviews_append_only'); END;
-- Deleting a review is only legitimate when retention removes its (already deleted) parent assessment.
CREATE TRIGGER abuse_reviews_no_delete BEFORE DELETE ON abuse_reviews
WHEN EXISTS(SELECT 1 FROM abuse_assessments WHERE id=OLD.assessment_id)
BEGIN SELECT RAISE(ABORT,'abuse_reviews_append_only'); END;

CREATE TABLE abuse_baselines (
  model_version_id TEXT NOT NULL REFERENCES abuse_model_versions(id),
  feature TEXT NOT NULL CHECK(length(feature) BETWEEN 1 AND 60),
  proportions_json TEXT NOT NULL CHECK(json_valid(proportions_json) AND json_array_length(proportions_json)=5),
  sample_size INTEGER NOT NULL CHECK(sample_size>=30),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),'')),
  PRIMARY KEY(model_version_id, feature)
) STRICT;

CREATE TABLE abuse_drift_reports (
  id TEXT PRIMARY KEY,
  model_version_id TEXT NOT NULL REFERENCES abuse_model_versions(id),
  feature TEXT NOT NULL CHECK(length(feature) BETWEEN 1 AND 60),
  window_start TEXT NOT NULL CHECK(window_start=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', window_start),'')),
  window_end TEXT NOT NULL CHECK(window_end=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', window_end),'')),
  sample_size INTEGER NOT NULL CHECK(sample_size>=0),
  psi REAL CHECK(psi IS NULL OR psi>=0),
  status TEXT NOT NULL CHECK(status IN ('ok','warn','alert','insufficient_data')),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),'')),
  CHECK((status='insufficient_data')=(psi IS NULL))
) STRICT;

CREATE INDEX abuse_drift_reports_model_idx ON abuse_drift_reports(model_version_id, created_at);

CREATE TABLE abuse_audit (
  id TEXT PRIMARY KEY,
  actor_identity_id TEXT REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('model_created','model_activated','baseline_recorded','drift_computed','review_submitted','assessments_purged')),
  ref_id TEXT,
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at),''))
) STRICT;

CREATE TRIGGER abuse_audit_no_update BEFORE UPDATE ON abuse_audit
BEGIN SELECT RAISE(ABORT,'abuse_audit_append_only'); END;
CREATE TRIGGER abuse_audit_no_delete BEFORE DELETE ON abuse_audit
BEGIN SELECT RAISE(ABORT,'abuse_audit_append_only'); END;
