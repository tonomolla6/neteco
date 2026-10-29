-- Separate immutable administrative reviews; 0019 remains submitted-only.
CREATE TABLE company_admin_review_commands (
 command_id TEXT PRIMARY KEY CHECK(length(command_id)=36), company_id TEXT NOT NULL REFERENCES companies(id),
 actor_id TEXT NOT NULL REFERENCES identities(id), session_id TEXT NOT NULL REFERENCES auth_sessions(id),
 session_version INTEGER NOT NULL CHECK(session_version>0),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
 expected_change_id TEXT, from_status TEXT NOT NULL CHECK(from_status IN('pending','approved','rejected','suspended')),
 to_status TEXT NOT NULL CHECK(to_status IN('pending','approved','rejected','suspended')),
 reason TEXT NOT NULL CHECK(reason=trim(reason) AND length(reason) BETWEEN 3 AND 500),
 tax_id_suffix TEXT CHECK(tax_id_suffix IS NULL OR length(tax_id_suffix) BETWEEN 1 AND 4),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 CHECK(from_status=to_status OR (from_status='pending' AND to_status IN('approved','rejected'))
 OR(from_status='approved' AND to_status='suspended') OR(from_status='rejected' AND to_status='pending')
 OR(from_status='suspended' AND to_status IN('pending','approved')))
) STRICT;
CREATE INDEX company_admin_review_company_time ON company_admin_review_commands(company_id,created_at,command_id);
CREATE TRIGGER company_admin_review_no_update BEFORE UPDATE ON company_admin_review_commands
BEGIN SELECT RAISE(ABORT,'company_review_immutable'); END;
CREATE TRIGGER company_admin_review_no_delete BEFORE DELETE ON company_admin_review_commands
BEGIN SELECT RAISE(ABORT,'company_review_immutable'); END;
CREATE TRIGGER company_admin_review_guard BEFORE INSERT ON company_admin_review_commands
WHEN NOT EXISTS(SELECT 1 FROM companies c JOIN auth_sessions s ON s.id=NEW.session_id JOIN identities i ON i.id=s.identity_id
 WHERE c.id=NEW.company_id AND c.last_change_id IS NEW.expected_change_id AND c.status=NEW.from_status
 AND c.updated_at<=NEW.created_at AND(NEW.to_status<>'approved' OR c.tax_id IS NOT NULL)
 AND i.id=NEW.actor_id AND s.session_version=NEW.session_version AND i.session_version=s.session_version
 AND i.status IN('pending','active') AND s.revoked_at IS NULL AND s.created_at<=NEW.created_at AND s.expires_at>NEW.created_at
 AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.created_at AND s.mfa_verified=1
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=NEW.created_at
 AND(r.expires_at IS NULL OR r.expires_at>NEW.created_at)))
BEGIN SELECT RAISE(ABORT,'company_review_conflict'); END;
-- The command, immutable audit and corresponding status form one atomic SQL
-- statement, including when the D1 batch response is lost after commit.
CREATE TRIGGER company_admin_review_apply AFTER INSERT ON company_admin_review_commands
BEGIN
 UPDATE companies SET status=NEW.to_status,last_change_id=NEW.command_id,updated_at=NEW.created_at
 WHERE id=NEW.company_id AND last_change_id IS NEW.expected_change_id AND status=NEW.from_status;
 SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'company_review_conflict') END;
END;
