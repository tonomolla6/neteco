-- Migration 0122: COM-019 Operational alerts (warehouse & delivery), COM-020 Send-time optimization, OBS-029 Warehouse & route telemetry.

-- ---------------------------------------------------------------------------
-- COM-019: Alertas operativas a almacén/reparto
-- Redundant channel for critical exceptions, ack & escalation, no un-auditable personal groups.
-- ---------------------------------------------------------------------------

CREATE TABLE operational_alerts (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  area TEXT NOT NULL CHECK(area IN ('warehouse', 'delivery', 'general')),
  severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'critical')),
  category TEXT NOT NULL CHECK(category IN (
    'chemical_spill', 'hazard_dg_rupture', 'temperature_breach', 'urgent_stock_shortage',
    'dock_blockage', 'vehicle_breakdown', 'route_blocked', 'critical_delivery_delay',
    'parcel_hazardous_damage', 'minor_damage_hold', 'general_operational'
  )),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 5 AND 200),
  description TEXT NOT NULL CHECK(length(trim(description)) BETWEEN 5 AND 2000),
  location_ref TEXT NOT NULL CHECK(length(trim(location_ref)) BETWEEN 2 AND 100),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'acknowledged', 'escalated', 'resolved')),
  escalation_tier INTEGER NOT NULL DEFAULT 1 CHECK(escalation_tier BETWEEN 1 AND 4),
  redundant_channel_required INTEGER NOT NULL CHECK(redundant_channel_required IN (0, 1)),
  redundant_channel_dispatched INTEGER NOT NULL DEFAULT 0 CHECK(redundant_channel_dispatched IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  acknowledged_at TEXT CHECK(acknowledged_at IS NULL OR acknowledged_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', acknowledged_at), '')),
  acknowledged_by TEXT REFERENCES identities(id),
  ack_note TEXT CHECK(ack_note IS NULL OR length(trim(ack_note)) BETWEEN 1 AND 1000),
  escalated_at TEXT CHECK(escalated_at IS NULL OR escalated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', escalated_at), '')),
  escalation_reason TEXT CHECK(escalation_reason IS NULL OR length(trim(escalation_reason)) BETWEEN 1 AND 1000),
  resolved_at TEXT CHECK(resolved_at IS NULL OR resolved_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', resolved_at), '')),
  resolved_by TEXT REFERENCES identities(id),
  resolution_note TEXT CHECK(resolution_note IS NULL OR length(trim(resolution_note)) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  created_by TEXT NOT NULL REFERENCES identities(id),
  CHECK(severity <> 'critical' OR redundant_channel_required = 1)
) STRICT;

CREATE INDEX idx_operational_alerts_status ON operational_alerts(status, severity, created_at DESC);
CREATE INDEX idx_operational_alerts_area ON operational_alerts(area, created_at DESC);

CREATE TRIGGER operational_alerts_no_delete BEFORE DELETE ON operational_alerts
BEGIN SELECT RAISE(ABORT, 'operational_alert_immutable'); END;

CREATE TRIGGER operational_alerts_cas BEFORE UPDATE ON operational_alerts
WHEN NEW.id IS NOT OLD.id OR NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'operational_alert_version_conflict'); END;

CREATE TABLE operational_alert_dispatches (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  alert_id TEXT NOT NULL REFERENCES operational_alerts(id),
  channel TEXT NOT NULL CHECK(channel IN ('dashboard', 'warehouse_terminal', 'sms_pager', 'redundant_webhook')),
  is_redundant INTEGER NOT NULL CHECK(is_redundant IN (0, 1)),
  recipient_target TEXT NOT NULL CHECK(length(trim(recipient_target)) BETWEEN 2 AND 120),
  status TEXT NOT NULL CHECK(status IN ('dispatched', 'delivered', 'failed')),
  dispatched_at TEXT NOT NULL CHECK(dispatched_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', dispatched_at), ''))
) STRICT;

CREATE INDEX idx_alert_dispatches_alert ON operational_alert_dispatches(alert_id, dispatched_at DESC);

CREATE TRIGGER operational_alert_dispatches_no_update BEFORE UPDATE ON operational_alert_dispatches
BEGIN SELECT RAISE(ABORT, 'operational_alert_dispatch_immutable'); END;

CREATE TRIGGER operational_alert_dispatches_no_delete BEFORE DELETE ON operational_alert_dispatches
BEGIN SELECT RAISE(ABORT, 'operational_alert_dispatch_immutable'); END;

CREATE TABLE operational_alert_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  alert_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('create', 'acknowledge', 'escalate', 'resolve')),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  applied_version INTEGER NOT NULL CHECK(applied_version >= 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(actor_id, command_id)
) STRICT;

CREATE TRIGGER operational_alert_commands_no_update BEFORE UPDATE ON operational_alert_commands
BEGIN SELECT RAISE(ABORT, 'operational_alert_command_immutable'); END;

CREATE TRIGGER operational_alert_commands_no_delete BEFORE DELETE ON operational_alert_commands
BEGIN SELECT RAISE(ABORT, 'operational_alert_command_immutable'); END;

-- ---------------------------------------------------------------------------
-- COM-020: Optimización de send-time
-- Strict consented marketing, holdout control group, frequency limits, zero delay on operational messages.
-- ---------------------------------------------------------------------------

CREATE TABLE send_time_optimization_policies (
  id TEXT PRIMARY KEY CHECK(id = 'global'),
  version INTEGER NOT NULL CHECK(version >= 1),
  holdout_rate_basis_points INTEGER NOT NULL CHECK(holdout_rate_basis_points BETWEEN 0 AND 5000),
  min_hours_between_marketing INTEGER NOT NULL CHECK(min_hours_between_marketing BETWEEN 1 AND 168),
  max_weekly_marketing_sends INTEGER NOT NULL CHECK(max_weekly_marketing_sends BETWEEN 1 AND 14),
  allowed_window_start_hour INTEGER NOT NULL CHECK(allowed_window_start_hour BETWEEN 0 AND 23),
  allowed_window_end_hour INTEGER NOT NULL CHECK(allowed_window_end_hour BETWEEN 1 AND 24 AND allowed_window_end_hour > allowed_window_start_hour),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  updated_by TEXT NOT NULL REFERENCES identities(id)
) STRICT;

CREATE TRIGGER send_time_policies_no_delete BEFORE DELETE ON send_time_optimization_policies
BEGIN SELECT RAISE(ABORT, 'send_time_policy_immutable'); END;

CREATE TRIGGER send_time_policies_cas BEFORE UPDATE ON send_time_optimization_policies
WHEN NEW.id IS NOT OLD.id OR NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'send_time_policy_version_conflict'); END;

CREATE TABLE send_time_optimization_decisions (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  message_id TEXT NOT NULL CHECK(length(trim(message_id)) BETWEEN 4 AND 64),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  category TEXT NOT NULL CHECK(category IN ('marketing', 'operational')),
  channel TEXT NOT NULL CHECK(channel IN ('email', 'sms', 'push')),
  campaign_code TEXT CHECK(campaign_code IS NULL OR length(trim(campaign_code)) <= 64),
  status TEXT NOT NULL CHECK(status IN ('sent_immediate', 'scheduled_optimized', 'held_out', 'suppressed_no_consent', 'suppressed_rate_limit')),
  scheduled_for TEXT NOT NULL CHECK(scheduled_for = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', scheduled_for), '')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) <= 200),
  holdout_applied INTEGER NOT NULL CHECK(holdout_applied IN (0, 1)),
  consent_verified INTEGER NOT NULL CHECK(consent_verified IN (0, 1)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  CHECK(category <> 'operational' OR (status = 'sent_immediate' AND holdout_applied = 0))
) STRICT;

CREATE INDEX idx_send_time_decisions_customer ON send_time_optimization_decisions(customer_id, created_at DESC);
CREATE INDEX idx_send_time_decisions_status ON send_time_optimization_decisions(status, scheduled_for);

CREATE TRIGGER send_time_decisions_no_update BEFORE UPDATE ON send_time_optimization_decisions
BEGIN SELECT RAISE(ABORT, 'send_time_decision_immutable'); END;

CREATE TRIGGER send_time_decisions_no_delete BEFORE DELETE ON send_time_optimization_decisions
BEGIN SELECT RAISE(ABORT, 'send_time_decision_immutable'); END;

CREATE TABLE send_time_optimization_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('update_policy', 'evaluate_message')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  applied_version INTEGER NOT NULL CHECK(applied_version >= 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(actor_id, idempotency_key)
) STRICT;

CREATE TRIGGER send_time_commands_no_update BEFORE UPDATE ON send_time_optimization_commands
BEGIN SELECT RAISE(ABORT, 'send_time_command_immutable'); END;

CREATE TRIGGER send_time_commands_no_delete BEFORE DELETE ON send_time_optimization_commands
BEGIN SELECT RAISE(ABORT, 'send_time_command_immutable'); END;

-- ---------------------------------------------------------------------------
-- OBS-029: Telemetría de almacén/rutas
-- Pick rate/error, dock-to-stock, packing, on-time, daños, capacidad, dispositivos; privacidad laboral revisada.
-- ---------------------------------------------------------------------------

CREATE TABLE warehouse_telemetry_events (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  facet TEXT NOT NULL CHECK(facet IN ('pick_rate', 'dock_to_stock', 'packing', 'on_time_delivery', 'damages', 'capacity', 'devices')),
  shift_code TEXT NOT NULL CHECK(shift_code IN ('morning', 'afternoon', 'night')),
  zone_code TEXT NOT NULL CHECK(zone_code IN ('chemicals_bulk', 'picking_flow', 'packing_dock', 'fleet_transit', 'warehouse_general')),
  operator_pseudonym TEXT NOT NULL CHECK(length(operator_pseudonym) = 64 AND operator_pseudonym NOT GLOB '*[^0-9a-f]*'),
  metric_primary REAL NOT NULL,
  metric_secondary REAL NOT NULL DEFAULT 0.0,
  error_count INTEGER NOT NULL DEFAULT 0 CHECK(error_count >= 0),
  labor_privacy_reviewed INTEGER NOT NULL CHECK(labor_privacy_reviewed = 1),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  occurred_at TEXT NOT NULL CHECK(occurred_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', occurred_at), '')),
  recorded_at TEXT NOT NULL CHECK(recorded_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', recorded_at), ''))
) STRICT;

CREATE INDEX idx_telemetry_events_facet ON warehouse_telemetry_events(facet, recorded_at DESC);
CREATE INDEX idx_telemetry_events_shift ON warehouse_telemetry_events(shift_code, zone_code, recorded_at DESC);

CREATE TRIGGER warehouse_telemetry_events_no_update BEFORE UPDATE ON warehouse_telemetry_events
BEGIN SELECT RAISE(ABORT, 'warehouse_telemetry_event_immutable'); END;

CREATE TRIGGER warehouse_telemetry_events_no_delete BEFORE DELETE ON warehouse_telemetry_events
BEGIN SELECT RAISE(ABORT, 'warehouse_telemetry_event_immutable'); END;

CREATE TABLE warehouse_device_telemetry (
  device_id TEXT PRIMARY KEY CHECK(length(trim(device_id)) BETWEEN 4 AND 64),
  device_type TEXT NOT NULL CHECK(device_type IN ('rf_scanner', 'forklift_terminal', 'driver_handheld', 'pack_station_tablet')),
  battery_percent INTEGER NOT NULL CHECK(battery_percent BETWEEN 0 AND 100),
  app_version TEXT NOT NULL CHECK(length(trim(app_version)) BETWEEN 1 AND 32),
  sync_latency_ms INTEGER NOT NULL CHECK(sync_latency_ms >= 0),
  offline_queue_depth INTEGER NOT NULL CHECK(offline_queue_depth >= 0),
  error_count_24h INTEGER NOT NULL CHECK(error_count_24h >= 0),
  status TEXT NOT NULL CHECK(status IN ('online', 'offline', 'degraded')),
  last_heartbeat_at TEXT NOT NULL CHECK(last_heartbeat_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', last_heartbeat_at), ''))
) STRICT;

CREATE TABLE warehouse_telemetry_aggregates (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  period_date TEXT NOT NULL CHECK(length(period_date) = 10),
  shift_code TEXT NOT NULL CHECK(shift_code IN ('morning', 'afternoon', 'night', 'all_day')),
  zone_code TEXT NOT NULL CHECK(zone_code IN ('chemicals_bulk', 'picking_flow', 'packing_dock', 'fleet_transit', 'all_warehouse')),
  avg_pick_rate_per_hour REAL NOT NULL CHECK(avg_pick_rate_per_hour >= 0),
  pick_error_rate_basis_points INTEGER NOT NULL CHECK(pick_error_rate_basis_points >= 0),
  dock_to_stock_minutes REAL NOT NULL CHECK(dock_to_stock_minutes >= 0),
  packing_parcels_per_hour REAL NOT NULL CHECK(packing_parcels_per_hour >= 0),
  on_time_delivery_ratio REAL NOT NULL CHECK(on_time_delivery_ratio BETWEEN 0.0 AND 1.0),
  damages_count INTEGER NOT NULL CHECK(damages_count >= 0),
  warehouse_capacity_percent REAL NOT NULL CHECK(warehouse_capacity_percent BETWEEN 0.0 AND 100.0),
  vehicle_capacity_percent REAL NOT NULL CHECK(vehicle_capacity_percent BETWEEN 0.0 AND 100.0),
  healthy_devices_ratio REAL NOT NULL CHECK(healthy_devices_ratio BETWEEN 0.0 AND 1.0),
  labor_privacy_reviewed INTEGER NOT NULL CHECK(labor_privacy_reviewed = 1),
  computed_at TEXT NOT NULL CHECK(computed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', computed_at), '')),
  computed_by TEXT NOT NULL REFERENCES identities(id),
  UNIQUE(period_date, shift_code, zone_code)
) STRICT;

CREATE TRIGGER warehouse_aggregates_no_delete BEFORE DELETE ON warehouse_telemetry_aggregates
BEGIN SELECT RAISE(ABORT, 'warehouse_aggregate_immutable'); END;

CREATE TABLE warehouse_telemetry_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('record_event', 'record_device_heartbeat', 'compute_aggregates', 'audit_privacy_compliance')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(actor_id, idempotency_key)
) STRICT;

CREATE TRIGGER warehouse_telemetry_commands_no_update BEFORE UPDATE ON warehouse_telemetry_commands
BEGIN SELECT RAISE(ABORT, 'warehouse_telemetry_command_immutable'); END;

CREATE TRIGGER warehouse_telemetry_commands_no_delete BEFORE DELETE ON warehouse_telemetry_commands
BEGIN SELECT RAISE(ABORT, 'warehouse_telemetry_command_immutable'); END;
