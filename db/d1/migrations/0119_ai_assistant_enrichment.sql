-- Migration: 0119_ai_assistant_enrichment.sql
-- ADM-032: Asistente de administración con IA bajo aprobación.
-- ADM-033: Generación asistida de descripciones/atributos.
-- MED-023: Enriquecimiento visual asistido.

-- ADM-032: Admin AI Assistant
CREATE TABLE admin_ai_assistant_interactions (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  category TEXT NOT NULL CHECK(category IN ('order_ops', 'customer_care', 'catalog_review', 'inventory_planning', 'financial_inquiry', 'general_admin')),
  prompt TEXT NOT NULL CHECK(length(trim(prompt)) BETWEEN 2 AND 4000),
  context_summary TEXT NOT NULL CHECK(length(trim(context_summary)) BETWEEN 5 AND 4000),
  proposed_reply TEXT NOT NULL CHECK(length(trim(proposed_reply)) BETWEEN 5 AND 6000),
  proposed_action TEXT CHECK(proposed_action IS NULL OR length(trim(proposed_action)) <= 2000),
  action_type TEXT CHECK(action_type IS NULL OR action_type IN ('propose_catalog_update', 'propose_order_note', 'propose_customer_notice', 'propose_restock_alert', 'propose_publish_review', 'propose_refund_review')),
  action_payload_json TEXT CHECK(action_payload_json IS NULL OR json_valid(action_payload_json)),
  citations_json TEXT NOT NULL CHECK(json_valid(citations_json)),
  redaction_flags_json TEXT NOT NULL CHECK(json_valid(redaction_flags_json)),
  requires_human_approval INTEGER NOT NULL DEFAULT 1 CHECK(requires_human_approval = 1),
  auto_execution_forbidden INTEGER NOT NULL DEFAULT 1 CHECK(auto_execution_forbidden = 1),
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK(approval_status IN ('pending', 'approved', 'rejected', 'modified_and_approved')),
  human_decided_at TEXT CHECK(human_decided_at IS NULL OR human_decided_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', human_decided_at), '')),
  human_decider_id TEXT REFERENCES identities(id),
  human_notes TEXT CHECK(human_notes IS NULL OR length(trim(human_notes)) <= 1000),
  model_id TEXT NOT NULL CHECK(length(model_id) BETWEEN 3 AND 64),
  tokens_used INTEGER NOT NULL CHECK(tokens_used >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_admin_ai_assistant_actor ON admin_ai_assistant_interactions(actor_id, created_at DESC);
CREATE INDEX idx_admin_ai_assistant_status ON admin_ai_assistant_interactions(approval_status, category);

CREATE TABLE admin_ai_assistant_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  interaction_id TEXT NOT NULL REFERENCES admin_ai_assistant_interactions(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('generate_proposal', 'human_decision')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  result_version INTEGER NOT NULL CHECK(result_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (actor_id, idempotency_key),
  UNIQUE (interaction_id, result_version)
) STRICT;

CREATE TRIGGER admin_ai_assistant_commands_no_update BEFORE UPDATE ON admin_ai_assistant_commands
BEGIN SELECT RAISE(ABORT, 'admin_ai_assistant_command_immutable'); END;

CREATE TRIGGER admin_ai_assistant_commands_no_delete BEFORE DELETE ON admin_ai_assistant_commands
BEGIN SELECT RAISE(ABORT, 'admin_ai_assistant_command_immutable'); END;


-- ADM-033: Catalog AI Generation
CREATE TABLE catalog_ai_generations (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  product_id TEXT REFERENCES products(id),
  target_scope TEXT NOT NULL CHECK(target_scope IN ('description', 'attributes', 'full_editorial')),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  sources_json TEXT NOT NULL CHECK(json_valid(sources_json)),
  prompt TEXT NOT NULL CHECK(length(trim(prompt)) BETWEEN 2 AND 4000),
  generated_title TEXT CHECK(generated_title IS NULL OR length(trim(generated_title)) BETWEEN 2 AND 300),
  generated_short_description TEXT CHECK(generated_short_description IS NULL OR length(trim(generated_short_description)) <= 1000),
  generated_description TEXT CHECK(generated_description IS NULL OR length(trim(generated_description)) <= 10000),
  generated_usage TEXT CHECK(generated_usage IS NULL OR length(trim(generated_usage)) <= 10000),
  generated_attributes_json TEXT CHECK(generated_attributes_json IS NULL OR json_valid(generated_attributes_json)),
  verifiable_claims_json TEXT NOT NULL CHECK(json_valid(verifiable_claims_json)),
  duplicate_check_json TEXT NOT NULL CHECK(json_valid(duplicate_check_json)),
  is_ai_generated INTEGER NOT NULL DEFAULT 1 CHECK(is_ai_generated = 1),
  ai_model_name TEXT NOT NULL CHECK(length(ai_model_name) BETWEEN 2 AND 64),
  approval_status TEXT NOT NULL DEFAULT 'pending_review' CHECK(approval_status IN ('pending_review', 'approved', 'rejected', 'modified_and_approved')),
  human_reviewed_at TEXT CHECK(human_reviewed_at IS NULL OR human_reviewed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', human_reviewed_at), '')),
  human_reviewer_id TEXT REFERENCES identities(id),
  applied_content_json TEXT CHECK(applied_content_json IS NULL OR json_valid(applied_content_json)),
  review_notes TEXT CHECK(review_notes IS NULL OR length(trim(review_notes)) <= 1000),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_catalog_ai_generations_prod ON catalog_ai_generations(product_id, created_at DESC);
CREATE INDEX idx_catalog_ai_generations_status ON catalog_ai_generations(approval_status, target_scope);

CREATE TABLE catalog_ai_generation_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  generation_id TEXT NOT NULL REFERENCES catalog_ai_generations(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('generate_catalog_content', 'human_review_decision', 'apply_to_product')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  result_version INTEGER NOT NULL CHECK(result_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (actor_id, idempotency_key),
  UNIQUE (generation_id, result_version)
) STRICT;

CREATE TRIGGER catalog_ai_generation_commands_no_update BEFORE UPDATE ON catalog_ai_generation_commands
BEGIN SELECT RAISE(ABORT, 'catalog_ai_generation_command_immutable'); END;

CREATE TRIGGER catalog_ai_generation_commands_no_delete BEFORE DELETE ON catalog_ai_generation_commands
BEGIN SELECT RAISE(ABORT, 'catalog_ai_generation_command_immutable'); END;


-- MED-023: Media AI Enrichment
CREATE TABLE media_ai_enrichments (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  asset_id TEXT NOT NULL REFERENCES media_assets(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  enrichment_type TEXT NOT NULL CHECK(enrichment_type IN ('remove_background', 'propose_crops', 'propose_metadata', 'full_visual_enrichment')),
  original_metadata_json TEXT NOT NULL CHECK(json_valid(original_metadata_json)),
  background_removal_json TEXT CHECK(background_removal_json IS NULL OR json_valid(background_removal_json)),
  proposed_crops_json TEXT CHECK(proposed_crops_json IS NULL OR json_valid(proposed_crops_json)),
  proposed_metadata_json TEXT CHECK(proposed_metadata_json IS NULL OR json_valid(proposed_metadata_json)),
  prohibited_invention_check_json TEXT NOT NULL CHECK(json_valid(prohibited_invention_check_json)),
  requires_human_approval INTEGER NOT NULL DEFAULT 1 CHECK(requires_human_approval = 1),
  approval_status TEXT NOT NULL DEFAULT 'pending_approval' CHECK(approval_status IN ('pending_approval', 'approved', 'rejected', 'modified_and_approved')),
  human_decided_at TEXT CHECK(human_decided_at IS NULL OR human_decided_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', human_decided_at), '')),
  human_decider_id TEXT REFERENCES identities(id),
  human_notes TEXT CHECK(human_notes IS NULL OR length(trim(human_notes)) <= 1000),
  applied_to_asset_at TEXT CHECK(applied_to_asset_at IS NULL OR applied_to_asset_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', applied_to_asset_at), '')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_media_ai_enrichments_asset ON media_ai_enrichments(asset_id, created_at DESC);
CREATE INDEX idx_media_ai_enrichments_status ON media_ai_enrichments(approval_status, enrichment_type);

CREATE TABLE media_ai_enrichment_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  enrichment_id TEXT NOT NULL REFERENCES media_ai_enrichments(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('propose_enrichment', 'human_decision', 'apply_enrichment')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  result_version INTEGER NOT NULL CHECK(result_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (actor_id, idempotency_key),
  UNIQUE (enrichment_id, result_version)
) STRICT;

CREATE TRIGGER media_ai_enrichment_commands_no_update BEFORE UPDATE ON media_ai_enrichment_commands
BEGIN SELECT RAISE(ABORT, 'media_ai_enrichment_command_immutable'); END;

CREATE TRIGGER media_ai_enrichment_commands_no_delete BEFORE DELETE ON media_ai_enrichment_commands
BEGIN SELECT RAISE(ABORT, 'media_ai_enrichment_command_immutable'); END;


