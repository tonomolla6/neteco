-- Migration 0113: PDP-016 (Verified Reviews & Moderated Q&A), PDP-018 (Video/Demo & Expert Content), MED-016 (Short Dosage & Assembly Video Guides)

-- 1. PDP-016: Reviews verificadas con detección de fraude, consentimiento y respuesta
CREATE TABLE product_reviews (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  product_id TEXT NOT NULL REFERENCES products(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  order_id TEXT REFERENCES orders(id),
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 3 AND 160),
  content TEXT NOT NULL CHECK(length(content) BETWEEN 10 AND 3000),
  is_verified_buyer INTEGER NOT NULL DEFAULT 0 CHECK(is_verified_buyer IN (0, 1)),
  moderation_status TEXT NOT NULL DEFAULT 'pending' CHECK(moderation_status IN ('pending', 'approved', 'rejected', 'quarantined')),
  fraud_status TEXT NOT NULL DEFAULT 'clean' CHECK(fraud_status IN ('clean', 'flagged', 'blocked')),
  fraud_score REAL NOT NULL DEFAULT 0.0 CHECK(fraud_score >= 0.0),
  fraud_reasons_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(fraud_reasons_json)),
  consent_accepted INTEGER NOT NULL DEFAULT 1 CHECK(consent_accepted IN (0, 1)),
  consent_version TEXT NOT NULL DEFAULT '2026-v1' CHECK(length(consent_version) <= 32),
  consent_at TEXT NOT NULL CHECK(length(consent_at) = 20 AND consent_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', consent_at), '')),
  merchant_response TEXT CHECK(merchant_response IS NULL OR length(merchant_response) BETWEEN 3 AND 3000),
  merchant_responded_at TEXT CHECK(merchant_responded_at IS NULL OR (length(merchant_responded_at) = 20 AND merchant_responded_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', merchant_responded_at), ''))),
  merchant_responder_id TEXT REFERENCES identities(id),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 100),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_product_reviews_public ON product_reviews(product_id, moderation_status, created_at DESC);
CREATE INDEX idx_product_reviews_customer ON product_reviews(customer_id, product_id);
CREATE INDEX idx_product_reviews_moderation ON product_reviews(moderation_status, fraud_status, created_at ASC);

-- 2. PDP-016: Q&A moderado con respuesta oficial y consentimiento
CREATE TABLE product_questions (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  product_id TEXT NOT NULL REFERENCES products(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 3 AND 160),
  content TEXT NOT NULL CHECK(length(content) BETWEEN 10 AND 3000),
  is_verified_buyer INTEGER NOT NULL DEFAULT 0 CHECK(is_verified_buyer IN (0, 1)),
  moderation_status TEXT NOT NULL DEFAULT 'pending' CHECK(moderation_status IN ('pending', 'approved', 'rejected', 'answered')),
  fraud_status TEXT NOT NULL DEFAULT 'clean' CHECK(fraud_status IN ('clean', 'flagged', 'blocked')),
  fraud_score REAL NOT NULL DEFAULT 0.0 CHECK(fraud_score >= 0.0),
  official_answer TEXT CHECK(official_answer IS NULL OR length(official_answer) BETWEEN 3 AND 3000),
  answered_at TEXT CHECK(answered_at IS NULL OR (length(answered_at) = 20 AND answered_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', answered_at), ''))),
  answered_by TEXT REFERENCES identities(id),
  consent_accepted INTEGER NOT NULL DEFAULT 1 CHECK(consent_accepted IN (0, 1)),
  consent_version TEXT NOT NULL DEFAULT '2026-v1' CHECK(length(consent_version) <= 32),
  consent_at TEXT NOT NULL CHECK(length(consent_at) = 20 AND consent_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', consent_at), '')),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 100),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_product_questions_public ON product_questions(product_id, moderation_status, created_at DESC);
CREATE INDEX idx_product_questions_moderation ON product_questions(moderation_status, fraud_status, created_at ASC);

-- 3. PDP-016: Registro de comandos inmutable para reviews y Q&A (Idempotencia y CAS)
CREATE TABLE product_reviews_qa_commands (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  entity_id TEXT NOT NULL CHECK(length(entity_id) <= 64),
  entity_type TEXT NOT NULL CHECK(entity_type IN ('review', 'question')),
  action TEXT NOT NULL CHECK(action IN ('submit_review', 'submit_question', 'moderate_review', 'moderate_question', 'merchant_reply_review', 'official_answer_question', 'revoke_consent')),
  command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 64),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  applied_version INTEGER NOT NULL CHECK(applied_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(entity_id, command_id),
  UNIQUE(entity_id, applied_version)
) STRICT;

CREATE TRIGGER product_reviews_qa_commands_no_update BEFORE UPDATE ON product_reviews_qa_commands
BEGIN SELECT RAISE(ABORT, 'product_reviews_qa_commands_immutable'); END;

CREATE TRIGGER product_reviews_qa_commands_no_delete BEFORE DELETE ON product_reviews_qa_commands
BEGIN SELECT RAISE(ABORT, 'product_reviews_qa_commands_immutable'); END;

-- 4. PDP-018 & MED-016: Guías audiovisuales, contenido experto, dosificación y montaje
CREATE TABLE product_media_guides (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  product_id TEXT NOT NULL REFERENCES products(id),
  guide_type TEXT NOT NULL CHECK(guide_type IN ('expert_demo', 'dosage', 'application', 'assembly')),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 3 AND 160),
  description TEXT CHECK(description IS NULL OR length(description) <= 1000),
  expert_presenter TEXT CHECK(expert_presenter IS NULL OR length(expert_presenter) <= 100),
  expert_title TEXT CHECK(expert_title IS NULL OR length(expert_title) <= 150),
  video_url TEXT NOT NULL CHECK(length(video_url) BETWEEN 3 AND 500),
  mime_type TEXT NOT NULL DEFAULT 'video/mp4' CHECK(mime_type IN ('video/mp4', 'video/webm')),
  duration_seconds INTEGER NOT NULL CHECK(duration_seconds > 0 AND duration_seconds <= 3600),
  aspect_ratio TEXT NOT NULL DEFAULT '16:9' CHECK(aspect_ratio IN ('16:9', '9:16', '4:3', '1:1')),
  poster_url TEXT NOT NULL CHECK(length(poster_url) BETWEEN 3 AND 500),
  poster_optimized_webp TEXT CHECK(poster_optimized_webp IS NULL OR length(poster_optimized_webp) BETWEEN 3 AND 500),
  poster_width INTEGER NOT NULL DEFAULT 1280 CHECK(poster_width > 0),
  poster_height INTEGER NOT NULL DEFAULT 720 CHECK(poster_height > 0),
  subtitles_vtt_url TEXT CHECK(subtitles_vtt_url IS NULL OR length(subtitles_vtt_url) BETWEEN 3 AND 500),
  subtitles_language TEXT NOT NULL DEFAULT 'es' CHECK(length(subtitles_language) BETWEEN 2 AND 10),
  transcript_text TEXT NOT NULL CHECK(length(transcript_text) >= 10),
  steps_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(steps_json)),
  requires_consent INTEGER NOT NULL DEFAULT 0 CHECK(requires_consent IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('draft', 'published', 'archived')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_product_media_guides_search ON product_media_guides(product_id, status, sort_order ASC);
CREATE INDEX idx_product_media_guides_type ON product_media_guides(guide_type, status);

-- 5. PDP-018 & MED-016: Métricas y medición de uso anónima con consentimiento
CREATE TABLE product_media_usage_metrics (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  guide_id TEXT NOT NULL REFERENCES product_media_guides(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('impression', 'play_start', 'progress_25', 'progress_50', 'progress_75', 'complete', 'transcript_view', 'subtitles_toggle')),
  play_position_seconds REAL CHECK(play_position_seconds IS NULL OR play_position_seconds >= 0.0),
  session_hash TEXT NOT NULL CHECK(length(session_hash) = 64 AND session_hash NOT GLOB '*[^0-9a-f]*'),
  consent_verified INTEGER NOT NULL DEFAULT 1 CHECK(consent_verified IN (0, 1)),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_media_metrics_guide ON product_media_usage_metrics(guide_id, event_type);

CREATE TRIGGER product_media_usage_metrics_no_update BEFORE UPDATE ON product_media_usage_metrics
BEGIN SELECT RAISE(ABORT, 'product_media_usage_metrics_immutable'); END;

CREATE TRIGGER product_media_usage_metrics_no_delete BEFORE DELETE ON product_media_usage_metrics
BEGIN SELECT RAISE(ABORT, 'product_media_usage_metrics_immutable'); END;

-- 6. Comandos administrativos de guías audiovisuales (CAS e Idempotencia)
CREATE TABLE product_media_guides_commands (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  guide_id TEXT NOT NULL CHECK(length(guide_id) <= 64),
  action TEXT NOT NULL CHECK(action IN ('upsert_guide', 'archive_guide')),
  command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 64),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  applied_version INTEGER NOT NULL CHECK(applied_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(guide_id, command_id),
  UNIQUE(guide_id, applied_version)
) STRICT;

CREATE TRIGGER product_media_guides_commands_no_update BEFORE UPDATE ON product_media_guides_commands
BEGIN SELECT RAISE(ABORT, 'product_media_guides_commands_immutable'); END;

CREATE TRIGGER product_media_guides_commands_no_delete BEFORE DELETE ON product_media_guides_commands
BEGIN SELECT RAISE(ABORT, 'product_media_guides_commands_immutable'); END;
