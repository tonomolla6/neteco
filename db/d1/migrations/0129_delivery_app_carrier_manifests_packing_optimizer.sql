-- SHP-027 delivery driver app, SHP-028 carrier manifests/closures/pickups, SHP-030 packing optimisation.
-- Depends on 0069 (order_packings) and 0109 (delivery routes). No provider is contacted by any table here.
-- Order references are plain text: orders are owned by checkout and shipments by order_packings.dispatch.

CREATE TABLE shipping_ops_guards (
  id TEXT PRIMARY KEY,
  satisfied INTEGER NOT NULL CONSTRAINT shipping_ops_atomic_guard CHECK (satisfied = 1)
) STRICT;

-- ---------------------------------------------------------------- SHP-027
CREATE TABLE delivery_stop_events (
  command_id TEXT PRIMARY KEY CHECK (length(command_id) BETWEEN 8 AND 64),
  route_id TEXT NOT NULL REFERENCES delivery_routes(id),
  stop_id TEXT REFERENCES delivery_route_stops(id),
  driver_id TEXT NOT NULL REFERENCES delivery_drivers(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  kind TEXT NOT NULL CHECK (kind IN ('start_route', 'start', 'deliver', 'fail', 'incident')),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) = 20 AND occurred_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', occurred_at), '')),
  received_at TEXT NOT NULL CHECK (length(received_at) = 20 AND received_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', received_at), '')),
  CHECK ((kind = 'start_route') = (stop_id IS NULL))
) STRICT;
CREATE INDEX idx_delivery_stop_events_route ON delivery_stop_events(route_id, received_at);
CREATE INDEX idx_delivery_stop_events_stop ON delivery_stop_events(stop_id, received_at);
CREATE TRIGGER delivery_stop_events_no_update BEFORE UPDATE ON delivery_stop_events
BEGIN SELECT RAISE(ABORT, 'delivery_stop_events_immutable'); END;
CREATE TRIGGER delivery_stop_events_no_delete BEFORE DELETE ON delivery_stop_events
BEGIN SELECT RAISE(ABORT, 'delivery_stop_events_immutable'); END;

CREATE TABLE delivery_pods (
  stop_id TEXT PRIMARY KEY REFERENCES delivery_route_stops(id),
  command_id TEXT NOT NULL UNIQUE REFERENCES delivery_stop_events(command_id),
  method TEXT NOT NULL CHECK (method IN ('signature', 'photo', 'pin', 'neighbour')),
  received_by TEXT NOT NULL CHECK (length(received_by) BETWEEN 2 AND 100),
  evidence_mime TEXT CHECK (evidence_mime IS NULL OR evidence_mime IN ('image/png', 'image/jpeg')),
  evidence_base64 TEXT CHECK (evidence_base64 IS NULL OR length(evidence_base64) <= 200000),
  evidence_sha256 TEXT CHECK (evidence_sha256 IS NULL OR (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*')),
  evidence_bytes INTEGER CHECK (evidence_bytes IS NULL OR evidence_bytes BETWEEN 1 AND 150000),
  latitude_e5 INTEGER CHECK (latitude_e5 IS NULL OR latitude_e5 BETWEEN -9000000 AND 9000000),
  longitude_e5 INTEGER CHECK (longitude_e5 IS NULL OR longitude_e5 BETWEEN -18000000 AND 18000000),
  captured_at TEXT NOT NULL CHECK (length(captured_at) = 20 AND captured_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', captured_at), '')),
  created_at TEXT NOT NULL CHECK (length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  CHECK ((method IN ('signature', 'photo')) = (evidence_sha256 IS NOT NULL)),
  CHECK ((evidence_sha256 IS NULL) = (evidence_base64 IS NULL))
) STRICT;
CREATE TRIGGER delivery_pods_no_update BEFORE UPDATE ON delivery_pods
BEGIN SELECT RAISE(ABORT, 'delivery_pods_immutable'); END;
CREATE TRIGGER delivery_pods_no_delete BEFORE DELETE ON delivery_pods
BEGIN SELECT RAISE(ABORT, 'delivery_pods_immutable'); END;

CREATE TABLE delivery_incidents (
  id TEXT PRIMARY KEY CHECK (length(id) <= 36),
  command_id TEXT NOT NULL UNIQUE REFERENCES delivery_stop_events(command_id),
  route_id TEXT NOT NULL REFERENCES delivery_routes(id),
  stop_id TEXT NOT NULL REFERENCES delivery_route_stops(id),
  driver_id TEXT NOT NULL REFERENCES delivery_drivers(id),
  category TEXT NOT NULL CHECK (category IN ('customer_absent', 'wrong_address', 'access_blocked', 'damaged_parcel', 'refused', 'vehicle_issue', 'other')),
  note TEXT NOT NULL CHECK (length(note) <= 500),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) = 20 AND occurred_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', occurred_at), '')),
  created_at TEXT NOT NULL CHECK (length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE INDEX idx_delivery_incidents_route ON delivery_incidents(route_id, created_at);
CREATE TRIGGER delivery_incidents_no_update BEFORE UPDATE ON delivery_incidents
BEGIN SELECT RAISE(ABORT, 'delivery_incidents_immutable'); END;
CREATE TRIGGER delivery_incidents_no_delete BEFORE DELETE ON delivery_incidents
BEGIN SELECT RAISE(ABORT, 'delivery_incidents_immutable'); END;

-- ---------------------------------------------------------------- SHP-028
CREATE TABLE carrier_manifests (
  id TEXT PRIMARY KEY CHECK (length(id) <= 36),
  carrier TEXT NOT NULL CHECK (length(carrier) BETWEEN 1 AND 100 AND carrier = lower(trim(carrier))),
  pickup_date TEXT NOT NULL CHECK (length(pickup_date) = 10 AND pickup_date = COALESCE(strftime('%Y-%m-%d', pickup_date), '')),
  status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'picked_up', 'discrepancy', 'cancelled')),
  version INTEGER NOT NULL CHECK (version >= 1),
  included_shipments INTEGER NOT NULL CHECK (included_shipments >= 0),
  excluded_shipments INTEGER NOT NULL CHECK (excluded_shipments >= 0),
  parcel_count INTEGER NOT NULL CHECK (parcel_count >= 0),
  weight_grams INTEGER NOT NULL CHECK (weight_grams >= 0),
  provider_manifest_id TEXT,
  created_by TEXT NOT NULL REFERENCES identities(id),
  closed_at TEXT CHECK (closed_at IS NULL OR closed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', closed_at), '')),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK (updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  CHECK ((status = 'open') = (closed_at IS NULL AND provider_manifest_id IS NULL) OR status = 'cancelled')
) STRICT;
CREATE UNIQUE INDEX carrier_manifests_one_active ON carrier_manifests(carrier, pickup_date) WHERE status <> 'cancelled';

CREATE TABLE carrier_manifest_items (
  manifest_id TEXT NOT NULL REFERENCES carrier_manifests(id),
  tracking_number TEXT NOT NULL CHECK (length(tracking_number) BETWEEN 1 AND 120),
  shipment_number TEXT NOT NULL CHECK (length(shipment_number) BETWEEN 1 AND 120),
  order_id TEXT NOT NULL CHECK (length(order_id) BETWEEN 1 AND 64),
  parcel_index INTEGER NOT NULL CHECK (parcel_index BETWEEN 0 AND 19),
  weight_grams INTEGER NOT NULL CHECK (weight_grams >= 0),
  decision TEXT NOT NULL CHECK (decision IN ('included', 'excluded')),
  exclusion_reason TEXT CHECK (exclusion_reason IS NULL OR exclusion_reason IN ('already_manifested', 'order_exception', 'already_delivered', 'manual_hold')),
  scan_status TEXT NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'scanned', 'missing')),
  PRIMARY KEY (manifest_id, tracking_number),
  CHECK ((decision = 'excluded') = (exclusion_reason IS NOT NULL)),
  CHECK (decision = 'included' OR scan_status = 'pending')
) STRICT;
CREATE INDEX idx_carrier_manifest_items_tracking ON carrier_manifest_items(tracking_number, decision);

CREATE TABLE carrier_manifest_documents (
  id TEXT PRIMARY KEY CHECK (length(id) <= 36),
  manifest_id TEXT NOT NULL REFERENCES carrier_manifests(id),
  kind TEXT NOT NULL CHECK (kind IN ('manifest_csv', 'pickup_receipt')),
  content_type TEXT NOT NULL CHECK (content_type IN ('text/csv; charset=utf-8', 'text/plain; charset=utf-8')),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 500000),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 1),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (manifest_id, kind)
) STRICT;
CREATE TRIGGER carrier_manifest_documents_no_update BEFORE UPDATE ON carrier_manifest_documents
BEGIN SELECT RAISE(ABORT, 'carrier_manifest_documents_immutable'); END;
CREATE TRIGGER carrier_manifest_documents_no_delete BEFORE DELETE ON carrier_manifest_documents
BEGIN SELECT RAISE(ABORT, 'carrier_manifest_documents_immutable'); END;

CREATE TABLE carrier_pickups (
  manifest_id TEXT PRIMARY KEY REFERENCES carrier_manifests(id),
  provider_pickup_id TEXT NOT NULL CHECK (length(provider_pickup_id) BETWEEN 1 AND 120),
  scheduled_date TEXT NOT NULL CHECK (length(scheduled_date) = 10),
  parcel_count INTEGER NOT NULL CHECK (parcel_count >= 1),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'confirmed', 'discrepancy')),
  scanned_count INTEGER CHECK (scanned_count IS NULL OR scanned_count >= 0),
  missing_count INTEGER CHECK (missing_count IS NULL OR missing_count >= 0),
  unexpected_trackings TEXT CHECK (unexpected_trackings IS NULL OR (json_valid(unexpected_trackings) AND json_type(unexpected_trackings) = 'array')),
  confirmed_at TEXT CHECK (confirmed_at IS NULL OR confirmed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', confirmed_at), '')),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  CHECK ((status = 'scheduled') = (confirmed_at IS NULL))
) STRICT;

CREATE TABLE carrier_manifest_commands (
  command_id TEXT PRIMARY KEY CHECK (length(command_id) BETWEEN 8 AND 64),
  manifest_id TEXT NOT NULL CHECK (length(manifest_id) <= 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK (action IN ('create', 'set_item', 'close', 'schedule_pickup', 'confirm_pickup', 'cancel')),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  result_version INTEGER NOT NULL CHECK (result_version = expected_version + 1),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (manifest_id, result_version)
) STRICT;
CREATE TRIGGER carrier_manifest_commands_no_update BEFORE UPDATE ON carrier_manifest_commands
BEGIN SELECT RAISE(ABORT, 'carrier_manifest_commands_immutable'); END;
CREATE TRIGGER carrier_manifest_commands_no_delete BEFORE DELETE ON carrier_manifest_commands
BEGIN SELECT RAISE(ABORT, 'carrier_manifest_commands_immutable'); END;

-- ---------------------------------------------------------------- SHP-030
CREATE TABLE packing_box_types (
  code TEXT PRIMARY KEY CHECK (code = upper(code) AND length(code) BETWEEN 1 AND 30 AND code NOT GLOB '*[^A-Z0-9_-]*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  inner_width_mm INTEGER NOT NULL CHECK (inner_width_mm BETWEEN 1 AND 3000),
  inner_height_mm INTEGER NOT NULL CHECK (inner_height_mm BETWEEN 1 AND 3000),
  inner_depth_mm INTEGER NOT NULL CHECK (inner_depth_mm BETWEEN 1 AND 3000),
  tare_grams INTEGER NOT NULL CHECK (tare_grams BETWEEN 0 AND 100000),
  max_weight_grams INTEGER NOT NULL CHECK (max_weight_grams BETWEEN 1 AND 1000000),
  hazmat_allowed INTEGER NOT NULL CHECK (hazmat_allowed IN (0, 1)),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL CHECK (updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  CHECK (tare_grams < max_weight_grams)
) STRICT;

CREATE TABLE packing_product_profiles (
  sku TEXT PRIMARY KEY CHECK (length(sku) BETWEEN 1 AND 200),
  weight_grams INTEGER NOT NULL CHECK (weight_grams BETWEEN 1 AND 1000000),
  width_mm INTEGER NOT NULL CHECK (width_mm BETWEEN 1 AND 3000),
  height_mm INTEGER NOT NULL CHECK (height_mm BETWEEN 1 AND 3000),
  depth_mm INTEGER NOT NULL CHECK (depth_mm BETWEEN 1 AND 3000),
  hazard_class TEXT NOT NULL CHECK (hazard_class IN ('none', 'corrosive', 'flammable', 'oxidizer', 'toxic', 'irritant')),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL CHECK (updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;

CREATE TABLE packing_incompatibilities (
  class_a TEXT NOT NULL CHECK (class_a IN ('none', 'corrosive', 'flammable', 'oxidizer', 'toxic', 'irritant')),
  class_b TEXT NOT NULL CHECK (class_b IN ('none', 'corrosive', 'flammable', 'oxidizer', 'toxic', 'irritant')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 200),
  PRIMARY KEY (class_a, class_b),
  CHECK (class_a <= class_b)
) STRICT;

INSERT INTO packing_incompatibilities(class_a, class_b, reason) VALUES
  ('corrosive', 'flammable', 'Acidos/bases con inflamables'),
  ('corrosive', 'oxidizer', 'Corrosivos con oxidantes (p. ej. lejia con acidos)'),
  ('flammable', 'oxidizer', 'Inflamables con oxidantes'),
  ('oxidizer', 'toxic', 'Oxidantes con toxicos');

INSERT INTO packing_box_types(code, name, inner_width_mm, inner_height_mm, inner_depth_mm, tare_grams, max_weight_grams, hazmat_allowed, active, version, updated_at) VALUES
  ('S', 'Caja pequena', 200, 150, 150, 150, 5000, 1, 1, 1, '2026-10-29T00:00:00Z'),
  ('M', 'Caja mediana', 400, 300, 300, 400, 15000, 1, 1, 1, '2026-10-29T00:00:00Z'),
  ('L', 'Caja grande', 600, 400, 400, 800, 25000, 1, 1, 1, '2026-10-29T00:00:00Z');

CREATE TABLE packing_suggestions (
  id TEXT PRIMARY KEY CHECK (length(id) <= 36),
  command_id TEXT NOT NULL UNIQUE CHECK (length(command_id) BETWEEN 8 AND 64),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  order_id TEXT CHECK (order_id IS NULL OR length(order_id) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK (status IN ('suggested', 'validated', 'rejected')),
  version INTEGER NOT NULL CHECK (version >= 1),
  algorithm_version TEXT NOT NULL CHECK (length(algorithm_version) BETWEEN 1 AND 40),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  parcel_count INTEGER NOT NULL CHECK (parcel_count BETWEEN 1 AND 20),
  gross_weight_grams INTEGER NOT NULL CHECK (gross_weight_grams >= 1),
  created_by TEXT NOT NULL REFERENCES identities(id),
  validated_by TEXT REFERENCES identities(id),
  validation_json TEXT CHECK (validation_json IS NULL OR json_valid(validation_json)),
  validated_at TEXT CHECK (validated_at IS NULL OR validated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', validated_at), '')),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK (updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  CHECK ((status = 'suggested') = (validated_at IS NULL AND validated_by IS NULL AND validation_json IS NULL))
) STRICT;
CREATE INDEX idx_packing_suggestions_order ON packing_suggestions(order_id, created_at);

CREATE TABLE packing_suggestion_commands (
  command_id TEXT PRIMARY KEY CHECK (length(command_id) BETWEEN 8 AND 64),
  suggestion_id TEXT NOT NULL REFERENCES packing_suggestions(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK (action IN ('validate', 'reject')),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  expected_version INTEGER NOT NULL CHECK (expected_version >= 1),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE TRIGGER packing_suggestion_commands_no_update BEFORE UPDATE ON packing_suggestion_commands
BEGIN SELECT RAISE(ABORT, 'packing_suggestion_commands_immutable'); END;
CREATE TRIGGER packing_suggestion_commands_no_delete BEFORE DELETE ON packing_suggestion_commands
BEGIN SELECT RAISE(ABORT, 'packing_suggestion_commands_immutable'); END;
