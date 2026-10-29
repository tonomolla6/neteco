-- Isolated B2B integration records; no production orders or customer PII.
CREATE TABLE b2b_public_keys (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 64),
 key_hash TEXT NOT NULL UNIQUE CHECK(length(key_hash)=64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
 environment TEXT NOT NULL CHECK(environment IN ('live','sandbox')),
 scopes TEXT NOT NULL CHECK(scopes IN ('requests.read','requests.write','requests.read requests.write')),
 quota_daily INTEGER NOT NULL CHECK(quota_daily BETWEEN 1 AND 10000),
 status TEXT NOT NULL CHECK(status IN ('active','revoked')),
 version INTEGER NOT NULL CHECK(version>=1),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE TRIGGER b2b_public_key_version BEFORE UPDATE ON b2b_public_keys
WHEN NEW.id<>OLD.id OR NEW.key_hash<>OLD.key_hash OR NEW.environment<>OLD.environment OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 OR (OLD.status='revoked' AND NEW.status<>'revoked')
BEGIN SELECT RAISE(ABORT,'b2b_key_version_conflict'); END;
CREATE TABLE b2b_public_quota (
 key_id TEXT NOT NULL REFERENCES b2b_public_keys(id),
 day TEXT NOT NULL CHECK(day=COALESCE(strftime('%Y-%m-%d',day),'')),
 used INTEGER NOT NULL CHECK(used>0),
 PRIMARY KEY(key_id,day)
) STRICT;
CREATE TABLE b2b_public_requests (
 id TEXT PRIMARY KEY,
 key_id TEXT NOT NULL REFERENCES b2b_public_keys(id),
 generation TEXT NOT NULL CHECK(generation='live' OR generation=COALESCE(strftime('%Y-%m-%d',generation),'')),
 command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 128),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 reference TEXT NOT NULL CHECK(length(reference) BETWEEN 1 AND 100),
 version INTEGER NOT NULL CHECK(version=1),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(key_id,generation,command_id)
) STRICT;
CREATE INDEX b2b_public_requests_list ON b2b_public_requests(key_id,generation,created_at,id);
CREATE TRIGGER b2b_public_requests_no_update BEFORE UPDATE ON b2b_public_requests
BEGIN SELECT RAISE(ABORT,'b2b_request_immutable'); END;
CREATE TABLE b2b_public_admin_commands (
 actor_id TEXT NOT NULL REFERENCES identities(id),
 command_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 action TEXT NOT NULL CHECK(action IN ('create','revoke')),
 key_id TEXT NOT NULL REFERENCES b2b_public_keys(id),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 PRIMARY KEY(actor_id,command_id)
) STRICT;
CREATE TABLE b2b_public_admin_audit (
 actor_id TEXT NOT NULL,
 command_id TEXT NOT NULL,
 action TEXT NOT NULL,
 key_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(actor_id,command_id),
 FOREIGN KEY(actor_id,command_id) REFERENCES b2b_public_admin_commands(actor_id,command_id)
) STRICT;
CREATE TRIGGER b2b_public_admin_audit_insert AFTER INSERT ON b2b_public_admin_commands
BEGIN INSERT INTO b2b_public_admin_audit VALUES(NEW.actor_id,NEW.command_id,NEW.action,NEW.key_id,NEW.created_at); END;
CREATE TRIGGER b2b_public_admin_commands_no_update BEFORE UPDATE ON b2b_public_admin_commands BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER b2b_public_admin_commands_no_delete BEFORE DELETE ON b2b_public_admin_commands BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER b2b_public_admin_audit_no_update BEFORE UPDATE ON b2b_public_admin_audit BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER b2b_public_admin_audit_no_delete BEFORE DELETE ON b2b_public_admin_audit BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TABLE b2b_public_admin_guards(id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1)) STRICT;
