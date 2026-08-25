-- Inventory operations for the D1 lane (port of the PostgreSQL inventory model,
-- migrations 0001/0013), adapted to SQLite/D1 semantics.
--
-- Quantity semantics (single source of truth, never duplicated):
--   physical_quantity : units physically present at the location.
--   blocked_quantity  : units not sellable (quarantine/damage); always <= physical.
--   variants.safety_stock: single authoritative policy buffer kept unpromisable.
--   Active reservations live ONLY in inventory_reservations(_lines) with status
--   'reserved'; balances never duplicate them.
--   Sellable = physical - blocked - safety - SUM(active reservation lines).
--
-- The ledger is append-only: sum(physical_delta) per (variant, location) must
-- equal balances.physical_quantity and every balance change is explained by a
-- movement. All timestamps are canonical ISO-8601 UTC seconds strings.

CREATE TABLE inventory_locations (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('warehouse', 'store', 'vehicle', 'supplier')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 20
    AND strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS NOT NULL
    AND created_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at)
  )
) STRICT;

CREATE TABLE inventory_balances (
  variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  physical_quantity INTEGER NOT NULL DEFAULT 0 CHECK (physical_quantity >= 0),
  blocked_quantity INTEGER NOT NULL DEFAULT 0
    CHECK (blocked_quantity >= 0 AND blocked_quantity <= physical_quantity),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 20
    AND strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS NOT NULL
    AND created_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at)
  ),
  updated_at TEXT NOT NULL CHECK (
    length(updated_at) = 20
    AND strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) IS NOT NULL
    AND updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', updated_at)
  ),
  PRIMARY KEY (variant_id, location_id)
) STRICT;

CREATE TABLE inventory_reservations (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'assigned', 'released', 'expired')),
  correlation_id TEXT NOT NULL,
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 500),
  expires_at TEXT NOT NULL CHECK (
    length(expires_at) = 20
    AND strftime('%Y-%m-%dT%H:%M:%SZ', expires_at) IS NOT NULL
    AND expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', expires_at)
  ),
  renewed_at TEXT CHECK (
    renewed_at IS NULL OR (
      length(renewed_at) = 20
      AND strftime('%Y-%m-%dT%H:%M:%SZ', renewed_at) IS NOT NULL
      AND renewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', renewed_at)
    )
  ),
  assigned_at TEXT CHECK (
    assigned_at IS NULL OR (
      length(assigned_at) = 20
      AND strftime('%Y-%m-%dT%H:%M:%SZ', assigned_at) IS NOT NULL
      AND assigned_at = strftime('%Y-%m-%dT%H:%M:%SZ', assigned_at)
    )
  ),
  released_at TEXT CHECK (
    released_at IS NULL OR (
      length(released_at) = 20
      AND strftime('%Y-%m-%dT%H:%M:%SZ', released_at) IS NOT NULL
      AND released_at = strftime('%Y-%m-%dT%H:%M:%SZ', released_at)
    )
  ),
  expired_at TEXT CHECK (
    expired_at IS NULL OR (
      length(expired_at) = 20
      AND strftime('%Y-%m-%dT%H:%M:%SZ', expired_at) IS NOT NULL
      AND expired_at = strftime('%Y-%m-%dT%H:%M:%SZ', expired_at)
    )
  ),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 20
    AND strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS NOT NULL
    AND created_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at)
  ),
  updated_at TEXT NOT NULL CHECK (
    length(updated_at) = 20
    AND strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) IS NOT NULL
    AND updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', updated_at)
  ),
  CHECK (expires_at > created_at),
  CHECK (renewed_at IS NULL OR renewed_at >= created_at),
  CHECK (assigned_at IS NULL OR assigned_at >= created_at),
  CHECK (released_at IS NULL OR released_at >= created_at),
  CHECK (expired_at IS NULL OR expired_at >= created_at),
  CHECK (updated_at >= created_at),
  CHECK (
    (status = 'reserved' AND assigned_at IS NULL AND released_at IS NULL AND expired_at IS NULL)
    OR (status = 'assigned' AND assigned_at IS NOT NULL AND released_at IS NULL AND expired_at IS NULL)
    OR (status = 'released' AND assigned_at IS NULL AND released_at IS NOT NULL AND expired_at IS NULL)
    OR (status = 'expired' AND assigned_at IS NULL AND released_at IS NULL AND expired_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE inventory_reservation_lines (
  reservation_id TEXT NOT NULL REFERENCES inventory_reservations(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES variants(id),
  location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (reservation_id, variant_id, location_id),
  FOREIGN KEY (variant_id, location_id)
    REFERENCES inventory_balances(variant_id, location_id)
) STRICT;

CREATE TABLE inventory_movements (
  id TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL REFERENCES variants(id),
  location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  movement_type TEXT NOT NULL
    CHECK (movement_type IN ('initial', 'receipt', 'adjustment', 'reserve', 'release', 'allocate', 'ship', 'return', 'damage', 'transfer_in', 'transfer_out')),
  physical_delta INTEGER NOT NULL,
  reserved_delta INTEGER NOT NULL,
  reference_type TEXT NOT NULL,
  reference_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  correlation_id TEXT NOT NULL,
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 500),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 20
    AND strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS NOT NULL
    AND created_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at)
  ),
  CHECK (
    (movement_type = 'initial' AND physical_delta > 0 AND reserved_delta = 0)
    OR (movement_type = 'reserve' AND physical_delta = 0 AND reserved_delta > 0)
    OR (movement_type = 'release' AND physical_delta = 0 AND reserved_delta < 0)
    OR (movement_type = 'allocate' AND physical_delta < 0 AND reserved_delta = physical_delta)
    OR (movement_type IN ('receipt', 'return', 'transfer_in') AND physical_delta > 0 AND reserved_delta = 0)
    OR (movement_type IN ('ship', 'damage', 'transfer_out') AND physical_delta < 0 AND reserved_delta = 0)
    OR (movement_type = 'adjustment' AND physical_delta <> 0 AND reserved_delta = 0)
  ),
  FOREIGN KEY (variant_id, location_id)
    REFERENCES inventory_balances(variant_id, location_id)
) STRICT;

CREATE INDEX inventory_balances_location_idx ON inventory_balances(location_id);
CREATE INDEX inventory_reservations_expiry_idx ON inventory_reservations(status, expires_at);
CREATE INDEX inventory_reservation_lines_target_idx
  ON inventory_reservation_lines(variant_id, location_id);
CREATE INDEX inventory_movements_reconcile_idx
  ON inventory_movements(variant_id, location_id, created_at, id);
