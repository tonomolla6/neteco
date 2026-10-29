-- CUS-015 preference centre, CUS-016 company documents, CUS-019 replenishment
-- reminders and CUS-028 support impersonation. Additive; no provider calls.

-- ===== CUS-015: frequency, topics, sectors and channels with ESP/CMP sync jobs =====
CREATE TABLE preference_center_commands (
 customer_id TEXT NOT NULL REFERENCES customers(id),
 command_id TEXT NOT NULL CHECK(length(command_id)=36),
 actor_id TEXT NOT NULL REFERENCES identities(id),
 session_id TEXT NOT NULL REFERENCES auth_sessions(id),
 session_version INTEGER NOT NULL CHECK(session_version>0),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
 expected_version INTEGER NOT NULL CHECK(expected_version BETWEEN 0 AND 9007199254740989),
 applied_version INTEGER NOT NULL CHECK(applied_version=expected_version+1),
 frequency TEXT NOT NULL CHECK(frequency IN('weekly','biweekly','monthly','quarterly','never')),
 topics TEXT NOT NULL CHECK(json_valid(topics) AND json_type(topics)='array'),
 sectors TEXT NOT NULL CHECK(json_valid(sectors) AND json_type(sectors)='array'),
 channel_email INTEGER NOT NULL CHECK(channel_email IN(0,1)),
 channel_sms INTEGER NOT NULL CHECK(channel_sms IN(0,1)),
 channel_push INTEGER NOT NULL CHECK(channel_push IN(0,1)),
 unsubscribe_all INTEGER NOT NULL CHECK(unsubscribe_all IN(0,1)),
 policy_version TEXT NOT NULL CHECK(policy_version='preference-center-2026-10-29'),
 recorded_at TEXT NOT NULL CHECK(recorded_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',recorded_at),'')),
 PRIMARY KEY(customer_id,command_id), UNIQUE(customer_id,applied_version),
 CHECK(unsubscribe_all=0 OR(frequency='never' AND channel_email=0 AND channel_sms=0 AND channel_push=0 AND topics='[]' AND sectors='[]')),
 CHECK(topics='[]' OR(frequency<>'never' AND channel_email+channel_sms+channel_push>0))
) STRICT;
CREATE TABLE customer_preference_center (
 customer_id TEXT PRIMARY KEY REFERENCES customers(id),
 version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740990),
 frequency TEXT NOT NULL CHECK(frequency IN('weekly','biweekly','monthly','quarterly','never')),
 topics TEXT NOT NULL CHECK(json_valid(topics)), sectors TEXT NOT NULL CHECK(json_valid(sectors)),
 channel_email INTEGER NOT NULL CHECK(channel_email IN(0,1)), channel_sms INTEGER NOT NULL CHECK(channel_sms IN(0,1)),
 channel_push INTEGER NOT NULL CHECK(channel_push IN(0,1)), unsubscribe_all INTEGER NOT NULL CHECK(unsubscribe_all IN(0,1)),
 updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'')),
 command_id TEXT NOT NULL,
 FOREIGN KEY(customer_id,command_id) REFERENCES preference_center_commands(customer_id,command_id)
) STRICT;
-- One job per downstream system and applied version; the newest version wins.
CREATE TABLE preference_center_sync_jobs (
 id TEXT PRIMARY KEY CHECK(length(id)>=40),
 customer_id TEXT NOT NULL REFERENCES customers(id), command_id TEXT NOT NULL, applied_version INTEGER NOT NULL CHECK(applied_version>=1),
 target TEXT NOT NULL CHECK(target IN('esp','cmp')),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','synced','failed','superseded')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 20),
 next_attempt_at TEXT NOT NULL CHECK(next_attempt_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',next_attempt_at),'')),
 last_error_code TEXT CHECK(last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 80),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'')),
 UNIQUE(customer_id,command_id,target),
 FOREIGN KEY(customer_id,command_id) REFERENCES preference_center_commands(customer_id,command_id)
) STRICT;
CREATE INDEX preference_center_sync_due ON preference_center_sync_jobs(status,next_attempt_at,id);
CREATE TRIGGER preference_center_command_no_update BEFORE UPDATE ON preference_center_commands
BEGIN SELECT RAISE(ABORT,'preference_center_immutable'); END;
CREATE TRIGGER preference_center_command_no_delete BEFORE DELETE ON preference_center_commands
BEGIN SELECT RAISE(ABORT,'preference_center_immutable'); END;
CREATE TRIGGER preference_center_snapshot_no_delete BEFORE DELETE ON customer_preference_center
BEGIN SELECT RAISE(ABORT,'preference_center_immutable'); END;
CREATE TRIGGER preference_center_command_guard BEFORE INSERT ON preference_center_commands
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id JOIN customers c ON c.id=i.customer_id
 WHERE i.id=NEW.actor_id AND c.id=NEW.customer_id AND c.status='active' AND i.status='active'
 AND s.id=NEW.session_id AND s.session_version=NEW.session_version AND i.session_version=s.session_version
 AND s.revoked_at IS NULL AND s.created_at<=NEW.recorded_at AND s.expires_at>NEW.recorded_at
 AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.recorded_at
 AND(s.mfa_verified=1 OR NOT EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id=i.id AND m.verified_at IS NOT NULL))
 AND COALESCE((SELECT version FROM customer_preference_center WHERE customer_id=c.id),0)=NEW.expected_version)
BEGIN SELECT RAISE(ABORT,'preference_center_conflict'); END;
CREATE TRIGGER preference_center_command_apply AFTER INSERT ON preference_center_commands
BEGIN
 INSERT INTO customer_preference_center(customer_id,version,frequency,topics,sectors,channel_email,channel_sms,channel_push,unsubscribe_all,updated_at,command_id)
 VALUES(NEW.customer_id,NEW.applied_version,NEW.frequency,NEW.topics,NEW.sectors,NEW.channel_email,NEW.channel_sms,NEW.channel_push,NEW.unsubscribe_all,NEW.recorded_at,NEW.command_id)
 ON CONFLICT(customer_id) DO UPDATE SET version=excluded.version,frequency=excluded.frequency,topics=excluded.topics,sectors=excluded.sectors,
 channel_email=excluded.channel_email,channel_sms=excluded.channel_sms,channel_push=excluded.channel_push,unsubscribe_all=excluded.unsubscribe_all,
 updated_at=excluded.updated_at,command_id=excluded.command_id;
 UPDATE preference_center_sync_jobs SET status='superseded',updated_at=NEW.recorded_at
 WHERE customer_id=NEW.customer_id AND status IN('pending','failed') AND applied_version<NEW.applied_version;
 INSERT INTO preference_center_sync_jobs(id,customer_id,command_id,applied_version,target,next_attempt_at,created_at,updated_at)
 VALUES('esp:'||NEW.customer_id||':'||NEW.applied_version,NEW.customer_id,NEW.command_id,NEW.applied_version,'esp',NEW.recorded_at,NEW.recorded_at,NEW.recorded_at),
 ('cmp:'||NEW.customer_id||':'||NEW.applied_version,NEW.customer_id,NEW.command_id,NEW.applied_version,'cmp',NEW.recorded_at,NEW.recorded_at,NEW.recorded_at);
END;

-- ===== CUS-019: configurable replenishment plans and capped reminders =====
CREATE TABLE replenishment_plan_commands (
 customer_id TEXT NOT NULL REFERENCES customers(id),
 command_id TEXT NOT NULL CHECK(length(command_id)=36),
 actor_id TEXT NOT NULL REFERENCES identities(id),
 session_id TEXT NOT NULL REFERENCES auth_sessions(id),
 session_version INTEGER NOT NULL CHECK(session_version>0),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
 plan_id TEXT NOT NULL CHECK(length(plan_id)=36),
 variant_id TEXT NOT NULL REFERENCES variants(id),
 action TEXT NOT NULL CHECK(action IN('save','pause','resume','cancel')),
 expected_version INTEGER NOT NULL CHECK(expected_version BETWEEN 0 AND 9007199254740989),
 applied_version INTEGER NOT NULL CHECK(applied_version=expected_version+1),
 source TEXT NOT NULL CHECK(source IN('history','declared')),
 interval_days INTEGER NOT NULL CHECK(interval_days BETWEEN 7 AND 365),
 status TEXT NOT NULL CHECK(status IN('active','paused','cancelled')),
 next_due_at TEXT NOT NULL CHECK(next_due_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',next_due_at),'')),
 recorded_at TEXT NOT NULL CHECK(recorded_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',recorded_at),'')),
 PRIMARY KEY(customer_id,command_id), UNIQUE(plan_id,applied_version)
) STRICT;
CREATE TABLE replenishment_plans (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 customer_id TEXT NOT NULL REFERENCES customers(id), variant_id TEXT NOT NULL REFERENCES variants(id),
 source TEXT NOT NULL CHECK(source IN('history','declared')),
 interval_days INTEGER NOT NULL CHECK(interval_days BETWEEN 7 AND 365),
 status TEXT NOT NULL CHECK(status IN('active','paused','cancelled')),
 next_due_at TEXT NOT NULL CHECK(next_due_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',next_due_at),'')),
 last_reminded_at TEXT CHECK(last_reminded_at IS NULL OR last_reminded_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',last_reminded_at),'')),
 version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740990),
 command_id TEXT NOT NULL,
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'')),
 UNIQUE(customer_id,variant_id),
 FOREIGN KEY(customer_id,command_id) REFERENCES replenishment_plan_commands(customer_id,command_id)
) STRICT;
CREATE INDEX replenishment_plans_due ON replenishment_plans(status,next_due_at,id);
CREATE TABLE replenishment_reminders (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 plan_id TEXT NOT NULL REFERENCES replenishment_plans(id),
 customer_id TEXT NOT NULL REFERENCES customers(id), variant_id TEXT NOT NULL REFERENCES variants(id),
 due_at TEXT NOT NULL CHECK(due_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',due_at),'')),
 status TEXT NOT NULL CHECK(status IN('queued','suppressed')),
 suppression_reason TEXT CHECK(suppression_reason IN('no_consent','email_channel_off','unsubscribed_all','purchased_since')),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(plan_id,due_at),
 CHECK((status='suppressed')=(suppression_reason IS NOT NULL))
) STRICT;
CREATE INDEX replenishment_reminders_customer ON replenishment_reminders(customer_id,status,created_at);
CREATE TRIGGER replenishment_plan_command_no_update BEFORE UPDATE ON replenishment_plan_commands
BEGIN SELECT RAISE(ABORT,'replenishment_immutable'); END;
CREATE TRIGGER replenishment_plan_command_no_delete BEFORE DELETE ON replenishment_plan_commands
BEGIN SELECT RAISE(ABORT,'replenishment_immutable'); END;
CREATE TRIGGER replenishment_plan_no_delete BEFORE DELETE ON replenishment_plans
BEGIN SELECT RAISE(ABORT,'replenishment_immutable'); END;
CREATE TRIGGER replenishment_reminder_no_update BEFORE UPDATE ON replenishment_reminders
BEGIN SELECT RAISE(ABORT,'replenishment_immutable'); END;
CREATE TRIGGER replenishment_reminder_no_delete BEFORE DELETE ON replenishment_reminders
BEGIN SELECT RAISE(ABORT,'replenishment_immutable'); END;
-- Frequency cap: at most one queued reminder per customer in any 7 day window.
CREATE TRIGGER replenishment_reminder_cap BEFORE INSERT ON replenishment_reminders
WHEN NEW.status='queued' AND EXISTS(SELECT 1 FROM replenishment_reminders r WHERE r.customer_id=NEW.customer_id AND r.status='queued'
 AND r.created_at>strftime('%Y-%m-%dT%H:%M:%SZ',NEW.created_at,'-7 days'))
BEGIN SELECT RAISE(ABORT,'reminder_frequency_cap'); END;
CREATE TRIGGER replenishment_plan_command_guard BEFORE INSERT ON replenishment_plan_commands
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id JOIN customers c ON c.id=i.customer_id
 WHERE i.id=NEW.actor_id AND c.id=NEW.customer_id AND c.status='active' AND i.status='active'
 AND s.id=NEW.session_id AND s.session_version=NEW.session_version AND i.session_version=s.session_version
 AND s.revoked_at IS NULL AND s.created_at<=NEW.recorded_at AND s.expires_at>NEW.recorded_at
 AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.recorded_at
 AND(s.mfa_verified=1 OR NOT EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id=i.id AND m.verified_at IS NOT NULL))
 AND COALESCE((SELECT version FROM replenishment_plans WHERE customer_id=c.id AND variant_id=NEW.variant_id),0)=NEW.expected_version
 AND COALESCE((SELECT id FROM replenishment_plans WHERE customer_id=c.id AND variant_id=NEW.variant_id),NEW.plan_id)=NEW.plan_id)
BEGIN SELECT RAISE(ABORT,'replenishment_conflict'); END;
CREATE TRIGGER replenishment_plan_command_apply AFTER INSERT ON replenishment_plan_commands
BEGIN
 INSERT INTO replenishment_plans(id,customer_id,variant_id,source,interval_days,status,next_due_at,version,command_id,created_at,updated_at)
 VALUES(NEW.plan_id,NEW.customer_id,NEW.variant_id,NEW.source,NEW.interval_days,NEW.status,NEW.next_due_at,NEW.applied_version,NEW.command_id,NEW.recorded_at,NEW.recorded_at)
 ON CONFLICT(customer_id,variant_id) DO UPDATE SET source=excluded.source,interval_days=excluded.interval_days,status=excluded.status,
 next_due_at=excluded.next_due_at,version=excluded.version,command_id=excluded.command_id,updated_at=excluded.updated_at;
END;

-- ===== CUS-016: optional supporting documents for a company request (metadata only) =====
CREATE TABLE company_documents (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 company_id TEXT NOT NULL REFERENCES companies(id), customer_id TEXT NOT NULL REFERENCES customers(id),
 command_id TEXT NOT NULL CHECK(length(command_id)=36),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
 kind TEXT NOT NULL CHECK(kind IN('tax_certificate','commercial_register','authorization_letter','bank_certificate','other')),
 file_name TEXT NOT NULL CHECK(length(file_name) BETWEEN 1 AND 120 AND file_name=trim(file_name) AND file_name NOT GLOB '*[/\\]*'),
 content_type TEXT NOT NULL CHECK(content_type IN('application/pdf','image/jpeg','image/png')),
 size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 10485760),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
 created_by TEXT NOT NULL REFERENCES identities(id),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 removed_at TEXT CHECK(removed_at IS NULL OR removed_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',removed_at),'')),
 removed_by TEXT REFERENCES identities(id),
 UNIQUE(company_id,command_id),
 CHECK((removed_at IS NULL)=(removed_by IS NULL))
) STRICT;
CREATE UNIQUE INDEX company_documents_active_hash ON company_documents(company_id,sha256) WHERE removed_at IS NULL;
CREATE INDEX company_documents_company ON company_documents(company_id,created_at,id);
CREATE TRIGGER company_documents_no_delete BEFORE DELETE ON company_documents
BEGIN SELECT RAISE(ABORT,'company_documents_immutable'); END;
CREATE TRIGGER company_documents_remove_only BEFORE UPDATE ON company_documents
WHEN OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL OR NEW.id<>OLD.id OR NEW.company_id<>OLD.company_id OR NEW.sha256<>OLD.sha256
 OR NEW.file_name<>OLD.file_name OR NEW.kind<>OLD.kind OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at OR NEW.removed_at<OLD.created_at
BEGIN SELECT RAISE(ABORT,'company_documents_immutable'); END;
CREATE TRIGGER company_documents_insert_guard BEFORE INSERT ON company_documents
WHEN NOT EXISTS(SELECT 1 FROM companies c JOIN identities i ON i.customer_id=c.customer_id WHERE c.id=NEW.company_id AND c.customer_id=NEW.customer_id
 AND i.id=NEW.created_by AND i.status='active' AND c.status IN('pending','rejected','suspended'))
 OR(SELECT count(*) FROM company_documents d WHERE d.company_id=NEW.company_id AND d.removed_at IS NULL)>=5
BEGIN SELECT RAISE(ABORT,'company_documents_rejected'); END;

-- ===== CUS-028: controlled support impersonation =====
INSERT OR IGNORE INTO permissions(code,resource,action,description)
 VALUES('support.impersonate','support','impersonate','Open a short, audited, banner-visible impersonation session on a ticket');
INSERT OR IGNORE INTO role_permissions(role_code,permission_code)
 SELECT code,'support.impersonate' FROM roles WHERE code IN('owner','admin');
CREATE TABLE support_impersonation_sessions (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 command_id TEXT NOT NULL CHECK(length(command_id)=36),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
 actor_id TEXT NOT NULL REFERENCES identities(id), actor_session_id TEXT NOT NULL REFERENCES auth_sessions(id),
 customer_id TEXT NOT NULL REFERENCES customers(id),
 ticket_ref TEXT NOT NULL REFERENCES support_tickets(public_ref),
 reason TEXT NOT NULL CHECK(reason=trim(reason) AND length(reason) BETWEEN 10 AND 300),
 started_at TEXT NOT NULL CHECK(started_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',started_at),'')),
 expires_at TEXT NOT NULL CHECK(expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',expires_at),'')),
 ended_at TEXT CHECK(ended_at IS NULL OR ended_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',ended_at),'')),
 ended_reason TEXT CHECK(ended_reason IN('manual','expired')),
 UNIQUE(actor_id,command_id),
 CHECK(CAST(strftime('%s',expires_at) AS INTEGER)-CAST(strftime('%s',started_at) AS INTEGER) BETWEEN 60 AND 900),
 CHECK((ended_at IS NULL)=(ended_reason IS NULL)),
 CHECK(ended_at IS NULL OR ended_at>=started_at)
) STRICT;
CREATE UNIQUE INDEX support_impersonation_one_open ON support_impersonation_sessions(actor_id) WHERE ended_at IS NULL;
CREATE TABLE support_impersonation_actions (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 session_id TEXT NOT NULL REFERENCES support_impersonation_sessions(id),
 seq INTEGER NOT NULL CHECK(seq>=1),
 command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 80),
 actor_id TEXT NOT NULL REFERENCES identities(id),
 action_code TEXT NOT NULL CHECK(length(action_code) BETWEEN 1 AND 60),
 resource TEXT CHECK(resource IS NULL OR length(resource) BETWEEN 1 AND 120),
 outcome TEXT NOT NULL CHECK(outcome IN('allowed','blocked')),
 block_reason TEXT CHECK(block_reason IS NULL OR block_reason IN('sensitive_credentials','sensitive_payment','not_permitted','session_inactive')),
 recorded_at TEXT NOT NULL CHECK(recorded_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',recorded_at),'')),
 UNIQUE(session_id,seq), UNIQUE(session_id,command_id),
 CHECK((outcome='blocked')=(block_reason IS NOT NULL))
) STRICT;
CREATE TRIGGER support_impersonation_action_no_update BEFORE UPDATE ON support_impersonation_actions
BEGIN SELECT RAISE(ABORT,'impersonation_log_immutable'); END;
CREATE TRIGGER support_impersonation_action_no_delete BEFORE DELETE ON support_impersonation_actions
BEGIN SELECT RAISE(ABORT,'impersonation_log_immutable'); END;
CREATE TRIGGER support_impersonation_no_delete BEFORE DELETE ON support_impersonation_sessions
BEGIN SELECT RAISE(ABORT,'impersonation_log_immutable'); END;
CREATE TRIGGER support_impersonation_end_only BEFORE UPDATE ON support_impersonation_sessions
WHEN OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL OR NEW.id<>OLD.id OR NEW.actor_id<>OLD.actor_id OR NEW.customer_id<>OLD.customer_id
 OR NEW.ticket_ref<>OLD.ticket_ref OR NEW.reason<>OLD.reason OR NEW.started_at<>OLD.started_at OR NEW.expires_at<>OLD.expires_at
BEGIN SELECT RAISE(ABORT,'impersonation_log_immutable'); END;
CREATE TRIGGER support_impersonation_start_guard BEFORE INSERT ON support_impersonation_sessions
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE i.id=NEW.actor_id AND s.id=NEW.actor_session_id AND i.status='active' AND s.revoked_at IS NULL AND s.mfa_verified=1
 AND s.created_at<=NEW.started_at AND s.expires_at>NEW.started_at AND i.session_version=s.session_version
 AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.started_at
 AND i.customer_id IS NOT NEW.customer_id
 AND EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id=i.id AND m.verified_at IS NOT NULL AND m.verified_at<=NEW.started_at)
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id AND p.permission_code='support.manage'
 AND r.granted_at<=NEW.started_at AND(r.expires_at IS NULL OR r.expires_at>NEW.started_at))
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id AND p.permission_code='support.impersonate'
 AND r.granted_at<=NEW.started_at AND(r.expires_at IS NULL OR r.expires_at>NEW.started_at)))
 OR NOT EXISTS(SELECT 1 FROM support_tickets t WHERE t.public_ref=NEW.ticket_ref AND t.customer_id=NEW.customer_id AND t.state NOT IN('closed'))
 OR NOT EXISTS(SELECT 1 FROM customers c WHERE c.id=NEW.customer_id AND c.status='active')
BEGIN SELECT RAISE(ABORT,'impersonation_not_authorized'); END;
CREATE TRIGGER support_impersonation_started AFTER INSERT ON support_impersonation_sessions
BEGIN
 INSERT INTO support_impersonation_actions(id,session_id,seq,command_id,actor_id,action_code,resource,outcome,recorded_at)
 VALUES(lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
 NEW.id,1,'session.start',NEW.actor_id,'session.start',NEW.ticket_ref,'allowed',NEW.started_at);
END;
CREATE TRIGGER support_impersonation_ended AFTER UPDATE OF ended_at ON support_impersonation_sessions
BEGIN
 INSERT INTO support_impersonation_actions(id,session_id,seq,command_id,actor_id,action_code,resource,outcome,recorded_at)
 VALUES(lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
 NEW.id,(SELECT COALESCE(MAX(seq),0)+1 FROM support_impersonation_actions WHERE session_id=NEW.id),'session.end',NEW.actor_id,'session.end',NEW.ticket_ref,'allowed',NEW.ended_at);
END;
CREATE TRIGGER support_impersonation_action_guard BEFORE INSERT ON support_impersonation_actions
WHEN NEW.outcome='allowed' AND NEW.action_code NOT IN('session.start','session.end') AND NOT EXISTS(SELECT 1 FROM support_impersonation_sessions s
 WHERE s.id=NEW.session_id AND s.actor_id=NEW.actor_id AND s.ended_at IS NULL AND s.started_at<=NEW.recorded_at AND s.expires_at>NEW.recorded_at)
BEGIN SELECT RAISE(ABORT,'impersonation_session_inactive'); END;
