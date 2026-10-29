-- Empty governed library: no fabricated operational or legal approval.
CREATE TABLE support_macro_commands (
 id TEXT PRIMARY KEY CHECK(length(id)=36), macro_id TEXT NOT NULL CHECK(length(macro_id)=36),
 actor_id TEXT NOT NULL REFERENCES identities(id), idempotency_key TEXT NOT NULL,
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 action TEXT NOT NULL CHECK(action IN ('draft','approve','withdraw')),
 expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 version INTEGER NOT NULL CHECK(version=expected_version+1),
 state TEXT NOT NULL CHECK(state IN ('draft','approved','withdrawn')),
 input TEXT NOT NULL CHECK(json_valid(input)), snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
 response TEXT NOT NULL CHECK(COALESCE(json_valid(response) AND json_extract(response,'$.commandId')=id
  AND json_extract(response,'$.macroId')=macro_id AND json_extract(response,'$.version')=version
  AND json_extract(response,'$.state')=state,0)),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(actor_id,idempotency_key), UNIQUE(macro_id,version),
 CHECK((action='draft' AND state='draft') OR (action='approve' AND state='approved') OR (action='withdraw' AND state='withdrawn')),
 CHECK(state<>'approved' OR COALESCE(json_type(snapshot,'$.review')='object'
   AND length(json_extract(snapshot,'$.review.operationalReference'))>=3
   AND length(json_extract(snapshot,'$.review.legalReference'))>=3
   AND json_extract(snapshot,'$.review.reviewedAt')<=created_at
   AND json_extract(snapshot,'$.review.expiresAt')>created_at,0))
) STRICT;
CREATE INDEX support_macro_history ON support_macro_commands(macro_id,version DESC);
CREATE TRIGGER support_macro_cas BEFORE INSERT ON support_macro_commands
WHEN NEW.expected_version<>COALESCE((SELECT MAX(version) FROM support_macro_commands WHERE macro_id=NEW.macro_id),0)
 OR (NEW.action<>'draft' AND NEW.expected_version=0)
 OR (NEW.action='approve' AND NOT EXISTS(SELECT 1 FROM support_macro_commands WHERE macro_id=NEW.macro_id AND version=NEW.expected_version AND state='draft' AND json_extract(snapshot,'$.content')=json_extract(NEW.snapshot,'$.content')))
 OR (NEW.action='withdraw' AND NOT EXISTS(SELECT 1 FROM support_macro_commands WHERE macro_id=NEW.macro_id AND version=NEW.expected_version AND state='approved' AND snapshot=NEW.snapshot))
BEGIN SELECT RAISE(ABORT,'support_macro_version_conflict'); END;
CREATE TRIGGER support_macro_no_update BEFORE UPDATE ON support_macro_commands
BEGIN SELECT RAISE(ABORT,'support_macro_immutable'); END;
CREATE TRIGGER support_macro_no_delete BEFORE DELETE ON support_macro_commands
BEGIN SELECT RAISE(ABORT,'support_macro_immutable'); END;
-- Bind a new reply to a still-current reviewed revision at the same D1 commit.
-- Replaying an already committed command never performs another insert.
CREATE TRIGGER support_reply_macro_active BEFORE INSERT ON support_commands
WHEN json_type(NEW.input,'$.macro') IS NOT NULL AND (
 NEW.action<>'reply' OR NEW.actor_type<>'admin'
 OR COALESCE(json_extract(NEW.input,'$.macro.confirmed'),0)<>1
 OR NOT EXISTS(SELECT 1 FROM support_macro_commands m
   WHERE m.id=json_extract(NEW.input,'$.macro.revisionId')
   AND m.macro_id=json_extract(NEW.input,'$.macro.macroId') AND m.state='approved'
   AND m.version=(SELECT MAX(version) FROM support_macro_commands WHERE macro_id=m.macro_id)
   AND json_extract(m.snapshot,'$.review.expiresAt')>NEW.created_at))
BEGIN SELECT RAISE(ABORT,'support_macro_unavailable'); END;
