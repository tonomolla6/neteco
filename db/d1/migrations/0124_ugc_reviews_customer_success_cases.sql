-- Migration 0124: MED-018 (UGC Reviews with Photos & Moderation), MED-020 (Customer Cases with Verifiable Evidence & Periodic Review), MKT-031 (Authorized Success Cases Without Community)

-- 1. UGC Reviews con consentimiento/licencia, PII, transparencia de incentivos y retirada (MED-018)
CREATE TABLE ugc_reviews (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  product_id TEXT NOT NULL REFERENCES products(id),
  customer_id TEXT NOT NULL REFERENCES identities(id),
  order_id TEXT REFERENCES orders(id),
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 3 AND 160),
  content TEXT NOT NULL CHECK(length(content) BETWEEN 10 AND 3000),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 100),
  is_verified_buyer INTEGER NOT NULL DEFAULT 0 CHECK(is_verified_buyer IN (0, 1)),
  moderation_status TEXT NOT NULL DEFAULT 'pending' CHECK(moderation_status IN ('pending', 'approved', 'rejected', 'quarantined', 'withdrawn')),
  moderation_reason TEXT CHECK(moderation_reason IS NULL OR length(moderation_reason) <= 500),
  moderated_at TEXT CHECK(moderated_at IS NULL OR (length(moderated_at) = 20 AND moderated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', moderated_at), ''))),
  moderated_by TEXT REFERENCES identities(id),
  consent_accepted INTEGER NOT NULL DEFAULT 1 CHECK(consent_accepted = 1),
  consent_version TEXT NOT NULL DEFAULT '2026-ugc-v1' CHECK(length(consent_version) <= 32),
  consent_at TEXT NOT NULL CHECK(length(consent_at) = 20 AND consent_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', consent_at), '')),
  license_terms TEXT NOT NULL DEFAULT 'royalty_free_commercial_display' CHECK(length(license_terms) <= 64),
  rights_confirmed INTEGER NOT NULL DEFAULT 1 CHECK(rights_confirmed = 1),
  has_incentive INTEGER NOT NULL DEFAULT 0 CHECK(has_incentive IN (0, 1)),
  incentive_type TEXT NOT NULL DEFAULT 'none' CHECK(incentive_type IN ('none', 'free_sample', 'discount_coupon', 'monetary_reward', 'loyalty_points')),
  incentive_description TEXT CHECK(incentive_description IS NULL OR length(incentive_description) <= 500),
  hidden_incentive_suspected INTEGER NOT NULL DEFAULT 0 CHECK(hidden_incentive_suspected IN (0, 1)),
  pii_detected INTEGER NOT NULL DEFAULT 0 CHECK(pii_detected IN (0, 1)),
  pii_details_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(pii_details_json)),
  pii_redacted_content TEXT CHECK(pii_redacted_content IS NULL OR length(pii_redacted_content) <= 3500),
  withdrawn_at TEXT CHECK(withdrawn_at IS NULL OR (length(withdrawn_at) = 20 AND withdrawn_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', withdrawn_at), ''))),
  withdrawn_by TEXT REFERENCES identities(id),
  withdrawn_reason TEXT CHECK(withdrawn_reason IS NULL OR length(withdrawn_reason) <= 500),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_ugc_reviews_public ON ugc_reviews(product_id, moderation_status, created_at DESC);
CREATE INDEX idx_ugc_reviews_customer ON ugc_reviews(customer_id, product_id);
CREATE INDEX idx_ugc_reviews_moderation ON ugc_reviews(moderation_status, created_at ASC);

-- 2. Fotos de reviews UGC con escaneo antivirus, hash SHA-256 y moderación (MED-018)
CREATE TABLE ugc_review_photos (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  review_id TEXT NOT NULL REFERENCES ugc_reviews(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL CHECK(length(storage_key) BETWEEN 5 AND 200),
  photo_url TEXT NOT NULL CHECK(length(photo_url) BETWEEN 5 AND 500),
  mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  file_size_bytes INTEGER NOT NULL CHECK(file_size_bytes > 0 AND file_size_bytes <= 10485760),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  width INTEGER NOT NULL CHECK(width > 0 AND width <= 8192),
  height INTEGER NOT NULL CHECK(height > 0 AND height <= 8192),
  antivirus_status TEXT NOT NULL DEFAULT 'scanning' CHECK(antivirus_status IN ('clean', 'infected', 'quarantined', 'scanning')),
  antivirus_scanner TEXT NOT NULL CHECK(length(antivirus_scanner) <= 64),
  antivirus_scan_at TEXT CHECK(antivirus_scan_at IS NULL OR (length(antivirus_scan_at) = 20 AND antivirus_scan_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', antivirus_scan_at), ''))),
  antivirus_signature TEXT CHECK(antivirus_signature IS NULL OR length(antivirus_signature) <= 128),
  moderation_status TEXT NOT NULL DEFAULT 'pending' CHECK(moderation_status IN ('pending', 'approved', 'rejected', 'quarantined')),
  moderation_reason TEXT CHECK(moderation_reason IS NULL OR length(moderation_reason) <= 500),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_ugc_photos_review ON ugc_review_photos(review_id, sort_order ASC);
CREATE INDEX idx_ugc_photos_antivirus ON ugc_review_photos(antivirus_status);

-- 3. Registro inmutable de comandos UGC (Idempotencia y CAS) (MED-018)
CREATE TABLE ugc_commands (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  entity_id TEXT NOT NULL CHECK(length(entity_id) <= 64),
  action TEXT NOT NULL CHECK(action IN ('submit_ugc_review', 'moderate_ugc_review', 'moderate_ugc_photo', 'withdraw_ugc_review', 'redact_ugc_pii')),
  command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 64),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  applied_version INTEGER NOT NULL CHECK(applied_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(entity_id, command_id),
  UNIQUE(entity_id, applied_version)
) STRICT;

CREATE TRIGGER ugc_commands_no_update BEFORE UPDATE ON ugc_commands
BEGIN SELECT RAISE(ABORT, 'ugc_commands_immutable'); END;

CREATE TRIGGER ugc_commands_no_delete BEFORE DELETE ON ugc_commands
BEGIN SELECT RAISE(ABORT, 'ugc_commands_immutable'); END;

-- 4. Casos de cliente con permiso firmado, evidencia y revisión periódica (MED-020, MKT-031)
CREATE TABLE customer_case_studies (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  slug TEXT NOT NULL UNIQUE CHECK(length(slug) BETWEEN 3 AND 100 AND slug NOT GLOB '*[^a-z0-9-]*'),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 5 AND 200),
  subtitle TEXT CHECK(subtitle IS NULL OR length(subtitle) <= 300),
  publication_status TEXT NOT NULL DEFAULT 'draft' CHECK(publication_status IN ('draft', 'published', 'archived')),
  -- Permiso firmado
  permission_signer_name TEXT NOT NULL CHECK(length(permission_signer_name) BETWEEN 2 AND 120),
  permission_signer_role TEXT NOT NULL CHECK(length(permission_signer_role) BETWEEN 2 AND 120),
  permission_company_name TEXT NOT NULL CHECK(length(permission_company_name) BETWEEN 2 AND 150),
  permission_company_cif TEXT NOT NULL CHECK(length(permission_company_cif) BETWEEN 5 AND 20),
  permission_document_ref TEXT NOT NULL CHECK(length(permission_document_ref) BETWEEN 3 AND 100),
  permission_document_sha256 TEXT NOT NULL CHECK(length(permission_document_sha256) = 64 AND permission_document_sha256 NOT GLOB '*[^0-9a-f]*'),
  permission_signed_at TEXT NOT NULL CHECK(length(permission_signed_at) = 20 AND permission_signed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', permission_signed_at), '')),
  permission_scope TEXT NOT NULL CHECK(length(permission_scope) BETWEEN 3 AND 100),
  publish_authorized_by_customer INTEGER NOT NULL CHECK(publish_authorized_by_customer IN (0, 1)),
  -- Contexto
  sector TEXT NOT NULL CHECK(length(sector) BETWEEN 2 AND 100),
  facility_description TEXT NOT NULL CHECK(length(facility_description) BETWEEN 5 AND 1000),
  initial_situation TEXT NOT NULL CHECK(length(initial_situation) BETWEEN 10 AND 2000),
  baseline_metrics_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(baseline_metrics_json)),
  -- Solución
  neteco_products_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(neteco_products_json)),
  dosage_protocol TEXT NOT NULL CHECK(length(dosage_protocol) BETWEEN 5 AND 2000),
  implementation_duration_weeks INTEGER NOT NULL CHECK(implementation_duration_weeks > 0 AND implementation_duration_weeks <= 104),
  solution_summary TEXT NOT NULL CHECK(length(solution_summary) BETWEEN 10 AND 3000),
  -- Resultado verificable
  outcome_metrics_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(outcome_metrics_json)),
  verification_method TEXT NOT NULL CHECK(length(verification_method) BETWEEN 5 AND 1000),
  verifier_identity TEXT NOT NULL CHECK(length(verifier_identity) BETWEEN 2 AND 150),
  verification_certificate_ref TEXT CHECK(verification_certificate_ref IS NULL OR length(verification_certificate_ref) <= 100),
  verification_evidence_sha256 TEXT NOT NULL CHECK(length(verification_evidence_sha256) = 64 AND verification_evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  -- Revisión periódica
  review_interval_months INTEGER NOT NULL DEFAULT 12 CHECK(review_interval_months IN (3, 6, 12, 24)),
  last_reviewed_at TEXT NOT NULL CHECK(length(last_reviewed_at) = 20 AND last_reviewed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', last_reviewed_at), '')),
  last_reviewed_by TEXT NOT NULL REFERENCES identities(id),
  next_review_due_at TEXT NOT NULL CHECK(length(next_review_due_at) = 20 AND next_review_due_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', next_review_due_at), '')),
  review_status TEXT NOT NULL DEFAULT 'current' CHECK(review_status IN ('current', 'due_soon', 'overdue', 'retired')),
  cover_image_url TEXT CHECK(cover_image_url IS NULL OR length(cover_image_url) <= 500),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  published_at TEXT CHECK(published_at IS NULL OR (length(published_at) = 20 AND published_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', published_at), ''))),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_case_studies_slug ON customer_case_studies(slug);
CREATE INDEX idx_case_studies_public ON customer_case_studies(publication_status, review_status, created_at DESC);
CREATE INDEX idx_case_studies_review_due ON customer_case_studies(review_status, next_review_due_at ASC);

-- 5. Registro inmutable de comandos de casos de cliente (Idempotencia y CAS) (MED-020, MKT-031)
CREATE TABLE customer_case_commands (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  entity_id TEXT NOT NULL CHECK(length(entity_id) <= 64),
  action TEXT NOT NULL CHECK(action IN ('create_case_study', 'update_case_study', 'publish_case_study', 'archive_case_study', 'perform_periodic_review', 'update_review_status')),
  command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 64),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  applied_version INTEGER NOT NULL CHECK(applied_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(entity_id, command_id),
  UNIQUE(entity_id, applied_version)
) STRICT;

CREATE TRIGGER customer_case_commands_no_update BEFORE UPDATE ON customer_case_commands
BEGIN SELECT RAISE(ABORT, 'customer_case_commands_immutable'); END;

CREATE TRIGGER customer_case_commands_no_delete BEFORE DELETE ON customer_case_commands
BEGIN SELECT RAISE(ABORT, 'customer_case_commands_immutable'); END;
