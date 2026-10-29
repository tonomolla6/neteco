-- Existing verified accounts only. No bootstrap identities, roles or credentials.
CREATE TABLE admin_invitations (
  id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND replace(id,'-','') NOT GLOB '*[^a-f0-9]*' AND length(replace(id,'-',''))=32),
  issuer_id TEXT NOT NULL REFERENCES identities(id),
  issuer_session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  issuer_session_version INTEGER NOT NULL CHECK(issuer_session_version>=1),
  recipient_id TEXT NOT NULL REFERENCES identities(id),
  recipient_email TEXT NOT NULL COLLATE NOCASE CHECK(length(recipient_email) BETWEEN 3 AND 254),
  role_code TEXT NOT NULL REFERENCES roles(code) CHECK(role_code IN('support','warehouse','catalog_editor','publisher','finance','admin')),
  permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json) AND json_type(permissions_json)='array' AND json_array_length(permissions_json) BETWEEN 1 AND 100),
  permissions_hash TEXT NOT NULL CHECK(length(permissions_hash)=64 AND permissions_hash NOT GLOB '*[^a-f0-9]*'),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^a-f0-9]*'),
  version INTEGER NOT NULL CHECK(version>=1),
  status TEXT NOT NULL CHECK(status IN('pending','accepted','revoked')),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  expires_at TEXT NOT NULL CHECK(expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',expires_at),'') AND expires_at>created_at AND expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ',created_at,'+168 hours')),
  accepted_at TEXT CHECK(accepted_at IS NULL OR accepted_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',accepted_at),'')),
  revoked_at TEXT CHECK(revoked_at IS NULL OR revoked_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',revoked_at),'')),
  command_id TEXT NOT NULL UNIQUE,
  CHECK(COALESCE((status='pending' AND version=1 AND accepted_at IS NULL AND revoked_at IS NULL) OR (status='accepted' AND version=2 AND accepted_at>=created_at AND revoked_at IS NULL) OR (status='revoked' AND version=2 AND revoked_at>=created_at AND accepted_at IS NULL),0))
) STRICT;
CREATE INDEX admin_invitations_created ON admin_invitations(created_at DESC,id DESC);
CREATE TABLE admin_invitation_commands (
  id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND replace(id,'-','') NOT GLOB '*[^a-f0-9]*' AND length(replace(id,'-',''))=32),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  actor_session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  actor_session_version INTEGER NOT NULL CHECK(actor_session_version>=1),
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN('create','revoke','accept')),
  invitation_id TEXT NOT NULL REFERENCES admin_invitations(id),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json) AND json_type(input_json)='object' AND json_extract(input_json,'$.token') IS NULL),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 10 AND 500),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json)='object' AND json_extract(receipt_json,'$.token') IS NULL AND json_extract(receipt_json,'$.tokenHash') IS NULL),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE INDEX admin_invitation_commands_actor ON admin_invitation_commands(actor_id,created_at,id);
CREATE TABLE admin_invitation_guards(id TEXT PRIMARY KEY,passed INTEGER NOT NULL CONSTRAINT admin_invitation_atomic_guard CHECK(passed=1)) STRICT;
CREATE TRIGGER admin_invitation_commands_immutable_update BEFORE UPDATE ON admin_invitation_commands BEGIN SELECT RAISE(ABORT,'admin_invitation_history_immutable'); END;
CREATE TRIGGER admin_invitation_commands_immutable_delete BEFORE DELETE ON admin_invitation_commands BEGIN SELECT RAISE(ABORT,'admin_invitation_history_immutable'); END;
CREATE TRIGGER admin_invitations_immutable_delete BEFORE DELETE ON admin_invitations BEGIN SELECT RAISE(ABORT,'admin_invitation_history_immutable'); END;
CREATE TRIGGER admin_invitations_controlled_update BEFORE UPDATE ON admin_invitations BEGIN
  SELECT CASE WHEN NEW.issuer_id IS NOT OLD.issuer_id OR NEW.issuer_session_id IS NOT OLD.issuer_session_id OR NEW.issuer_session_version IS NOT OLD.issuer_session_version OR NEW.recipient_id IS NOT OLD.recipient_id OR NEW.recipient_email IS NOT OLD.recipient_email OR NEW.role_code IS NOT OLD.role_code OR NEW.permissions_json IS NOT OLD.permissions_json OR NEW.permissions_hash IS NOT OLD.permissions_hash OR NEW.token_hash IS NOT OLD.token_hash OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at OR OLD.status!='pending' OR NEW.version!=OLD.version+1 OR NOT EXISTS(SELECT 1 FROM admin_invitation_commands c WHERE c.id=NEW.command_id AND c.invitation_id=OLD.id AND ((c.action='accept' AND NEW.status='accepted' AND NEW.accepted_at=c.created_at) OR (c.action='revoke' AND NEW.status='revoked' AND NEW.revoked_at=c.created_at))) THEN RAISE(ABORT,'admin_invitation_atomic_guard') END;
END;
CREATE TRIGGER admin_invitation_command_guard BEFORE INSERT ON admin_invitation_commands BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM identities i JOIN auth_sessions s ON s.identity_id=i.id JOIN identity_mfa m ON m.identity_id=i.id
    WHERE i.id=NEW.actor_id AND s.id=NEW.actor_session_id AND s.session_version=NEW.actor_session_version AND i.session_version=s.session_version
      AND i.status='active' AND i.email=NEW.actor_email AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
      AND s.revoked_at IS NULL AND s.created_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
      AND s.mfa_verified=1 AND m.verified_at IS NOT NULL AND m.verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
      AND (NEW.action!='accept' OR EXISTS(SELECT 1 FROM customers customer WHERE customer.id=i.customer_id AND customer.status='active'))
      AND (NEW.action='accept' OR EXISTS(SELECT 1 FROM identity_roles a JOIN role_permissions p ON p.role_code=a.role_code WHERE a.identity_id=i.id AND p.permission_code='administration.manage' AND a.granted_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND (a.expires_at IS NULL OR a.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now'))))
  ) THEN RAISE(ABORT,'admin_invitation_atomic_guard') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM admin_invitations v WHERE v.id=NEW.invitation_id AND v.status='pending'
    AND ((NEW.action='create' AND v.command_id=NEW.id AND v.issuer_id=NEW.actor_id) OR NEW.action IN('accept','revoke'))
    AND COALESCE(json_extract(NEW.receipt_json,'$.source')='cloudflare' AND json_extract(NEW.receipt_json,'$.commandId')=NEW.id AND json_extract(NEW.receipt_json,'$.action')=NEW.action AND json_extract(NEW.receipt_json,'$.invitationId')=v.id AND json_extract(NEW.receipt_json,'$.payloadHash')=NEW.payload_hash AND json_extract(NEW.receipt_json,'$.roleCode')=v.role_code AND json_extract(NEW.receipt_json,'$.recordedAt')=NEW.created_at AND json_extract(NEW.receipt_json,'$.version')=v.version + CASE WHEN NEW.action='create' THEN 0 ELSE 1 END AND json_extract(NEW.receipt_json,'$.sessionRevoked') = CASE WHEN NEW.action='accept' THEN 1 ELSE 0 END,0)
    AND (NEW.action!='revoke' OR json_extract(NEW.input_json,'$.expectedVersion')=v.version)
    AND (NEW.action!='accept' OR (v.recipient_id=NEW.actor_id AND v.recipient_email=NEW.actor_email AND v.token_hash=json_extract(NEW.input_json,'$.tokenHash') AND v.created_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND v.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now') AND NOT EXISTS(SELECT 1 FROM identity_roles old WHERE old.identity_id=NEW.actor_id AND old.role_code=v.role_code))))
  THEN RAISE(ABORT,'admin_invitation_atomic_guard') END;
  SELECT CASE WHEN NEW.action IN('create','accept') AND NOT EXISTS(
    SELECT 1 FROM admin_invitations v JOIN identities i ON i.id=v.issuer_id JOIN identity_mfa m ON m.identity_id=i.id
    WHERE v.id=NEW.invitation_id AND i.status='active' AND i.session_version=v.issuer_session_version
      AND m.verified_at IS NOT NULL AND m.verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
      AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
      AND v.permissions_json=(SELECT json_group_array(permission_code) FROM(SELECT permission_code FROM role_permissions WHERE role_code=v.role_code ORDER BY permission_code))
      AND EXISTS(SELECT 1 FROM identity_roles a JOIN role_permissions p ON p.role_code=a.role_code WHERE a.identity_id=i.id AND p.permission_code='administration.manage' AND a.granted_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND (a.expires_at IS NULL OR a.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')))
      AND NOT EXISTS(SELECT 1 FROM role_permissions target WHERE target.role_code=v.role_code AND NOT EXISTS(SELECT 1 FROM identity_roles a JOIN role_permissions p ON p.role_code=a.role_code WHERE a.identity_id=i.id AND p.permission_code=target.permission_code AND a.granted_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND (a.expires_at IS NULL OR a.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now'))))
  ) THEN RAISE(ABORT,'admin_invitation_atomic_guard') END;
END;
CREATE TRIGGER admin_invitation_command_apply AFTER INSERT ON admin_invitation_commands BEGIN
  UPDATE admin_invitations SET version=version+1,status='revoked',revoked_at=NEW.created_at,command_id=NEW.id WHERE id=NEW.invitation_id AND NEW.action='revoke';
  INSERT INTO identity_roles(identity_id,role_code,granted_by,granted_at,expires_at)
    SELECT v.recipient_id,v.role_code,v.issuer_id,NEW.created_at,NULL FROM admin_invitations v WHERE v.id=NEW.invitation_id AND NEW.action='accept';
  UPDATE admin_invitations SET version=version+1,status='accepted',accepted_at=NEW.created_at,command_id=NEW.id WHERE id=NEW.invitation_id AND NEW.action='accept';
  UPDATE identities SET session_version=session_version+1,updated_at=NEW.created_at WHERE id=NEW.actor_id AND NEW.action='accept';
  UPDATE auth_sessions SET revoked_at=NEW.created_at WHERE identity_id=NEW.actor_id AND revoked_at IS NULL AND NEW.action='accept';
END;
