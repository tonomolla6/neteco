-- Server-side carts and pre-checkout contractual quotes (D1/SQLite port).
--
-- Invariants:
--   * cart ids are non-enumerable random UUIDs; the secret token is stored ONLY
--     as a SHA-256 hex digest, never in clear text.
--   * one line per variant (composite PK); quantities are positive integers
--     with an explicit upper bound; quantity 0 is modelled by deleting the line.
--   * version is a monotonic optimistic-concurrency counter.
--   * checkout_quotes and their lines are IMMUTABLE snapshots; later changes to
--     prices, availability or the cart never touch them.
--   * all timestamps must round-trip through strftime in canonical
--     ISO-8601 UTC seconds form, which also rejects impossible dates.

CREATE TABLE carts (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE
    CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'converted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  expires_at TEXT NOT NULL CHECK (
    expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at), '')
  ),
  expired_at TEXT CHECK (
    expired_at IS NULL OR expired_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expired_at), '')
  ),
  converted_at TEXT CHECK (
    converted_at IS NULL OR converted_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', converted_at), '')
  ),
  converted_quote_id TEXT REFERENCES checkout_quotes(id),
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK (updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  CHECK (expires_at > created_at),
  CHECK (updated_at >= created_at),
  CHECK (expired_at IS NULL OR expired_at >= created_at),
  CHECK (converted_at IS NULL OR converted_at >= created_at),
  CHECK (
    (status = 'active' AND expired_at IS NULL AND converted_at IS NULL AND converted_quote_id IS NULL)
    OR (status = 'expired' AND expired_at IS NOT NULL AND converted_at IS NULL AND converted_quote_id IS NULL)
    OR (status = 'converted' AND expired_at IS NULL AND converted_at IS NOT NULL AND converted_quote_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE cart_lines (
  cart_id TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES variants(id),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK (updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  CHECK (updated_at >= created_at),
  PRIMARY KEY (cart_id, variant_id)
) STRICT;

CREATE INDEX cart_lines_variant_idx ON cart_lines(variant_id);

-- Persistent idempotency ledger: the durable source for replays regardless of
-- any Durable Object cache lifetime. payload_hash covers the full command.
CREATE TABLE cart_commands (
  command_id TEXT NOT NULL CHECK (length(command_id) BETWEEN 1 AND 200),
  cart_id TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mutate', 'quote')),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  response_status INTEGER NOT NULL CHECK (response_status BETWEEN 200 AND 499),
  response_body TEXT NOT NULL CHECK (
    length(response_body) <= 65536 AND json_valid(response_body) AND json_type(response_body) = 'object'
  ),
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  PRIMARY KEY (cart_id, command_id)
) STRICT;

CREATE INDEX cart_commands_cart_idx ON cart_commands(cart_id, created_at);

CREATE TABLE checkout_quotes (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  cart_version INTEGER NOT NULL,
  pricing_instant TEXT NOT NULL CHECK (
    pricing_instant = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', pricing_instant), '')
  ),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  shipping_gross_cents INTEGER NOT NULL DEFAULT 0 CHECK (shipping_gross_cents = 0),
  shipping_pending INTEGER NOT NULL DEFAULT 1 CHECK (shipping_pending = 1),
  total_net_cents INTEGER NOT NULL CHECK (total_net_cents >= 0),
  total_tax_cents INTEGER NOT NULL CHECK (total_tax_cents >= 0),
  total_gross_cents INTEGER NOT NULL CHECK (total_gross_cents >= 0),
  snapshot_hash TEXT NOT NULL
    CHECK (length(snapshot_hash) = 64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'),
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX checkout_quotes_cart_idx ON checkout_quotes(cart_id, created_at);

CREATE TRIGGER checkout_quotes_immutable_update
BEFORE UPDATE ON checkout_quotes
BEGIN
  SELECT RAISE(ABORT, 'checkout quote snapshots are immutable');
END;

CREATE TRIGGER checkout_quotes_immutable_delete
BEFORE DELETE ON checkout_quotes
BEGIN
  SELECT RAISE(ABORT, 'checkout quote snapshots are immutable');
END;

CREATE TABLE checkout_quote_lines (
  quote_id TEXT NOT NULL REFERENCES checkout_quotes(id) ON DELETE CASCADE,
  line_index INTEGER NOT NULL CHECK (line_index >= 0),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  format TEXT NOT NULL,
  unit_label TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  unit_gross_cents INTEGER NOT NULL CHECK (unit_gross_cents > 0),
  net_cents INTEGER NOT NULL CHECK (net_cents >= 0),
  tax_cents INTEGER NOT NULL CHECK (tax_cents >= 0),
  gross_cents INTEGER NOT NULL CHECK (gross_cents >= 0),
  tax_rate_basis_points INTEGER NOT NULL CHECK (tax_rate_basis_points BETWEEN 0 AND 10000),
  price_version_id TEXT NOT NULL,
  available_quantity INTEGER NOT NULL CHECK (available_quantity >= 0),
  backorder_allowed INTEGER NOT NULL CHECK (backorder_allowed IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  CHECK (gross_cents = net_cents + tax_cents),
  CHECK (gross_cents = unit_gross_cents * quantity),
  PRIMARY KEY (quote_id, line_index)
) STRICT;

CREATE TRIGGER checkout_quote_lines_immutable_update
BEFORE UPDATE ON checkout_quote_lines
BEGIN
  SELECT RAISE(ABORT, 'checkout quote line snapshots are immutable');
END;

CREATE TRIGGER checkout_quote_lines_immutable_delete
BEFORE DELETE ON checkout_quote_lines
BEGIN
  SELECT RAISE(ABORT, 'checkout quote line snapshots are immutable');
END;
