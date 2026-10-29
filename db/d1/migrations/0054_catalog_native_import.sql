-- Full tabular intake creates new drafts, never publication/scanner authority.
-- Imported media descriptors are pending evidence, not verified R2 objects.
-- A submitted exception explanation is not a governed publication exception.
ALTER TABLE variants ADD COLUMN identifier_exception_reason TEXT;
CREATE TABLE media_assets (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  storage_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size>0),
  checksum_sha256 TEXT NOT NULL UNIQUE CHECK(length(checksum_sha256)=64 AND checksum_sha256 NOT GLOB '*[^0-9a-f]*'),
  owner_name TEXT NOT NULL,
  source_url TEXT,
  license TEXT NOT NULL,
  authorized_at TEXT NOT NULL,
  rights_status TEXT NOT NULL CHECK(rights_status='pending'),
  quarantine_status TEXT NOT NULL CHECK(quarantine_status='pending'),
  alt_text TEXT NOT NULL,
  metadata TEXT NOT NULL CHECK(json_valid(metadata) AND json_type(metadata)='object'),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE TABLE product_media (
  product_id TEXT NOT NULL REFERENCES products(id),
  variant_id TEXT REFERENCES variants(id),
  asset_id TEXT NOT NULL REFERENCES media_assets(id),
  role TEXT NOT NULL CHECK(role IN ('primary','gallery','label','scale','datasheet','sds','certificate','video')),
  version TEXT NOT NULL,
  sort_order INTEGER NOT NULL CHECK(sort_order>=0),
  UNIQUE(product_id,variant_id,asset_id,role,version)
) STRICT;
CREATE UNIQUE INDEX product_media_null_variant ON product_media(product_id,asset_id,role,version) WHERE variant_id IS NULL;
CREATE TRIGGER product_media_same_product BEFORE INSERT ON product_media
WHEN NEW.variant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM variants WHERE id=NEW.variant_id AND product_id=NEW.product_id)
BEGIN SELECT RAISE(ABORT,'native_import_variant_product'); END;

CREATE TABLE catalog_native_previews (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  hash TEXT NOT NULL CHECK(length(hash)=64 AND hash NOT GLOB '*[^0-9a-f]*'),
  manifest TEXT NOT NULL CHECK(json_valid(manifest) AND json_type(manifest)='object' AND length(CAST(manifest AS BLOB))<=900000
    AND json_array_length(manifest,'$.products') BETWEEN 1 AND 500
    AND json_array_length(manifest,'$.variants') BETWEEN 1 AND 500
    AND json_array_length(manifest,'$.assets') BETWEEN 1 AND 500
    AND json_array_length(manifest,'$.media') BETWEEN 1 AND 500),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  expires_at TEXT NOT NULL CHECK(expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',expires_at),'') AND expires_at>created_at)
) STRICT;
CREATE INDEX catalog_native_previews_actor ON catalog_native_previews(actor_id,created_at);
CREATE TRIGGER catalog_native_previews_no_update BEFORE UPDATE ON catalog_native_previews
BEGIN SELECT RAISE(ABORT,'native_preview_immutable'); END;
CREATE TRIGGER catalog_native_previews_no_delete BEFORE DELETE ON catalog_native_previews
BEGIN SELECT RAISE(ABORT,'native_preview_immutable'); END;
CREATE TRIGGER catalog_native_previews_no_replace BEFORE INSERT ON catalog_native_previews
WHEN EXISTS(SELECT 1 FROM catalog_native_previews WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'native_preview_immutable'); END;

CREATE TABLE catalog_native_commands (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  nonce TEXT NOT NULL UNIQUE CHECK(length(nonce)=36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  preview_id TEXT NOT NULL REFERENCES catalog_native_previews(id),
  action TEXT NOT NULL CHECK(action IN ('apply','revert')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
  response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object'
    AND COALESCE(json_extract(response,'$.source')='cloudflare',0)
    AND COALESCE(json_extract(response,'$.action')=action,0)
    AND COALESCE(json_extract(response,'$.previewId')=preview_id,0)
    AND COALESCE(json_extract(response,'$.commandId')=id,0)
    AND COALESCE(json_type(response,'$.updated')='true',0)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(actor_id,idempotency_key), UNIQUE(preview_id,action)
) STRICT;
CREATE TRIGGER catalog_native_commands_no_update BEFORE UPDATE ON catalog_native_commands
BEGIN SELECT RAISE(ABORT,'native_command_immutable'); END;
CREATE TRIGGER catalog_native_commands_no_delete BEFORE DELETE ON catalog_native_commands
BEGIN SELECT RAISE(ABORT,'native_command_immutable'); END;
CREATE TRIGGER catalog_native_commands_no_replace BEFORE INSERT ON catalog_native_commands
WHEN EXISTS(SELECT 1 FROM catalog_native_commands WHERE id=NEW.id OR nonce=NEW.nonce
  OR (actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key) OR (preview_id=NEW.preview_id AND action=NEW.action))
BEGIN SELECT RAISE(ABORT,'native_command_immutable'); END;
CREATE TRIGGER catalog_native_commands_shape BEFORE INSERT ON catalog_native_commands
WHEN NOT EXISTS(SELECT 1 FROM catalog_native_previews p WHERE p.id=NEW.preview_id AND p.actor_id=NEW.actor_id
  AND p.created_at<=NEW.created_at AND COALESCE(json_extract(NEW.response,'$.previewHash')=p.hash,0)
  AND COALESCE(json_extract(NEW.response,'$.counts.products')=json_array_length(p.manifest,'$.products'),0)
  AND COALESCE(json_extract(NEW.response,'$.counts.variants')=json_array_length(p.manifest,'$.variants'),0)
  AND COALESCE(json_extract(NEW.response,'$.counts.assets')=json_array_length(p.manifest,'$.assets'),0)
  AND COALESCE(json_extract(NEW.response,'$.counts.mappings')=json_array_length(p.manifest,'$.media'),0))
BEGIN SELECT RAISE(ABORT,'native_command_shape'); END;

CREATE TABLE catalog_native_audit (
  command_id TEXT PRIMARY KEY REFERENCES catalog_native_commands(id),
  before_state TEXT CHECK(before_state IS NULL OR (json_valid(before_state) AND json_type(before_state)='object')),
  after_state TEXT NOT NULL CHECK(json_valid(after_state) AND json_type(after_state)='object')
) STRICT;
CREATE TRIGGER catalog_native_audit_no_update BEFORE UPDATE ON catalog_native_audit
BEGIN SELECT RAISE(ABORT,'native_audit_immutable'); END;
CREATE TRIGGER catalog_native_audit_no_delete BEFORE DELETE ON catalog_native_audit
BEGIN SELECT RAISE(ABORT,'native_audit_immutable'); END;
CREATE TRIGGER catalog_native_audit_no_replace BEFORE INSERT ON catalog_native_audit
WHEN EXISTS(SELECT 1 FROM catalog_native_audit WHERE command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'native_audit_immutable'); END;
CREATE TRIGGER catalog_native_initial_movement_no_update BEFORE UPDATE ON inventory_movements
WHEN OLD.reference_type='catalog_native_import'
BEGIN SELECT RAISE(ABORT,'native_movement_immutable'); END;
CREATE TRIGGER catalog_native_initial_movement_no_delete BEFORE DELETE ON inventory_movements
WHEN OLD.reference_type='catalog_native_import'
BEGIN SELECT RAISE(ABORT,'native_movement_immutable'); END;
CREATE TRIGGER catalog_native_initial_movement_no_replace BEFORE INSERT ON inventory_movements
WHEN EXISTS(SELECT 1 FROM inventory_movements WHERE reference_type='catalog_native_import'
  AND (id=NEW.id OR idempotency_key=NEW.idempotency_key))
BEGIN SELECT RAISE(ABORT,'native_movement_immutable'); END;
CREATE TABLE catalog_native_guards (
  id TEXT PRIMARY KEY,
  satisfied INTEGER NOT NULL CONSTRAINT native_catalog_atomic_guard CHECK(satisfied=1)
) STRICT;
