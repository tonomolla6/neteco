CREATE TABLE inventory_count_import_commands (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES identities(id),
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('propose','approve')),
  import_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  response TEXT NOT NULL CHECK(json_valid(response)),
  created_at TEXT NOT NULL,
  UNIQUE(actor_id,idempotency_key)
) STRICT;
CREATE TABLE inventory_count_imports (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE REFERENCES inventory_count_import_commands(id),
  proposed_by TEXT NOT NULL REFERENCES identities(id),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 10 AND 500),
  reference TEXT NOT NULL CHECK(length(reference) BETWEEN 3 AND 200),
  preview_hash TEXT NOT NULL CHECK(length(preview_hash)=64),
  row_count INTEGER NOT NULL CHECK(row_count BETWEEN 1 AND 100),
  changed_count INTEGER NOT NULL CHECK(changed_count BETWEEN 1 AND row_count),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE inventory_count_import_rows (
  import_id TEXT NOT NULL REFERENCES inventory_count_imports(id),
  row_number INTEGER NOT NULL CHECK(row_number BETWEEN 2 AND 101),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  legacy_variant_id INTEGER NOT NULL CHECK(legacy_variant_id>0),
  sku TEXT NOT NULL,
  expected_version INTEGER NOT NULL CHECK(expected_version>=1),
  physical_before INTEGER NOT NULL CHECK(physical_before>=0),
  counted_quantity INTEGER NOT NULL CHECK(counted_quantity BETWEEN 0 AND 9007199254740991),
  physical_delta INTEGER NOT NULL,
  before_state TEXT NOT NULL CHECK(json_valid(before_state)),
  movement_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY(import_id,row_number),
  UNIQUE(import_id,variant_id),
  CHECK(physical_delta=counted_quantity-physical_before)
) STRICT;
CREATE TABLE inventory_count_import_audit (
  command_id TEXT PRIMARY KEY REFERENCES inventory_count_import_commands(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('propose','approve')),
  import_id TEXT NOT NULL REFERENCES inventory_count_imports(id),
  payload_hash TEXT NOT NULL,
  response TEXT NOT NULL CHECK(json_valid(response)),
  created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX inventory_count_import_one_approval ON inventory_count_import_commands(import_id) WHERE action='approve';
CREATE INDEX inventory_count_import_created ON inventory_count_imports(created_at,id);
CREATE TABLE inventory_count_import_guards(id TEXT PRIMARY KEY,satisfied INTEGER NOT NULL CHECK(satisfied=1)) STRICT;
CREATE TRIGGER inventory_count_import_commands_no_update BEFORE UPDATE ON inventory_count_import_commands BEGIN SELECT RAISE(ABORT,'immutable_inventory_count_import'); END;
CREATE TRIGGER inventory_count_import_commands_no_delete BEFORE DELETE ON inventory_count_import_commands BEGIN SELECT RAISE(ABORT,'immutable_inventory_count_import'); END;
CREATE TRIGGER inventory_count_imports_no_update BEFORE UPDATE ON inventory_count_imports BEGIN SELECT RAISE(ABORT,'immutable_inventory_count_import'); END;
CREATE TRIGGER inventory_count_imports_no_delete BEFORE DELETE ON inventory_count_imports BEGIN SELECT RAISE(ABORT,'immutable_inventory_count_import'); END;
CREATE TRIGGER inventory_count_import_rows_no_update BEFORE UPDATE ON inventory_count_import_rows BEGIN SELECT RAISE(ABORT,'immutable_inventory_count_import'); END;
CREATE TRIGGER inventory_count_import_rows_no_delete BEFORE DELETE ON inventory_count_import_rows BEGIN SELECT RAISE(ABORT,'immutable_inventory_count_import'); END;
CREATE TRIGGER inventory_count_import_audit_no_update BEFORE UPDATE ON inventory_count_import_audit BEGIN SELECT RAISE(ABORT,'immutable_inventory_count_import'); END;
CREATE TRIGGER inventory_count_import_audit_no_delete BEFORE DELETE ON inventory_count_import_audit BEGIN SELECT RAISE(ABORT,'immutable_inventory_count_import'); END;
CREATE TRIGGER inventory_count_import_movement_no_update BEFORE UPDATE ON inventory_movements WHEN OLD.reference_type='inventory_count_import' BEGIN SELECT RAISE(ABORT,'immutable_inventory_count_import'); END;
CREATE TRIGGER inventory_count_import_movement_no_delete BEFORE DELETE ON inventory_movements WHEN OLD.reference_type='inventory_count_import' BEGIN SELECT RAISE(ABORT,'immutable_inventory_count_import'); END;
