-- Migration 0140: INV-017 reorder points + purchase suggestions, INV-018 barcode-validated
-- receiving/picking/packing, INV-020 cycle counts with blind count, approval and root cause.
-- Single warehouse. Ledger/audit tables are append-only (triggers); mutable rows use CAS by version.

-- Shared idempotency + audit ledger (command_id + payload_hash).
CREATE TABLE inventory_planning_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  scope TEXT NOT NULL CHECK(scope IN ('reorder', 'scan', 'cycle_count')),
  action TEXT NOT NULL CHECK(length(action) BETWEEN 3 AND 40),
  target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 64),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE TRIGGER inventory_planning_commands_no_update BEFORE UPDATE ON inventory_planning_commands
BEGIN SELECT RAISE(ABORT, 'inventory_planning_command_immutable'); END;
CREATE TRIGGER inventory_planning_commands_no_delete BEFORE DELETE ON inventory_planning_commands
BEGIN SELECT RAISE(ABORT, 'inventory_planning_command_immutable'); END;

-- INV-017 ---------------------------------------------------------------
CREATE TABLE inventory_reorder_policies (
  variant_id TEXT PRIMARY KEY REFERENCES variants(id),
  lead_time_days INTEGER NOT NULL CHECK(lead_time_days BETWEEN 0 AND 365),
  review_days INTEGER NOT NULL DEFAULT 7 CHECK(review_days BETWEEN 0 AND 90),
  demand_window_days INTEGER NOT NULL DEFAULT 30 CHECK(demand_window_days BETWEEN 7 AND 180),
  order_multiple INTEGER NOT NULL DEFAULT 1 CHECK(order_multiple BETWEEN 1 AND 10000),
  min_order_quantity INTEGER NOT NULL DEFAULT 1 CHECK(min_order_quantity BETWEEN 1 AND 1000000),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  updated_by TEXT NOT NULL REFERENCES identities(id),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;
CREATE TRIGGER inventory_reorder_policies_cas BEFORE UPDATE ON inventory_reorder_policies
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_conflict'); END;

CREATE TABLE inventory_purchase_suggestions (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'superseded')),
  position_quantity INTEGER NOT NULL,
  safety_stock INTEGER NOT NULL CHECK(safety_stock >= 0),
  lead_time_days INTEGER NOT NULL CHECK(lead_time_days >= 0),
  daily_demand_milli INTEGER NOT NULL CHECK(daily_demand_milli >= 0),
  reorder_point INTEGER NOT NULL CHECK(reorder_point >= 0),
  suggested_quantity INTEGER NOT NULL CHECK(suggested_quantity BETWEEN 1 AND 1000000),
  approved_quantity INTEGER CHECK(approved_quantity IS NULL OR approved_quantity BETWEEN 1 AND 1000000),
  basis_hash TEXT NOT NULL CHECK(length(basis_hash) = 64),
  generated_by TEXT NOT NULL REFERENCES identities(id),
  decided_by TEXT REFERENCES identities(id),
  decision_note TEXT CHECK(decision_note IS NULL OR length(decision_note) BETWEEN 3 AND 500),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  CHECK((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL)),
  CHECK((status = 'approved') = (approved_quantity IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX inventory_purchase_suggestions_one_pending
  ON inventory_purchase_suggestions(variant_id) WHERE status = 'pending';
CREATE INDEX inventory_purchase_suggestions_status ON inventory_purchase_suggestions(status, created_at DESC);
CREATE TRIGGER inventory_purchase_suggestions_cas BEFORE UPDATE ON inventory_purchase_suggestions
WHEN NEW.version <> OLD.version + 1 OR OLD.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'version_conflict'); END;
CREATE TRIGGER inventory_purchase_suggestions_no_delete BEFORE DELETE ON inventory_purchase_suggestions
BEGIN SELECT RAISE(ABORT, 'inventory_purchase_suggestion_immutable'); END;

-- INV-018 ---------------------------------------------------------------
CREATE TABLE warehouse_scan_tasks (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  stage TEXT NOT NULL CHECK(stage IN ('receiving', 'picking', 'packing')),
  reference TEXT NOT NULL CHECK(length(trim(reference)) BETWEEN 2 AND 100),
  order_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('open', 'completed', 'completed_with_exceptions')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;
CREATE INDEX warehouse_scan_tasks_status ON warehouse_scan_tasks(stage, status, created_at DESC);
CREATE TRIGGER warehouse_scan_tasks_cas BEFORE UPDATE ON warehouse_scan_tasks
WHEN NEW.version <> OLD.version + 1 OR OLD.status <> 'open'
BEGIN SELECT RAISE(ABORT, 'version_conflict'); END;

CREATE TABLE warehouse_scan_task_lines (
  task_id TEXT NOT NULL REFERENCES warehouse_scan_tasks(id),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  sku TEXT NOT NULL,
  expected_quantity INTEGER NOT NULL CHECK(expected_quantity BETWEEN 1 AND 100000),
  scanned_quantity INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  PRIMARY KEY (task_id, variant_id),
  CHECK(scanned_quantity BETWEEN 0 AND expected_quantity)
) STRICT;
CREATE TRIGGER warehouse_scan_task_lines_cas BEFORE UPDATE ON warehouse_scan_task_lines
WHEN NEW.version <> OLD.version + 1 OR NEW.scanned_quantity < OLD.scanned_quantity
BEGIN SELECT RAISE(ABORT, 'version_conflict'); END;

CREATE TABLE warehouse_scan_events (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  command_id TEXT NOT NULL UNIQUE CHECK(length(command_id) = 36),
  task_id TEXT NOT NULL REFERENCES warehouse_scan_tasks(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  barcode TEXT NOT NULL CHECK(length(barcode) BETWEEN 1 AND 64),
  variant_id TEXT REFERENCES variants(id),
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 100000),
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted', 'rejected', 'exception')),
  reason_code TEXT CHECK(reason_code IS NULL OR length(reason_code) BETWEEN 3 AND 40),
  exception_note TEXT CHECK(exception_note IS NULL OR length(exception_note) BETWEEN 10 AND 500),
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  CHECK((outcome = 'accepted') = (reason_code IS NULL)),
  CHECK(outcome <> 'exception' OR exception_note IS NOT NULL)
) STRICT;
CREATE INDEX warehouse_scan_events_task ON warehouse_scan_events(task_id, created_at);
CREATE TRIGGER warehouse_scan_events_no_update BEFORE UPDATE ON warehouse_scan_events
BEGIN SELECT RAISE(ABORT, 'warehouse_scan_event_immutable'); END;
CREATE TRIGGER warehouse_scan_events_no_delete BEFORE DELETE ON warehouse_scan_events
BEGIN SELECT RAISE(ABORT, 'warehouse_scan_event_immutable'); END;

-- INV-020 ---------------------------------------------------------------
CREATE TABLE cycle_count_plans (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 3 AND 120),
  scheduled_for TEXT NOT NULL CHECK(scheduled_for = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', scheduled_for), '')),
  blind INTEGER NOT NULL DEFAULT 1 CHECK(blind IN (0, 1)),
  status TEXT NOT NULL CHECK(status IN ('planned', 'counting', 'review', 'closed', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;
CREATE INDEX cycle_count_plans_status ON cycle_count_plans(status, scheduled_for);
CREATE TRIGGER cycle_count_plans_cas BEFORE UPDATE ON cycle_count_plans
WHEN NEW.version <> OLD.version + 1 OR OLD.status IN ('closed', 'cancelled')
BEGIN SELECT RAISE(ABORT, 'version_conflict'); END;

CREATE TABLE cycle_count_lines (
  plan_id TEXT NOT NULL REFERENCES cycle_count_plans(id),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  expected_quantity INTEGER CHECK(expected_quantity IS NULL OR expected_quantity >= 0),
  counted_quantity INTEGER CHECK(counted_quantity IS NULL OR counted_quantity BETWEEN 0 AND 10000000),
  counted_by TEXT REFERENCES identities(id),
  status TEXT NOT NULL CHECK(status IN ('pending', 'counted', 'recount', 'approved', 'rejected')),
  root_cause TEXT CHECK(root_cause IS NULL OR root_cause IN
    ('miscount', 'receiving_error', 'picking_error', 'damage_loss', 'theft_suspected', 'supplier_shortage', 'system_error', 'unknown')),
  decision_note TEXT CHECK(decision_note IS NULL OR length(decision_note) BETWEEN 3 AND 500),
  decided_by TEXT REFERENCES identities(id),
  movement_id TEXT REFERENCES inventory_movements(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  PRIMARY KEY (plan_id, variant_id),
  CHECK(status NOT IN ('approved', 'rejected') OR decided_by IS NOT NULL)
) STRICT;
CREATE TRIGGER cycle_count_lines_cas BEFORE UPDATE ON cycle_count_lines
WHEN NEW.version <> OLD.version + 1 OR OLD.status IN ('approved', 'rejected')
BEGIN SELECT RAISE(ABORT, 'version_conflict'); END;

CREATE TABLE cycle_count_events (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  plan_id TEXT NOT NULL REFERENCES cycle_count_plans(id),
  variant_id TEXT REFERENCES variants(id),
  kind TEXT NOT NULL CHECK(kind IN ('planned', 'started', 'counted', 'recount_requested', 'approved', 'rejected', 'closed')),
  counted_quantity INTEGER,
  actor_id TEXT NOT NULL REFERENCES identities(id),
  note TEXT,
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE INDEX cycle_count_events_plan ON cycle_count_events(plan_id, created_at);
CREATE TRIGGER cycle_count_events_no_update BEFORE UPDATE ON cycle_count_events
BEGIN SELECT RAISE(ABORT, 'cycle_count_event_immutable'); END;
CREATE TRIGGER cycle_count_events_no_delete BEFORE DELETE ON cycle_count_events
BEGIN SELECT RAISE(ABORT, 'cycle_count_event_immutable'); END;
