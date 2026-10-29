-- Migration 0097: Carrier Resilience (Circuit Breaker, Fallbacks, Label Idempotency) & Carrier Scorecard
-- Requirements SHP-022 and SHP-021

CREATE TABLE carrier_circuit_breakers (
  carrier TEXT PRIMARY KEY CHECK(length(carrier) BETWEEN 2 AND 64),
  state TEXT NOT NULL DEFAULT 'closed' CHECK(state IN ('closed', 'open', 'half_open')),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count >= 0),
  success_count INTEGER NOT NULL DEFAULT 0 CHECK(success_count >= 0),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
  consecutive_successes INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_successes >= 0),
  failure_threshold INTEGER NOT NULL DEFAULT 5 CHECK(failure_threshold >= 1),
  success_threshold INTEGER NOT NULL DEFAULT 2 CHECK(success_threshold >= 1),
  cooldown_seconds INTEGER NOT NULL DEFAULT 300 CHECK(cooldown_seconds >= 1),
  opened_at TEXT CHECK(opened_at IS NULL OR (length(opened_at) = 20 AND opened_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', opened_at), ''))),
  half_opened_at TEXT CHECK(half_opened_at IS NULL OR (length(half_opened_at) = 20 AND half_opened_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', half_opened_at), ''))),
  last_failure_at TEXT CHECK(last_failure_at IS NULL OR (length(last_failure_at) = 20 AND last_failure_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', last_failure_at), ''))),
  last_success_at TEXT CHECK(last_success_at IS NULL OR (length(last_success_at) = 20 AND last_success_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', last_success_at), ''))),
  last_failure_reason TEXT,
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;

CREATE TABLE carrier_circuit_breaker_events (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  carrier TEXT NOT NULL REFERENCES carrier_circuit_breakers(carrier),
  previous_state TEXT NOT NULL CHECK(previous_state IN ('closed', 'open', 'half_open')),
  new_state TEXT NOT NULL CHECK(new_state IN ('closed', 'open', 'half_open')),
  trigger_reason TEXT NOT NULL CHECK(length(trigger_reason) >= 1),
  consecutive_failures INTEGER NOT NULL CHECK(consecutive_failures >= 0),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE TABLE carrier_rate_cache (
  cache_key TEXT PRIMARY KEY CHECK(length(cache_key) = 64),
  carrier TEXT NOT NULL CHECK(length(carrier) BETWEEN 2 AND 64),
  zone_code TEXT NOT NULL CHECK(length(zone_code) >= 1),
  service_code TEXT NOT NULL CHECK(length(service_code) >= 1),
  service_profile TEXT NOT NULL CHECK(service_profile IN ('parcel', 'pallet', 'adr', 'own_delivery', 'pickup')),
  weight_tier_grams INTEGER NOT NULL CHECK(weight_tier_grams >= 0),
  net_cents INTEGER NOT NULL CHECK(net_cents >= 0),
  tax_rate_basis_points INTEGER NOT NULL CHECK(tax_rate_basis_points >= 0),
  gross_cents INTEGER NOT NULL CHECK(gross_cents >= 0),
  eta_min_days INTEGER NOT NULL CHECK(eta_min_days >= 0),
  eta_max_days INTEGER NOT NULL CHECK(eta_max_days >= eta_min_days),
  cached_at TEXT NOT NULL CHECK(length(cached_at) = 20 AND cached_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', cached_at), '')),
  expires_at TEXT NOT NULL CHECK(length(expires_at) = 20 AND expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at), ''))
) STRICT;

CREATE INDEX idx_carrier_rate_cache_lookup ON carrier_rate_cache(carrier, zone_code, service_profile, weight_tier_grams, expires_at);

CREATE TABLE carrier_fallback_rates (
  carrier TEXT NOT NULL CHECK(length(carrier) BETWEEN 2 AND 64),
  service_profile TEXT NOT NULL CHECK(service_profile IN ('parcel', 'pallet', 'adr', 'own_delivery', 'pickup')),
  zone_code TEXT NOT NULL CHECK(length(zone_code) >= 1),
  service_code TEXT NOT NULL CHECK(length(service_code) >= 1),
  net_cents INTEGER NOT NULL CHECK(net_cents >= 0),
  tax_rate_basis_points INTEGER NOT NULL CHECK(tax_rate_basis_points >= 0),
  gross_cents INTEGER NOT NULL CHECK(gross_cents >= 0),
  eta_min_days INTEGER NOT NULL CHECK(eta_min_days >= 0),
  eta_max_days INTEGER NOT NULL CHECK(eta_max_days >= eta_min_days),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  PRIMARY KEY (carrier, service_profile, zone_code)
) STRICT;

CREATE TABLE carrier_shipment_labels (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  order_id TEXT NOT NULL REFERENCES orders(id),
  parcel_index INTEGER NOT NULL CHECK(parcel_index >= 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  command_id TEXT CHECK(command_id IS NULL OR length(command_id) = 36),
  carrier TEXT NOT NULL CHECK(length(carrier) BETWEEN 2 AND 64),
  service_code TEXT NOT NULL CHECK(length(service_code) >= 1),
  tracking_number TEXT NOT NULL CHECK(length(tracking_number) >= 1),
  provider_shipment_id TEXT NOT NULL CHECK(length(provider_shipment_id) >= 1),
  label_format TEXT NOT NULL CHECK(label_format IN ('pdf', 'zpl')),
  label_data TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'uncertain', 'failed', 'cancelled')),
  reconciliation_status TEXT NOT NULL DEFAULT 'none' CHECK(reconciliation_status IN ('none', 'required', 'in_progress', 'reconciled_confirmed', 'reconciled_not_found', 'failed')),
  reconciliation_attempts INTEGER NOT NULL DEFAULT 0 CHECK(reconciliation_attempts >= 0),
  uncertain_reason TEXT,
  quoted_gross_cents INTEGER NOT NULL CHECK(quoted_gross_cents >= 0),
  actual_cost_cents INTEGER NOT NULL CHECK(actual_cost_cents >= 0),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  UNIQUE(order_id, parcel_index)
) STRICT;

CREATE INDEX idx_carrier_labels_order ON carrier_shipment_labels(order_id, parcel_index);
CREATE INDEX idx_carrier_labels_tracking ON carrier_shipment_labels(tracking_number);

CREATE TABLE carrier_performance_records (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  carrier TEXT NOT NULL CHECK(length(carrier) BETWEEN 2 AND 64),
  order_id TEXT REFERENCES orders(id),
  tracking_number TEXT NOT NULL CHECK(length(tracking_number) >= 1),
  service_code TEXT NOT NULL CHECK(length(service_code) >= 1),
  dispatched_at TEXT NOT NULL CHECK(length(dispatched_at) = 20 AND dispatched_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', dispatched_at), '')),
  promised_delivery_at TEXT NOT NULL CHECK(length(promised_delivery_at) = 20 AND promised_delivery_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', promised_delivery_at), '')),
  first_delivery_attempt_at TEXT CHECK(first_delivery_attempt_at IS NULL OR (length(first_delivery_attempt_at) = 20 AND first_delivery_attempt_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', first_delivery_attempt_at), ''))),
  delivered_at TEXT CHECK(delivered_at IS NULL OR (length(delivered_at) = 20 AND delivered_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', delivered_at), ''))),
  status TEXT NOT NULL CHECK(status IN ('in_transit', 'delivered', 'failed_attempt', 'incident', 'returned', 'cancelled')),
  is_delivered INTEGER NOT NULL DEFAULT 0 CHECK(is_delivered IN (0, 1)),
  is_on_time INTEGER CHECK(is_on_time IS NULL OR is_on_time IN (0, 1)),
  is_first_attempt_success INTEGER CHECK(is_first_attempt_success IS NULL OR is_first_attempt_success IN (0, 1)),
  has_damage INTEGER NOT NULL DEFAULT 0 CHECK(has_damage IN (0, 1)),
  has_incident INTEGER NOT NULL DEFAULT 0 CHECK(has_incident IN (0, 1)),
  incident_kind TEXT CHECK(incident_kind IS NULL OR incident_kind IN ('damage', 'address_not_found', 'recipient_absent', 'delay', 'lost', 'weather', 'customs', 'other')),
  incident_opened_at TEXT CHECK(incident_opened_at IS NULL OR (length(incident_opened_at) = 20 AND incident_opened_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', incident_opened_at), ''))),
  incident_resolved_at TEXT CHECK(incident_resolved_at IS NULL OR (length(incident_resolved_at) = 20 AND incident_resolved_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', incident_resolved_at), ''))),
  resolution_time_seconds INTEGER CHECK(resolution_time_seconds IS NULL OR resolution_time_seconds >= 0),
  cost_cents INTEGER NOT NULL DEFAULT 0 CHECK(cost_cents >= 0),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;

CREATE INDEX idx_carrier_perf_carrier_date ON carrier_performance_records(carrier, dispatched_at);
CREATE INDEX idx_carrier_perf_status ON carrier_performance_records(status, dispatched_at);
