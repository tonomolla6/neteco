-- INV-014: contract/customer stock commitments (backed by real reservations)
-- INV-015: picking locations inside the single warehouse (no transfers)
-- INV-016: purchase orders, receipts, discrepancies and receipt documents
--
-- Invariants kept from 0004: balances are mutated only together with an
-- append-only movement; reservations stay the single source of reserved stock
-- (a commitment is metadata over a reservation, never a second counter).

CREATE TABLE IF NOT EXISTS catalog_suppliers (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  code TEXT NOT NULL UNIQUE CHECK(length(trim(code)) BETWEEN 2 AND 50),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 160),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK(currency IN ('EUR', 'USD', 'GBP')),
  lead_time_days_default INTEGER NOT NULL DEFAULT 3 CHECK(lead_time_days_default >= 0),
  reliability_score INTEGER NOT NULL DEFAULT 95 CHECK(reliability_score BETWEEN 0 AND 100),
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK(payment_terms_days >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

-- Idempotent, immutable command journal shared by the three capabilities.
CREATE TABLE inventory_ops_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(length(action) BETWEEN 3 AND 60),
  target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 100),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response) = 'object'),
  result_version INTEGER NOT NULL CHECK(result_version >= 1),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE TRIGGER inventory_ops_commands_no_update BEFORE UPDATE ON inventory_ops_commands
BEGIN SELECT RAISE(ABORT, 'inventory_ops_commands_immutable'); END;
CREATE TRIGGER inventory_ops_commands_no_delete BEFORE DELETE ON inventory_ops_commands
BEGIN SELECT RAISE(ABORT, 'inventory_ops_commands_immutable'); END;

-- ---------------------------------------------------------------- INV-014
CREATE TABLE inventory_contract_commitments (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  reservation_id TEXT NOT NULL UNIQUE REFERENCES inventory_reservations(id),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  customer_id TEXT REFERENCES customers(id),
  contract_ref TEXT NOT NULL CHECK(length(trim(contract_ref)) BETWEEN 3 AND 100),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  committed_until TEXT NOT NULL CHECK(length(committed_until) = 20 AND committed_until = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', committed_until), '')),
  max_renewals INTEGER NOT NULL DEFAULT 0 CHECK(max_renewals BETWEEN 0 AND 12),
  renewal_count INTEGER NOT NULL DEFAULT 0 CHECK(renewal_count BETWEEN 0 AND max_renewals),
  release_reason TEXT CHECK(release_reason IS NULL OR length(release_reason) BETWEEN 5 AND 500),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  last_command_id TEXT NOT NULL REFERENCES inventory_ops_commands(command_id) DEFERRABLE INITIALLY DEFERRED,
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;
CREATE INDEX inventory_contract_commitments_variant_idx ON inventory_contract_commitments(variant_id, committed_until);
CREATE INDEX inventory_contract_commitments_customer_idx ON inventory_contract_commitments(customer_id) WHERE customer_id IS NOT NULL;
CREATE TRIGGER inventory_contract_commitments_no_delete BEFORE DELETE ON inventory_contract_commitments
BEGIN SELECT RAISE(ABORT, 'inventory_contract_commitments_permanent'); END;

-- ---------------------------------------------------------------- INV-015
-- Transfers between locations do not exist in a single-warehouse store.
CREATE TRIGGER inventory_movements_no_transfers BEFORE INSERT ON inventory_movements
WHEN NEW.movement_type IN ('transfer_in', 'transfer_out')
BEGIN SELECT RAISE(ABORT, 'single_warehouse_no_transfers'); END;

CREATE TABLE inventory_pick_locations (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  warehouse_location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  code TEXT NOT NULL CHECK(code GLOB '[A-Z0-9]*' AND code NOT GLOB '*[^A-Z0-9-]*' AND length(code) BETWEEN 2 AND 24),
  zone TEXT NOT NULL CHECK(length(trim(zone)) BETWEEN 1 AND 40),
  kind TEXT NOT NULL CHECK(kind IN ('pick', 'bulk', 'receiving', 'quarantine')),
  pick_sequence INTEGER NOT NULL CHECK(pick_sequence BETWEEN 0 AND 100000),
  capacity_units INTEGER CHECK(capacity_units IS NULL OR capacity_units > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  last_command_id TEXT NOT NULL REFERENCES inventory_ops_commands(command_id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  UNIQUE(warehouse_location_id, code)
) STRICT;
CREATE TRIGGER inventory_pick_locations_warehouse BEFORE INSERT ON inventory_pick_locations
WHEN NOT EXISTS (SELECT 1 FROM inventory_locations l WHERE l.id = NEW.warehouse_location_id AND l.kind = 'warehouse' AND l.active = 1)
BEGIN SELECT RAISE(ABORT, 'pick_location_requires_active_warehouse'); END;
CREATE TRIGGER inventory_pick_locations_no_delete BEFORE DELETE ON inventory_pick_locations
BEGIN SELECT RAISE(ABORT, 'inventory_pick_locations_permanent'); END;

CREATE TABLE inventory_pick_stock (
  pick_location_id TEXT NOT NULL REFERENCES inventory_pick_locations(id),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  quantity INTEGER NOT NULL CHECK(quantity >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  last_command_id TEXT NOT NULL REFERENCES inventory_ops_commands(command_id) DEFERRABLE INITIALLY DEFERRED,
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  PRIMARY KEY (pick_location_id, variant_id)
) STRICT;
CREATE INDEX inventory_pick_stock_variant_idx ON inventory_pick_stock(variant_id);

-- Located stock per (warehouse, variant) can never exceed what is physically
-- there, and a bin can never exceed its declared capacity.
CREATE TRIGGER inventory_pick_stock_within_physical_ins BEFORE INSERT ON inventory_pick_stock
WHEN (
  SELECT COALESCE(SUM(s.quantity), 0) FROM inventory_pick_stock s
  JOIN inventory_pick_locations p ON p.id = s.pick_location_id
  WHERE s.variant_id = NEW.variant_id
    AND p.warehouse_location_id = (SELECT warehouse_location_id FROM inventory_pick_locations WHERE id = NEW.pick_location_id)
) + NEW.quantity > COALESCE((
  SELECT b.physical_quantity FROM inventory_balances b
  WHERE b.variant_id = NEW.variant_id
    AND b.location_id = (SELECT warehouse_location_id FROM inventory_pick_locations WHERE id = NEW.pick_location_id)
), 0)
BEGIN SELECT RAISE(ABORT, 'pick_stock_exceeds_physical'); END;
CREATE TRIGGER inventory_pick_stock_within_physical_upd BEFORE UPDATE OF quantity ON inventory_pick_stock
WHEN NEW.quantity > OLD.quantity AND (
  SELECT COALESCE(SUM(s.quantity), 0) FROM inventory_pick_stock s
  JOIN inventory_pick_locations p ON p.id = s.pick_location_id
  WHERE s.variant_id = NEW.variant_id
    AND NOT (s.pick_location_id = NEW.pick_location_id)
    AND p.warehouse_location_id = (SELECT warehouse_location_id FROM inventory_pick_locations WHERE id = NEW.pick_location_id)
) + NEW.quantity > COALESCE((
  SELECT b.physical_quantity FROM inventory_balances b
  WHERE b.variant_id = NEW.variant_id
    AND b.location_id = (SELECT warehouse_location_id FROM inventory_pick_locations WHERE id = NEW.pick_location_id)
), 0)
BEGIN SELECT RAISE(ABORT, 'pick_stock_exceeds_physical'); END;
CREATE TRIGGER inventory_pick_stock_capacity_ins BEFORE INSERT ON inventory_pick_stock
WHEN (SELECT capacity_units FROM inventory_pick_locations WHERE id = NEW.pick_location_id) IS NOT NULL
  AND (SELECT COALESCE(SUM(quantity), 0) FROM inventory_pick_stock WHERE pick_location_id = NEW.pick_location_id) + NEW.quantity
      > (SELECT capacity_units FROM inventory_pick_locations WHERE id = NEW.pick_location_id)
BEGIN SELECT RAISE(ABORT, 'pick_location_capacity_exceeded'); END;
CREATE TRIGGER inventory_pick_stock_capacity_upd BEFORE UPDATE OF quantity ON inventory_pick_stock
WHEN NEW.quantity > OLD.quantity
  AND (SELECT capacity_units FROM inventory_pick_locations WHERE id = NEW.pick_location_id) IS NOT NULL
  AND (SELECT COALESCE(SUM(quantity), 0) FROM inventory_pick_stock WHERE pick_location_id = NEW.pick_location_id AND variant_id <> NEW.variant_id) + NEW.quantity
      > (SELECT capacity_units FROM inventory_pick_locations WHERE id = NEW.pick_location_id)
BEGIN SELECT RAISE(ABORT, 'pick_location_capacity_exceeded'); END;
CREATE TRIGGER inventory_pick_stock_active_only BEFORE INSERT ON inventory_pick_stock
WHEN NOT EXISTS (SELECT 1 FROM inventory_pick_locations WHERE id = NEW.pick_location_id AND active = 1)
BEGIN SELECT RAISE(ABORT, 'pick_location_inactive'); END;
CREATE TRIGGER inventory_pick_stock_no_delete BEFORE DELETE ON inventory_pick_stock
BEGIN SELECT RAISE(ABORT, 'inventory_pick_stock_permanent'); END;

CREATE TABLE inventory_pick_movements (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  kind TEXT NOT NULL CHECK(kind IN ('putaway', 'receipt_putaway', 'relocate', 'pick')),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  from_pick_location_id TEXT REFERENCES inventory_pick_locations(id),
  to_pick_location_id TEXT REFERENCES inventory_pick_locations(id),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  reference TEXT CHECK(reference IS NULL OR length(reference) BETWEEN 3 AND 200),
  command_id TEXT NOT NULL REFERENCES inventory_ops_commands(command_id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  CHECK(
    (kind IN ('putaway', 'receipt_putaway') AND from_pick_location_id IS NULL AND to_pick_location_id IS NOT NULL)
    OR (kind = 'relocate' AND from_pick_location_id IS NOT NULL AND to_pick_location_id IS NOT NULL AND from_pick_location_id <> to_pick_location_id)
    OR (kind = 'pick' AND from_pick_location_id IS NOT NULL AND to_pick_location_id IS NULL)
  )
) STRICT;
CREATE INDEX inventory_pick_movements_variant_idx ON inventory_pick_movements(variant_id, created_at);
CREATE TRIGGER inventory_pick_movements_no_update BEFORE UPDATE ON inventory_pick_movements
BEGIN SELECT RAISE(ABORT, 'inventory_pick_movements_immutable'); END;
CREATE TRIGGER inventory_pick_movements_no_delete BEFORE DELETE ON inventory_pick_movements
BEGIN SELECT RAISE(ABORT, 'inventory_pick_movements_immutable'); END;

-- ---------------------------------------------------------------- INV-016
CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  po_number TEXT NOT NULL UNIQUE CHECK(length(trim(po_number)) BETWEEN 3 AND 60),
  supplier_id TEXT NOT NULL REFERENCES catalog_suppliers(id),
  status TEXT NOT NULL CHECK(status IN ('draft', 'ordered', 'partially_received', 'received', 'closed', 'cancelled')),
  currency TEXT NOT NULL CHECK(currency IN ('EUR', 'USD', 'GBP')),
  expected_at TEXT CHECK(expected_at IS NULL OR (length(expected_at) = 20 AND expected_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expected_at), ''))),
  notes TEXT CHECK(notes IS NULL OR length(notes) BETWEEN 1 AND 1000),
  cancel_reason TEXT CHECK(cancel_reason IS NULL OR length(cancel_reason) BETWEEN 5 AND 500),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  last_command_id TEXT NOT NULL REFERENCES inventory_ops_commands(command_id) DEFERRABLE INITIALLY DEFERRED,
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  CHECK((status = 'cancelled') = (cancel_reason IS NOT NULL))
) STRICT;
CREATE INDEX purchase_orders_status_idx ON purchase_orders(status, created_at);
CREATE INDEX purchase_orders_supplier_idx ON purchase_orders(supplier_id, created_at);
CREATE TRIGGER purchase_orders_no_delete BEFORE DELETE ON purchase_orders
BEGIN SELECT RAISE(ABORT, 'purchase_orders_permanent'); END;

CREATE TABLE purchase_order_lines (
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id),
  line_index INTEGER NOT NULL CHECK(line_index >= 0),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  expected_quantity INTEGER NOT NULL CHECK(expected_quantity > 0),
  received_quantity INTEGER NOT NULL DEFAULT 0 CHECK(received_quantity >= 0),
  rejected_quantity INTEGER NOT NULL DEFAULT 0 CHECK(rejected_quantity >= 0),
  unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents >= 0),
  PRIMARY KEY (purchase_order_id, line_index),
  UNIQUE (purchase_order_id, variant_id)
) STRICT;
CREATE TRIGGER purchase_order_lines_no_delete BEFORE DELETE ON purchase_order_lines
BEGIN SELECT RAISE(ABORT, 'purchase_order_lines_permanent'); END;
CREATE TRIGGER purchase_order_lines_frozen BEFORE UPDATE ON purchase_order_lines
WHEN NEW.variant_id <> OLD.variant_id OR NEW.expected_quantity <> OLD.expected_quantity
  OR NEW.unit_cost_cents <> OLD.unit_cost_cents OR NEW.received_quantity < OLD.received_quantity
  OR NEW.rejected_quantity < OLD.rejected_quantity
BEGIN SELECT RAISE(ABORT, 'purchase_order_lines_frozen'); END;

CREATE TABLE purchase_receipts (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id),
  receipt_number TEXT NOT NULL CHECK(length(trim(receipt_number)) BETWEEN 3 AND 60),
  received_at TEXT NOT NULL CHECK(length(received_at) = 20 AND received_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', received_at), '')),
  notes TEXT CHECK(notes IS NULL OR length(notes) BETWEEN 1 AND 1000),
  command_id TEXT NOT NULL UNIQUE REFERENCES inventory_ops_commands(command_id) DEFERRABLE INITIALLY DEFERRED,
  actor_id TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (purchase_order_id, receipt_number)
) STRICT;
CREATE TRIGGER purchase_receipts_no_update BEFORE UPDATE ON purchase_receipts
BEGIN SELECT RAISE(ABORT, 'purchase_receipts_immutable'); END;
CREATE TRIGGER purchase_receipts_no_delete BEFORE DELETE ON purchase_receipts
BEGIN SELECT RAISE(ABORT, 'purchase_receipts_immutable'); END;

CREATE TABLE purchase_receipt_lines (
  receipt_id TEXT NOT NULL REFERENCES purchase_receipts(id),
  line_index INTEGER NOT NULL CHECK(line_index >= 0),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  received_quantity INTEGER NOT NULL CHECK(received_quantity >= 0),
  rejected_quantity INTEGER NOT NULL CHECK(rejected_quantity >= 0),
  unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents >= 0),
  movement_id TEXT REFERENCES inventory_movements(id),
  pick_location_id TEXT REFERENCES inventory_pick_locations(id),
  PRIMARY KEY (receipt_id, line_index),
  CHECK(received_quantity + rejected_quantity > 0),
  CHECK((received_quantity > 0) = (movement_id IS NOT NULL))
) STRICT;
CREATE TRIGGER purchase_receipt_lines_no_update BEFORE UPDATE ON purchase_receipt_lines
BEGIN SELECT RAISE(ABORT, 'purchase_receipts_immutable'); END;
CREATE TRIGGER purchase_receipt_lines_no_delete BEFORE DELETE ON purchase_receipt_lines
BEGIN SELECT RAISE(ABORT, 'purchase_receipts_immutable'); END;

-- Metadata only (reference + content hash); the file itself lives in private
-- object storage, never in D1.
CREATE TABLE purchase_documents (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id),
  receipt_id TEXT REFERENCES purchase_receipts(id),
  kind TEXT NOT NULL CHECK(kind IN ('delivery_note', 'invoice', 'packing_list', 'quality_certificate', 'other')),
  reference TEXT NOT NULL CHECK(length(trim(reference)) BETWEEN 3 AND 200),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 52428800),
  media_type TEXT NOT NULL CHECK(media_type IN ('application/pdf', 'image/jpeg', 'image/png', 'text/csv')),
  command_id TEXT NOT NULL REFERENCES inventory_ops_commands(command_id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (purchase_order_id, sha256)
) STRICT;
CREATE INDEX purchase_documents_po_idx ON purchase_documents(purchase_order_id, created_at);
CREATE TRIGGER purchase_documents_no_update BEFORE UPDATE ON purchase_documents
BEGIN SELECT RAISE(ABORT, 'purchase_documents_immutable'); END;
CREATE TRIGGER purchase_documents_no_delete BEFORE DELETE ON purchase_documents
BEGIN SELECT RAISE(ABORT, 'purchase_documents_immutable'); END;
