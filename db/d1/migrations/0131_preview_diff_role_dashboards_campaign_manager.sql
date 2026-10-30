-- Migration 0131: ADM-024 Visual preview comparison & automated regression,
--                 ADM-025 Configurable dashboard by role with mandatory alert protection,
--                 ADM-026 Commercial campaign manager & commercial calendar with conflict view.

-- ---------------------------------------------------------------------------
-- 1. ADM-024: Visual preview comparison & automated regression baselines
-- ---------------------------------------------------------------------------

CREATE TABLE cms_template_visual_baselines (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  template_name TEXT NOT NULL CHECK(template_name IN ('home', 'catalog', 'search', 'product', 'cart_empty', 'login', 'promotional_landing')),
  breakpoint TEXT NOT NULL CHECK(breakpoint IN ('mobile', 'tablet', 'desktop')),
  dom_structure_hash TEXT NOT NULL CHECK(length(dom_structure_hash) = 64),
  critical_selectors_json TEXT NOT NULL CHECK(json_valid(critical_selectors_json)),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'deprecated', 'in_review')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  UNIQUE(template_name, breakpoint)
) STRICT;

CREATE INDEX idx_cms_baselines_template ON cms_template_visual_baselines(template_name, status);

CREATE TABLE cms_preview_diff_runs (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  page_id TEXT NOT NULL,
  base_version INTEGER NOT NULL CHECK(base_version >= 0),
  compare_version INTEGER NOT NULL CHECK(compare_version >= 1),
  diff_summary_json TEXT NOT NULL CHECK(json_valid(diff_summary_json)),
  breakpoint TEXT NOT NULL CHECK(breakpoint IN ('mobile', 'tablet', 'desktop')),
  regression_passed INTEGER NOT NULL CHECK(regression_passed IN (0, 1)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  created_by TEXT REFERENCES identities(id)
) STRICT;

CREATE INDEX idx_cms_preview_runs_page ON cms_preview_diff_runs(page_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. ADM-025: Panel configurable por rol y vistas guardadas
-- ---------------------------------------------------------------------------

CREATE TABLE admin_role_dashboards (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  role_code TEXT NOT NULL UNIQUE REFERENCES roles(code),
  widget_layout_json TEXT NOT NULL CHECK(json_valid(widget_layout_json)),
  column_preferences_json TEXT NOT NULL CHECK(json_valid(column_preferences_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  updated_by TEXT REFERENCES identities(id)
) STRICT;

CREATE INDEX idx_role_dashboards_role ON admin_role_dashboards(role_code);

CREATE TABLE admin_role_saved_views (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  role_code TEXT REFERENCES roles(code),
  owner_id TEXT REFERENCES identities(id),
  view_type TEXT NOT NULL CHECK(view_type IN ('orders', 'catalog', 'campaigns', 'inventory', 'alerts')),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 100),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
  scope TEXT NOT NULL CHECK(scope IN ('role_shared', 'personal')),
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_saved_views_lookup ON admin_role_saved_views(view_type, role_code, owner_id, archived);

CREATE TABLE admin_dashboard_commands (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  command_id TEXT NOT NULL UNIQUE CHECK(length(command_id) BETWEEN 6 AND 128),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('save_role_dashboard', 'save_view', 'archive_view', 'set_default_view')),
  target_id TEXT NOT NULL CHECK(length(target_id) <= 64),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE TRIGGER admin_dashboard_commands_no_update BEFORE UPDATE ON admin_dashboard_commands
BEGIN SELECT RAISE(ABORT, 'admin_dashboard_commands_immutable'); END;

CREATE TRIGGER admin_dashboard_commands_no_delete BEFORE DELETE ON admin_dashboard_commands
BEGIN SELECT RAISE(ABORT, 'admin_dashboard_commands_immutable'); END;

-- ---------------------------------------------------------------------------
-- 3. ADM-026: Gestor de campañas comerciales y calendario
-- ---------------------------------------------------------------------------

CREATE TABLE commercial_campaigns (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  code TEXT NOT NULL UNIQUE CHECK(length(code) BETWEEN 3 AND 64 AND code NOT GLOB '*[^a-z0-9_-]*'),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 3 AND 200),
  description TEXT NOT NULL CHECK(length(trim(description)) BETWEEN 3 AND 2000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'scheduled', 'active', 'paused', 'completed', 'cancelled')),
  channel_type TEXT NOT NULL CHECK(channel_type IN ('omnichannel', 'web', 'email', 'mobile')),
  target_audience TEXT NOT NULL DEFAULT 'all' CHECK(target_audience IN ('all', 'b2b', 'b2c', 'vip', 'new_customers')),
  priority INTEGER NOT NULL DEFAULT 50 CHECK(priority BETWEEN 1 AND 100),
  budget_limit_cents INTEGER CHECK(budget_limit_cents IS NULL OR budget_limit_cents >= 0),
  start_at TEXT NOT NULL CHECK(length(start_at) = 20 AND start_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', start_at), '')),
  end_at TEXT NOT NULL CHECK(length(end_at) = 20 AND end_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', end_at), '') AND end_at >= start_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  created_by TEXT NOT NULL REFERENCES identities(id)
) STRICT;

CREATE INDEX idx_commercial_campaigns_dates ON commercial_campaigns(status, start_at, end_at);
CREATE INDEX idx_commercial_campaigns_audience ON commercial_campaigns(target_audience, status);

CREATE TABLE campaign_linked_assets (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  campaign_id TEXT NOT NULL REFERENCES commercial_campaigns(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL CHECK(asset_type IN ('banner', 'promotion', 'modal', 'email', 'landing')),
  asset_id TEXT NOT NULL CHECK(length(trim(asset_id)) BETWEEN 1 AND 100),
  asset_name TEXT NOT NULL CHECK(length(trim(asset_name)) BETWEEN 2 AND 200),
  placement_or_slot TEXT CHECK(placement_or_slot IS NULL OR length(trim(placement_or_slot)) BETWEEN 1 AND 100),
  start_at TEXT NOT NULL CHECK(length(start_at) = 20 AND start_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', start_at), '')),
  end_at TEXT NOT NULL CHECK(length(end_at) = 20 AND end_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', end_at), '') AND end_at >= start_at),
  status TEXT NOT NULL DEFAULT 'linked' CHECK(status IN ('linked', 'active', 'inactive', 'paused')),
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_campaign_assets_lookup ON campaign_linked_assets(asset_type, placement_or_slot, start_at, end_at);
CREATE INDEX idx_campaign_assets_campaign ON campaign_linked_assets(campaign_id, status);

CREATE TABLE commercial_campaign_commands (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  command_id TEXT NOT NULL UNIQUE CHECK(length(command_id) BETWEEN 6 AND 128),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create_campaign', 'update_campaign', 'link_asset', 'unlink_asset', 'change_status')),
  campaign_id TEXT NOT NULL REFERENCES commercial_campaigns(id),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE TRIGGER commercial_campaign_commands_no_update BEFORE UPDATE ON commercial_campaign_commands
BEGIN SELECT RAISE(ABORT, 'commercial_campaign_commands_immutable'); END;

CREATE TRIGGER commercial_campaign_commands_no_delete BEFORE DELETE ON commercial_campaign_commands
BEGIN SELECT RAISE(ABORT, 'commercial_campaign_commands_immutable'); END;
