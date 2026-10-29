CREATE TABLE admin_order_views (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES identities(id),
  name TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  version INTEGER NOT NULL CHECK(version>=1),
  archived INTEGER NOT NULL CHECK(archived IN(0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  command_id TEXT NOT NULL,
  CHECK((archived=0 AND archived_at IS NULL) OR (archived=1 AND archived_at=updated_at))
);
CREATE INDEX admin_order_views_owner ON admin_order_views(owner_id,archived,updated_at,id);
CREATE TABLE admin_order_view_commands (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES identities(id),
  session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  session_version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN('create','update','archive')),
  view_id TEXT NOT NULL,
  expected_version INTEGER NOT NULL CHECK(expected_version>=0),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  recorded_at TEXT NOT NULL
);
CREATE TRIGGER admin_order_view_commands_no_update BEFORE UPDATE ON admin_order_view_commands BEGIN
  SELECT RAISE(ABORT,'admin_order_view_command_immutable');
END;
CREATE TRIGGER admin_order_view_commands_no_replace BEFORE INSERT ON admin_order_view_commands WHEN EXISTS(SELECT 1 FROM admin_order_view_commands WHERE id=NEW.id) BEGIN
  SELECT RAISE(ABORT,'admin_order_view_command_immutable');
END;
CREATE TRIGGER admin_order_views_no_replace BEFORE INSERT ON admin_order_views WHEN EXISTS(SELECT 1 FROM admin_order_views WHERE id=NEW.id) BEGIN
  SELECT RAISE(ABORT,'admin_order_view_projection_immutable');
END;
CREATE TRIGGER admin_order_view_commands_no_delete BEFORE DELETE ON admin_order_view_commands BEGIN
  SELECT RAISE(ABORT,'admin_order_view_command_immutable');
END;
CREATE TRIGGER admin_order_view_command_apply AFTER INSERT ON admin_order_view_commands BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM identities i JOIN auth_sessions s ON s.identity_id=i.id JOIN identity_mfa m ON m.identity_id=i.id
    WHERE i.id=NEW.actor_id AND s.id=NEW.session_id AND i.status='active'
      AND i.session_version=NEW.session_version AND s.session_version=i.session_version
      AND s.revoked_at IS NULL AND s.mfa_verified=1
      AND s.created_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
      AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
      AND m.verified_at IS NOT NULL AND m.verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
      AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND (r.expires_at IS NULL OR r.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')))
  ) THEN RAISE(ABORT,'admin_order_view_authority') END;
  SELECT CASE WHEN json_extract(NEW.receipt_json,'$.commandId') IS NOT NEW.id
    OR json_extract(NEW.receipt_json,'$.viewId') IS NOT NEW.view_id
    OR json_extract(NEW.receipt_json,'$.payloadHash') IS NOT NEW.payload_hash
    OR json_extract(NEW.receipt_json,'$.action') IS NOT NEW.action
    OR json_extract(NEW.receipt_json,'$.version') IS NOT NEW.expected_version + 1
    OR json_extract(NEW.receipt_json,'$.recordedAt') IS NOT NEW.recorded_at
    THEN RAISE(ABORT,'admin_order_view_receipt') END;
  SELECT CASE WHEN NEW.action='create' AND (NEW.expected_version<>0 OR EXISTS(SELECT 1 FROM admin_order_views WHERE id=NEW.view_id) OR (SELECT count(*) FROM admin_order_views WHERE owner_id=NEW.actor_id AND archived=0)>=20)
    THEN RAISE(ABORT,'admin_order_view_limit') END;
  SELECT CASE WHEN NEW.action<>'create' AND NOT EXISTS(SELECT 1 FROM admin_order_views WHERE id=NEW.view_id AND owner_id=NEW.actor_id AND version=NEW.expected_version AND archived=0)
    THEN RAISE(ABORT,'admin_order_view_cas') END;
  INSERT INTO admin_order_views(id,owner_id,name,definition_json,version,archived,created_at,updated_at,archived_at,command_id)
    SELECT NEW.view_id,NEW.actor_id,json_extract(NEW.snapshot_json,'$.name'),json_extract(NEW.snapshot_json,'$.definition'),1,0,NEW.recorded_at,NEW.recorded_at,NULL,NEW.id WHERE NEW.action='create';
  UPDATE admin_order_views SET name=json_extract(NEW.snapshot_json,'$.name'),definition_json=json_extract(NEW.snapshot_json,'$.definition'),version=version + 1,
    archived= CASE WHEN NEW.action='archive' THEN 1 ELSE 0 END,updated_at=NEW.recorded_at,archived_at= CASE WHEN NEW.action='archive' THEN NEW.recorded_at ELSE NULL END,command_id=NEW.id
    WHERE id=NEW.view_id AND owner_id=NEW.actor_id AND NEW.action<>'create';
END;
CREATE TRIGGER admin_order_views_insert_guard BEFORE INSERT ON admin_order_views BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM admin_order_view_commands c WHERE c.id=NEW.command_id AND c.actor_id=NEW.owner_id AND c.view_id=NEW.id AND c.action='create' AND c.expected_version=0 AND NEW.version=1 AND NEW.archived=0 AND NEW.created_at=c.recorded_at AND NEW.updated_at=c.recorded_at AND NEW.name=json_extract(c.snapshot_json,'$.name') AND NEW.definition_json=json_extract(c.snapshot_json,'$.definition')) THEN RAISE(ABORT,'admin_order_view_projection') END;
END;
CREATE TRIGGER admin_order_views_update_guard BEFORE UPDATE ON admin_order_views BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM admin_order_view_commands c WHERE c.id=NEW.command_id AND c.actor_id=NEW.owner_id AND c.view_id=NEW.id AND c.action IN('update','archive') AND c.expected_version=OLD.version AND NEW.version=OLD.version + 1 AND NEW.owner_id=OLD.owner_id AND NEW.id=OLD.id AND NEW.created_at=OLD.created_at AND NEW.updated_at=c.recorded_at AND NEW.name=json_extract(c.snapshot_json,'$.name') AND NEW.definition_json=json_extract(c.snapshot_json,'$.definition') AND NEW.archived= CASE WHEN c.action='archive' THEN 1 ELSE 0 END) THEN RAISE(ABORT,'admin_order_view_projection') END;
END;
CREATE TRIGGER admin_order_views_no_delete BEFORE DELETE ON admin_order_views BEGIN
  SELECT RAISE(ABORT,'admin_order_view_no_delete');
END;
