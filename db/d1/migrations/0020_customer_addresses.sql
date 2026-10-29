-- A personal address book, not business locations. Orders keep their own
-- immutable shipping/billing snapshots and never depend on these rows.
CREATE TABLE customer_addresses (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('shipping', 'billing', 'both')),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 80 AND label = trim(label)),
  recipient_name TEXT NOT NULL CHECK (length(trim(recipient_name)) BETWEEN 2 AND 160 AND recipient_name = trim(recipient_name)),
  company_name TEXT CHECK (company_name IS NULL OR (length(trim(company_name)) BETWEEN 1 AND 160 AND company_name = trim(company_name))),
  tax_id TEXT CHECK (tax_id IS NULL OR (length(tax_id) BETWEEN 3 AND 32 AND tax_id NOT GLOB '*[^A-Z0-9-]*')),
  line1 TEXT NOT NULL CHECK (length(trim(line1)) BETWEEN 3 AND 200 AND line1 = trim(line1)),
  line2 TEXT CHECK (line2 IS NULL OR (length(trim(line2)) BETWEEN 1 AND 200 AND line2 = trim(line2))),
  postal_code TEXT NOT NULL CHECK (length(trim(postal_code)) BETWEEN 2 AND 16 AND postal_code = trim(postal_code)),
  city TEXT NOT NULL CHECK (length(trim(city)) BETWEEN 2 AND 120 AND city = trim(city)),
  region TEXT NOT NULL CHECK (length(trim(region)) BETWEEN 2 AND 120 AND region = trim(region)),
  country_code TEXT NOT NULL CHECK (length(country_code) = 2 AND country_code NOT GLOB '*[^A-Z]*'),
  phone TEXT CHECK (phone IS NULL OR (length(trim(phone)) BETWEEN 7 AND 32 AND phone = trim(phone))),
  instructions TEXT CHECK (instructions IS NULL OR (length(trim(instructions)) BETWEEN 1 AND 500 AND instructions = trim(instructions))),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK (updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;
CREATE INDEX customer_addresses_customer_time ON customer_addresses(customer_id, created_at DESC);
CREATE UNIQUE INDEX customer_addresses_one_default ON customer_addresses(customer_id) WHERE is_default = 1;

CREATE TABLE customer_address_events (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  address_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
  kind TEXT NOT NULL CHECK (kind IN ('shipping', 'billing', 'both')),
  country_code TEXT NOT NULL,
  is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE INDEX customer_address_events_customer_time ON customer_address_events(customer_id, created_at DESC);
CREATE TRIGGER customer_address_events_no_update BEFORE UPDATE ON customer_address_events
BEGIN SELECT RAISE(ABORT, 'customer_address_events_immutable'); END;
CREATE TRIGGER customer_address_events_no_delete BEFORE DELETE ON customer_address_events
BEGIN SELECT RAISE(ABORT, 'customer_address_events_immutable'); END;

-- SQLite executes each statement with its triggers atomically. Clearing a
-- previous default is therefore part of the same write as the new default.
CREATE TRIGGER customer_addresses_clear_default_insert BEFORE INSERT ON customer_addresses
WHEN NEW.is_default = 1
BEGIN
  UPDATE customer_addresses SET is_default = 0, updated_at = NEW.updated_at
  WHERE customer_id = NEW.customer_id AND is_default = 1;
END;
CREATE TRIGGER customer_addresses_clear_default_update BEFORE UPDATE ON customer_addresses
WHEN NEW.is_default = 1
BEGIN
  UPDATE customer_addresses SET is_default = 0, updated_at = NEW.updated_at
  WHERE customer_id = NEW.customer_id AND id <> NEW.id AND is_default = 1;
END;

CREATE TRIGGER customer_addresses_audit_insert AFTER INSERT ON customer_addresses
BEGIN
  INSERT INTO customer_address_events(id, customer_id, address_id, action, kind, country_code, is_default, created_at)
  VALUES (lower(hex(randomblob(16))), NEW.customer_id, NEW.id, 'created', NEW.kind, NEW.country_code, NEW.is_default, NEW.created_at);
END;
CREATE TRIGGER customer_addresses_audit_update AFTER UPDATE ON customer_addresses
BEGIN
  INSERT INTO customer_address_events(id, customer_id, address_id, action, kind, country_code, is_default, created_at)
  VALUES (lower(hex(randomblob(16))), NEW.customer_id, NEW.id, 'updated', NEW.kind, NEW.country_code, NEW.is_default, NEW.updated_at);
END;
CREATE TRIGGER customer_addresses_audit_delete AFTER DELETE ON customer_addresses
BEGIN
  INSERT INTO customer_address_events(id, customer_id, address_id, action, kind, country_code, is_default, created_at)
  VALUES (lower(hex(randomblob(16))), OLD.customer_id, OLD.id, 'deleted', OLD.kind, OLD.country_code, OLD.is_default, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
END;
