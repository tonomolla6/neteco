-- Migration 0123: DAT-019 SEO & Content Dashboard, DAT-020 B2B Sales Metrics, DAT-021 Cost-to-Serve & Contribution Margin
-- STRICT tables, explicit checks, ISO-8601 UTC timestamps, CAS triggers, append-only immutable audit commands.

-- ----------------------------------------------------------------------------
-- DAT-019: SEO / Content Dashboard (Impressions, clicks, queries, landings, assisted revenue, freshness, costs)
-- ----------------------------------------------------------------------------

CREATE TABLE seo_content_performance_metrics (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  landing_path TEXT NOT NULL CHECK(length(trim(landing_path)) BETWEEN 1 AND 500),
  query TEXT NOT NULL CHECK(length(trim(query)) BETWEEN 1 AND 250),
  device TEXT NOT NULL CHECK(device IN ('desktop', 'mobile', 'tablet', 'all')),
  sync_date TEXT NOT NULL CHECK(sync_date = strftime('%Y-%m-%d', sync_date)),
  data_through_date TEXT NOT NULL CHECK(data_through_date = strftime('%Y-%m-%d', data_through_date)),
  source TEXT NOT NULL CHECK(length(trim(source)) BETWEEN 1 AND 100),
  impressions INTEGER NOT NULL CHECK(impressions >= 0),
  clicks INTEGER NOT NULL CHECK(clicks >= 0),
  avg_position REAL NOT NULL CHECK(avg_position >= 0.0),
  assisted_orders_count INTEGER NOT NULL DEFAULT 0 CHECK(assisted_orders_count >= 0),
  assisted_revenue_gross_cents INTEGER NOT NULL DEFAULT 0 CHECK(assisted_revenue_gross_cents >= 0),
  assisted_revenue_net_cents INTEGER NOT NULL DEFAULT 0 CHECK(assisted_revenue_net_cents >= 0),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(landing_path, query, device, sync_date)
) STRICT;

CREATE INDEX idx_seo_perf_date ON seo_content_performance_metrics(sync_date DESC);
CREATE INDEX idx_seo_perf_landing ON seo_content_performance_metrics(landing_path, sync_date DESC);
CREATE INDEX idx_seo_perf_query ON seo_content_performance_metrics(query, sync_date DESC);

CREATE TRIGGER seo_content_perf_no_update BEFORE UPDATE ON seo_content_performance_metrics
BEGIN SELECT RAISE(ABORT, 'seo_content_performance_immutable'); END;

CREATE TRIGGER seo_content_perf_no_delete BEFORE DELETE ON seo_content_performance_metrics
BEGIN SELECT RAISE(ABORT, 'seo_content_performance_immutable'); END;

CREATE TABLE seo_content_costs (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  landing_path TEXT NOT NULL CHECK(length(trim(landing_path)) BETWEEN 1 AND 500),
  period_start TEXT NOT NULL CHECK(period_start = strftime('%Y-%m-%d', period_start)),
  period_end TEXT NOT NULL CHECK(period_end = strftime('%Y-%m-%d', period_end)),
  cost_cents INTEGER NOT NULL CHECK(cost_cents >= 0),
  cost_type TEXT NOT NULL CHECK(cost_type IN ('copywriting', 'translation', 'design', 'update', 'audit', 'general')),
  description TEXT NOT NULL CHECK(length(trim(description)) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_seo_content_costs_landing ON seo_content_costs(landing_path, period_start DESC);

CREATE TRIGGER seo_content_costs_no_update BEFORE UPDATE ON seo_content_costs
BEGIN SELECT RAISE(ABORT, 'seo_content_costs_immutable'); END;

CREATE TRIGGER seo_content_costs_no_delete BEFORE DELETE ON seo_content_costs
BEGIN SELECT RAISE(ABORT, 'seo_content_costs_immutable'); END;

CREATE TABLE seo_content_sync_commands (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  command_id TEXT NOT NULL CHECK(length(trim(command_id)) BETWEEN 1 AND 128),
  session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  session_version INTEGER NOT NULL CHECK(session_version >= 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  sync_date TEXT NOT NULL,
  records_processed INTEGER NOT NULL CHECK(records_processed >= 0),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(actor_id, command_id)
) STRICT;

CREATE TRIGGER seo_sync_cmd_authority BEFORE INSERT ON seo_content_sync_commands
WHEN NOT EXISTS(
  SELECT 1 FROM auth_sessions s
  JOIN identities i ON i.id = s.identity_id
  WHERE s.id = NEW.session_id AND s.identity_id = NEW.actor_id AND s.session_version = NEW.session_version
    AND i.session_version = s.session_version AND i.status IN ('active', 'pending')
    AND i.email_verified_at IS NOT NULL AND i.email_verified_at <= NEW.created_at
    AND s.mfa_verified = 1 AND s.revoked_at IS NULL
    AND s.created_at <= NEW.created_at AND s.expires_at > NEW.created_at
    AND EXISTS(
      SELECT 1 FROM identity_roles r
      JOIN role_permissions p ON p.role_code = r.role_code
      WHERE r.identity_id = i.id AND p.permission_code = 'administration.manage'
        AND r.granted_at <= NEW.created_at AND (r.expires_at IS NULL OR r.expires_at > NEW.created_at)
    )
)
BEGIN SELECT RAISE(ABORT, 'seo_sync_authorization_changed'); END;

CREATE TRIGGER seo_sync_cmd_no_update BEFORE UPDATE ON seo_content_sync_commands
BEGIN SELECT RAISE(ABORT, 'seo_sync_command_immutable'); END;

CREATE TRIGGER seo_sync_cmd_no_delete BEFORE DELETE ON seo_content_sync_commands
BEGIN SELECT RAISE(ABORT, 'seo_sync_command_immutable'); END;

CREATE TABLE seo_content_cost_commands (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  command_id TEXT NOT NULL CHECK(length(trim(command_id)) BETWEEN 1 AND 128),
  session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  session_version INTEGER NOT NULL CHECK(session_version >= 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  landing_path TEXT NOT NULL,
  cost_cents INTEGER NOT NULL CHECK(cost_cents >= 0),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(actor_id, command_id)
) STRICT;

CREATE TRIGGER seo_cost_cmd_authority BEFORE INSERT ON seo_content_cost_commands
WHEN NOT EXISTS(
  SELECT 1 FROM auth_sessions s
  JOIN identities i ON i.id = s.identity_id
  WHERE s.id = NEW.session_id AND s.identity_id = NEW.actor_id AND s.session_version = NEW.session_version
    AND i.session_version = s.session_version AND i.status IN ('active', 'pending')
    AND i.email_verified_at IS NOT NULL AND i.email_verified_at <= NEW.created_at
    AND s.mfa_verified = 1 AND s.revoked_at IS NULL
    AND s.created_at <= NEW.created_at AND s.expires_at > NEW.created_at
    AND EXISTS(
      SELECT 1 FROM identity_roles r
      JOIN role_permissions p ON p.role_code = r.role_code
      WHERE r.identity_id = i.id AND p.permission_code = 'administration.manage'
        AND r.granted_at <= NEW.created_at AND (r.expires_at IS NULL OR r.expires_at > NEW.created_at)
    )
)
BEGIN SELECT RAISE(ABORT, 'seo_cost_authorization_changed'); END;

CREATE TRIGGER seo_cost_cmd_no_update BEFORE UPDATE ON seo_content_cost_commands
BEGIN SELECT RAISE(ABORT, 'seo_cost_command_immutable'); END;

CREATE TRIGGER seo_cost_cmd_no_delete BEFORE DELETE ON seo_content_cost_commands
BEGIN SELECT RAISE(ABORT, 'seo_cost_command_immutable'); END;

-- ----------------------------------------------------------------------------
-- DAT-020: B2B Sales Metrics (Activation, Conversion, Recurrence, Real Commercial Conditions)
-- Explicitly NO sedes, NO aprobadores, NO presupuestos departamentales
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS order_customer_ownership (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  bound_at TEXT NOT NULL CHECK(bound_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', bound_at), ''))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_order_customer_ownership_cust ON order_customer_ownership(customer_id, bound_at DESC);

CREATE TRIGGER IF NOT EXISTS order_cust_ownership_no_update BEFORE UPDATE ON order_customer_ownership
BEGIN SELECT RAISE(ABORT, 'order_customer_ownership_immutable'); END;

CREATE TRIGGER IF NOT EXISTS order_cust_ownership_no_delete BEFORE DELETE ON order_customer_ownership
BEGIN SELECT RAISE(ABORT, 'order_customer_ownership_immutable'); END;

CREATE TABLE b2b_sales_daily_snapshots (
  snapshot_date TEXT PRIMARY KEY CHECK(snapshot_date = strftime('%Y-%m-%d', snapshot_date)),
  total_companies INTEGER NOT NULL CHECK(total_companies >= 0),
  approved_companies INTEGER NOT NULL CHECK(approved_companies >= 0),
  activated_companies INTEGER NOT NULL CHECK(activated_companies >= 0),
  orders_count INTEGER NOT NULL CHECK(orders_count >= 0),
  revenue_gross_cents INTEGER NOT NULL CHECK(revenue_gross_cents >= 0),
  revenue_net_cents INTEGER NOT NULL CHECK(revenue_net_cents >= 0),
  average_order_value_cents INTEGER NOT NULL CHECK(average_order_value_cents >= 0),
  credit_limit_total_cents INTEGER NOT NULL CHECK(credit_limit_total_cents >= 0),
  credit_utilized_cents INTEGER NOT NULL CHECK(credit_utilized_cents >= 0),
  overdue_cents INTEGER NOT NULL CHECK(overdue_cents >= 0),
  blocked_companies_count INTEGER NOT NULL CHECK(blocked_companies_count >= 0),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE TRIGGER b2b_sales_snapshots_no_update BEFORE UPDATE ON b2b_sales_daily_snapshots
BEGIN SELECT RAISE(ABORT, 'b2b_sales_snapshot_immutable'); END;

CREATE TRIGGER b2b_sales_snapshots_no_delete BEFORE DELETE ON b2b_sales_daily_snapshots
BEGIN SELECT RAISE(ABORT, 'b2b_sales_snapshot_immutable'); END;

CREATE TABLE b2b_sales_commands (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  command_id TEXT NOT NULL CHECK(length(trim(command_id)) BETWEEN 1 AND 128),
  session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  session_version INTEGER NOT NULL CHECK(session_version >= 1),
  snapshot_date TEXT NOT NULL CHECK(snapshot_date = strftime('%Y-%m-%d', snapshot_date)),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(actor_id, command_id)
) STRICT;

CREATE TRIGGER b2b_sales_cmd_authority BEFORE INSERT ON b2b_sales_commands
WHEN NOT EXISTS(
  SELECT 1 FROM auth_sessions s
  JOIN identities i ON i.id = s.identity_id
  WHERE s.id = NEW.session_id AND s.identity_id = NEW.actor_id AND s.session_version = NEW.session_version
    AND i.session_version = s.session_version AND i.status IN ('active', 'pending')
    AND i.email_verified_at IS NOT NULL AND i.email_verified_at <= NEW.created_at
    AND s.mfa_verified = 1 AND s.revoked_at IS NULL
    AND s.created_at <= NEW.created_at AND s.expires_at > NEW.created_at
    AND EXISTS(
      SELECT 1 FROM identity_roles r
      JOIN role_permissions p ON p.role_code = r.role_code
      WHERE r.identity_id = i.id AND p.permission_code = 'administration.manage'
        AND r.granted_at <= NEW.created_at AND (r.expires_at IS NULL OR r.expires_at > NEW.created_at)
    )
)
BEGIN SELECT RAISE(ABORT, 'b2b_sales_authorization_changed'); END;

CREATE TRIGGER b2b_sales_cmd_no_update BEFORE UPDATE ON b2b_sales_commands
BEGIN SELECT RAISE(ABORT, 'b2b_sales_command_immutable'); END;

CREATE TRIGGER b2b_sales_cmd_no_delete BEFORE DELETE ON b2b_sales_commands
BEGIN SELECT RAISE(ABORT, 'b2b_sales_command_immutable'); END;

-- ----------------------------------------------------------------------------
-- DAT-021: Cost-to-Serve y Margen de Contribución
-- COGS, descuentos, pago, picking, porte real, devoluciones y soporte vinculados al pedido
-- ----------------------------------------------------------------------------

CREATE TABLE order_cost_to_serve (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK(currency = 'EUR'),
  gross_revenue_cents INTEGER NOT NULL CHECK(gross_revenue_cents >= 0),
  net_revenue_cents INTEGER NOT NULL CHECK(net_revenue_cents >= 0),
  tax_cents INTEGER NOT NULL CHECK(tax_cents >= 0),
  -- 7 factores vinculados al pedido
  cogs_cents INTEGER NOT NULL CHECK(cogs_cents >= 0),
  discount_cents INTEGER NOT NULL CHECK(discount_cents >= 0),
  payment_fee_cents INTEGER NOT NULL CHECK(payment_fee_cents >= 0),
  picking_cost_cents INTEGER NOT NULL CHECK(picking_cost_cents >= 0),
  shipping_real_cost_cents INTEGER NOT NULL CHECK(shipping_real_cost_cents >= 0),
  returns_cost_cents INTEGER NOT NULL CHECK(returns_cost_cents >= 0),
  support_cost_cents INTEGER NOT NULL CHECK(support_cost_cents >= 0),
  -- Totales y márgenes
  total_cost_to_serve_cents INTEGER NOT NULL CHECK(
    total_cost_to_serve_cents = cogs_cents + payment_fee_cents + picking_cost_cents + shipping_real_cost_cents + returns_cost_cents + support_cost_cents
  ),
  contribution_margin_cents INTEGER NOT NULL CHECK(
    contribution_margin_cents = net_revenue_cents - total_cost_to_serve_cents
  ),
  margin_ratio REAL NOT NULL,
  profitability_tier TEXT NOT NULL CHECK(profitability_tier IN ('high_margin', 'healthy_margin', 'low_margin', 'loss_making')),
  cost_breakdown_json TEXT NOT NULL CHECK(json_valid(cost_breakdown_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_order_cost_margin ON order_cost_to_serve(profitability_tier, margin_ratio);
CREATE INDEX idx_order_cost_created ON order_cost_to_serve(created_at DESC);

CREATE TRIGGER order_cost_to_serve_cas BEFORE UPDATE ON order_cost_to_serve
WHEN NEW.order_id IS NOT OLD.order_id OR NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'order_cost_to_serve_version_conflict'); END;

CREATE TRIGGER order_cost_to_serve_no_delete BEFORE DELETE ON order_cost_to_serve
BEGIN SELECT RAISE(ABORT, 'order_cost_to_serve_immutable'); END;

CREATE TABLE order_cost_to_serve_commands (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  command_id TEXT NOT NULL CHECK(length(trim(command_id)) BETWEEN 1 AND 128),
  session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  session_version INTEGER NOT NULL CHECK(session_version >= 1),
  order_id TEXT NOT NULL REFERENCES orders(id),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  version INTEGER NOT NULL CHECK(version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(actor_id, command_id),
  UNIQUE(order_id, expected_version)
) STRICT;

CREATE TRIGGER cost_to_serve_cmd_authority BEFORE INSERT ON order_cost_to_serve_commands
WHEN NOT EXISTS(
  SELECT 1 FROM auth_sessions s
  JOIN identities i ON i.id = s.identity_id
  WHERE s.id = NEW.session_id AND s.identity_id = NEW.actor_id AND s.session_version = NEW.session_version
    AND i.session_version = s.session_version AND i.status IN ('active', 'pending')
    AND i.email_verified_at IS NOT NULL AND i.email_verified_at <= NEW.created_at
    AND s.mfa_verified = 1 AND s.revoked_at IS NULL
    AND s.created_at <= NEW.created_at AND s.expires_at > NEW.created_at
    AND EXISTS(
      SELECT 1 FROM identity_roles r
      JOIN role_permissions p ON p.role_code = r.role_code
      WHERE r.identity_id = i.id AND p.permission_code = 'administration.manage'
        AND r.granted_at <= NEW.created_at AND (r.expires_at IS NULL OR r.expires_at > NEW.created_at)
    )
)
BEGIN SELECT RAISE(ABORT, 'cost_to_serve_authorization_changed'); END;

CREATE TRIGGER cost_to_serve_cmd_no_update BEFORE UPDATE ON order_cost_to_serve_commands
BEGIN SELECT RAISE(ABORT, 'cost_to_serve_command_immutable'); END;

CREATE TRIGGER cost_to_serve_cmd_no_delete BEFORE DELETE ON order_cost_to_serve_commands
BEGIN SELECT RAISE(ABORT, 'cost_to_serve_command_immutable'); END;
