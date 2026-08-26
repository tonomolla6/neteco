-- Checkout acceptance, server-side shipping, contractual orders and inventory
-- reservation saga (D1/SQLite). Incremental over 0001-0005, never editing them.
--
-- Hex-digest CHECKs use the negated-GLOB form: length = 64 AND NOT GLOB '*[^0-9a-f]*'
-- (the naive `GLOB '[0-9a-f]*'` only constrains the first character).
-- All timestamps are canonical ISO-8601 UTC seconds validated by strftime
-- round-trip with COALESCE so NULL results reject the row.

-- Quote expiry arrives with this migration; 0005 stays untouched.
ALTER TABLE checkout_quotes ADD COLUMN expires_at TEXT;
UPDATE checkout_quotes
SET expires_at = COALESCE(
  strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+1 day'),
  '9999-12-31T23:59:59Z'
);
CREATE TABLE shipping_zones (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('warehouse_pickup', 'own_delivery', 'parcel_peninsular')),
  postal_prefixes TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(postal_prefixes) AND json_type(postal_prefixes) = 'array'),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL CHECK (
    created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  )
) STRICT;

CREATE TABLE shipping_rates (
  id TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL REFERENCES shipping_zones(id),
  method_code TEXT NOT NULL CHECK (method_code IN ('pickup', 'own_delivery', 'parcel')),
  service_profile TEXT NOT NULL CHECK (service_profile IN ('parcel', 'pallet', 'adr')),
  net_cents INTEGER NOT NULL CHECK (net_cents >= 0),
  tax_rate_basis_points INTEGER NOT NULL CHECK (tax_rate_basis_points BETWEEN 0 AND 10000),
  eta_min_days INTEGER NOT NULL CHECK (eta_min_days >= 0),
  eta_max_days INTEGER NOT NULL CHECK (eta_max_days >= eta_min_days),
  rate_version INTEGER NOT NULL CHECK (rate_version >= 1),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL CHECK (
    created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  ),
  UNIQUE (zone_id, method_code, service_profile, rate_version)
) STRICT;

CREATE INDEX shipping_rates_zone_idx ON shipping_rates(zone_id, active);

-- Expirable snapshot of the eligible options for one cart + destination.
CREATE TABLE shipping_quotes (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  cart_version INTEGER NOT NULL,
  destination_hash TEXT NOT NULL
    CHECK (length(destination_hash) = 64 AND destination_hash NOT GLOB '*[^0-9a-f]*'),
  options_json TEXT NOT NULL CHECK (json_valid(options_json) AND json_type(options_json) = 'array'),
  option_count INTEGER NOT NULL CHECK (option_count >= 0),
  snapshot_hash TEXT NOT NULL
    CHECK (length(snapshot_hash) = 64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'),
  expires_at TEXT NOT NULL CHECK (
    expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at), '')
  ),
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (
    created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  )
) STRICT;

CREATE INDEX shipping_quotes_cart_idx ON shipping_quotes(cart_id, created_at);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL UNIQUE REFERENCES carts(id),
  quote_id TEXT NOT NULL REFERENCES checkout_quotes(id),
  shipping_quote_id TEXT NOT NULL REFERENCES shipping_quotes(id),
  attempt_id TEXT NOT NULL REFERENCES checkout_attempts(id),
  token_hash TEXT NOT NULL UNIQUE
    CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL DEFAULT 'awaiting_payment'
    CHECK (status IN ('awaiting_payment', 'cancelled')),
  reservation_id TEXT NOT NULL,
  reservation_expires_at TEXT NOT NULL CHECK (
    reservation_expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', reservation_expires_at), '')
  ),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  total_net_cents INTEGER NOT NULL CHECK (total_net_cents >= 0),
  total_tax_cents INTEGER NOT NULL CHECK (total_tax_cents >= 0),
  total_gross_cents INTEGER NOT NULL CHECK (total_gross_cents >= 0),
  shipping_net_cents INTEGER NOT NULL CHECK (shipping_net_cents >= 0),
  shipping_tax_cents INTEGER NOT NULL CHECK (shipping_tax_cents >= 0),
  shipping_gross_cents INTEGER NOT NULL CHECK (shipping_gross_cents >= 0),
  shipping_method_code TEXT NOT NULL,
  shipping_rate_version INTEGER NOT NULL,
  shipping_eta_min_days INTEGER NOT NULL,
  shipping_eta_max_days INTEGER NOT NULL,
  contact_email TEXT NOT NULL CHECK (length(contact_email) BETWEEN 3 AND 254),
  contact_email_hash TEXT NOT NULL
    CHECK (length(contact_email_hash) = 64 AND contact_email_hash NOT GLOB '*[^0-9a-f]*'),
  consent_tos INTEGER NOT NULL CHECK (consent_tos = 1),
  consent_privacy INTEGER NOT NULL CHECK (consent_privacy = 1),
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (
    created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')
  ),
  CHECK (shipping_gross_cents = shipping_net_cents + shipping_tax_cents),
  CHECK (total_gross_cents = total_net_cents + total_tax_cents),
  CHECK (shipping_eta_max_days >= shipping_eta_min_days)
) STRICT;

CREATE INDEX orders_status_idx ON orders(status, created_at);

-- Immutable contractual line snapshots.
CREATE TABLE order_lines (
  order_id TEXT NOT NULL REFERENCES orders(id),
  line_index INTEGER NOT NULL CHECK (line_index >= 0),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  unit_gross_cents INTEGER NOT NULL CHECK (unit_gross_cents > 0),
  net_cents INTEGER NOT NULL CHECK (net_cents >= 0),
  tax_cents INTEGER NOT NULL CHECK (tax_cents >= 0),
  gross_cents INTEGER NOT NULL CHECK (gross_cents >= 0),
  tax_rate_basis_points INTEGER NOT NULL CHECK (tax_rate_basis_points BETWEEN 0 AND 10000),
  price_version_id TEXT NOT NULL,
  location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  created_at TEXT NOT NULL CHECK (
    created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  ),
  CONSTRAINT gross_matches_line CHECK (gross_cents = net_cents + tax_cents),
  CONSTRAINT gross_matches_units CHECK (gross_cents = unit_gross_cents * quantity),
  PRIMARY KEY (order_id, line_index)
) STRICT;

CREATE TABLE order_shipping_address (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  recipient_name TEXT NOT NULL CHECK (length(recipient_name) BETWEEN 2 AND 120),
  line1 TEXT NOT NULL CHECK (length(line1) BETWEEN 3 AND 160),
  line2 TEXT CHECK (line2 IS NULL OR length(line2) <= 160),
  city TEXT NOT NULL CHECK (length(city) BETWEEN 1 AND 80),
  province TEXT NOT NULL CHECK (length(province) BETWEEN 1 AND 80),
  postal_code TEXT NOT NULL CHECK (postal_code GLOB '[0-9][0-9][0-9][0-9][0-9]'),
  country_code TEXT NOT NULL CHECK (country_code = 'ES'),
  phone TEXT NOT NULL CHECK (length(phone) BETWEEN 6 AND 24),
  created_at TEXT NOT NULL CHECK (
    created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  )
) STRICT;

CREATE TABLE order_billing_address (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  recipient_name TEXT NOT NULL CHECK (length(recipient_name) BETWEEN 2 AND 120),
  line1 TEXT NOT NULL CHECK (length(line1) BETWEEN 3 AND 160),
  line2 TEXT CHECK (line2 IS NULL OR length(line2) <= 160),
  city TEXT NOT NULL CHECK (length(city) BETWEEN 1 AND 80),
  province TEXT NOT NULL CHECK (province IS NULL OR length(province) <= 80)
    CHECK (province IS NOT NULL),
  postal_code TEXT NOT NULL CHECK (postal_code GLOB '[0-9][0-9][0-9][0-9][0-9]'),
  country_code TEXT NOT NULL CHECK (country_code = 'ES'),
  nif TEXT CHECK (nif IS NULL OR length(nif) BETWEEN 6 AND 20),
  created_at TEXT NOT NULL CHECK (
    created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  )
) STRICT;

-- Persistent checkout saga: D1 alone can recover an interrupted checkout.
CREATE TABLE checkout_attempts (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL REFERENCES carts(id),
  command_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'reserving'
    CHECK (state IN ('reserving', 'reserved', 'completed', 'failed', 'compensated')),
  reservation_id TEXT,
  reservation_expires_at TEXT CHECK (
    reservation_expires_at IS NULL OR
    reservation_expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', reservation_expires_at), '')
  ),
  reservation_lines_json TEXT CHECK (
    reservation_lines_json IS NULL OR
    (json_valid(reservation_lines_json) AND json_type(reservation_lines_json) = 'array')
  ),
  order_id TEXT UNIQUE REFERENCES orders(id),
  failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) <= 200),
  correlation_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL
    CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (
    created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')
  ),
  UNIQUE (cart_id, command_key),
  CHECK (
    (state = 'reserving' AND reservation_id IS NULL AND order_id IS NULL
      AND reservation_expires_at IS NOT NULL AND reservation_lines_json IS NOT NULL)
    OR (state = 'reserved' AND reservation_id IS NOT NULL AND order_id IS NULL
      AND reservation_expires_at IS NOT NULL AND reservation_lines_json IS NOT NULL)
    OR (state = 'completed' AND reservation_id IS NOT NULL AND order_id IS NOT NULL
      AND reservation_expires_at IS NOT NULL AND reservation_lines_json IS NOT NULL)
    OR (state = 'failed' AND order_id IS NULL)
    OR (state = 'compensated' AND order_id IS NULL)
  )
) STRICT;

CREATE INDEX checkout_attempts_sweep_idx ON checkout_attempts(state, reservation_expires_at, updated_at);

-- Idempotency ledger for the new checkout-lane commands (shipping options and
-- order placement), isolated per cart exactly like cart_commands.
CREATE TABLE checkout_commands (
  cart_id TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  command_id TEXT NOT NULL CHECK (length(command_id) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK (kind IN ('shipping-options', 'checkout')),
  payload_hash TEXT NOT NULL
    CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  response_status INTEGER NOT NULL CHECK (response_status BETWEEN 200 AND 499),
  response_body TEXT NOT NULL CHECK (
    length(response_body) <= 65536 AND json_valid(response_body) AND json_type(response_body) = 'object'
  ),
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (
    created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  ),
  PRIMARY KEY (cart_id, command_id)
) STRICT;


-- Append-only order event ledger; UPDATE and DELETE are physically rejected.
CREATE TABLE order_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 3 AND 60),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (
    created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  )
) STRICT;

CREATE INDEX order_events_order_idx ON order_events(order_id, created_at);

CREATE TRIGGER order_events_no_update BEFORE UPDATE ON order_events
BEGIN
  SELECT RAISE(ABORT, 'order_events is append-only');
END;
CREATE TRIGGER order_events_no_delete BEFORE DELETE ON order_events
BEGIN
  SELECT RAISE(ABORT, 'order_events is append-only');
END;

-- Contractual snapshots reject UPDATE/DELETE outright.
CREATE TRIGGER order_lines_no_update BEFORE UPDATE ON order_lines
BEGIN
  SELECT RAISE(ABORT, 'order lines are contractual snapshots');
END;
CREATE TRIGGER order_lines_no_delete BEFORE DELETE ON order_lines
BEGIN
  SELECT RAISE(ABORT, 'order lines are contractual snapshots');
END;
CREATE TRIGGER order_shipping_address_no_update BEFORE UPDATE ON order_shipping_address
BEGIN
  SELECT RAISE(ABORT, 'shipping address is a contractual snapshot');
END;
CREATE TRIGGER order_shipping_address_no_delete BEFORE DELETE ON order_shipping_address
BEGIN
  SELECT RAISE(ABORT, 'shipping address is a contractual snapshot');
END;
CREATE TRIGGER order_billing_address_no_update BEFORE UPDATE ON order_billing_address
BEGIN
  SELECT RAISE(ABORT, 'billing address is a contractual snapshot');
END;
CREATE TRIGGER order_billing_address_no_delete BEFORE DELETE ON order_billing_address
BEGIN
  SELECT RAISE(ABORT, 'billing address is a contractual snapshot');
END;
CREATE TRIGGER shipping_quotes_no_update BEFORE UPDATE ON shipping_quotes
BEGIN
  SELECT RAISE(ABORT, 'shipping quotes are immutable snapshots');
END;
CREATE TRIGGER shipping_quotes_no_delete BEFORE DELETE ON shipping_quotes
BEGIN
  SELECT RAISE(ABORT, 'shipping quotes are immutable snapshots');
END;
CREATE TRIGGER checkout_quotes_no_update BEFORE UPDATE ON checkout_quotes
BEGIN
  SELECT RAISE(ABORT, 'checkout quotes are immutable snapshots');
END;
CREATE TRIGGER checkout_quotes_no_delete BEFORE DELETE ON checkout_quotes
BEGIN
  SELECT RAISE(ABORT, 'checkout quotes are immutable snapshots');
END;
CREATE TRIGGER checkout_quote_lines_no_update BEFORE UPDATE ON checkout_quote_lines
BEGIN
  SELECT RAISE(ABORT, 'quote lines are immutable snapshots');
END;
CREATE TRIGGER checkout_quote_lines_no_delete BEFORE DELETE ON checkout_quote_lines
BEGIN
  SELECT RAISE(ABORT, 'quote lines are immutable snapshots');
END;

-- orders allow only operational columns to change (status, reservation linkage,
-- updated_at); every contractual column is compared against its old value.
CREATE TRIGGER orders_contractual_immutable BEFORE UPDATE ON orders
WHEN old.cart_id <> new.cart_id
  OR old.quote_id <> new.quote_id
  OR old.shipping_quote_id <> new.shipping_quote_id
  OR old.attempt_id <> new.attempt_id
  OR old.token_hash <> new.token_hash
  OR old.reservation_id <> new.reservation_id
  OR old.reservation_expires_at <> new.reservation_expires_at
  OR old.currency <> new.currency
  OR old.total_net_cents <> new.total_net_cents
  OR old.total_tax_cents <> new.total_tax_cents
  OR old.total_gross_cents <> new.total_gross_cents
  OR old.shipping_net_cents <> new.shipping_net_cents
  OR old.shipping_tax_cents <> new.shipping_tax_cents
  OR old.shipping_gross_cents <> new.shipping_gross_cents
  OR old.shipping_method_code <> new.shipping_method_code
  OR old.shipping_rate_version <> new.shipping_rate_version
  OR old.shipping_eta_min_days <> new.shipping_eta_min_days
  OR old.shipping_eta_max_days <> new.shipping_eta_max_days
  OR old.contact_email <> new.contact_email
  OR old.contact_email_hash <> new.contact_email_hash
  OR old.consent_tos <> new.consent_tos
  OR old.consent_privacy <> new.consent_privacy
  OR old.correlation_id <> new.correlation_id
  OR old.created_at <> new.created_at
BEGIN
  SELECT RAISE(ABORT, 'order contractual fields are immutable');
END;
