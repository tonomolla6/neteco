-- Central review/export commands only. Domain history remains in its original
-- immutable ledgers; no mutable copy of business actions is introduced.
CREATE TABLE admin_audit_commands (
 id TEXT PRIMARY KEY CHECK(length(id)=36 AND length(replace(id,'-',''))=32 AND replace(id,'-','') NOT GLOB '*[^a-f0-9]*'),
 actor_id TEXT NOT NULL REFERENCES identities(id),
 session_id TEXT NOT NULL REFERENCES auth_sessions(id),
 session_version INTEGER NOT NULL CHECK(session_version>=1),
 ip_hash TEXT CHECK(ip_hash IS NULL OR (length(ip_hash)=64 AND ip_hash NOT GLOB '*[^a-f0-9]*')),
 action TEXT NOT NULL CHECK(action IN('review','export')),
 event_id TEXT,
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
 input_json TEXT NOT NULL CHECK(json_valid(input_json) AND json_type(input_json)='object' AND length(CAST(input_json AS BLOB))<=16384),
 expected_version INTEGER,
 version INTEGER,
 disposition TEXT CHECK(disposition IS NULL OR disposition IN('reviewed','follow_up')),
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json)='object' AND length(CAST(receipt_json AS BLOB))<=2048),
 csv TEXT,
 expires_at TEXT CHECK(expires_at IS NULL OR expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',expires_at),'')),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 CHECK(length(CAST(COALESCE(csv,'') AS BLOB))+length(CAST(input_json AS BLOB))+length(CAST(receipt_json AS BLOB))<=2000000),
 CHECK(COALESCE(json_extract(receipt_json,'$.source')='cloudflare' AND json_extract(receipt_json,'$.commandId')=id
  AND json_extract(receipt_json,'$.action')=action AND json_extract(receipt_json,'$.payloadHash')=payload_hash
  AND json_extract(receipt_json,'$.recordedAt')=created_at,0)),
 CHECK(COALESCE((action='review' AND event_id IS NOT NULL AND length(event_id)<=160 AND expected_version>=0
  AND version=expected_version+1 AND disposition IS NOT NULL AND csv IS NULL AND expires_at IS NULL
  AND json_extract(input_json,'$.expectedVersion')=expected_version AND json_extract(input_json,'$.disposition')=disposition
  AND json_extract(receipt_json,'$.eventId')=event_id AND json_extract(receipt_json,'$.version')=version
  AND json_extract(receipt_json,'$.disposition')=disposition)
 OR(action='export' AND event_id IS NULL AND expected_version IS NULL AND version IS NULL AND disposition IS NULL
  AND csv IS NOT NULL AND expires_at=strftime('%Y-%m-%dT%H:%M:%SZ',created_at,'+24 hours')
  AND json_extract(receipt_json,'$.expiresAt')=expires_at AND json_type(receipt_json,'$.rows')='integer'
  AND json_extract(receipt_json,'$.rows') BETWEEN 0 AND 1000
  AND json_extract(receipt_json,'$.bytes')=length(CAST(csv AS BLOB))
  AND length(json_extract(receipt_json,'$.digest'))=64 AND length(json_extract(receipt_json,'$.filterHash'))=64),0))
) STRICT;
CREATE UNIQUE INDEX admin_audit_review_version ON admin_audit_commands(event_id,version) WHERE action='review';
CREATE INDEX admin_audit_actor ON admin_audit_commands(actor_id,created_at,id);
CREATE TRIGGER admin_audit_commands_authority BEFORE INSERT ON admin_audit_commands
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM identities i JOIN auth_sessions s ON s.identity_id=i.id
  JOIN identity_mfa m ON m.identity_id=i.id WHERE i.id=NEW.actor_id AND i.status='active'
  AND i.session_version=NEW.session_version AND s.id=NEW.session_id AND s.session_version=i.session_version
  AND s.revoked_at IS NULL AND s.created_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
  AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now') AND s.mfa_verified=1
  AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
  AND m.verified_at IS NOT NULL AND m.verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
  AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
   WHERE r.identity_id=i.id AND p.permission_code='administration.manage'
   AND r.granted_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
   AND (r.expires_at IS NULL OR r.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now'))))
  THEN RAISE(ABORT,'admin_audit_atomic_guard') END;
 SELECT CASE WHEN NEW.action='review' AND NEW.expected_version<>(SELECT COALESCE(max(version),0) FROM admin_audit_commands WHERE event_id=NEW.event_id AND action='review')
  THEN RAISE(ABORT,'admin_audit_version_conflict') END;
END;
CREATE TRIGGER admin_audit_no_update BEFORE UPDATE ON admin_audit_commands
BEGIN SELECT RAISE(ABORT,'admin_audit_immutable'); END;
CREATE TRIGGER admin_audit_no_delete BEFORE DELETE ON admin_audit_commands
BEGIN SELECT RAISE(ABORT,'admin_audit_immutable'); END;
CREATE TRIGGER admin_audit_no_replace BEFORE INSERT ON admin_audit_commands WHEN EXISTS(SELECT 1 FROM admin_audit_commands WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'admin_audit_immutable'); END;
CREATE TABLE admin_audit_guards(id TEXT PRIMARY KEY,passed INTEGER NOT NULL CONSTRAINT admin_audit_atomic_guard CHECK(passed=1)) STRICT;
