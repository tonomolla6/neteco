-- INV-019: Lotes y caducidades (FEFO y trazabilidad a pedido/cliente)
-- INV-021: Coste medio/FIFO y margen analítico con conciliación financiera
-- INV-022: Forecast de demanda y anomalías (sugerencias no destructivas medidas contra baseline)

CREATE TABLE inventory_lots (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  lot_number TEXT NOT NULL CHECK(length(trim(lot_number)) BETWEEN 1 AND 100),
  location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'quarantined', 'depleted', 'expired')),
  manufactured_at TEXT CHECK(
    manufactured_at IS NULL OR (
      length(manufactured_at) = 20
      AND manufactured_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', manufactured_at), '')
    )
  ),
  expires_at TEXT NOT NULL CHECK(
    length(expires_at) = 20
    AND expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at), '')
  ),
  initial_quantity INTEGER NOT NULL CHECK(initial_quantity > 0),
  available_quantity INTEGER NOT NULL CHECK(available_quantity >= 0 AND available_quantity <= initial_quantity),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TEXT NOT NULL CHECK(
    length(created_at) = 20
    AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  ),
  updated_at TEXT NOT NULL CHECK(
    length(updated_at) = 20
    AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')
    AND updated_at >= created_at
  ),
  UNIQUE(variant_id, lot_number),
  CHECK(available_quantity > 0 OR status IN ('depleted', 'quarantined', 'expired'))
) STRICT;

CREATE INDEX inventory_lots_fefo_idx
  ON inventory_lots(variant_id, location_id, status, expires_at ASC, created_at ASC);

CREATE TABLE inventory_lot_allocations (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  lot_id TEXT NOT NULL REFERENCES inventory_lots(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  order_line_index INTEGER NOT NULL CHECK(order_line_index >= 0),
  customer_id TEXT REFERENCES customers(id),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK(
    length(created_at) = 20
    AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  )
) STRICT;

CREATE INDEX inventory_lot_alloc_lot_idx ON inventory_lot_allocations(lot_id, created_at);
CREATE INDEX inventory_lot_alloc_order_idx ON inventory_lot_allocations(order_id, order_line_index);
CREATE INDEX inventory_lot_alloc_customer_idx ON inventory_lot_allocations(customer_id, created_at) WHERE customer_id IS NOT NULL;

CREATE TRIGGER inventory_lot_allocations_no_update BEFORE UPDATE ON inventory_lot_allocations
BEGIN SELECT RAISE(ABORT, 'inventory_lot_allocations_immutable'); END;

CREATE TRIGGER inventory_lot_allocations_no_delete BEFORE DELETE ON inventory_lot_allocations
BEGIN SELECT RAISE(ABORT, 'inventory_lot_allocations_immutable'); END;

-- INV-021: Costing policy per variant (average cost vs FIFO)
CREATE TABLE inventory_costing_policies (
  variant_id TEXT PRIMARY KEY REFERENCES variants(id),
  method TEXT NOT NULL CHECK(method IN ('average_cost', 'fifo')),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK(currency = 'EUR'),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TEXT NOT NULL CHECK(
    length(created_at) = 20
    AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  ),
  updated_at TEXT NOT NULL CHECK(
    length(updated_at) = 20
    AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')
    AND updated_at >= created_at
  )
) STRICT;

-- Running weighted-average cost per variant & location
CREATE TABLE inventory_cost_balances (
  variant_id TEXT NOT NULL REFERENCES variants(id),
  location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  total_quantity INTEGER NOT NULL DEFAULT 0 CHECK(total_quantity >= 0),
  total_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK(total_cost_cents >= 0),
  unit_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK(unit_cost_cents >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at TEXT NOT NULL CHECK(
    length(updated_at) = 20
    AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')
  ),
  PRIMARY KEY (variant_id, location_id)
) STRICT;

-- FIFO Cost Layers recorded upon stock receipts
CREATE TABLE inventory_cost_layers (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  receipt_movement_id TEXT,
  unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents >= 0),
  initial_quantity INTEGER NOT NULL CHECK(initial_quantity > 0),
  remaining_quantity INTEGER NOT NULL CHECK(remaining_quantity >= 0 AND remaining_quantity <= initial_quantity),
  created_at TEXT NOT NULL CHECK(
    length(created_at) = 20
    AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  )
) STRICT;

CREATE INDEX inventory_cost_layers_fifo_idx
  ON inventory_cost_layers(variant_id, location_id, remaining_quantity, created_at ASC);

-- Analytical COGS consumption on fulfilled order lines with analytical margin
CREATE TABLE inventory_cost_consumptions (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  order_id TEXT NOT NULL REFERENCES orders(id),
  order_line_index INTEGER NOT NULL CHECK(order_line_index >= 0),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  method TEXT NOT NULL CHECK(method IN ('average_cost', 'fifo')),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents >= 0),
  total_cogs_cents INTEGER NOT NULL CHECK(total_cogs_cents >= 0),
  revenue_net_cents INTEGER NOT NULL CHECK(revenue_net_cents >= 0),
  margin_cents INTEGER NOT NULL CHECK(margin_cents = revenue_net_cents - total_cogs_cents),
  created_at TEXT NOT NULL CHECK(
    length(created_at) = 20
    AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  )
) STRICT;

CREATE INDEX inventory_cost_consumptions_order_idx
  ON inventory_cost_consumptions(order_id, order_line_index);
CREATE INDEX inventory_cost_consumptions_variant_idx
  ON inventory_cost_consumptions(variant_id, created_at);

CREATE TRIGGER inventory_cost_consumptions_no_update BEFORE UPDATE ON inventory_cost_consumptions
BEGIN SELECT RAISE(ABORT, 'inventory_cost_consumptions_immutable'); END;

CREATE TRIGGER inventory_cost_consumptions_no_delete BEFORE DELETE ON inventory_cost_consumptions
BEGIN SELECT RAISE(ABORT, 'inventory_cost_consumptions_immutable'); END;

-- INV-022: Demand model evaluation against baseline
CREATE TABLE inventory_demand_baselines (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  period_start TEXT NOT NULL CHECK(
    length(period_start) = 20
    AND period_start = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', period_start), '')
  ),
  period_end TEXT NOT NULL CHECK(
    length(period_end) = 20
    AND period_end = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', period_end), '')
  ),
  baseline_model TEXT NOT NULL CHECK(baseline_model IN ('naive_last_period', 'simple_moving_average')),
  baseline_mae REAL NOT NULL CHECK(baseline_mae >= 0),
  advanced_model TEXT NOT NULL CHECK(advanced_model IN ('exponential_smoothing', 'trend_adjusted')),
  advanced_mae REAL NOT NULL CHECK(advanced_mae >= 0),
  mae_improvement_percent REAL NOT NULL,
  forecast_daily_demand REAL NOT NULL CHECK(forecast_daily_demand >= 0),
  created_at TEXT NOT NULL CHECK(
    length(created_at) = 20
    AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  )
) STRICT;

CREATE INDEX inventory_demand_baselines_variant_idx
  ON inventory_demand_baselines(variant_id, created_at DESC);

-- Reorder suggestions: suggestions only, no irreversible automatic action
CREATE TABLE inventory_reorder_suggestions (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  status TEXT NOT NULL DEFAULT 'suggested' CHECK(status IN ('suggested', 'reviewed', 'dismissed', 'ordered')),
  current_physical_stock INTEGER NOT NULL CHECK(current_physical_stock >= 0),
  safety_stock INTEGER NOT NULL CHECK(safety_stock >= 0),
  forecasted_daily_demand REAL NOT NULL CHECK(forecasted_daily_demand >= 0),
  lead_time_days INTEGER NOT NULL CHECK(lead_time_days > 0),
  suggested_quantity INTEGER NOT NULL CHECK(suggested_quantity > 0),
  suggested_reorder_date TEXT NOT NULL CHECK(
    length(suggested_reorder_date) = 20
    AND suggested_reorder_date = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', suggested_reorder_date), '')
  ),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 500),
  reviewed_by TEXT REFERENCES identities(id),
  reviewed_at TEXT CHECK(
    reviewed_at IS NULL OR (
      length(reviewed_at) = 20
      AND reviewed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', reviewed_at), '')
    )
  ),
  created_at TEXT NOT NULL CHECK(
    length(created_at) = 20
    AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  )
) STRICT;

CREATE INDEX inventory_reorder_sugg_variant_idx
  ON inventory_reorder_suggestions(variant_id, status, created_at DESC);

-- Demand anomaly signals (spikes or drops)
CREATE TABLE inventory_demand_anomalies (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  detected_at TEXT NOT NULL CHECK(
    length(detected_at) = 20
    AND detected_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', detected_at), '')
  ),
  kind TEXT NOT NULL CHECK(kind IN ('spike', 'drop')),
  severity TEXT NOT NULL CHECK(severity IN ('warning', 'critical')),
  observed_units INTEGER NOT NULL CHECK(observed_units >= 0),
  expected_units REAL NOT NULL CHECK(expected_units >= 0),
  z_score REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'acknowledged', 'resolved')),
  created_at TEXT NOT NULL CHECK(
    length(created_at) = 20
    AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  )
) STRICT;

CREATE INDEX inventory_demand_anomalies_idx
  ON inventory_demand_anomalies(variant_id, status, detected_at DESC);

-- Governed commands ledger
CREATE TABLE inventory_lots_costing_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input TEXT NOT NULL CHECK(json_valid(input)),
  response TEXT NOT NULL CHECK(json_valid(response)),
  result_version INTEGER NOT NULL CHECK(result_version >= 0),
  created_at TEXT NOT NULL CHECK(
    length(created_at) = 20
    AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  ),
  UNIQUE(actor_id, command_id)
) STRICT;

CREATE TRIGGER inventory_lots_costing_cmd_no_update BEFORE UPDATE ON inventory_lots_costing_commands
BEGIN SELECT RAISE(ABORT, 'inventory_lots_costing_commands_immutable'); END;

CREATE TRIGGER inventory_lots_costing_cmd_no_delete BEFORE DELETE ON inventory_lots_costing_commands
BEGIN SELECT RAISE(ABORT, 'inventory_lots_costing_commands_immutable'); END;
