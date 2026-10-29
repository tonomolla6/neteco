-- Migration: 0110_rca_copilot_audiences.sql
-- SUP-018: Systematic RCA for operational incidents (damage, picking error, delay, stock, documentation linked to preventive actions and verification).
-- SUP-019: Support Copilot (summarizes and drafts replies citing data; redaction/permissions, human approval, and accuracy evaluation).
-- ADM-027: Customer segments and audiences with estimation (versioned rules, predicted size/consent, and privacy preview without unnecessary PII).

-- SUP-018: Operational RCA Tables
CREATE TABLE support_operational_rcas (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  public_ref TEXT NOT NULL UNIQUE CHECK(length(public_ref) = 24 AND substr(public_ref, 1, 4) = 'RCA-'),
  incident_category TEXT NOT NULL CHECK(incident_category IN ('damage', 'picking_error', 'delay', 'stock_discrepancy', 'documentation')),
  ticket_id TEXT REFERENCES support_tickets(id),
  order_id TEXT REFERENCES orders(id),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 5 AND 200),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'investigating', 'action_planned', 'verified', 'closed')),
  severity TEXT NOT NULL CHECK(severity IN ('low', 'medium', 'high', 'critical')),
  root_cause_summary TEXT NOT NULL CHECK(length(trim(root_cause_summary)) BETWEEN 5 AND 2000),
  five_whys_json TEXT NOT NULL CHECK(json_valid(five_whys_json)),
  preventive_actions_json TEXT NOT NULL CHECK(json_valid(preventive_actions_json)),
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK(verification_status IN ('unverified', 'pending_verification', 'verified_effective', 'verified_ineffective')),
  verified_at TEXT CHECK(verified_at IS NULL OR verified_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', verified_at), '')),
  verified_by TEXT REFERENCES identities(id),
  verification_notes TEXT CHECK(verification_notes IS NULL OR length(trim(verification_notes)) <= 2000),
  version INTEGER NOT NULL CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  created_by TEXT NOT NULL REFERENCES identities(id)
) STRICT;

CREATE INDEX idx_rca_category ON support_operational_rcas(incident_category, created_at DESC);
CREATE INDEX idx_rca_status ON support_operational_rcas(status, verification_status);

CREATE TABLE support_operational_rca_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  rca_id TEXT NOT NULL REFERENCES support_operational_rcas(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create_rca', 'update_investigation', 'plan_preventive_action', 'verify_effectiveness', 'close_rca')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  result_version INTEGER NOT NULL CHECK(result_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (actor_id, idempotency_key),
  UNIQUE (rca_id, result_version)
) STRICT;

CREATE TRIGGER support_rca_commands_no_update BEFORE UPDATE ON support_operational_rca_commands
BEGIN SELECT RAISE(ABORT, 'support_rca_command_immutable'); END;

CREATE TRIGGER support_rca_commands_no_delete BEFORE DELETE ON support_operational_rca_commands
BEGIN SELECT RAISE(ABORT, 'support_rca_command_immutable'); END;


-- SUP-019: Support Copilot Tables
CREATE TABLE support_copilot_interactions (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  operator_id TEXT NOT NULL REFERENCES identities(id),
  context_summary TEXT NOT NULL CHECK(length(trim(context_summary)) BETWEEN 5 AND 4000),
  proposed_reply TEXT NOT NULL CHECK(length(trim(proposed_reply)) BETWEEN 5 AND 4000),
  citations_json TEXT NOT NULL CHECK(json_valid(citations_json)),
  redaction_flags_json TEXT NOT NULL CHECK(json_valid(redaction_flags_json)),
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK(approval_status IN ('pending', 'approved', 'rejected', 'modified_and_approved')),
  human_approved_at TEXT CHECK(human_approved_at IS NULL OR human_approved_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', human_approved_at), '')),
  human_approver_id TEXT REFERENCES identities(id),
  final_sent_reply TEXT CHECK(final_sent_reply IS NULL OR length(trim(final_sent_reply)) BETWEEN 1 AND 4000),
  accuracy_evaluation TEXT CHECK(accuracy_evaluation IS NULL OR accuracy_evaluation IN ('accurate', 'partially_accurate', 'inaccurate', 'hallucinated_data')),
  accuracy_score INTEGER CHECK(accuracy_score IS NULL OR accuracy_score BETWEEN 1 AND 5),
  accuracy_notes TEXT CHECK(accuracy_notes IS NULL OR length(trim(accuracy_notes)) <= 1000),
  evaluated_at TEXT CHECK(evaluated_at IS NULL OR evaluated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', evaluated_at), '')),
  evaluated_by TEXT REFERENCES identities(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_copilot_ticket ON support_copilot_interactions(ticket_id, created_at DESC);
CREATE INDEX idx_copilot_approval ON support_copilot_interactions(approval_status, created_at DESC);

CREATE TABLE support_copilot_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  interaction_id TEXT NOT NULL REFERENCES support_copilot_interactions(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('generate_draft', 'human_decision', 'evaluate_accuracy')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (actor_id, idempotency_key)
) STRICT;

CREATE TRIGGER support_copilot_commands_no_update BEFORE UPDATE ON support_copilot_commands
BEGIN SELECT RAISE(ABORT, 'support_copilot_command_immutable'); END;

CREATE TRIGGER support_copilot_commands_no_delete BEFORE DELETE ON support_copilot_commands
BEGIN SELECT RAISE(ABORT, 'support_copilot_command_immutable'); END;


-- ADM-027: Audience Segments Tables
CREATE TABLE audience_segments (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  slug TEXT NOT NULL UNIQUE CHECK(length(slug) BETWEEN 3 AND 64 AND slug NOT GLOB '*[^a-z0-9_-]*'),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 3 AND 120),
  description TEXT CHECK(description IS NULL OR length(trim(description)) <= 500),
  version INTEGER NOT NULL CHECK(version >= 1),
  rules_json TEXT NOT NULL CHECK(json_valid(rules_json)),
  target_type TEXT NOT NULL CHECK(target_type IN ('all', 'b2b', 'b2c')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft', 'active', 'archived')),
  last_estimated_at TEXT CHECK(last_estimated_at IS NULL OR last_estimated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', last_estimated_at), '')),
  estimated_total_users INTEGER DEFAULT 0 CHECK(estimated_total_users >= 0),
  estimated_consented_users INTEGER DEFAULT 0 CHECK(estimated_consented_users >= 0),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  created_by TEXT NOT NULL REFERENCES identities(id),
  updated_by TEXT NOT NULL REFERENCES identities(id)
) STRICT;

CREATE INDEX idx_audience_status ON audience_segments(status, target_type);

CREATE TABLE audience_segment_versions (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  segment_id TEXT NOT NULL REFERENCES audience_segments(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version >= 1),
  rules_json TEXT NOT NULL CHECK(json_valid(rules_json)),
  change_summary TEXT NOT NULL CHECK(length(trim(change_summary)) BETWEEN 1 AND 255),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (segment_id, version)
) STRICT;

CREATE INDEX idx_audience_version ON audience_segment_versions(segment_id, version DESC);

CREATE TABLE audience_segment_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  segment_id TEXT NOT NULL REFERENCES audience_segments(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create_segment', 'update_rules', 'estimate_audience', 'archive_segment')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  result_version INTEGER NOT NULL CHECK(result_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (actor_id, idempotency_key),
  UNIQUE (segment_id, result_version)
) STRICT;

CREATE TRIGGER audience_segment_commands_no_update BEFORE UPDATE ON audience_segment_commands
BEGIN SELECT RAISE(ABORT, 'audience_segment_command_immutable'); END;

CREATE TRIGGER audience_segment_commands_no_delete BEFORE DELETE ON audience_segment_commands
BEGIN SELECT RAISE(ABORT, 'audience_segment_command_immutable'); END;

