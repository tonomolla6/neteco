-- Editorial versions are independent of price/inventory versions. A no-op or
-- timestamp-only import does not invalidate an editor's snapshot.
ALTER TABLE products ADD COLUMN catalog_version INTEGER NOT NULL DEFAULT 1
  CHECK (catalog_version BETWEEN 1 AND 9007199254740991);

CREATE TRIGGER products_catalog_version_insert BEFORE INSERT ON products
WHEN NEW.catalog_version <> 1
BEGIN SELECT RAISE(ABORT, 'catalog_version_initial'); END;
CREATE TRIGGER products_catalog_version_guard BEFORE UPDATE ON products
WHEN NEW.catalog_version < OLD.catalog_version OR NEW.catalog_version > OLD.catalog_version + 1
BEGIN SELECT RAISE(ABORT, 'catalog_version_monotonic'); END;

-- A version-only nested UPDATE must never reindex FTS a second time. Null-safe
-- comparisons also avoid reindexing identical seed UPSERTs.
DROP TRIGGER products_fts_update;
CREATE TRIGGER products_fts_update
AFTER UPDATE OF name, short_description, description, usage ON products
WHEN NEW.name IS NOT OLD.name OR NEW.short_description IS NOT OLD.short_description
  OR NEW.description IS NOT OLD.description OR NEW.usage IS NOT OLD.usage
BEGIN
  INSERT INTO products_fts(products_fts, rowid, name, short_description, description, usage)
  VALUES ('delete', OLD.rowid, OLD.name, OLD.short_description, OLD.description, OLD.usage);
  INSERT INTO products_fts(rowid, name, short_description, description, usage)
  VALUES (NEW.rowid, NEW.name, NEW.short_description, NEW.description, NEW.usage);
END;

CREATE TRIGGER products_catalog_version_bump
AFTER UPDATE OF id, legacy_id, category_id, brand_id, source_id, name, slug,
  short_description, description, usage, series, status, featured, attributes,
  regulatory, source_version, published_at ON products
WHEN NEW.catalog_version = OLD.catalog_version AND (
  NEW.id IS NOT OLD.id OR NEW.legacy_id IS NOT OLD.legacy_id
  OR NEW.category_id IS NOT OLD.category_id OR NEW.brand_id IS NOT OLD.brand_id
  OR NEW.source_id IS NOT OLD.source_id OR NEW.name IS NOT OLD.name
  OR NEW.slug IS NOT OLD.slug OR NEW.short_description IS NOT OLD.short_description
  OR NEW.description IS NOT OLD.description OR NEW.usage IS NOT OLD.usage
  OR NEW.series IS NOT OLD.series OR NEW.status IS NOT OLD.status
  OR NEW.featured IS NOT OLD.featured OR NEW.attributes IS NOT OLD.attributes
  OR NEW.regulatory IS NOT OLD.regulatory OR NEW.source_version IS NOT OLD.source_version
  OR NEW.published_at IS NOT OLD.published_at
)
BEGIN
  UPDATE products SET catalog_version = OLD.catalog_version + 1
    WHERE id = NEW.id AND catalog_version = OLD.catalog_version;
END;

CREATE TABLE catalog_draft_commands (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  claim_nonce TEXT NOT NULL UNIQUE CHECK (length(claim_nonce) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  product_legacy_id INTEGER NOT NULL CHECK (product_legacy_id BETWEEN 1 AND 9007199254740991),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  expected_version INTEGER NOT NULL CHECK (expected_version BETWEEN 1 AND 9007199254740990),
  result_version INTEGER NOT NULL CHECK (result_version = expected_version + 1 AND result_version <= 9007199254740991),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 500),
  patch TEXT NOT NULL CHECK (json_valid(patch) AND json_type(patch) = 'object'),
  before_metadata TEXT NOT NULL CHECK (json_valid(before_metadata) AND json_type(before_metadata) = 'object'),
  after_metadata TEXT NOT NULL CHECK (json_valid(after_metadata) AND json_type(after_metadata) = 'object'),
  response TEXT NOT NULL CHECK (json_valid(response) AND json_type(response) = 'object'
    AND COALESCE(json_extract(response, '$.source') = 'cloudflare', 0)
    AND COALESCE(json_extract(response, '$.productId') = product_legacy_id, 0)
    AND COALESCE(json_extract(response, '$.productUuid') = product_id, 0)
    AND COALESCE(json_extract(response, '$.catalogVersion') = result_version, 0)
    AND COALESCE(json_type(response, '$.updated') = 'true', 0)),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(actor_id, idempotency_key),
  UNIQUE(product_id, result_version)
) STRICT;
CREATE INDEX catalog_draft_commands_product ON catalog_draft_commands(product_id, result_version);
CREATE TRIGGER catalog_draft_commands_shape BEFORE INSERT ON catalog_draft_commands
WHEN NOT EXISTS (SELECT 1 FROM json_each(NEW.patch)) OR EXISTS (
  SELECT 1 FROM json_each(NEW.patch) WHERE key NOT IN (
    'name', 'categoryId', 'shortDesc', 'description', 'usage', 'series', 'featured', 'badges', 'visual', 'attrs'
  )
)
BEGIN SELECT RAISE(ABORT, 'catalog_draft_commands_shape'); END;
-- DELETE triggers do not protect implicit REPLACE deletion with recursive
-- triggers disabled. Reject duplicate identities/business keys before INSERT.
CREATE TRIGGER catalog_draft_commands_duplicate BEFORE INSERT ON catalog_draft_commands
WHEN EXISTS (SELECT 1 FROM catalog_draft_commands WHERE id = NEW.id OR claim_nonce = NEW.claim_nonce
  OR (actor_id = NEW.actor_id AND idempotency_key = NEW.idempotency_key)
  OR (product_id = NEW.product_id AND result_version = NEW.result_version))
BEGIN SELECT RAISE(ABORT, 'catalog_draft_commands_immutable'); END;
CREATE TRIGGER catalog_draft_commands_no_update BEFORE UPDATE ON catalog_draft_commands
BEGIN SELECT RAISE(ABORT, 'catalog_draft_commands_immutable'); END;
CREATE TRIGGER catalog_draft_commands_no_delete BEFORE DELETE ON catalog_draft_commands
BEGIN SELECT RAISE(ABORT, 'catalog_draft_commands_immutable'); END;

CREATE TABLE catalog_draft_audit (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  command_id TEXT NOT NULL UNIQUE REFERENCES catalog_draft_commands(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  product_legacy_id INTEGER NOT NULL CHECK (product_legacy_id BETWEEN 1 AND 9007199254740991),
  before_version INTEGER NOT NULL CHECK (before_version BETWEEN 1 AND 9007199254740990),
  after_version INTEGER NOT NULL CHECK (after_version = before_version + 1 AND after_version <= 9007199254740991),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 500),
  before_metadata TEXT NOT NULL CHECK (json_valid(before_metadata) AND json_type(before_metadata) = 'object'),
  after_metadata TEXT NOT NULL CHECK (json_valid(after_metadata) AND json_type(after_metadata) = 'object'),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE INDEX catalog_draft_audit_product ON catalog_draft_audit(product_id, after_version);
CREATE TRIGGER catalog_draft_audit_duplicate BEFORE INSERT ON catalog_draft_audit
WHEN EXISTS (SELECT 1 FROM catalog_draft_audit WHERE id = NEW.id OR command_id = NEW.command_id)
BEGIN SELECT RAISE(ABORT, 'catalog_draft_audit_immutable'); END;
CREATE TRIGGER catalog_draft_audit_command BEFORE INSERT ON catalog_draft_audit
WHEN NOT EXISTS (SELECT 1 FROM catalog_draft_commands command WHERE command.id = NEW.command_id
  AND command.actor_id = NEW.actor_id AND command.product_id = NEW.product_id
  AND command.product_legacy_id = NEW.product_legacy_id
  AND command.expected_version = NEW.before_version AND command.result_version = NEW.after_version
  AND command.reason = NEW.reason AND command.before_metadata = NEW.before_metadata
  AND command.after_metadata = NEW.after_metadata AND command.created_at = NEW.created_at)
BEGIN SELECT RAISE(ABORT, 'catalog_draft_audit_command'); END;
CREATE TRIGGER catalog_draft_audit_no_update BEFORE UPDATE ON catalog_draft_audit
BEGIN SELECT RAISE(ABORT, 'catalog_draft_audit_immutable'); END;
CREATE TRIGGER catalog_draft_audit_no_delete BEFORE DELETE ON catalog_draft_audit
BEGIN SELECT RAISE(ABORT, 'catalog_draft_audit_immutable'); END;

-- Successful batches leave no guard row; any failed ownership/auth/CAS/audit
-- condition violates this CHECK and rolls back every preceding statement.
CREATE TABLE catalog_draft_guards (
  id TEXT PRIMARY KEY,
  satisfied INTEGER NOT NULL CONSTRAINT catalog_draft_atomic_guard CHECK (satisfied = 1)
) STRICT;
