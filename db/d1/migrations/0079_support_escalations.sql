-- Empty internal library: a customer-reply macro grants no operational approval.
CREATE TABLE support_escalation_commands (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 target_kind TEXT NOT NULL CHECK(target_kind IN ('runbook','escalation')),
 target_id TEXT NOT NULL, ticket_id TEXT REFERENCES support_tickets(id),
 actor_id TEXT NOT NULL REFERENCES identities(id),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 action TEXT NOT NULL CHECK(action IN ('draft','approve','withdraw','handoff','update','resolve')),
 expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 version INTEGER NOT NULL CHECK(version=expected_version+1),
 input TEXT NOT NULL CHECK(json_valid(input)), snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
 response TEXT NOT NULL CHECK(COALESCE(json_valid(response)
  AND json_extract(response,'$.commandId')=id AND json_extract(response,'$.targetId')=target_id
  AND json_extract(response,'$.action')=action AND json_extract(response,'$.payloadHash')=payload_hash
  AND json_extract(response,'$.expectedVersion')=expected_version AND json_extract(response,'$.version')=version
  AND json_extract(response,'$.recordedAt')=created_at,0)),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(target_kind,target_id,version),
 CHECK((target_kind='runbook' AND ticket_id IS NULL AND action IN ('draft','approve','withdraw'))
  OR (target_kind='escalation' AND ticket_id IS NOT NULL AND action IN ('handoff','update','resolve')))
) STRICT;
CREATE INDEX support_escalation_history ON support_escalation_commands(target_kind,target_id,version DESC);
CREATE TRIGGER support_escalation_cas BEFORE INSERT ON support_escalation_commands
WHEN NEW.expected_version<>COALESCE((SELECT MAX(version) FROM support_escalation_commands
 WHERE target_kind=NEW.target_kind AND target_id=NEW.target_id),0)
BEGIN SELECT RAISE(ABORT,'support_escalation_version_conflict'); END;
CREATE TRIGGER support_escalation_source BEFORE INSERT ON support_escalation_commands
WHEN NEW.target_kind='escalation' AND NOT EXISTS(
 SELECT 1 FROM support_tickets t WHERE t.id=NEW.ticket_id AND t.public_ref=NEW.target_id
 AND t.version=json_extract(NEW.input,'$.expectedTicketVersion')
 AND t.retention_until>NEW.created_at AND t.state NOT IN ('resolved','closed'))
BEGIN SELECT RAISE(ABORT,'support_escalation_ticket_conflict'); END;
CREATE TRIGGER support_escalation_runbook BEFORE INSERT ON support_escalation_commands
WHEN NEW.target_kind='escalation' AND NEW.action<>'resolve' AND NOT EXISTS(
 SELECT 1 FROM support_escalation_commands r WHERE r.target_kind='runbook'
 AND r.target_id=json_extract(NEW.input,'$.runbook.id')
 AND r.version=json_extract(NEW.input,'$.runbook.version')
 AND r.version=(SELECT MAX(version) FROM support_escalation_commands WHERE target_kind='runbook' AND target_id=r.target_id)
 AND json_extract(r.snapshot,'$.state')='approved'
 AND json_extract(r.snapshot,'$.queue')=json_extract(NEW.input,'$.queue')
 AND json_extract(r.snapshot,'$.expiresAt')>NEW.created_at)
BEGIN SELECT RAISE(ABORT,'support_escalation_runbook_unavailable'); END;
CREATE TRIGGER support_escalation_no_update BEFORE UPDATE ON support_escalation_commands
BEGIN SELECT RAISE(ABORT,'support_escalation_immutable'); END;
CREATE TRIGGER support_escalation_no_delete BEFORE DELETE ON support_escalation_commands
BEGIN SELECT RAISE(ABORT,'support_escalation_immutable'); END;
