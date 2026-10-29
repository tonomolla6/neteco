-- Private favorites remain the saved-list source; sharing is an explicit,
-- immutable variant/quantity snapshot. No bearer token is stored.
CREATE TABLE customer_cart_snapshot_commands (
  actor_id TEXT NOT NULL REFERENCES identities(id),
  command_id TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  action TEXT NOT NULL CHECK(action IN ('create','revoke')),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  cart_id TEXT,
  list_id TEXT,
  share_id TEXT,
  cart_version INTEGER,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json)='object'),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  PRIMARY KEY(actor_id,command_id),
  CHECK((action='create' AND cart_id IS NOT NULL AND list_id IS NOT NULL AND cart_version>=1)
    OR (action='revoke' AND cart_id IS NULL AND list_id IS NULL AND cart_version IS NULL AND share_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX customer_cart_snapshot_one_list ON customer_cart_snapshot_commands(list_id) WHERE action='create';
CREATE INDEX customer_cart_snapshot_owner ON customer_cart_snapshot_commands(customer_id,created_at,command_id);
CREATE TRIGGER customer_cart_snapshot_commands_no_update BEFORE UPDATE ON customer_cart_snapshot_commands BEGIN SELECT RAISE(ABORT,'immutable_cart_snapshot_command'); END;
CREATE TRIGGER customer_cart_snapshot_commands_no_delete BEFORE DELETE ON customer_cart_snapshot_commands BEGIN SELECT RAISE(ABORT,'immutable_cart_snapshot_command'); END;
CREATE TRIGGER customer_cart_snapshot_commands_no_replace BEFORE INSERT ON customer_cart_snapshot_commands
WHEN EXISTS(SELECT 1 FROM customer_cart_snapshot_commands WHERE actor_id=NEW.actor_id AND command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'immutable_cart_snapshot_command'); END;

CREATE TABLE customer_cart_shares (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  creator_identity_id TEXT NOT NULL REFERENCES identities(id),
  create_command_id TEXT NOT NULL,
  -- Deliberately not a FK: deleting a favorite list invalidates its capability
  -- through the live read gate, without deleting history or blocking favorites.
  list_id TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND json_type(snapshot_json)='array'
    AND json_array_length(snapshot_json) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  expires_at TEXT NOT NULL CHECK(expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',expires_at),'')
    AND expires_at= strftime('%Y-%m-%dT%H:%M:%SZ',created_at,'+24 hours')),
  revoked_at TEXT CHECK(revoked_at IS NULL OR (revoked_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',revoked_at),'') AND revoked_at>=created_at)),
  FOREIGN KEY(creator_identity_id,create_command_id) REFERENCES customer_cart_snapshot_commands(actor_id,command_id)
) STRICT;
CREATE TRIGGER customer_cart_shares_no_update BEFORE UPDATE ON customer_cart_shares
WHEN NEW.id IS NOT OLD.id OR NEW.customer_id IS NOT OLD.customer_id OR NEW.creator_identity_id IS NOT OLD.creator_identity_id
  OR NEW.create_command_id IS NOT OLD.create_command_id OR NEW.list_id IS NOT OLD.list_id OR NEW.token_hash IS NOT OLD.token_hash
  OR NEW.snapshot_json IS NOT OLD.snapshot_json OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN SELECT RAISE(ABORT,'immutable_cart_share'); END;
CREATE TRIGGER customer_cart_shares_no_delete BEFORE DELETE ON customer_cart_shares BEGIN SELECT RAISE(ABORT,'immutable_cart_share'); END;
CREATE TRIGGER customer_cart_shares_no_replace BEFORE INSERT ON customer_cart_shares
WHEN EXISTS(SELECT 1 FROM customer_cart_shares WHERE id=NEW.id OR list_id=NEW.list_id)
BEGIN SELECT RAISE(ABORT,'immutable_cart_share'); END;
CREATE TABLE customer_cart_snapshot_guards(id TEXT PRIMARY KEY,valid INTEGER NOT NULL CONSTRAINT cart_snapshot_atomic_guard CHECK(valid=1)) STRICT;
