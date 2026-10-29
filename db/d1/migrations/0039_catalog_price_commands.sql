-- Governed price commands only; no approved price, inventory, tax or publication
-- evidence is invented by migration. Existing price windows remain untouched.
CREATE TABLE catalog_price_commands (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  claim_nonce TEXT NOT NULL UNIQUE CHECK(length(claim_nonce)=36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('price_schedule','price_cancel')),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  price_id TEXT NOT NULL CHECK(length(price_id) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object'),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND json_extract(input,'$.reason')=reason),
  before_state TEXT NOT NULL CHECK(json_valid(before_state) AND json_type(before_state)='object'),
  after_state TEXT NOT NULL CHECK(json_valid(after_state) AND json_type(after_state)='object'),
  response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object'
    AND COALESCE(json_extract(response,'$.source')='cloudflare',0)
    AND COALESCE(json_extract(response,'$.action')=action,0)
    AND COALESCE(json_extract(response,'$.commandId')=id,0)
    AND COALESCE(json_extract(response,'$.priceId')=price_id,0)
    AND COALESCE(json_extract(response,'$.variantId')=variant_id,0)
    AND COALESCE(json_type(response,'$.updated')='true',0)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',created_at),'')),
  UNIQUE(actor_id,idempotency_key)
) STRICT;
CREATE INDEX catalog_price_commands_variant ON catalog_price_commands(variant_id,created_at);
CREATE TRIGGER catalog_price_commands_duplicate BEFORE INSERT ON catalog_price_commands
WHEN EXISTS(SELECT 1 FROM catalog_price_commands WHERE id=NEW.id OR claim_nonce=NEW.claim_nonce
  OR (actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key))
BEGIN SELECT RAISE(ABORT,'catalog_price_commands_immutable'); END;
CREATE TRIGGER catalog_price_commands_no_update BEFORE UPDATE ON catalog_price_commands
BEGIN SELECT RAISE(ABORT,'catalog_price_commands_immutable'); END;
CREATE TRIGGER catalog_price_commands_no_delete BEFORE DELETE ON catalog_price_commands
BEGIN SELECT RAISE(ABORT,'catalog_price_commands_immutable'); END;
CREATE TABLE catalog_price_audit (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE REFERENCES catalog_price_commands(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL,
  variant_id TEXT NOT NULL REFERENCES variants(id),
  price_id TEXT NOT NULL REFERENCES variant_price_versions(id),
  input TEXT NOT NULL,
  reason TEXT NOT NULL,
  before_state TEXT NOT NULL,
  after_state TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER catalog_price_audit_matches BEFORE INSERT ON catalog_price_audit
WHEN NOT EXISTS(SELECT 1 FROM catalog_price_commands c WHERE c.id=NEW.command_id AND c.actor_id=NEW.actor_id
  AND c.action=NEW.action AND c.variant_id=NEW.variant_id AND c.price_id=NEW.price_id AND c.input=NEW.input
  AND c.reason=NEW.reason AND c.before_state=NEW.before_state AND c.after_state=NEW.after_state
  AND c.response=NEW.response AND c.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'catalog_price_audit_mismatch'); END;
CREATE TRIGGER catalog_price_audit_duplicate BEFORE INSERT ON catalog_price_audit
WHEN EXISTS(SELECT 1 FROM catalog_price_audit WHERE id=NEW.id OR command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'catalog_price_audit_immutable'); END;
CREATE TRIGGER catalog_price_audit_no_update BEFORE UPDATE ON catalog_price_audit
BEGIN SELECT RAISE(ABORT,'catalog_price_audit_immutable'); END;
CREATE TRIGGER catalog_price_audit_no_delete BEFORE DELETE ON catalog_price_audit
BEGIN SELECT RAISE(ABORT,'catalog_price_audit_immutable'); END;
CREATE TABLE catalog_price_guards (
  id TEXT PRIMARY KEY,
  satisfied INTEGER NOT NULL CONSTRAINT catalog_price_atomic_guard CHECK(satisfied=1)
) STRICT;
