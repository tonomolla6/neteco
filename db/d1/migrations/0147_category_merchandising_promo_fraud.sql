-- SEA-015: category merchandising by rule (stock, margin, popularity, contract and campaign signals,
-- combinable with guardrails) and SEC-036: promotional / referral fraud review and appeals.
-- Neither feature seeds any rule, case, limit or approval.
--
-- SEA-015: one append-only revision per command; the revisions are the audit trail and the durable
-- idempotency receipt. A rule always has a reason, an author and an expiry (at most 180 days).
CREATE TABLE category_merchandising_commands (
 id TEXT PRIMARY KEY CHECK(length(id)=36), actor_id TEXT NOT NULL REFERENCES identities(id),
 session_id TEXT NOT NULL REFERENCES auth_sessions(id), session_version INTEGER NOT NULL,
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 rule_id TEXT NOT NULL CHECK(length(rule_id)=36), expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 version INTEGER NOT NULL CHECK(version=expected_version+1),
 category_id TEXT NOT NULL REFERENCES categories(id),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
 valid_from TEXT NOT NULL CHECK(valid_from=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',valid_from),'')),
 valid_until TEXT NOT NULL CHECK(valid_until=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',valid_until),'')
  AND valid_until>valid_from AND valid_until<=strftime('%Y-%m-%dT%H:%M:%SZ',valid_from,'+180 days')),
 status TEXT NOT NULL CHECK(status IN('active','retired')),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), response TEXT NOT NULL CHECK(json_valid(response)),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(actor_id,idempotency_key), UNIQUE(rule_id,version)
) STRICT;
CREATE INDEX category_merchandising_category ON category_merchandising_commands(category_id,rule_id,version);
CREATE VIEW category_merchandising_current AS SELECT c.* FROM category_merchandising_commands c
 WHERE c.version=(SELECT max(latest.version) FROM category_merchandising_commands latest WHERE latest.rule_id=c.rule_id);
CREATE TRIGGER category_merchandising_append_only_update BEFORE UPDATE ON category_merchandising_commands
BEGIN SELECT RAISE(ABORT,'category_merchandising_append_only'); END;
CREATE TRIGGER category_merchandising_append_only_delete BEFORE DELETE ON category_merchandising_commands
BEGIN SELECT RAISE(ABORT,'category_merchandising_append_only'); END;
-- The writer must still hold catalog.write with MFA when the row lands, not only when it was validated.
CREATE TRIGGER category_merchandising_authority BEFORE INSERT ON category_merchandising_commands
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE s.id=NEW.session_id AND s.identity_id=NEW.actor_id AND s.session_version=NEW.session_version
 AND i.session_version=s.session_version AND s.revoked_at IS NULL AND s.mfa_verified=1
 AND s.created_at<=NEW.created_at AND s.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 AND i.status IN('pending','active') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.created_at
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code='catalog.write' AND r.granted_at<=NEW.created_at
 AND(r.expires_at IS NULL OR r.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')))))
BEGIN SELECT RAISE(ABORT,'category_merchandising_authority_changed'); END;
CREATE TRIGGER category_merchandising_guard BEFORE INSERT ON category_merchandising_commands
WHEN json_extract(NEW.snapshot,'$.id') IS NOT NEW.rule_id
 OR json_extract(NEW.snapshot,'$.version') IS NOT NEW.version
 OR json_extract(NEW.snapshot,'$.status') IS NOT NEW.status
 OR json_extract(NEW.snapshot,'$.categoryId') IS NOT NEW.category_id
 OR json_extract(NEW.snapshot,'$.reason') IS NOT NEW.reason
 OR json_extract(NEW.snapshot,'$.validFrom') IS NOT NEW.valid_from
 OR json_extract(NEW.snapshot,'$.validUntil') IS NOT NEW.valid_until
 OR json_extract(NEW.snapshot,'$.authorId') IS NOT NEW.actor_id
 OR json_type(NEW.snapshot,'$.weights')<>'object' OR json_type(NEW.snapshot,'$.guardrails')<>'object'
BEGIN SELECT RAISE(ABORT,'category_merchandising_snapshot_mismatch'); END;
-- CAS: a revision must follow the current, non-retired revision of the same rule, and cannot change its category.
CREATE TRIGGER category_merchandising_version_chain BEFORE INSERT ON category_merchandising_commands
WHEN NEW.expected_version>0 AND NOT EXISTS(SELECT 1 FROM category_merchandising_current c
 WHERE c.rule_id=NEW.rule_id AND c.version=NEW.expected_version AND c.status='active' AND c.category_id=NEW.category_id)
BEGIN SELECT RAISE(ABORT,'category_merchandising_version_conflict'); END;
-- At most one active rule per category over any period of time, so the order is never ambiguous.
CREATE TRIGGER category_merchandising_no_overlap BEFORE INSERT ON category_merchandising_commands
WHEN NEW.status='active' AND EXISTS(SELECT 1 FROM category_merchandising_current c
 WHERE c.category_id=NEW.category_id AND c.status='active' AND c.rule_id<>NEW.rule_id
 AND c.valid_from<NEW.valid_until AND c.valid_until>NEW.valid_from)
BEGIN SELECT RAISE(ABORT,'category_merchandising_rule_conflict'); END;

-- SEC-036: promotional / referral fraud controls. Signals are keyed pseudonyms (HMAC with a server
-- pepper), never raw identity, address, device or payment data. A single exceeded signal only asks for
-- review; a hold needs at least two independent signal kinds. Every decision is reviewable and appealable
-- and every state change leaves an append-only event. No case, limit or approval is seeded.
CREATE TABLE promo_fraud_cases (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 command_id TEXT NOT NULL UNIQUE CHECK(length(command_id)=36),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 context TEXT NOT NULL CHECK(context IN('referral','promotion')),
 ref_id TEXT NOT NULL CHECK(length(ref_id) BETWEEN 1 AND 120 AND ref_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
 customer_id TEXT NOT NULL REFERENCES customers(id),
 decision TEXT NOT NULL CHECK(decision IN('clear','review','hold')),
 score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
 exceeded_kinds TEXT NOT NULL CHECK(json_valid(exceeded_kinds) AND json_type(exceeded_kinds)='array'),
 shared_counts TEXT NOT NULL CHECK(json_valid(shared_counts) AND json_type(shared_counts)='object'),
 status TEXT NOT NULL CHECK(status IN('closed','open','released','upheld','appealed','appeal_accepted','appeal_rejected')),
 version INTEGER NOT NULL CHECK(version>=1),
 decided_by TEXT REFERENCES identities(id),
 decided_at TEXT CHECK(decided_at IS NULL OR decided_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',decided_at),'')),
 decision_note TEXT CHECK(decision_note IS NULL OR length(trim(decision_note)) BETWEEN 3 AND 1000),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'') AND updated_at>=created_at),
 CHECK((decision='clear')=(status='closed')),
 CHECK(decision<>'review' OR json_array_length(exceeded_kinds)=1),
 CHECK(decision<>'hold' OR json_array_length(exceeded_kinds)>=2),
 CHECK(decision<>'clear' OR json_array_length(exceeded_kinds)=0),
 UNIQUE(context,ref_id)
) STRICT;
CREATE INDEX promo_fraud_cases_queue ON promo_fraud_cases(status,created_at);
CREATE INDEX promo_fraud_cases_customer ON promo_fraud_cases(customer_id,created_at);

CREATE TABLE promo_fraud_signals (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 case_id TEXT NOT NULL REFERENCES promo_fraud_cases(id),
 customer_id TEXT NOT NULL REFERENCES customers(id),
 kind TEXT NOT NULL CHECK(kind IN('identity','address','device','payment')),
 signal_hash TEXT NOT NULL CHECK(length(signal_hash)=64 AND signal_hash NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(case_id,kind)
) STRICT;
CREATE INDEX promo_fraud_signals_lookup ON promo_fraud_signals(kind,signal_hash,created_at);

CREATE TABLE promo_fraud_appeals (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 case_id TEXT NOT NULL UNIQUE REFERENCES promo_fraud_cases(id),
 customer_id TEXT NOT NULL REFERENCES customers(id),
 statement TEXT NOT NULL CHECK(length(trim(statement)) BETWEEN 10 AND 1000),
 status TEXT NOT NULL CHECK(status IN('pending','accepted','rejected')),
 resolved_by TEXT REFERENCES identities(id),
 resolved_at TEXT CHECK(resolved_at IS NULL OR resolved_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',resolved_at),'')),
 resolution_note TEXT CHECK(resolution_note IS NULL OR length(trim(resolution_note)) BETWEEN 3 AND 1000),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 CHECK((status='pending')=(resolved_by IS NULL AND resolved_at IS NULL AND resolution_note IS NULL))
) STRICT;

CREATE TABLE promo_fraud_events (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 case_id TEXT NOT NULL REFERENCES promo_fraud_cases(id),
 action TEXT NOT NULL CHECK(action IN('assessed','released','upheld','appeal_submitted','appeal_accepted','appeal_rejected')),
 actor_identity_id TEXT REFERENCES identities(id),
 detail TEXT NOT NULL CHECK(json_valid(detail)),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE INDEX promo_fraud_events_case ON promo_fraud_events(case_id,created_at);
CREATE TRIGGER promo_fraud_events_no_update BEFORE UPDATE ON promo_fraud_events
BEGIN SELECT RAISE(ABORT,'promo_fraud_events_append_only'); END;
CREATE TRIGGER promo_fraud_events_no_delete BEFORE DELETE ON promo_fraud_events
BEGIN SELECT RAISE(ABORT,'promo_fraud_events_append_only'); END;
CREATE TRIGGER promo_fraud_cases_no_delete BEFORE DELETE ON promo_fraud_cases
BEGIN SELECT RAISE(ABORT,'promo_fraud_cases_no_delete'); END;
CREATE TRIGGER promo_fraud_appeals_no_delete BEFORE DELETE ON promo_fraud_appeals
BEGIN SELECT RAISE(ABORT,'promo_fraud_appeals_no_delete'); END;

-- Case identity and the assessed facts are immutable; the version moves by exactly one and only along
-- the allowed state machine, so no writer can skip review or reopen a final decision.
CREATE TRIGGER promo_fraud_cases_update_guard BEFORE UPDATE ON promo_fraud_cases
WHEN NEW.id IS NOT OLD.id OR NEW.command_id IS NOT OLD.command_id OR NEW.payload_hash IS NOT OLD.payload_hash
 OR NEW.context IS NOT OLD.context OR NEW.ref_id IS NOT OLD.ref_id OR NEW.customer_id IS NOT OLD.customer_id
 OR NEW.decision IS NOT OLD.decision OR NEW.score IS NOT OLD.score OR NEW.exceeded_kinds IS NOT OLD.exceeded_kinds
 OR NEW.shared_counts IS NOT OLD.shared_counts OR NEW.created_at IS NOT OLD.created_at
 OR NEW.version<>OLD.version+1
 OR NOT ((OLD.status='open' AND NEW.status IN('released','upheld'))
  OR (OLD.status IN('open','upheld') AND NEW.status='appealed')
  OR (OLD.status='appealed' AND NEW.status IN('appeal_accepted','appeal_rejected')))
BEGIN SELECT RAISE(ABORT,'promo_fraud_case_transition_invalid'); END;
CREATE TRIGGER promo_fraud_appeals_update_guard BEFORE UPDATE ON promo_fraud_appeals
WHEN NEW.id IS NOT OLD.id OR NEW.case_id IS NOT OLD.case_id OR NEW.customer_id IS NOT OLD.customer_id
 OR NEW.statement IS NOT OLD.statement OR NEW.created_at IS NOT OLD.created_at OR OLD.status<>'pending'
BEGIN SELECT RAISE(ABORT,'promo_fraud_appeal_transition_invalid'); END;
-- An appeal exists only for a case that is actually appealable, and only for its own customer.
CREATE TRIGGER promo_fraud_appeals_insert_guard BEFORE INSERT ON promo_fraud_appeals
WHEN NOT EXISTS(SELECT 1 FROM promo_fraud_cases c WHERE c.id=NEW.case_id AND c.customer_id=NEW.customer_id
 AND (c.status='upheld' OR (c.status='open' AND c.decision='hold')))
BEGIN SELECT RAISE(ABORT,'promo_fraud_appeal_not_allowed'); END;
