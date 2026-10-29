-- Migration 0109: SHP-023 (Convenience Delivery Points), SHP-025 (Company Shipping Conditions), SHP-026 (Own Route Planning & Reoptimization)

-- 1. SHP-023: Puntos de conveniencia (Locker / Pick-up Point)
CREATE TABLE shipping_convenience_points (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  network TEXT NOT NULL CHECK(network IN ('inpost', 'correos', 'seur', 'gls')),
  code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 50),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 150),
  street_address TEXT NOT NULL CHECK(length(street_address) BETWEEN 1 AND 250),
  postal_code TEXT NOT NULL CHECK(length(postal_code) = 5 AND postal_code NOT GLOB '*[^0-9]*'),
  city TEXT NOT NULL CHECK(length(city) BETWEEN 1 AND 100),
  province TEXT NOT NULL CHECK(length(province) BETWEEN 1 AND 100),
  country_code TEXT NOT NULL DEFAULT 'ES' CHECK(country_code = 'ES'),
  latitude REAL CHECK(latitude IS NULL OR (latitude BETWEEN -90.0 AND 90.0)),
  longitude REAL CHECK(longitude IS NULL OR (longitude BETWEEN -180.0 AND 180.0)),
  opening_hours_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(opening_hours_json)),
  operating_status TEXT NOT NULL DEFAULT 'active' CHECK(operating_status IN ('active', 'temporarily_closed')),
  max_weight_grams INTEGER NOT NULL DEFAULT 20000 CHECK(max_weight_grams > 0),
  accepts_returns INTEGER NOT NULL DEFAULT 1 CHECK(accepts_returns IN (0, 1)),
  has_locker INTEGER NOT NULL DEFAULT 0 CHECK(has_locker IN (0, 1)),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  UNIQUE(network, code)
) STRICT;

CREATE INDEX idx_shipping_convenience_points_search ON shipping_convenience_points(postal_code, operating_status);

-- 2. SHP-025: Condiciones de envío por empresa / cliente B2B
CREATE TABLE company_shipping_conditions (
  company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  custom_methods_enabled INTEGER NOT NULL DEFAULT 1 CHECK(custom_methods_enabled IN (0, 1)),
  allowed_methods_json TEXT NOT NULL DEFAULT '["pickup","own_delivery","parcel"]' CHECK(json_valid(allowed_methods_json)),
  carrier_account_carrier TEXT CHECK(carrier_account_carrier IS NULL OR length(carrier_account_carrier) BETWEEN 2 AND 64),
  carrier_account_number TEXT CHECK(carrier_account_number IS NULL OR length(carrier_account_number) BETWEEN 1 AND 64),
  warehouse_pickup_allowed INTEGER NOT NULL DEFAULT 1 CHECK(warehouse_pickup_allowed IN (0, 1)),
  free_shipping_threshold_cents INTEGER CHECK(free_shipping_threshold_cents IS NULL OR free_shipping_threshold_cents >= 0),
  custom_delivery_instructions TEXT CHECK(custom_delivery_instructions IS NULL OR length(custom_delivery_instructions) <= 500),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE TABLE company_shipping_condition_commands (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES identities(id),
  command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 64),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  applied_version INTEGER NOT NULL CHECK(applied_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(company_id, command_id),
  UNIQUE(company_id, applied_version)
) STRICT;

CREATE TRIGGER company_shipping_condition_commands_no_update BEFORE UPDATE ON company_shipping_condition_commands
BEGIN SELECT RAISE(ABORT, 'company_shipping_condition_commands_immutable'); END;

CREATE TRIGGER company_shipping_condition_commands_no_delete BEFORE DELETE ON company_shipping_condition_commands
BEGIN SELECT RAISE(ABORT, 'company_shipping_condition_commands_immutable'); END;

-- 3. SHP-026: Planificación y secuenciación de rutas propias
CREATE TABLE delivery_vehicles (
  id TEXT PRIMARY KEY CHECK(length(id) <= 36),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  registration_plate TEXT NOT NULL UNIQUE CHECK(length(registration_plate) BETWEEN 1 AND 20),
  max_weight_grams INTEGER NOT NULL CHECK(max_weight_grams > 0),
  max_parcels INTEGER NOT NULL CHECK(max_parcels > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'maintenance', 'inactive')),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;

CREATE TABLE delivery_drivers (
  id TEXT PRIMARY KEY CHECK(length(id) <= 36),
  identity_id TEXT REFERENCES identities(id),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  phone TEXT NOT NULL CHECK(length(phone) BETWEEN 6 AND 30),
  license_number TEXT NOT NULL CHECK(length(license_number) BETWEEN 1 AND 50),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'off_duty')),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;

CREATE TABLE delivery_routes (
  id TEXT PRIMARY KEY CHECK(length(id) <= 36),
  route_date TEXT NOT NULL CHECK(length(route_date) = 10 AND route_date = COALESCE(strftime('%Y-%m-%d', route_date), '')),
  vehicle_id TEXT REFERENCES delivery_vehicles(id),
  driver_id TEXT REFERENCES delivery_drivers(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'planned', 'in_progress', 'completed', 'cancelled')),
  window_start TEXT NOT NULL CHECK(length(window_start) = 5),
  window_end TEXT NOT NULL CHECK(length(window_end) = 5 AND window_end >= window_start),
  total_stops INTEGER NOT NULL DEFAULT 0 CHECK(total_stops >= 0),
  total_parcels INTEGER NOT NULL DEFAULT 0 CHECK(total_parcels >= 0),
  total_weight_grams INTEGER NOT NULL DEFAULT 0 CHECK(total_weight_grams >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE TABLE delivery_route_stops (
  id TEXT PRIMARY KEY CHECK(length(id) <= 36),
  route_id TEXT NOT NULL REFERENCES delivery_routes(id) ON DELETE CASCADE,
  sequence_index INTEGER NOT NULL CHECK(sequence_index >= 0),
  order_id TEXT REFERENCES orders(id),
  recipient_name TEXT NOT NULL CHECK(length(recipient_name) >= 1),
  street_address TEXT NOT NULL CHECK(length(street_address) >= 1),
  postal_code TEXT NOT NULL CHECK(length(postal_code) = 5),
  city TEXT NOT NULL CHECK(length(city) >= 1),
  parcel_count INTEGER NOT NULL DEFAULT 1 CHECK(parcel_count >= 1),
  weight_grams INTEGER NOT NULL DEFAULT 1000 CHECK(weight_grams >= 0),
  time_window_start TEXT CHECK(time_window_start IS NULL OR length(time_window_start) = 5),
  time_window_end TEXT CHECK(time_window_end IS NULL OR (length(time_window_end) = 5 AND time_window_end >= time_window_start)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'delivered', 'failed')),
  failure_reason TEXT,
  completed_at TEXT CHECK(completed_at IS NULL OR (length(completed_at) = 20 AND completed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', completed_at), ''))),
  UNIQUE(route_id, sequence_index)
) STRICT;

CREATE INDEX idx_delivery_route_stops_lookup ON delivery_route_stops(route_id, sequence_index);

CREATE TABLE delivery_route_commands (
  id TEXT PRIMARY KEY CHECK(length(id) <= 36),
  route_id TEXT NOT NULL REFERENCES delivery_routes(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create', 'assign_resources', 'add_stop', 'reorder_stops', 'reoptimize', 'dispatch', 'complete_stop', 'cancel')),
  command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 64),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  applied_version INTEGER NOT NULL CHECK(applied_version = expected_version + 1),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(route_id, command_id),
  UNIQUE(route_id, applied_version)
) STRICT;

CREATE TRIGGER delivery_route_commands_no_update BEFORE UPDATE ON delivery_route_commands
BEGIN SELECT RAISE(ABORT, 'delivery_route_commands_immutable'); END;

CREATE TRIGGER delivery_route_commands_no_delete BEFORE DELETE ON delivery_route_commands
BEGIN SELECT RAISE(ABORT, 'delivery_route_commands_immutable'); END;
