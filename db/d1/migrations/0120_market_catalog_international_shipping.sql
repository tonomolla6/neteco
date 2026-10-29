-- 0120_market_catalog_international_shipping.sql
-- CAT-022: Catálogo por mercado/idioma (disponibilidad, contenido y cumplimiento sin clonar producto)
-- SHP-031: Envío internacional/restricciones por país (duties, documentación, químicos ADR y devoluciones)
-- CAT-020: Lotes, caducidad, bloqueo de expedición y trazabilidad de stock/clientes afectados

-- 1. Supported Markets Table
CREATE TABLE catalog_markets (
  code TEXT PRIMARY KEY CHECK(length(code) BETWEEN 2 AND 5 AND code = upper(code)),
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  default_locale TEXT NOT NULL CHECK(length(trim(default_locale)) BETWEEN 2 AND 10),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK(currency = 'EUR'),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

-- 2. Localized Product Market Configuration (CAT-022)
CREATE TABLE catalog_market_configs (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  market_code TEXT NOT NULL REFERENCES catalog_markets(code),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  -- Disponibilidad
  is_available INTEGER NOT NULL DEFAULT 1 CHECK(is_available IN (0, 1)),
  availability_status TEXT NOT NULL DEFAULT 'available' CHECK(availability_status IN ('available', 'preorder', 'discontinued', 'restricted', 'b2b_only')),
  min_order_quantity INTEGER NOT NULL DEFAULT 1 CHECK(min_order_quantity > 0),
  max_order_quantity INTEGER CHECK(max_order_quantity IS NULL OR max_order_quantity >= min_order_quantity),
  restriction_reason TEXT CHECK(restriction_reason IS NULL OR length(trim(restriction_reason)) <= 500),
  -- Contenido localizado sin clonar producto
  locale TEXT NOT NULL CHECK(length(trim(locale)) BETWEEN 2 AND 10),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 255),
  description TEXT NOT NULL CHECK(length(trim(description)) > 0),
  slug TEXT NOT NULL CHECK(length(trim(slug)) BETWEEN 1 AND 255),
  meta_title TEXT CHECK(meta_title IS NULL OR length(trim(meta_title)) <= 255),
  meta_description TEXT CHECK(meta_description IS NULL OR length(trim(meta_description)) <= 500),
  usage_instructions TEXT,
  -- Cumplimiento químico y regulatorio
  is_compliant INTEGER NOT NULL DEFAULT 1 CHECK(is_compliant IN (0, 1)),
  clp_warnings TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(clp_warnings)),
  ufi_code TEXT CHECK(ufi_code IS NULL OR length(trim(ufi_code)) BETWEEN 4 AND 40),
  registration_number TEXT CHECK(registration_number IS NULL OR length(trim(registration_number)) <= 100),
  sds_url TEXT CHECK(sds_url IS NULL OR sds_url LIKE 'https://%'),
  compliance_notes TEXT,
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  UNIQUE(product_id, market_code),
  UNIQUE(market_code, slug),
  CHECK(is_available = 0 OR is_compliant = 1)
) STRICT;

CREATE INDEX idx_catalog_market_configs_slug ON catalog_market_configs(market_code, slug);
CREATE INDEX idx_catalog_market_configs_product ON catalog_market_configs(product_id);

-- Append-only audit table for catalog market configuration commands
CREATE TABLE catalog_market_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  product_id TEXT NOT NULL REFERENCES products(id),
  market_code TEXT NOT NULL REFERENCES catalog_markets(code),
  action TEXT NOT NULL CHECK(action IN ('configure', 'set_availability', 'set_compliance', 'deactivate')),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  session_version INTEGER NOT NULL CHECK(session_version > 0),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  version INTEGER NOT NULL CHECK(version = expected_version + 1),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(product_id, market_code, version)
) STRICT;

CREATE TRIGGER catalog_market_commands_no_update BEFORE UPDATE ON catalog_market_commands BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER catalog_market_commands_no_delete BEFORE DELETE ON catalog_market_commands BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE TRIGGER catalog_market_commands_cas BEFORE INSERT ON catalog_market_commands
WHEN NEW.expected_version <> COALESCE((SELECT max(version) FROM catalog_market_commands WHERE product_id = NEW.product_id AND market_code = NEW.market_code), 0)
BEGIN SELECT RAISE(ABORT, 'conflict'); END;

CREATE TRIGGER catalog_market_commands_authority BEFORE INSERT ON catalog_market_commands
WHEN NOT EXISTS (
  SELECT 1 FROM auth_sessions s
  JOIN identities i ON i.id = s.identity_id
  WHERE s.id = NEW.session_id
    AND s.identity_id = NEW.actor_id
    AND s.session_version = NEW.session_version
    AND i.session_version = s.session_version
    AND s.revoked_at IS NULL
    AND s.mfa_verified = 1
    AND i.status IN ('active', 'pending')
    AND s.created_at <= NEW.created_at
    AND s.expires_at > max(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    AND i.email_verified_at IS NOT NULL
    AND i.email_verified_at <= NEW.created_at
    AND EXISTS (
      SELECT 1 FROM identity_roles r
      JOIN role_permissions p ON p.role_code = r.role_code
      WHERE r.identity_id = i.id
        AND p.permission_code = 'administration.manage'
        AND r.granted_at <= NEW.created_at
        AND (r.expires_at IS NULL OR r.expires_at > max(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))
    )
)
BEGIN SELECT RAISE(ABORT, 'authority'); END;

-- 3. International Shipping Policies per Market (SHP-031)
CREATE TABLE international_shipping_market_policies (
  market_code TEXT PRIMARY KEY REFERENCES catalog_markets(code),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  -- Duties & Customs
  customs_declared_value_required INTEGER NOT NULL DEFAULT 0 CHECK(customs_declared_value_required IN (0, 1)),
  duty_collection_type TEXT NOT NULL DEFAULT 'exempt' CHECK(duty_collection_type IN ('exempt', 'ddp', 'dap')),
  hs_tariff_code_required INTEGER NOT NULL DEFAULT 0 CHECK(hs_tariff_code_required IN (0, 1)),
  de_minimis_threshold_cents INTEGER NOT NULL DEFAULT 15000 CHECK(de_minimis_threshold_cents >= 0),
  estimated_duty_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK(estimated_duty_rate_bps >= 0 AND estimated_duty_rate_bps <= 10000),
  customs_handling_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK(customs_handling_fee_cents >= 0),
  -- Documentación
  required_documents TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(required_documents)),
  customs_declaration_notes TEXT,
  -- Químicos y restricciones ADR
  adr_allowed INTEGER NOT NULL DEFAULT 1 CHECK(adr_allowed IN (0, 1)),
  max_hazard_class TEXT NOT NULL DEFAULT 'unrestricted' CHECK(max_hazard_class IN ('none', 'unrestricted', 'limited_quantity_only', 'class_2', 'class_3', 'class_8')),
  prohibited_un_numbers TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(prohibited_un_numbers)),
  max_dangerous_goods_volume_liters INTEGER NOT NULL DEFAULT 50 CHECK(max_dangerous_goods_volume_liters >= 0),
  requires_special_adr_carrier INTEGER NOT NULL DEFAULT 0 CHECK(requires_special_adr_carrier IN (0, 1)),
  -- Devoluciones definidas por mercado
  returns_permitted INTEGER NOT NULL DEFAULT 1 CHECK(returns_permitted IN (0, 1)),
  return_window_days INTEGER NOT NULL DEFAULT 14 CHECK(return_window_days >= 0 AND return_window_days <= 365),
  hazardous_returns_allowed INTEGER NOT NULL DEFAULT 0 CHECK(hazardous_returns_allowed IN (0, 1)),
  return_carrier_code TEXT CHECK(return_carrier_code IS NULL OR length(trim(return_carrier_code)) <= 50),
  customer_return_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK(customer_return_fee_cents >= 0),
  return_policy_notes TEXT,
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE TABLE international_shipping_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  market_code TEXT NOT NULL REFERENCES catalog_markets(code),
  action TEXT NOT NULL CHECK(action IN ('configure_policy', 'update_duties', 'update_adr_restrictions', 'update_returns')),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  session_version INTEGER NOT NULL CHECK(session_version > 0),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  version INTEGER NOT NULL CHECK(version = expected_version + 1),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(market_code, version)
) STRICT;

CREATE TRIGGER international_shipping_commands_no_update BEFORE UPDATE ON international_shipping_commands BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER international_shipping_commands_no_delete BEFORE DELETE ON international_shipping_commands BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE TRIGGER international_shipping_commands_cas BEFORE INSERT ON international_shipping_commands
WHEN NEW.expected_version <> COALESCE((SELECT max(version) FROM international_shipping_commands WHERE market_code = NEW.market_code), 0)
BEGIN SELECT RAISE(ABORT, 'conflict'); END;

CREATE TRIGGER international_shipping_commands_authority BEFORE INSERT ON international_shipping_commands
WHEN NOT EXISTS (
  SELECT 1 FROM auth_sessions s
  JOIN identities i ON i.id = s.identity_id
  WHERE s.id = NEW.session_id
    AND s.identity_id = NEW.actor_id
    AND s.session_version = NEW.session_version
    AND i.session_version = s.session_version
    AND s.revoked_at IS NULL
    AND s.mfa_verified = 1
    AND i.status IN ('active', 'pending')
    AND s.created_at <= NEW.created_at
    AND s.expires_at > max(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    AND i.email_verified_at IS NOT NULL
    AND i.email_verified_at <= NEW.created_at
    AND EXISTS (
      SELECT 1 FROM identity_roles r
      JOIN role_permissions p ON p.role_code = r.role_code
      WHERE r.identity_id = i.id
        AND p.permission_code = 'administration.manage'
        AND r.granted_at <= NEW.created_at
        AND (r.expires_at IS NULL OR r.expires_at > max(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))
    )
)
BEGIN SELECT RAISE(ABORT, 'authority'); END;

-- 4. Variant Lot Tracking Policies & Expedition Blocks (CAT-020)
CREATE TABLE catalog_lot_tracking_policies (
  variant_id TEXT PRIMARY KEY REFERENCES variants(id),
  lot_tracking_required INTEGER NOT NULL DEFAULT 1 CHECK(lot_tracking_required IN (0, 1)),
  shelf_life_days INTEGER NOT NULL DEFAULT 365 CHECK(shelf_life_days > 0),
  min_shelf_life_dispatch_days INTEGER NOT NULL DEFAULT 30 CHECK(min_shelf_life_dispatch_days >= 0),
  quarantine_on_expiry INTEGER NOT NULL DEFAULT 1 CHECK(quarantine_on_expiry IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE TABLE lot_expedition_blocks (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  lot_id TEXT NOT NULL REFERENCES inventory_lots(id),
  block_reason TEXT NOT NULL CHECK(block_reason IN ('lot_expired', 'lot_recalled', 'lot_quarantined', 'manual_quarantine')),
  evidence TEXT NOT NULL CHECK(length(evidence) BETWEEN 4 AND 100 AND evidence NOT GLOB '*[^a-zA-Z0-9_-]*'),
  is_blocked INTEGER NOT NULL DEFAULT 1 CHECK(is_blocked IN (0, 1)),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  UNIQUE(lot_id)
) STRICT;

CREATE INDEX idx_lot_expedition_blocks_lot ON lot_expedition_blocks(lot_id, is_blocked);
