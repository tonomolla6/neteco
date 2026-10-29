-- No campaign, activation or redemption is seeded. Commands and audit are
-- append-only; pause/resume is another immutable rule version, never deletion.
CREATE TABLE promotion_admin_commands (
 command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
 rule_id TEXT NOT NULL REFERENCES promotion_rules(id),
 actor_id TEXT NOT NULL REFERENCES identities(id),
 session_id TEXT NOT NULL REFERENCES auth_sessions(id), session_version INTEGER NOT NULL CHECK(session_version>=1),
 expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 applied_version INTEGER NOT NULL CHECK(applied_version=expected_version+1),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 rule_hash TEXT NOT NULL CHECK(length(rule_hash)=64 AND rule_hash NOT GLOB '*[^0-9a-f]*'),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 500),
 created_at TEXT NOT NULL,
 FOREIGN KEY(rule_id,applied_version) REFERENCES promotion_rule_versions(rule_id,version),
 UNIQUE(rule_id,applied_version)
) STRICT;
CREATE TABLE promotion_admin_audit (
 command_id TEXT PRIMARY KEY REFERENCES promotion_admin_commands(command_id),
 rule_id TEXT NOT NULL, version INTEGER NOT NULL,
 actor_id TEXT NOT NULL, rule_hash TEXT NOT NULL, payload_hash TEXT NOT NULL,
 reason TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER promotion_admin_audit_matches BEFORE INSERT ON promotion_admin_audit
WHEN NOT EXISTS(SELECT 1 FROM promotion_admin_commands c WHERE c.command_id=NEW.command_id
 AND c.rule_id=NEW.rule_id AND c.applied_version=NEW.version AND c.actor_id=NEW.actor_id
 AND c.rule_hash=NEW.rule_hash AND c.payload_hash=NEW.payload_hash
 AND c.reason=NEW.reason AND c.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'promotion_admin_audit_mismatch'); END;
CREATE TRIGGER promotion_admin_commands_no_update BEFORE UPDATE ON promotion_admin_commands
BEGIN SELECT RAISE(ABORT,'promotion_admin_command_immutable'); END;
CREATE TRIGGER promotion_admin_commands_no_delete BEFORE DELETE ON promotion_admin_commands
BEGIN SELECT RAISE(ABORT,'promotion_admin_command_immutable'); END;
CREATE TRIGGER promotion_admin_commands_no_replace BEFORE INSERT ON promotion_admin_commands
WHEN EXISTS(SELECT 1 FROM promotion_admin_commands WHERE command_id=NEW.command_id OR (rule_id=NEW.rule_id AND applied_version=NEW.applied_version))
BEGIN SELECT RAISE(ABORT,'promotion_admin_command_immutable'); END;
CREATE TRIGGER promotion_admin_audit_no_update BEFORE UPDATE ON promotion_admin_audit
BEGIN SELECT RAISE(ABORT,'promotion_admin_audit_immutable'); END;
CREATE TRIGGER promotion_admin_audit_no_delete BEFORE DELETE ON promotion_admin_audit
BEGIN SELECT RAISE(ABORT,'promotion_admin_audit_immutable'); END;
CREATE TRIGGER promotion_admin_audit_no_replace BEFORE INSERT ON promotion_admin_audit
WHEN EXISTS(SELECT 1 FROM promotion_admin_audit WHERE command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'promotion_admin_audit_immutable'); END;
CREATE TABLE promotion_admin_guards(command_id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1)) STRICT;
