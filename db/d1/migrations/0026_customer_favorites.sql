-- Account-owned replenishment lists. Saved quantities are purchase units (the
-- variant's minimum/increment policy), not content litres/kilos or case counts.
-- Publication, quantity policy and sellable stock are always read from catalog
-- again before display/add-to-cart; no availability snapshot is persisted.
CREATE TABLE customer_favorite_lists (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80 AND name = trim(name)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK (updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  UNIQUE (customer_id, name),
  CHECK (is_default = 0 OR name = 'Favoritos')
) STRICT;
CREATE UNIQUE INDEX customer_favorite_lists_one_default
  ON customer_favorite_lists(customer_id) WHERE is_default = 1;
CREATE INDEX customer_favorite_lists_owner
  ON customer_favorite_lists(customer_id, is_default DESC, created_at, id);

CREATE TABLE customer_favorite_items (
  list_id TEXT NOT NULL REFERENCES customer_favorite_lists(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  -- A fresh nonce proves that the guarded batch actually wrote this item.
  write_nonce TEXT UNIQUE CHECK (write_nonce IS NULL OR length(write_nonce) = 36),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK (updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  PRIMARY KEY (list_id, variant_id)
) STRICT;
CREATE INDEX customer_favorite_items_variant ON customer_favorite_items(variant_id);
