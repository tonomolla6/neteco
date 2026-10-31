-- MKT-032: Calendario de campañas estacionales por sector.
-- Necesidad, ventana, inventario, logística, contenido y margen coordinados; postmortem por campaña.
-- Cloudflare D1 STRICT, CAS versioning, append-only command ledger.

CREATE TABLE seasonal_sector_campaigns (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  code TEXT NOT NULL UNIQUE CHECK(length(code) BETWEEN 3 AND 64 AND code NOT GLOB '*[^a-z0-9_-]*'),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 3 AND 200),
  sector TEXT NOT NULL CHECK(sector IN ('horeca', 'healthcare', 'education', 'industrial', 'facility_services', 'food_processing', 'general_b2b')),
  season TEXT NOT NULL CHECK(season IN ('spring', 'summer', 'autumn', 'winter', 'all_year', 'custom')),
  year INTEGER NOT NULL CHECK(year BETWEEN 2024 AND 2035),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'planned', 'active', 'paused', 'completed', 'cancelled')),

  -- Pillar 1: Necesidad
  need_justification TEXT NOT NULL CHECK(length(trim(need_justification)) BETWEEN 10 AND 2000),
  target_customer_profile TEXT NOT NULL CHECK(target_customer_profile IN ('all_b2b', 'horeca_operators', 'industrial_plants', 'facility_contractors', 'clinics_residencias', 'educational_centers')),

  -- Pillar 2: Ventana
  procurement_start_at TEXT NOT NULL CHECK(length(procurement_start_at) = 20 AND procurement_start_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', procurement_start_at), '')),
  window_start_at TEXT NOT NULL CHECK(length(window_start_at) = 20 AND window_start_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', window_start_at), '') AND window_start_at >= procurement_start_at),
  window_end_at TEXT NOT NULL CHECK(length(window_end_at) = 20 AND window_end_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', window_end_at), '') AND window_end_at >= window_start_at),

  -- Pillar 3: Inventario (JSON array de skus, variantes, unidades previstas y stock de seguridad)
  inventory_plan_json TEXT NOT NULL CHECK(json_valid(inventory_plan_json)),

  -- Pillar 4: Logística (JSON de perfiles permitidos, instrucciones a transportista, plazos y empaque)
  logistics_plan_json TEXT NOT NULL CHECK(json_valid(logistics_plan_json)),

  -- Pillar 5: Contenido (JSON de landing slug, slots de banner, código email y tags de marketing)
  content_plan_json TEXT NOT NULL CHECK(json_valid(content_plan_json)),

  -- Pillar 6: Margen & Presupuesto financiero
  target_revenue_cents INTEGER NOT NULL CHECK(target_revenue_cents >= 0),
  budget_limit_cents INTEGER NOT NULL CHECK(budget_limit_cents >= 0),
  min_margin_basis_points INTEGER NOT NULL CHECK(min_margin_basis_points BETWEEN 0 AND 10000),
  max_discount_basis_points INTEGER NOT NULL CHECK(max_discount_basis_points BETWEEN 0 AND 10000),

  -- Versión y auditoría
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  created_by TEXT NOT NULL REFERENCES identities(id)
) STRICT;

CREATE INDEX idx_seasonal_campaigns_lookup ON seasonal_sector_campaigns(sector, season, year, status);
CREATE INDEX idx_seasonal_campaigns_dates ON seasonal_sector_campaigns(status, window_start_at, window_end_at);

-- Postmortem por campaña
CREATE TABLE seasonal_campaign_postmortems (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  campaign_id TEXT NOT NULL UNIQUE REFERENCES seasonal_sector_campaigns(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'approved', 'archived')),
  actual_revenue_cents INTEGER NOT NULL CHECK(actual_revenue_cents >= 0),
  actual_margin_basis_points INTEGER NOT NULL CHECK(actual_margin_basis_points BETWEEN -10000 AND 10000),
  target_margin_achieved INTEGER NOT NULL CHECK(target_margin_achieved IN (0, 1)),
  stockout_occurred INTEGER NOT NULL CHECK(stockout_occurred IN (0, 1)),
  stockout_details TEXT,
  logistics_incidents_count INTEGER NOT NULL DEFAULT 0 CHECK(logistics_incidents_count >= 0),
  logistics_incident_notes TEXT,
  content_performance_score INTEGER CHECK(content_performance_score IS NULL OR content_performance_score BETWEEN 0 AND 100),
  roi_basis_points INTEGER CHECK(roi_basis_points IS NULL OR roi_basis_points >= -10000),
  key_learnings TEXT NOT NULL CHECK(length(trim(key_learnings)) BETWEEN 10 AND 4000),
  action_items_json TEXT NOT NULL CHECK(json_valid(action_items_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  created_by TEXT NOT NULL REFERENCES identities(id)
) STRICT;

CREATE INDEX idx_seasonal_postmortems_campaign ON seasonal_campaign_postmortems(campaign_id, status);

-- Registro inmutable de comandos para trazabilidad
CREATE TABLE seasonal_campaign_commands (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  command_id TEXT NOT NULL UNIQUE CHECK(length(command_id) BETWEEN 6 AND 128),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create_campaign', 'update_campaign', 'change_status', 'save_postmortem', 'approve_postmortem')),
  campaign_id TEXT NOT NULL REFERENCES seasonal_sector_campaigns(id),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE TRIGGER seasonal_campaign_commands_no_update BEFORE UPDATE ON seasonal_campaign_commands
BEGIN SELECT RAISE(ABORT, 'seasonal_campaign_commands_immutable'); END;

CREATE TRIGGER seasonal_campaign_commands_no_delete BEFORE DELETE ON seasonal_campaign_commands
BEGIN SELECT RAISE(ABORT, 'seasonal_campaign_commands_immutable'); END;
