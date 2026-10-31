-- Migration 0141: Downloadable Templates Library (MED-019), Brand Center & Verifiable Certifications (MED-021),
-- and Warehouse/ADR Operational Assets by Variant & Lot (MED-022)

-- ============================================================================
-- MED-019: Biblioteca de plantillas descargables (Checklists, planes y guías)
-- ============================================================================

CREATE TABLE IF NOT EXISTS downloadable_templates (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  slug TEXT UNIQUE NOT NULL CHECK(length(slug) BETWEEN 2 AND 160 AND slug GLOB '[a-z0-9]*'),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 3 AND 200),
  description TEXT NOT NULL CHECK(length(trim(description)) BETWEEN 10 AND 500),
  template_type TEXT NOT NULL CHECK(template_type IN ('checklist', 'plan', 'guide')),
  category TEXT NOT NULL CHECK(category IN ('hosteleria', 'industria', 'sanitario', 'lavanderia', 'alimentaria', 'mantenimiento')),
  target_audience TEXT NOT NULL CHECK(length(trim(target_audience)) BETWEEN 2 AND 160),
  sections_json TEXT NOT NULL CHECK(json_valid(sections_json)),
  pdf_metadata_json TEXT NOT NULL CHECK(json_valid(pdf_metadata_json)),
  status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  published_at TEXT CHECK(published_at IS NULL OR published_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', published_at), '')),
  reviewed_at TEXT NOT NULL CHECK(reviewed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', reviewed_at), '')),
  review_due_at TEXT NOT NULL CHECK(review_due_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', review_due_at), '') AND review_due_at > reviewed_at),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_downloadable_templates_status_type ON downloadable_templates(status, template_type, category);
CREATE INDEX IF NOT EXISTS idx_downloadable_templates_published_at ON downloadable_templates(published_at DESC);

CREATE TRIGGER IF NOT EXISTS downloadable_templates_cas BEFORE UPDATE ON downloadable_templates
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_conflict'); END;

CREATE TABLE IF NOT EXISTS downloadable_template_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  template_id TEXT NOT NULL REFERENCES downloadable_templates(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create', 'update', 'publish', 'archive', 'review')),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  result_version INTEGER NOT NULL CHECK(result_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (template_id, result_version)
) STRICT;

CREATE TRIGGER IF NOT EXISTS downloadable_template_commands_no_update BEFORE UPDATE ON downloadable_template_commands
BEGIN SELECT RAISE(ABORT, 'downloadable_template_commands_immutable'); END;

CREATE TRIGGER IF NOT EXISTS downloadable_template_commands_no_delete BEFORE DELETE ON downloadable_template_commands
BEGIN SELECT RAISE(ABORT, 'downloadable_template_commands_immutable'); END;


-- ============================================================================
-- MED-021: Centro de marca y certificaciones oficiales verificables
-- ============================================================================

CREATE TABLE IF NOT EXISTS brand_assets (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 120),
  category TEXT NOT NULL CHECK(category IN ('logo', 'symbol', 'guideline', 'typography', 'palette')),
  format TEXT NOT NULL CHECK(format IN ('svg', 'png', 'pdf', 'json')),
  variant TEXT NOT NULL CHECK(variant IN ('primary', 'monochrome', 'negative', 'symbol', 'spec')),
  url TEXT NOT NULL CHECK(length(trim(url)) BETWEEN 5 AND 500),
  min_clearspace_px INTEGER NOT NULL DEFAULT 16 CHECK(min_clearspace_px >= 0),
  prohibited_uses_json TEXT NOT NULL CHECK(json_valid(prohibited_uses_json)),
  status TEXT NOT NULL CHECK(status IN ('active', 'deprecated')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;

CREATE TRIGGER IF NOT EXISTS brand_assets_cas BEFORE UPDATE ON brand_assets
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_conflict'); END;

CREATE TABLE IF NOT EXISTS brand_authorizations (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  partner_name TEXT NOT NULL CHECK(length(trim(partner_name)) BETWEEN 2 AND 160),
  authorized_domain TEXT NOT NULL CHECK(length(trim(authorized_domain)) BETWEEN 3 AND 160),
  scope TEXT NOT NULL CHECK(scope IN ('distribuidor_oficial', 'partner_logistico', 'proveedor_homologado', 'prensa_medios')),
  status TEXT NOT NULL CHECK(status IN ('active', 'revoked', 'expired')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  valid_from TEXT NOT NULL CHECK(valid_from = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', valid_from), '')),
  valid_until TEXT CHECK(valid_until IS NULL OR (valid_until = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', valid_until), '') AND valid_until > valid_from)),
  authorized_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;

CREATE TRIGGER IF NOT EXISTS brand_authorizations_cas BEFORE UPDATE ON brand_authorizations
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_conflict'); END;

CREATE TABLE IF NOT EXISTS official_certifications (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  standard_code TEXT UNIQUE NOT NULL CHECK(standard_code IN ('ISO-9001', 'ISO-14001', 'ECOLABEL-EU', 'UNE-EN-ISO-22716', 'ADR-SAFETY-CONSULTANT', 'ROESB-BIOCIDAS', 'IFS-HPC')),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 3 AND 200),
  issuer TEXT NOT NULL CHECK(length(trim(issuer)) BETWEEN 2 AND 160),
  certificate_number TEXT UNIQUE NOT NULL CHECK(length(trim(certificate_number)) BETWEEN 3 AND 100),
  scope TEXT NOT NULL CHECK(length(trim(scope)) BETWEEN 10 AND 1000),
  valid_from TEXT NOT NULL CHECK(valid_from = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', valid_from), '')),
  valid_until TEXT NOT NULL CHECK(valid_until = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', valid_until), '') AND valid_until > valid_from),
  verification_url TEXT NOT NULL CHECK(length(trim(verification_url)) BETWEEN 10 AND 500),
  document_url TEXT NOT NULL CHECK(length(trim(document_url)) BETWEEN 5 AND 500),
  status TEXT NOT NULL CHECK(status IN ('active', 'expired', 'suspended')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  audited_by TEXT NOT NULL CHECK(length(trim(audited_by)) BETWEEN 2 AND 120),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_official_certifications_status ON official_certifications(status, valid_until);

CREATE TRIGGER IF NOT EXISTS official_certifications_cas BEFORE UPDATE ON official_certifications
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_conflict'); END;

CREATE TABLE IF NOT EXISTS brand_center_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  entity_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create_certification', 'update_certification', 'revoke_certification', 'authorize_partner', 'revoke_partner', 'upsert_brand_asset')),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  result_version INTEGER NOT NULL CHECK(result_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (entity_id, result_version)
) STRICT;

CREATE TRIGGER IF NOT EXISTS brand_center_commands_no_update BEFORE UPDATE ON brand_center_commands
BEGIN SELECT RAISE(ABORT, 'brand_center_commands_immutable'); END;

CREATE TRIGGER IF NOT EXISTS brand_center_commands_no_delete BEFORE DELETE ON brand_center_commands
BEGIN SELECT RAISE(ABORT, 'brand_center_commands_immutable'); END;


-- ============================================================================
-- MED-022: Assets operativos de almacén y ADR por variante y lote
-- ============================================================================

CREATE TABLE IF NOT EXISTS variant_adr_specifications (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  variant_id TEXT UNIQUE NOT NULL REFERENCES variants(id),
  un_number TEXT NOT NULL CHECK(un_number GLOB 'UN [0-9][0-9][0-9][0-9]' OR un_number = 'NONE'),
  proper_shipping_name TEXT NOT NULL CHECK(length(trim(proper_shipping_name)) BETWEEN 2 AND 200),
  adr_class TEXT NOT NULL CHECK(adr_class IN ('8', '3', '5.1', '6.1', '9', 'NONE')),
  packing_group TEXT NOT NULL CHECK(packing_group IN ('I', 'II', 'III', 'NONE')),
  tunnel_code TEXT NOT NULL CHECK(tunnel_code IN ('(E)', '(D/E)', '(B/D)', 'NONE')),
  limited_quantity TEXT NOT NULL CHECK(length(trim(limited_quantity)) BETWEEN 1 AND 20),
  adr_points_factor INTEGER NOT NULL DEFAULT 1 CHECK(adr_points_factor IN (0, 1, 3, 20, 50)),
  pictograms_json TEXT NOT NULL CHECK(json_valid(pictograms_json)),
  signal_word TEXT NOT NULL CHECK(signal_word IN ('PELIGRO', 'ATENCIÓN', 'NONE')),
  hazard_statements_json TEXT NOT NULL CHECK(json_valid(hazard_statements_json)),
  precautionary_statements_json TEXT NOT NULL CHECK(json_valid(precautionary_statements_json)),
  ufi_code TEXT CHECK(ufi_code IS NULL OR length(trim(ufi_code)) BETWEEN 10 AND 50),
  handling_instructions_json TEXT NOT NULL CHECK(json_valid(handling_instructions_json)),
  sds_version TEXT NOT NULL CHECK(length(trim(sds_version)) BETWEEN 1 AND 20),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE TRIGGER IF NOT EXISTS variant_adr_specifications_cas BEFORE UPDATE ON variant_adr_specifications
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_conflict'); END;

CREATE TABLE IF NOT EXISTS warehouse_lot_records (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  lot_number TEXT UNIQUE NOT NULL CHECK(length(trim(lot_number)) BETWEEN 3 AND 64),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  spec_version INTEGER NOT NULL CHECK(spec_version >= 1),
  manufacturing_date TEXT NOT NULL CHECK(manufacturing_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  expiry_date TEXT NOT NULL CHECK(expiry_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' AND expiry_date >= manufacturing_date),
  units_produced INTEGER NOT NULL CHECK(units_produced BETWEEN 1 AND 1000000),
  qa_release_status TEXT NOT NULL CHECK(qa_release_status IN ('approved', 'quarantine', 'rejected')),
  qa_released_by TEXT REFERENCES identities(id),
  qa_released_at TEXT CHECK(qa_released_at IS NULL OR qa_released_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', qa_released_at), '')),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_warehouse_lot_records_variant ON warehouse_lot_records(variant_id, qa_release_status);

CREATE TABLE IF NOT EXISTS warehouse_adr_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('upsert_spec', 'create_lot', 'qa_release_lot', 'generate_label', 'generate_transport_document')),
  target_id TEXT NOT NULL CHECK(length(trim(target_id)) BETWEEN 1 AND 64),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  result_version INTEGER NOT NULL CHECK(result_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (target_id, result_version)
) STRICT;

CREATE TRIGGER IF NOT EXISTS warehouse_adr_commands_no_update BEFORE UPDATE ON warehouse_adr_commands
BEGIN SELECT RAISE(ABORT, 'warehouse_adr_commands_immutable'); END;

CREATE TRIGGER IF NOT EXISTS warehouse_adr_commands_no_delete BEFORE DELETE ON warehouse_adr_commands
BEGIN SELECT RAISE(ABORT, 'warehouse_adr_commands_immutable'); END;
