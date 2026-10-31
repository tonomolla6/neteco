-- Isolated B2B integration records; no production orders or customer PII.
CREATE TABLE b2b_public_keys (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 64),
 key_hash TEXT NOT NULL UNIQUE CHECK(length(key_hash)=64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
 environment TEXT NOT NULL CHECK(environment IN ('live','sandbox')),
 company_id TEXT REFERENCES companies(id),
 scopes TEXT NOT NULL CHECK(scopes IN ('requests.read','requests.write','requests.read requests.write')),
 quota_daily INTEGER NOT NULL CHECK(quota_daily BETWEEN 1 AND 10000),
 status TEXT NOT NULL CHECK(status IN ('active','revoked')),
 version INTEGER NOT NULL CHECK(version>=1),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 CHECK((environment='sandbox' AND company_id IS NULL) OR (environment='live' AND company_id IS NOT NULL))
) STRICT;
CREATE TRIGGER b2b_public_key_version BEFORE UPDATE ON b2b_public_keys
WHEN NEW.id<>OLD.id OR NEW.key_hash<>OLD.key_hash OR NEW.environment<>OLD.environment OR NEW.company_id IS NOT OLD.company_id OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 OR (OLD.status='revoked' AND NEW.status<>'revoked')
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
 reference TEXT NOT NULL CHECK(length(reference) BETWEEN 1 AND 100 AND substr(reference,1,1) GLOB '[A-Za-z0-9]' AND reference NOT GLOB '*[^A-Za-z0-9._:-]*'),
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
CREATE TRIGGER b2b_public_admin_commands_no_replace BEFORE INSERT ON b2b_public_admin_commands
WHEN EXISTS(SELECT 1 FROM b2b_public_admin_commands WHERE actor_id=NEW.actor_id AND command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER b2b_public_admin_audit_no_replace BEFORE INSERT ON b2b_public_admin_audit
WHEN EXISTS(SELECT 1 FROM b2b_public_admin_audit WHERE actor_id=NEW.actor_id AND command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TABLE developer_service_owners (
 service_id TEXT PRIMARY KEY CHECK(service_id IN ('catalog','checkout','operations')),
 owner TEXT NOT NULL CHECK(length(owner) BETWEEN 2 AND 64 AND owner NOT GLOB '*[^a-z0-9._-]*'),
 version INTEGER NOT NULL CHECK(version>=1),
 updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),''))
) STRICT;
CREATE TABLE developer_ownership_commands (
 actor_id TEXT NOT NULL REFERENCES identities(id),
 command_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 service_id TEXT NOT NULL CHECK(service_id IN ('catalog','checkout','operations')),
 owner TEXT NOT NULL CHECK(length(owner) BETWEEN 2 AND 64 AND owner NOT GLOB '*[^a-z0-9._-]*'),
 version INTEGER NOT NULL CHECK(version>=1),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 PRIMARY KEY(actor_id,command_id),
 UNIQUE(service_id,version)
) STRICT;
CREATE TABLE developer_ownership_audit (
 actor_id TEXT NOT NULL,
 command_id TEXT NOT NULL,
 service_id TEXT NOT NULL,
 owner TEXT NOT NULL,
 version INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(actor_id,command_id),
 FOREIGN KEY(actor_id,command_id) REFERENCES developer_ownership_commands(actor_id,command_id)
) STRICT;
CREATE TRIGGER developer_ownership_cas BEFORE INSERT ON developer_ownership_commands
WHEN NEW.version<>COALESCE((SELECT version FROM developer_service_owners WHERE service_id=NEW.service_id),0)+1
BEGIN SELECT RAISE(ABORT,'developer_ownership_version_conflict'); END;
CREATE TRIGGER developer_ownership_apply AFTER INSERT ON developer_ownership_commands
BEGIN
 INSERT INTO developer_service_owners(service_id,owner,version,updated_at) VALUES(NEW.service_id,NEW.owner,NEW.version,NEW.created_at)
 ON CONFLICT(service_id) DO UPDATE SET owner=NEW.owner,version=NEW.version,updated_at=NEW.created_at;
 INSERT INTO developer_ownership_audit VALUES(NEW.actor_id,NEW.command_id,NEW.service_id,NEW.owner,NEW.version,NEW.created_at);
END;
CREATE TRIGGER developer_ownership_commands_no_update BEFORE UPDATE ON developer_ownership_commands BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER developer_ownership_commands_no_delete BEFORE DELETE ON developer_ownership_commands BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER developer_ownership_commands_no_replace BEFORE INSERT ON developer_ownership_commands WHEN EXISTS(SELECT 1 FROM developer_ownership_commands WHERE actor_id=NEW.actor_id AND command_id=NEW.command_id) BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER developer_ownership_audit_no_update BEFORE UPDATE ON developer_ownership_audit BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER developer_ownership_audit_no_delete BEFORE DELETE ON developer_ownership_audit BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER developer_ownership_audit_no_replace BEFORE INSERT ON developer_ownership_audit WHEN EXISTS(SELECT 1 FROM developer_ownership_audit WHERE actor_id=NEW.actor_id AND command_id=NEW.command_id) BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER b2b_public_requests_live_no_delete BEFORE DELETE ON b2b_public_requests
WHEN OLD.generation='live' BEGIN SELECT RAISE(ABORT,'b2b_request_immutable'); END;
CREATE TRIGGER b2b_public_requests_no_replace BEFORE INSERT ON b2b_public_requests
WHEN EXISTS(SELECT 1 FROM b2b_public_requests WHERE id=NEW.id OR (key_id=NEW.key_id AND generation=NEW.generation AND command_id=NEW.command_id))
BEGIN SELECT RAISE(ABORT,'b2b_request_immutable'); END;
CREATE TRIGGER b2b_public_requests_environment BEFORE INSERT ON b2b_public_requests
WHEN NOT EXISTS(SELECT 1 FROM b2b_public_keys k WHERE k.id=NEW.key_id AND
 ((k.environment='live' AND NEW.generation='live') OR
  (k.environment='sandbox' AND NEW.generation=substr(NEW.created_at,1,10))))
BEGIN SELECT RAISE(ABORT,'b2b_environment_mismatch'); END;
