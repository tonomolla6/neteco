-- 0152_international_seo_channel_feeds_adr_lq.sql
-- SEO-033: revisión humana de traducciones por mercado (base del hreflang recíproco)
-- SEO-034: transformaciones de feeds por canal, versionadas e inmutables
-- SHP-029: restricciones de transportista y validación de especialista para ADR / cantidades limitadas

-- ---------------------------------------------------------------------------
-- SEO-033 -- una traducción solo es publicable si un humano la revisó para ESA versión del contenido.
-- ---------------------------------------------------------------------------
CREATE TABLE catalog_market_translation_reviews (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  product_id TEXT NOT NULL REFERENCES products(id),
  market_code TEXT NOT NULL REFERENCES catalog_markets(code),
  reviewed_config_version INTEGER NOT NULL CHECK(reviewed_config_version > 0),
  locale TEXT NOT NULL CHECK(length(trim(locale)) BETWEEN 2 AND 10),
  reviewer_name TEXT NOT NULL CHECK(length(trim(reviewer_name)) BETWEEN 2 AND 120),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  session_version INTEGER NOT NULL CHECK(session_version > 0),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(product_id, market_code, reviewed_config_version)
) STRICT;

CREATE TRIGGER catalog_market_translation_reviews_no_update BEFORE UPDATE ON catalog_market_translation_reviews BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER catalog_market_translation_reviews_no_delete BEFORE DELETE ON catalog_market_translation_reviews BEGIN SELECT RAISE(ABORT, 'immutable'); END;

-- La revisión solo vale para la versión y el idioma vigentes en el instante de escritura (atómico con el INSERT).
CREATE TRIGGER catalog_market_translation_reviews_current BEFORE INSERT ON catalog_market_translation_reviews
WHEN NOT EXISTS (
  SELECT 1 FROM catalog_market_configs c
  WHERE c.product_id = NEW.product_id AND c.market_code = NEW.market_code
    AND c.version = NEW.reviewed_config_version AND c.locale = NEW.locale
)
BEGIN SELECT RAISE(ABORT, 'stale_config'); END;

CREATE TRIGGER catalog_market_translation_reviews_authority BEFORE INSERT ON catalog_market_translation_reviews
WHEN NOT EXISTS (
  SELECT 1 FROM auth_sessions s
  JOIN identities i ON i.id = s.identity_id
  WHERE s.id = NEW.session_id AND s.identity_id = NEW.actor_id AND s.session_version = NEW.session_version
    AND i.session_version = s.session_version AND s.revoked_at IS NULL AND s.mfa_verified = 1
    AND i.status IN ('active', 'pending') AND s.created_at <= NEW.created_at
    AND s.expires_at > max(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    AND i.email_verified_at IS NOT NULL AND i.email_verified_at <= NEW.created_at
    AND EXISTS (
      SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code = r.role_code
      WHERE r.identity_id = i.id AND p.permission_code = 'administration.manage'
        AND r.granted_at <= NEW.created_at
        AND (r.expires_at IS NULL OR r.expires_at > max(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))
    )
)
BEGIN SELECT RAISE(ABORT, 'authority'); END;

-- ---------------------------------------------------------------------------
-- SEO-034 -- transformaciones por canal (versiones inmutables + activación auditada con CAS)
-- ---------------------------------------------------------------------------
CREATE TABLE channel_feed_transform_versions (
  channel TEXT NOT NULL CHECK(channel IN ('google_merchant', 'meta_catalog', 'price_comparator')),
  version INTEGER NOT NULL CHECK(version > 0),
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  config_hash TEXT NOT NULL CHECK(length(config_hash) = 64 AND config_hash NOT GLOB '*[^0-9a-f]*'),
  command_id TEXT NOT NULL UNIQUE CHECK(length(command_id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  PRIMARY KEY(channel, version)
) STRICT;

CREATE TRIGGER channel_feed_transform_versions_no_update BEFORE UPDATE ON channel_feed_transform_versions BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER channel_feed_transform_versions_no_delete BEFORE DELETE ON channel_feed_transform_versions BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER channel_feed_transform_versions_cas BEFORE INSERT ON channel_feed_transform_versions
WHEN NEW.version <> COALESCE((SELECT max(version) FROM channel_feed_transform_versions WHERE channel = NEW.channel), 0) + 1
BEGIN SELECT RAISE(ABORT, 'conflict'); END;

CREATE TABLE channel_feed_active_transforms (
  channel TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  FOREIGN KEY(channel, version) REFERENCES channel_feed_transform_versions(channel, version)
) STRICT;

CREATE TABLE channel_feed_activations (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  channel TEXT NOT NULL,
  from_version INTEGER NOT NULL CHECK(from_version >= 0),
  to_version INTEGER NOT NULL CHECK(to_version > 0),
  seq INTEGER NOT NULL CHECK(seq > 0),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  FOREIGN KEY(channel, to_version) REFERENCES channel_feed_transform_versions(channel, version),
  UNIQUE(channel, seq)
) STRICT;

CREATE TRIGGER channel_feed_activations_no_update BEFORE UPDATE ON channel_feed_activations BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER channel_feed_activations_no_delete BEFORE DELETE ON channel_feed_activations BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER channel_feed_activations_cas BEFORE INSERT ON channel_feed_activations
WHEN NEW.from_version <> COALESCE((SELECT version FROM channel_feed_active_transforms WHERE channel = NEW.channel), 0)
  OR NEW.seq <> COALESCE((SELECT max(seq) FROM channel_feed_activations WHERE channel = NEW.channel), 0) + 1
BEGIN SELECT RAISE(ABORT, 'conflict'); END;

-- Reparto de stock entre canales: la suma de allocationPercent de los canales activos nunca supera 100 (evita sobreventa entre canales).
CREATE TRIGGER channel_feed_active_transforms_allocation_insert BEFORE INSERT ON channel_feed_active_transforms
WHEN COALESCE((SELECT sum(json_extract(v.config_json, '$.allocationPercent'))
               FROM channel_feed_active_transforms a
               JOIN channel_feed_transform_versions v ON v.channel = a.channel AND v.version = a.version
               WHERE a.channel <> NEW.channel), 0)
   + COALESCE((SELECT json_extract(config_json, '$.allocationPercent') FROM channel_feed_transform_versions
               WHERE channel = NEW.channel AND version = NEW.version), 101) > 100
BEGIN SELECT RAISE(ABORT, 'allocation_exceeded'); END;
CREATE TRIGGER channel_feed_active_transforms_allocation_update BEFORE UPDATE ON channel_feed_active_transforms
WHEN COALESCE((SELECT sum(json_extract(v.config_json, '$.allocationPercent'))
               FROM channel_feed_active_transforms a
               JOIN channel_feed_transform_versions v ON v.channel = a.channel AND v.version = a.version
               WHERE a.channel <> NEW.channel), 0)
   + COALESCE((SELECT json_extract(config_json, '$.allocationPercent') FROM channel_feed_transform_versions
               WHERE channel = NEW.channel AND version = NEW.version), 101) > 100
BEGIN SELECT RAISE(ABORT, 'allocation_exceeded'); END;

-- ---------------------------------------------------------------------------
-- SHP-029 -- restricciones por transportista, comandos auditados y validación de especialista (DGSA)
-- ---------------------------------------------------------------------------
CREATE TABLE adr_carrier_restrictions (
  carrier_code TEXT NOT NULL CHECK(length(carrier_code) BETWEEN 2 AND 40 AND carrier_code NOT GLOB '*[^a-z0-9_]*'),
  adr_class TEXT NOT NULL CHECK(adr_class IN ('8', '3', '5.1', '6.1', '9', 'NONE')),
  packing_group TEXT NOT NULL CHECK(packing_group IN ('I', 'II', 'III', 'NONE')),
  allows_limited_quantity INTEGER NOT NULL CHECK(allows_limited_quantity IN (0, 1)),
  max_gross_grams_per_package INTEGER CHECK(max_gross_grams_per_package IS NULL OR max_gross_grams_per_package BETWEEN 1 AND 30000),
  documentation_note TEXT CHECK(documentation_note IS NULL OR length(documentation_note) <= 500),
  version INTEGER NOT NULL CHECK(version >= 1),
  updated_by TEXT NOT NULL REFERENCES identities(id),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  PRIMARY KEY(carrier_code, adr_class, packing_group),
  CHECK(allows_limited_quantity = 0 OR max_gross_grams_per_package IS NOT NULL)
) STRICT;

CREATE TABLE adr_lq_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  kind TEXT NOT NULL CHECK(kind IN ('carrier_restriction', 'specialist_validation')),
  target_key TEXT NOT NULL CHECK(length(target_key) BETWEEN 3 AND 120),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  result_version INTEGER NOT NULL CHECK(result_version = expected_version + 1),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  session_version INTEGER NOT NULL CHECK(session_version > 0),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(target_key, result_version)
) STRICT;

CREATE TRIGGER adr_lq_commands_no_update BEFORE UPDATE ON adr_lq_commands BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER adr_lq_commands_no_delete BEFORE DELETE ON adr_lq_commands BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER adr_lq_commands_cas BEFORE INSERT ON adr_lq_commands
WHEN NEW.expected_version <> COALESCE((SELECT max(result_version) FROM adr_lq_commands WHERE target_key = NEW.target_key), 0)
BEGIN SELECT RAISE(ABORT, 'conflict'); END;
CREATE TRIGGER adr_lq_commands_authority BEFORE INSERT ON adr_lq_commands
WHEN NOT EXISTS (
  SELECT 1 FROM auth_sessions s
  JOIN identities i ON i.id = s.identity_id
  WHERE s.id = NEW.session_id AND s.identity_id = NEW.actor_id AND s.session_version = NEW.session_version
    AND i.session_version = s.session_version AND s.revoked_at IS NULL AND s.mfa_verified = 1
    AND i.status IN ('active', 'pending') AND s.created_at <= NEW.created_at
    AND s.expires_at > max(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    AND i.email_verified_at IS NOT NULL AND i.email_verified_at <= NEW.created_at
    AND EXISTS (
      SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code = r.role_code
      WHERE r.identity_id = i.id AND p.permission_code = 'administration.manage'
        AND r.granted_at <= NEW.created_at
        AND (r.expires_at IS NULL OR r.expires_at > max(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))
    )
)
BEGIN SELECT RAISE(ABORT, 'authority'); END;

-- Historial append-only: la validación vigente es la de mayor version y solo cuenta si spec_version == versión actual de la ficha ADR.
CREATE TABLE adr_specialist_validations (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  version INTEGER NOT NULL CHECK(version >= 1),
  spec_version INTEGER NOT NULL CHECK(spec_version >= 1),
  status TEXT NOT NULL CHECK(status IN ('validated', 'rejected')),
  specialist_name TEXT NOT NULL CHECK(length(trim(specialist_name)) BETWEEN 2 AND 120),
  certificate_ref TEXT NOT NULL CHECK(length(trim(certificate_ref)) BETWEEN 3 AND 80),
  content_unit TEXT NOT NULL CHECK(content_unit IN ('ml', 'g')),
  inner_content_amount INTEGER NOT NULL CHECK(inner_content_amount > 0),
  units_per_outer INTEGER NOT NULL CHECK(units_per_outer > 0),
  outer_gross_grams INTEGER NOT NULL CHECK(outer_gross_grams > 0),
  gross_limit_grams INTEGER NOT NULL CHECK(gross_limit_grams BETWEEN 1 AND 30000),
  rejection_reason TEXT CHECK(rejection_reason IS NULL OR length(trim(rejection_reason)) BETWEEN 5 AND 500),
  command_id TEXT NOT NULL UNIQUE REFERENCES adr_lq_commands(command_id),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(variant_id, version),
  CHECK(status = 'validated' OR rejection_reason IS NOT NULL)
) STRICT;

CREATE TRIGGER adr_specialist_validations_no_update BEFORE UPDATE ON adr_specialist_validations BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER adr_specialist_validations_no_delete BEFORE DELETE ON adr_specialist_validations BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER adr_specialist_validations_current_spec BEFORE INSERT ON adr_specialist_validations
WHEN NOT EXISTS (SELECT 1 FROM variant_adr_specifications s WHERE s.variant_id = NEW.variant_id AND s.version = NEW.spec_version)
BEGIN SELECT RAISE(ABORT, 'stale_spec'); END;
