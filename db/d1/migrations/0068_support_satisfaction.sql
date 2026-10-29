-- Optional CSAT. No stock, money, support-state or delivery-state transitions.
-- Private comments are separate from the immutable command and can be redacted.
CREATE TABLE support_satisfaction_commands (
 command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
 customer_id TEXT NOT NULL REFERENCES customers(id),
 actor_id TEXT NOT NULL REFERENCES identities(id),
 kind TEXT NOT NULL CHECK(kind IN('support','delivery')),
 target_id TEXT NOT NULL CHECK((kind='support' AND length(target_id)=28 AND target_id GLOB 'SOP-*') OR (kind='delivery' AND length(target_id)=36)),
 source_id TEXT NOT NULL,
 source_version INTEGER NOT NULL CHECK(source_version BETWEEN 1 AND 9007199254740991),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
 score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
 comment_hash TEXT NOT NULL CHECK(length(comment_hash)=64 AND comment_hash NOT GLOB '*[^a-f0-9]*'),
 policy TEXT NOT NULL CHECK(json_valid(policy) AND json_type(policy)='object'),
 policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64 AND policy_hash NOT GLOB '*[^a-f0-9]*'),
 retention_until TEXT NOT NULL CHECK(retention_until=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',retention_until),'')),
 category TEXT CHECK(category IN('product','order','shipping','payment','invoice','return','account','other')),
 shipping_method TEXT CHECK(shipping_method IN('pickup','own_delivery','parcel')),
 submitted_at TEXT NOT NULL CHECK(submitted_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',submitted_at),'') AND submitted_at<retention_until),
 UNIQUE(kind,target_id,customer_id), UNIQUE(command_id,customer_id)
) STRICT;
CREATE TABLE support_satisfaction_feedback (
 command_id TEXT PRIMARY KEY REFERENCES support_satisfaction_commands(command_id),
 customer_id TEXT NOT NULL REFERENCES customers(id),
 kind TEXT NOT NULL CHECK(kind IN('support','delivery')),
 target_id TEXT NOT NULL,
 score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
 comment TEXT CHECK(comment IS NULL OR (length(comment) BETWEEN 1 AND 1000 AND comment=trim(comment))),
 comment_hash TEXT NOT NULL CHECK(length(comment_hash)=64 AND comment_hash NOT GLOB '*[^a-f0-9]*'),
 submitted_at TEXT NOT NULL,
 retention_until TEXT NOT NULL,
 UNIQUE(kind,target_id,customer_id),
 FOREIGN KEY(command_id,customer_id) REFERENCES support_satisfaction_commands(command_id,customer_id)
) STRICT;
CREATE INDEX support_satisfaction_segment ON support_satisfaction_commands(kind,score,submitted_at,command_id);
CREATE INDEX support_satisfaction_retention ON support_satisfaction_feedback(retention_until,command_id);
CREATE TRIGGER support_satisfaction_commands_no_update BEFORE UPDATE ON support_satisfaction_commands
BEGIN SELECT RAISE(ABORT,'support_satisfaction_immutable'); END;
CREATE TRIGGER support_satisfaction_commands_no_delete BEFORE DELETE ON support_satisfaction_commands
BEGIN SELECT RAISE(ABORT,'support_satisfaction_immutable'); END;
CREATE TRIGGER support_satisfaction_feedback_proof BEFORE INSERT ON support_satisfaction_feedback
WHEN NOT EXISTS(SELECT 1 FROM support_satisfaction_commands c WHERE c.command_id=NEW.command_id
 AND c.customer_id=NEW.customer_id AND c.kind=NEW.kind AND c.target_id=NEW.target_id
 AND c.score=NEW.score AND c.comment_hash=NEW.comment_hash AND c.submitted_at=NEW.submitted_at AND c.retention_until=NEW.retention_until)
BEGIN SELECT RAISE(ABORT,'support_satisfaction_unconfirmed'); END;
CREATE TRIGGER support_satisfaction_feedback_redact_only BEFORE UPDATE ON support_satisfaction_feedback
WHEN NEW.command_id IS NOT OLD.command_id OR NEW.customer_id IS NOT OLD.customer_id OR NEW.kind IS NOT OLD.kind
 OR NEW.target_id IS NOT OLD.target_id OR NEW.score IS NOT OLD.score OR NEW.comment_hash IS NOT OLD.comment_hash
 OR NEW.submitted_at IS NOT OLD.submitted_at OR NEW.retention_until IS NOT OLD.retention_until OR NEW.comment IS NOT NULL
BEGIN SELECT RAISE(ABORT,'support_satisfaction_redaction_only'); END;
CREATE TRIGGER support_satisfaction_feedback_no_delete BEFORE DELETE ON support_satisfaction_feedback
BEGIN SELECT RAISE(ABORT,'support_satisfaction_immutable'); END;
CREATE TABLE support_satisfaction_guards(id TEXT PRIMARY KEY,satisfied INTEGER NOT NULL CHECK(satisfied=1)) STRICT;
