-- No policies, approvals, classifications or exceptions are seeded. Commands
-- own their claim nonce and retain complete immutable domain snapshots.
CREATE TABLE catalog_policy_commands (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  claim_nonce TEXT NOT NULL UNIQUE CHECK(length(claim_nonce)=36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('policy_create','policy_withdraw','policy_assign','exception_create','exception_withdraw')),
  target TEXT NOT NULL CHECK(json_valid(target) AND json_type(target)='object'),
  input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object'),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  entity_id TEXT NOT NULL CHECK(length(entity_id)=36),
  resource_id TEXT NOT NULL CHECK(length(resource_id)=36),
  policy_version INTEGER CHECK(policy_version BETWEEN 1 AND 9007199254740991),
  product_id INTEGER CHECK(product_id BETWEEN 1 AND 9007199254740991),
  product_uuid TEXT REFERENCES products(id),
  expected_version INTEGER NOT NULL CHECK(expected_version BETWEEN 0 AND 9007199254740991),
  result_version INTEGER CHECK(result_version=expected_version+1 AND result_version<=9007199254740991),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 500 AND json_extract(input,'$.reason')=reason),
  before_state TEXT NOT NULL CHECK(json_valid(before_state) AND json_type(before_state)='object'),
  after_state TEXT NOT NULL CHECK(json_valid(after_state) AND json_type(after_state)='object'),
  response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object'
    AND COALESCE(json_extract(response,'$.source')='cloudflare',0)
    AND COALESCE(json_extract(response,'$.action')=action,0)
    AND COALESCE(json_extract(response,'$.entityId')=entity_id,0)
    AND COALESCE(json_extract(response,'$.resourceId')=resource_id,0)
    AND json_extract(response,'$.policyVersion') IS policy_version
    AND json_extract(response,'$.productId') IS product_id
    AND json_extract(response,'$.productUuid') IS product_uuid
    AND json_extract(response,'$.catalogVersion') IS result_version
    AND COALESCE(json_type(response,'$.updated')='true',0)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(actor_id,idempotency_key),
  UNIQUE(product_uuid,result_version),
  CHECK((action IN ('policy_assign','exception_create','exception_withdraw'))=
    (product_id IS NOT NULL AND product_uuid IS NOT NULL AND result_version IS NOT NULL)),
  CHECK(action IN ('policy_assign','exception_create','exception_withdraw') OR
    (product_id IS NULL AND product_uuid IS NULL AND result_version IS NULL)),
  CHECK((action='exception_withdraw')=(policy_version IS NULL)),
  CHECK(action<>'policy_create' OR policy_version=expected_version+1),
  CHECK(action<>'policy_withdraw' OR policy_version=expected_version)
) STRICT;
CREATE INDEX catalog_policy_commands_product ON catalog_policy_commands(product_uuid,result_version);
CREATE TRIGGER catalog_policy_commands_duplicate BEFORE INSERT ON catalog_policy_commands
WHEN EXISTS(SELECT 1 FROM catalog_policy_commands WHERE id=NEW.id OR claim_nonce=NEW.claim_nonce
  OR (actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key)
  OR (product_uuid=NEW.product_uuid AND result_version=NEW.result_version))
BEGIN SELECT RAISE(ABORT,'catalog_policy_commands_immutable'); END;
CREATE TRIGGER catalog_policy_commands_no_update BEFORE UPDATE ON catalog_policy_commands
BEGIN SELECT RAISE(ABORT,'catalog_policy_commands_immutable'); END;
CREATE TRIGGER catalog_policy_commands_no_delete BEFORE DELETE ON catalog_policy_commands
BEGIN SELECT RAISE(ABORT,'catalog_policy_commands_immutable'); END;

CREATE TABLE catalog_policy_audit (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  command_id TEXT NOT NULL UNIQUE REFERENCES catalog_policy_commands(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL,
  target TEXT NOT NULL,input TEXT NOT NULL,entity_id TEXT NOT NULL,resource_id TEXT NOT NULL,
  policy_version INTEGER,product_id INTEGER,product_uuid TEXT REFERENCES products(id),
  expected_version INTEGER NOT NULL,result_version INTEGER,reason TEXT NOT NULL,
  before_state TEXT NOT NULL CHECK(json_valid(before_state) AND json_type(before_state)='object'),
  after_state TEXT NOT NULL CHECK(json_valid(after_state) AND json_type(after_state)='object'),
  response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object'),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE INDEX catalog_policy_audit_product ON catalog_policy_audit(product_uuid,result_version);
CREATE TRIGGER catalog_policy_audit_duplicate BEFORE INSERT ON catalog_policy_audit
WHEN EXISTS(SELECT 1 FROM catalog_policy_audit WHERE id=NEW.id OR command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'catalog_policy_audit_immutable'); END;
CREATE TRIGGER catalog_policy_audit_command BEFORE INSERT ON catalog_policy_audit
WHEN NOT EXISTS(SELECT 1 FROM catalog_policy_commands c WHERE c.id=NEW.command_id AND c.actor_id=NEW.actor_id
  AND c.action=NEW.action AND c.target=NEW.target AND c.input=NEW.input AND c.entity_id=NEW.entity_id AND c.resource_id=NEW.resource_id
  AND c.policy_version IS NEW.policy_version AND c.product_id IS NEW.product_id AND c.product_uuid IS NEW.product_uuid
  AND c.expected_version=NEW.expected_version AND c.result_version IS NEW.result_version AND c.reason=NEW.reason
  AND c.before_state=NEW.before_state AND c.after_state=NEW.after_state AND c.response=NEW.response AND c.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'catalog_policy_audit_command'); END;
CREATE TRIGGER catalog_policy_audit_no_update BEFORE UPDATE ON catalog_policy_audit
BEGIN SELECT RAISE(ABORT,'catalog_policy_audit_immutable'); END;
CREATE TRIGGER catalog_policy_audit_no_delete BEFORE DELETE ON catalog_policy_audit
BEGIN SELECT RAISE(ABORT,'catalog_policy_audit_immutable'); END;
CREATE TABLE catalog_policy_guards (
  id TEXT PRIMARY KEY,
  satisfied INTEGER NOT NULL CONSTRAINT catalog_policy_atomic_guard CHECK(satisfied=1)
) STRICT;
