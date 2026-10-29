-- One customer per login and at most one company per customer. Businesses have
-- ordinary billing details, without locations or delegated purchasing roles.
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  name TEXT CHECK (name IS NULL OR (length(trim(name)) BETWEEN 1 AND 200 AND name = trim(name))),
  phone TEXT CHECK (phone IS NULL OR (length(trim(phone)) BETWEEN 6 AND 32 AND phone = trim(phone))),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'anonymized')),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK (updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

ALTER TABLE identities ADD COLUMN customer_id TEXT REFERENCES customers(id);
CREATE UNIQUE INDEX identities_customer_unique ON identities(customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  legal_name TEXT NOT NULL CHECK (length(trim(legal_name)) BETWEEN 1 AND 200 AND legal_name = trim(legal_name)),
  trade_name TEXT CHECK (trade_name IS NULL OR (length(trim(trade_name)) BETWEEN 1 AND 200 AND trade_name = trim(trade_name))),
  tax_id TEXT CHECK (tax_id IS NULL OR (length(trim(tax_id)) BETWEEN 3 AND 32 AND tax_id = trim(tax_id))),
  country_code TEXT NOT NULL DEFAULT 'ES' CHECK (length(country_code) = 2 AND country_code NOT GLOB '*[^A-Z]*'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK (updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE UNIQUE INDEX companies_country_tax_unique ON companies(country_code, tax_id) WHERE tax_id IS NOT NULL;
