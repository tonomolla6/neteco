CREATE TABLE order_annotation_commands (
 order_id TEXT NOT NULL REFERENCES orders(id), command_id TEXT NOT NULL CHECK(length(command_id)=36
 AND substr(command_id,9,1)='-' AND substr(command_id,14,1)='-' AND substr(command_id,19,1)='-' AND substr(command_id,24,1)='-'
 AND length(replace(command_id,'-',''))=32 AND lower(replace(command_id,'-','')) NOT GLOB '*[^0-9a-f]*'
 AND substr(command_id,15,1) IN('1','2','3','4','5','6','7','8') AND lower(substr(command_id,20,1)) IN('8','9','a','b')),
 actor_id TEXT NOT NULL REFERENCES identities(id), session_id TEXT NOT NULL REFERENCES auth_sessions(id), session_version INTEGER NOT NULL CHECK(session_version>=1),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64), expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 version INTEGER NOT NULL CHECK(version=expected_version+1), note TEXT CHECK(note IS NULL OR length(note) BETWEEN 1 AND 2000),
 labels TEXT NOT NULL CHECK(json_valid(labels) AND json_type(labels)='array' AND json_array_length(labels)<=8),
 created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 PRIMARY KEY(order_id,command_id), UNIQUE(order_id,version)
) STRICT;
CREATE INDEX order_annotation_notes ON order_annotation_commands(order_id,created_at DESC,command_id DESC) WHERE note IS NOT NULL;
CREATE TRIGGER order_annotation_no_update BEFORE UPDATE ON order_annotation_commands BEGIN SELECT RAISE(ABORT,'annotation_immutable'); END;
CREATE TRIGGER order_annotation_no_delete BEFORE DELETE ON order_annotation_commands BEGIN SELECT RAISE(ABORT,'annotation_immutable'); END;
CREATE TRIGGER order_annotation_cas BEFORE INSERT ON order_annotation_commands
WHEN NEW.expected_version<>COALESCE((SELECT max(version) FROM order_annotation_commands WHERE order_id=NEW.order_id),0)
BEGIN SELECT RAISE(ABORT,'annotation_conflict'); END;
CREATE TRIGGER order_annotation_authority BEFORE INSERT ON order_annotation_commands
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE s.id=NEW.session_id AND s.identity_id=NEW.actor_id AND s.session_version=NEW.session_version AND i.session_version=s.session_version
 AND s.revoked_at IS NULL AND s.mfa_verified=1 AND i.status IN('active','pending')
 AND s.created_at<=NEW.created_at AND s.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.created_at
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=NEW.created_at
 AND (r.expires_at IS NULL OR r.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')))))
BEGIN SELECT RAISE(ABORT,'annotation_authority'); END;
CREATE TRIGGER order_annotation_labels BEFORE INSERT ON order_annotation_commands
WHEN EXISTS(SELECT 1 FROM json_each(NEW.labels) WHERE type<>'text' OR length(value) NOT BETWEEN 1 AND 40)
 OR (SELECT count(*) FROM json_each(NEW.labels))<>(SELECT count(DISTINCT value) FROM json_each(NEW.labels))
BEGIN SELECT RAISE(ABORT,'annotation_labels'); END;
