-- Status commands are separate from the metadata-only 0034 command contract.
-- Publication authority is supplied by an execution-time dependency gate, not
-- by a cached advisory or the editorial version alone.
CREATE TABLE catalog_product_status_commands (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  claim_nonce TEXT NOT NULL UNIQUE CHECK (length(claim_nonce) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  product_legacy_id INTEGER NOT NULL CHECK (product_legacy_id BETWEEN 1 AND 9007199254740991),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  expected_version INTEGER NOT NULL CHECK (expected_version BETWEEN 1 AND 9007199254740990),
  result_version INTEGER NOT NULL CHECK (result_version = expected_version + 1 AND result_version <= 9007199254740991),
  before_status TEXT NOT NULL CHECK (before_status IN ('draft','review','published','hidden','discontinued')),
  after_status TEXT NOT NULL CHECK (after_status IN ('draft','review','published','hidden','discontinued')),
  required_permission TEXT NOT NULL CHECK (required_permission IN ('catalog.write','catalog.publish')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 500),
  gate_fingerprint TEXT CHECK (gate_fingerprint IS NULL OR (length(gate_fingerprint) = 64 AND gate_fingerprint NOT GLOB '*[^0-9a-f]*')),
  before_product TEXT NOT NULL CHECK (json_valid(before_product) AND json_type(before_product) = 'object'),
  after_product TEXT NOT NULL CHECK (json_valid(after_product) AND json_type(after_product) = 'object'),
  before_variants TEXT NOT NULL CHECK (json_valid(before_variants) AND json_type(before_variants) = 'array'),
  after_variants TEXT NOT NULL CHECK (json_valid(after_variants) AND json_type(after_variants) = 'array'),
  response TEXT NOT NULL CHECK (json_valid(response) AND json_type(response) = 'object'
    AND COALESCE(json_extract(response,'$.source') = 'cloudflare',0)
    AND COALESCE(json_extract(response,'$.productId') = product_legacy_id,0)
    AND COALESCE(json_extract(response,'$.productUuid') = product_id,0)
    AND COALESCE(json_extract(response,'$.catalogVersion') = result_version,0)
    AND COALESCE(json_extract(response,'$.status') = after_status,0)
    AND COALESCE(json_type(response,'$.active') = CASE WHEN after_status = 'published' THEN 'true' ELSE 'false' END,0)
    AND COALESCE(json_type(response,'$.updated') = 'true',0)),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(actor_id,idempotency_key),
  UNIQUE(product_id,result_version),
  CHECK ((after_status = 'published') = (gate_fingerprint IS NOT NULL)),
  CHECK ((required_permission = 'catalog.write') = (
    (before_status = 'draft' AND after_status = 'review') OR (before_status = 'review' AND after_status = 'draft')
  )),
  CHECK ((before_status = 'draft' AND after_status IN ('review','hidden','discontinued'))
    OR (before_status = 'review' AND after_status IN ('draft','published','hidden'))
    OR (before_status = 'published' AND after_status IN ('hidden','discontinued'))
    OR (before_status = 'hidden' AND after_status IN ('draft','review','published','discontinued'))
    OR (before_status = 'discontinued' AND after_status = 'draft'))
) STRICT;
CREATE INDEX catalog_product_status_commands_product ON catalog_product_status_commands(product_id,result_version);
CREATE TRIGGER catalog_product_status_commands_duplicate BEFORE INSERT ON catalog_product_status_commands
WHEN EXISTS (SELECT 1 FROM catalog_product_status_commands WHERE id = NEW.id OR claim_nonce = NEW.claim_nonce
  OR (actor_id = NEW.actor_id AND idempotency_key = NEW.idempotency_key)
  OR (product_id = NEW.product_id AND result_version = NEW.result_version))
BEGIN SELECT RAISE(ABORT,'catalog_product_status_commands_immutable'); END;
CREATE TRIGGER catalog_product_status_commands_no_update BEFORE UPDATE ON catalog_product_status_commands
BEGIN SELECT RAISE(ABORT,'catalog_product_status_commands_immutable'); END;
CREATE TRIGGER catalog_product_status_commands_no_delete BEFORE DELETE ON catalog_product_status_commands
BEGIN SELECT RAISE(ABORT,'catalog_product_status_commands_immutable'); END;

CREATE TABLE catalog_product_status_audit (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  command_id TEXT NOT NULL UNIQUE REFERENCES catalog_product_status_commands(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  product_legacy_id INTEGER NOT NULL CHECK (product_legacy_id BETWEEN 1 AND 9007199254740991),
  before_version INTEGER NOT NULL CHECK (before_version BETWEEN 1 AND 9007199254740990),
  after_version INTEGER NOT NULL CHECK (after_version = before_version + 1 AND after_version <= 9007199254740991),
  before_status TEXT NOT NULL,
  after_status TEXT NOT NULL,
  required_permission TEXT NOT NULL,
  reason TEXT NOT NULL,
  gate_fingerprint TEXT,
  before_product TEXT NOT NULL CHECK (json_valid(before_product) AND json_type(before_product) = 'object'),
  after_product TEXT NOT NULL CHECK (json_valid(after_product) AND json_type(after_product) = 'object'),
  before_variants TEXT NOT NULL CHECK (json_valid(before_variants) AND json_type(before_variants) = 'array'),
  after_variants TEXT NOT NULL CHECK (json_valid(after_variants) AND json_type(after_variants) = 'array'),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE INDEX catalog_product_status_audit_product ON catalog_product_status_audit(product_id,after_version);
CREATE TRIGGER catalog_product_status_audit_duplicate BEFORE INSERT ON catalog_product_status_audit
WHEN EXISTS (SELECT 1 FROM catalog_product_status_audit WHERE id = NEW.id OR command_id = NEW.command_id)
BEGIN SELECT RAISE(ABORT,'catalog_product_status_audit_immutable'); END;
CREATE TRIGGER catalog_product_status_audit_command BEFORE INSERT ON catalog_product_status_audit
WHEN NOT EXISTS (SELECT 1 FROM catalog_product_status_commands c WHERE c.id = NEW.command_id
  AND c.actor_id = NEW.actor_id AND c.product_id = NEW.product_id AND c.product_legacy_id = NEW.product_legacy_id
  AND c.expected_version = NEW.before_version AND c.result_version = NEW.after_version
  AND c.before_status = NEW.before_status AND c.after_status = NEW.after_status
  AND c.required_permission = NEW.required_permission AND c.reason = NEW.reason
  AND c.gate_fingerprint IS NEW.gate_fingerprint AND c.before_product = NEW.before_product AND c.after_product = NEW.after_product
  AND c.before_variants = NEW.before_variants AND c.after_variants = NEW.after_variants AND c.created_at = NEW.created_at)
BEGIN SELECT RAISE(ABORT,'catalog_product_status_audit_command'); END;
CREATE TRIGGER catalog_product_status_audit_no_update BEFORE UPDATE ON catalog_product_status_audit
BEGIN SELECT RAISE(ABORT,'catalog_product_status_audit_immutable'); END;
CREATE TRIGGER catalog_product_status_audit_no_delete BEFORE DELETE ON catalog_product_status_audit
BEGIN SELECT RAISE(ABORT,'catalog_product_status_audit_immutable'); END;

-- Any failed claim, authority, CAS, dependency or audit check aborts the batch.
CREATE TABLE catalog_product_status_guards (
  id TEXT PRIMARY KEY,
  satisfied INTEGER NOT NULL CONSTRAINT catalog_product_status_atomic_guard CHECK (satisfied = 1)
) STRICT;
