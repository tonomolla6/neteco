-- Bounded editorial imports: immutable previews and one atomic apply/revert.
-- These tables never confer publication, price, stock or media authority.
CREATE TABLE catalog_editorial_previews (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  hash TEXT NOT NULL CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  manifest TEXT NOT NULL CHECK (json_valid(manifest) AND json_type(manifest) = 'array'
    AND json_array_length(manifest) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  expires_at TEXT NOT NULL CHECK (expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at), '')
    AND expires_at > created_at)
) STRICT;
CREATE INDEX catalog_editorial_previews_actor ON catalog_editorial_previews(actor_id, created_at);
CREATE TRIGGER catalog_editorial_previews_duplicate BEFORE INSERT ON catalog_editorial_previews
WHEN EXISTS (SELECT 1 FROM catalog_editorial_previews WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'editorial_preview_immutable'); END;
CREATE TRIGGER catalog_editorial_previews_no_update BEFORE UPDATE ON catalog_editorial_previews
BEGIN SELECT RAISE(ABORT, 'editorial_preview_immutable'); END;
CREATE TRIGGER catalog_editorial_previews_no_delete BEFORE DELETE ON catalog_editorial_previews
BEGIN SELECT RAISE(ABORT, 'editorial_preview_immutable'); END;

CREATE TABLE catalog_editorial_commands (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  nonce TEXT NOT NULL UNIQUE CHECK (length(nonce) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  preview_id TEXT NOT NULL REFERENCES catalog_editorial_previews(id),
  action TEXT NOT NULL CHECK (action IN ('apply', 'revert')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 500),
  response TEXT NOT NULL CHECK (json_valid(response) AND json_type(response) = 'object'
    AND COALESCE(json_extract(response, '$.source') = 'cloudflare', 0)
    AND COALESCE(json_extract(response, '$.action') = action, 0)
    AND COALESCE(json_extract(response, '$.previewId') = preview_id, 0)
    AND COALESCE(json_extract(response, '$.commandId') = id, 0)
    AND COALESCE(json_type(response, '$.updated') = 'true', 0)),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(actor_id, idempotency_key),
  UNIQUE(preview_id, action)
) STRICT;
CREATE TRIGGER catalog_editorial_commands_duplicate BEFORE INSERT ON catalog_editorial_commands
WHEN EXISTS (SELECT 1 FROM catalog_editorial_commands WHERE id = NEW.id OR nonce = NEW.nonce
  OR (actor_id = NEW.actor_id AND idempotency_key = NEW.idempotency_key)
  OR (preview_id = NEW.preview_id AND action = NEW.action))
BEGIN SELECT RAISE(ABORT, 'editorial_command_immutable'); END;
CREATE TRIGGER catalog_editorial_commands_no_update BEFORE UPDATE ON catalog_editorial_commands
BEGIN SELECT RAISE(ABORT, 'editorial_command_immutable'); END;
CREATE TRIGGER catalog_editorial_commands_no_delete BEFORE DELETE ON catalog_editorial_commands
BEGIN SELECT RAISE(ABORT, 'editorial_command_immutable'); END;
CREATE TRIGGER catalog_editorial_commands_shape BEFORE INSERT ON catalog_editorial_commands
WHEN NOT EXISTS (SELECT 1 FROM catalog_editorial_previews p
  WHERE p.id = NEW.preview_id AND p.actor_id = NEW.actor_id AND p.created_at <= NEW.created_at
    AND COALESCE(json_extract(NEW.response, '$.previewHash') = p.hash, 0)
    AND COALESCE(json_extract(NEW.response, '$.productCount') = json_array_length(p.manifest), 0))
BEGIN SELECT RAISE(ABORT, 'editorial_command_shape'); END;

CREATE TABLE catalog_editorial_audit (
  command_id TEXT NOT NULL REFERENCES catalog_editorial_commands(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  before_version INTEGER NOT NULL CHECK (before_version BETWEEN 1 AND 9007199254740990),
  after_version INTEGER NOT NULL CHECK (after_version = before_version + 1 AND after_version <= 9007199254740991),
  before_metadata TEXT NOT NULL CHECK (json_valid(before_metadata) AND json_type(before_metadata) = 'object'),
  after_metadata TEXT NOT NULL CHECK (json_valid(after_metadata) AND json_type(after_metadata) = 'object'),
  PRIMARY KEY(command_id, product_id)
) STRICT;
CREATE TRIGGER catalog_editorial_audit_duplicate BEFORE INSERT ON catalog_editorial_audit
WHEN EXISTS (SELECT 1 FROM catalog_editorial_audit WHERE command_id = NEW.command_id AND product_id = NEW.product_id)
BEGIN SELECT RAISE(ABORT, 'editorial_audit_immutable'); END;
CREATE TRIGGER catalog_editorial_audit_no_update BEFORE UPDATE ON catalog_editorial_audit
BEGIN SELECT RAISE(ABORT, 'editorial_audit_immutable'); END;
CREATE TRIGGER catalog_editorial_audit_no_delete BEFORE DELETE ON catalog_editorial_audit
BEGIN SELECT RAISE(ABORT, 'editorial_audit_immutable'); END;
CREATE TRIGGER catalog_editorial_audit_shape BEFORE INSERT ON catalog_editorial_audit
WHEN NOT EXISTS (SELECT 1 FROM catalog_editorial_commands c
  JOIN catalog_editorial_previews p ON p.id = c.preview_id, json_each(p.manifest) item
  WHERE c.id = NEW.command_id AND json_extract(item.value, '$.productId') = NEW.product_id
    AND NEW.before_version = json_extract(item.value, '$.expectedVersion') + CASE WHEN c.action = 'revert' THEN 1 ELSE 0 END
    AND NEW.before_metadata = CASE WHEN c.action = 'revert'
      THEN json_extract(item.value, '$.after') ELSE json_extract(item.value, '$.before') END
    AND NEW.after_metadata = CASE WHEN c.action = 'revert'
      THEN json_extract(item.value, '$.before') ELSE json_extract(item.value, '$.after') END)
BEGIN SELECT RAISE(ABORT, 'editorial_audit_shape'); END;
CREATE TABLE catalog_editorial_guards (
  id TEXT PRIMARY KEY,
  satisfied INTEGER NOT NULL CONSTRAINT editorial_atomic_guard CHECK (satisfied = 1)
) STRICT;
