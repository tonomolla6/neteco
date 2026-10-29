-- Authoring creates drafts only. No price approvals, inventory receipts,
-- publication policies, rights or media approvals are seeded by this migration.
CREATE TABLE catalog_draft_legacy_counters (
  entity TEXT PRIMARY KEY CHECK(entity IN ('product','variant')),
  last_id INTEGER NOT NULL CHECK(last_id BETWEEN 0 AND 9007199254740991)
) STRICT;
INSERT INTO catalog_draft_legacy_counters VALUES
  ('product',(SELECT COALESCE(max(legacy_id),0) FROM products)),
  ('variant',(SELECT COALESCE(max(legacy_id),0) FROM variants));
CREATE TRIGGER catalog_draft_legacy_counters_duplicate BEFORE INSERT ON catalog_draft_legacy_counters
WHEN EXISTS(SELECT 1 FROM catalog_draft_legacy_counters WHERE entity=NEW.entity)
BEGIN SELECT RAISE(ABORT,'catalog_draft_counter_immutable'); END;
CREATE TRIGGER catalog_draft_legacy_counters_monotonic BEFORE UPDATE ON catalog_draft_legacy_counters
WHEN NEW.entity<>OLD.entity OR NEW.last_id<=OLD.last_id
BEGIN SELECT RAISE(ABORT,'catalog_draft_counter_immutable'); END;
CREATE TRIGGER catalog_draft_legacy_counters_no_delete BEFORE DELETE ON catalog_draft_legacy_counters
BEGIN SELECT RAISE(ABORT,'catalog_draft_counter_immutable'); END;

-- product_uuid intentionally has no FK here: the owned claim precedes product
-- creation in the same atomic batch. The audit FK proves the created product.
CREATE TABLE catalog_draft_authoring_commands (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  claim_nonce TEXT NOT NULL UNIQUE CHECK(length(claim_nonce)=36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create_draft','assign_brand','create_variant','update_variant','discontinue_variant')),
  target TEXT NOT NULL CHECK(json_valid(target) AND json_type(target)='object'),
  input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object'),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  product_id INTEGER NOT NULL CHECK(product_id BETWEEN 1 AND 9007199254740991),
  product_uuid TEXT NOT NULL CHECK(length(product_uuid)=36),
  variant_id INTEGER CHECK(variant_id BETWEEN 1 AND 9007199254740991),
  variant_uuid TEXT CHECK(length(variant_uuid)=36),
  expected_version INTEGER NOT NULL CHECK(expected_version BETWEEN 0 AND 9007199254740990),
  result_version INTEGER NOT NULL CHECK(result_version=expected_version+1 AND result_version<=9007199254740991),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND json_extract(input,'$.reason')=reason),
  before_state TEXT NOT NULL CHECK(json_valid(before_state) AND json_type(before_state)='object'),
  after_state TEXT NOT NULL CHECK(json_valid(after_state) AND json_type(after_state)='object'),
  response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object'
    AND COALESCE(json_extract(response,'$.source')='cloudflare',0)
    AND COALESCE(json_extract(response,'$.action')=action,0)
    AND COALESCE(json_extract(response,'$.productId')=product_id,0)
    AND COALESCE(json_extract(response,'$.productUuid')=product_uuid,0)
    AND json_extract(response,'$.variantId') IS variant_id
    AND json_extract(response,'$.variantUuid') IS variant_uuid
    AND COALESCE(json_extract(response,'$.catalogVersion')=result_version,0)
    AND COALESCE(json_type(response,'$.updated')='true',0)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(actor_id,idempotency_key),
  UNIQUE(product_uuid,result_version),
  CHECK((action='create_draft')=(expected_version=0)),
  CHECK((action='assign_brand')=(variant_id IS NULL AND variant_uuid IS NULL)),
  CHECK((variant_id IS NULL)=(variant_uuid IS NULL))
) STRICT;
CREATE INDEX catalog_draft_authoring_commands_product ON catalog_draft_authoring_commands(product_uuid,result_version);
CREATE TRIGGER catalog_draft_authoring_commands_duplicate BEFORE INSERT ON catalog_draft_authoring_commands
WHEN EXISTS(SELECT 1 FROM catalog_draft_authoring_commands WHERE id=NEW.id OR claim_nonce=NEW.claim_nonce
  OR (actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key)
  OR (product_uuid=NEW.product_uuid AND result_version=NEW.result_version))
BEGIN SELECT RAISE(ABORT,'catalog_draft_authoring_commands_immutable'); END;
CREATE TRIGGER catalog_draft_authoring_commands_no_update BEFORE UPDATE ON catalog_draft_authoring_commands
BEGIN SELECT RAISE(ABORT,'catalog_draft_authoring_commands_immutable'); END;
CREATE TRIGGER catalog_draft_authoring_commands_no_delete BEFORE DELETE ON catalog_draft_authoring_commands
BEGIN SELECT RAISE(ABORT,'catalog_draft_authoring_commands_immutable'); END;

CREATE TABLE catalog_draft_authoring_audit (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  command_id TEXT NOT NULL UNIQUE REFERENCES catalog_draft_authoring_commands(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),action TEXT NOT NULL,target TEXT NOT NULL,input TEXT NOT NULL,
  product_id INTEGER NOT NULL,product_uuid TEXT NOT NULL REFERENCES products(id),
  variant_id INTEGER,variant_uuid TEXT REFERENCES variants(id),
  expected_version INTEGER NOT NULL,result_version INTEGER NOT NULL,reason TEXT NOT NULL,
  before_state TEXT NOT NULL CHECK(json_valid(before_state) AND json_type(before_state)='object'),
  after_state TEXT NOT NULL CHECK(json_valid(after_state) AND json_type(after_state)='object'),
  response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object'),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE INDEX catalog_draft_authoring_audit_product ON catalog_draft_authoring_audit(product_uuid,result_version);
CREATE TRIGGER catalog_draft_authoring_audit_duplicate BEFORE INSERT ON catalog_draft_authoring_audit
WHEN EXISTS(SELECT 1 FROM catalog_draft_authoring_audit WHERE id=NEW.id OR command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'catalog_draft_authoring_audit_immutable'); END;
CREATE TRIGGER catalog_draft_authoring_audit_command BEFORE INSERT ON catalog_draft_authoring_audit
WHEN NOT EXISTS(SELECT 1 FROM catalog_draft_authoring_commands c WHERE c.id=NEW.command_id AND c.actor_id=NEW.actor_id
  AND c.action=NEW.action AND c.target=NEW.target AND c.input=NEW.input AND c.product_id=NEW.product_id AND c.product_uuid=NEW.product_uuid
  AND c.variant_id IS NEW.variant_id AND c.variant_uuid IS NEW.variant_uuid AND c.expected_version=NEW.expected_version
  AND c.result_version=NEW.result_version AND c.reason=NEW.reason AND c.before_state=NEW.before_state
  AND c.after_state=NEW.after_state AND c.response=NEW.response AND c.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'catalog_draft_authoring_audit_command'); END;
CREATE TRIGGER catalog_draft_authoring_audit_no_update BEFORE UPDATE ON catalog_draft_authoring_audit
BEGIN SELECT RAISE(ABORT,'catalog_draft_authoring_audit_immutable'); END;
CREATE TRIGGER catalog_draft_authoring_audit_no_delete BEFORE DELETE ON catalog_draft_authoring_audit
BEGIN SELECT RAISE(ABORT,'catalog_draft_authoring_audit_immutable'); END;
CREATE TABLE catalog_draft_authoring_guards (
  id TEXT PRIMARY KEY,
  satisfied INTEGER NOT NULL CONSTRAINT catalog_draft_authoring_atomic_guard CHECK(satisfied=1)
) STRICT;
