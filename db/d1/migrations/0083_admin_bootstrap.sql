-- Explicit local CLI bootstrap for the FIRST administrator only. No default
-- accounts, passwords, policy seeds, remote endpoints or recovery backdoor.
CREATE VIEW admin_bootstrap_candidates AS
WITH policy AS (
  SELECT json_group_array(permission_code) AS permissions_json
  FROM (SELECT permission_code FROM role_permissions WHERE role_code='admin' ORDER BY permission_code)
)
SELECT i.id AS identity_id, s.id AS session_id, i.session_version,
  i.email_verified_at, m.verified_at AS mfa_verified_at,
  s.expires_at AS session_expires_at, s.created_at AS session_created_at, p.permissions_json
FROM identities i
JOIN customers c ON c.id=i.customer_id
JOIN identity_mfa m ON m.identity_id=i.id
JOIN auth_sessions s ON s.identity_id=i.id AND s.session_version=i.session_version
CROSS JOIN policy p
WHERE i.status='active' AND c.status='active'
  AND i.session_version BETWEEN 1 AND 9007199254740990
  AND i.created_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
  AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
  AND m.verified_at IS NOT NULL AND m.verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
  AND s.mfa_verified=1 AND s.revoked_at IS NULL
  AND s.created_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
  AND json_array_length(p.permissions_json) BETWEEN 1 AND 100
  AND EXISTS(SELECT 1 FROM roles WHERE code='admin')
  AND EXISTS(SELECT 1 FROM role_permissions WHERE role_code='admin' AND permission_code='administration.manage')
  AND NOT EXISTS(SELECT 1 FROM admin_bootstrap_commands)
  AND NOT EXISTS(SELECT 1 FROM identity_roles a WHERE a.role_code='admin' OR EXISTS(
    SELECT 1 FROM role_permissions rp WHERE rp.role_code=a.role_code AND rp.permission_code='administration.manage'
  ));

CREATE TABLE admin_bootstrap_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id)=36 AND length(replace(command_id,'-',''))=32 AND replace(command_id,'-','') NOT GLOB '*[^a-f0-9]*'),
  identity_id TEXT NOT NULL REFERENCES identities(id),
  session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  session_version INTEGER NOT NULL CHECK(session_version BETWEEN 1 AND 9007199254740990),
  email_verified_at TEXT NOT NULL CHECK(email_verified_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',email_verified_at),'')),
  mfa_verified_at TEXT NOT NULL CHECK(mfa_verified_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',mfa_verified_at),'')),
  session_expires_at TEXT NOT NULL CHECK(session_expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',session_expires_at),'')),
  permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json) AND json_type(permissions_json)='array' AND json_array_length(permissions_json) BETWEEN 1 AND 100),
  plan_hash TEXT NOT NULL CHECK(length(plan_hash)=64 AND plan_hash NOT GLOB '*[^a-f0-9]*'),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 10 AND 500 AND reason=trim(reason)),
  recorded_at TEXT NOT NULL CHECK(recorded_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',recorded_at),''))
) STRICT;
CREATE TRIGGER admin_bootstrap_commands_guard BEFORE INSERT ON admin_bootstrap_commands BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM admin_bootstrap_commands old WHERE old.command_id=NEW.command_id AND (
    old.identity_id!=NEW.identity_id OR old.plan_hash!=NEW.plan_hash OR old.reason!=NEW.reason
    OR old.session_id!=NEW.session_id OR old.session_version!=NEW.session_version OR old.permissions_json!=NEW.permissions_json
    OR old.email_verified_at!=NEW.email_verified_at OR old.mfa_verified_at!=NEW.mfa_verified_at OR old.session_expires_at!=NEW.session_expires_at
  )) THEN RAISE(ABORT,'bootstrap_idempotency_conflict') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM admin_bootstrap_commands WHERE command_id=NEW.command_id) AND (
    NEW.recorded_at!=strftime('%Y-%m-%dT%H:%M:%SZ','now') OR NOT EXISTS(
      SELECT 1 FROM admin_bootstrap_candidates p WHERE p.identity_id=NEW.identity_id AND p.session_id=NEW.session_id
      AND p.session_version=NEW.session_version AND p.email_verified_at=NEW.email_verified_at
      AND p.mfa_verified_at=NEW.mfa_verified_at AND p.session_expires_at=NEW.session_expires_at AND p.permissions_json=NEW.permissions_json
    )
  ) THEN RAISE(ABORT,'bootstrap_not_eligible') END;
END;
CREATE TRIGGER admin_bootstrap_commands_apply AFTER INSERT ON admin_bootstrap_commands BEGIN
  INSERT INTO identity_roles(identity_id,role_code,granted_by,granted_at,expires_at)
    VALUES(NEW.identity_id,'admin',NULL,NEW.recorded_at,NULL);
  UPDATE identities SET session_version=session_version+1,updated_at=NEW.recorded_at WHERE id=NEW.identity_id;
  UPDATE auth_sessions SET revoked_at=NEW.recorded_at WHERE identity_id=NEW.identity_id AND revoked_at IS NULL;
END;
CREATE TRIGGER admin_bootstrap_commands_no_update BEFORE UPDATE ON admin_bootstrap_commands
BEGIN SELECT RAISE(ABORT,'admin_bootstrap_commands_immutable'); END;
CREATE TRIGGER admin_bootstrap_commands_no_delete BEFORE DELETE ON admin_bootstrap_commands
BEGIN SELECT RAISE(ABORT,'admin_bootstrap_commands_immutable'); END;
