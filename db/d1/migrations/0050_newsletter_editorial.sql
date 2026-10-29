-- Newsletter editorial data/queue only. No consent, identity, approved policy,
-- topic, recipient, sender, provider binding or secret is provisioned here.
CREATE TABLE newsletter_editorial_policies (
 id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND length(replace(id,'-',''))=32 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'), document TEXT NOT NULL CHECK(json_valid(document) AND json_type(document)='object'
 AND COALESCE(json_type(document,'$.name')='text' AND length(trim(json_extract(document,'$.name'))) BETWEEN 3 AND 160,0)
 AND COALESCE(json_type(document,'$.reason')='text' AND length(trim(json_extract(document,'$.reason'))) BETWEEN 3 AND 500,0)
 AND COALESCE(json_type(document,'$.intervalHours')='object' AND json_type(document,'$.intervalHours.immediate')='integer' AND json_extract(document,'$.intervalHours.immediate') BETWEEN 1 AND 8760
 AND json_type(document,'$.intervalHours.weekly')='integer' AND json_extract(document,'$.intervalHours.weekly') BETWEEN 168 AND 8760
 AND json_type(document,'$.intervalHours.monthly')='integer' AND json_extract(document,'$.intervalHours.monthly') BETWEEN 744 AND 8760
 AND json_extract(document,'$.intervalHours.immediate')<=json_extract(document,'$.intervalHours.weekly') AND json_extract(document,'$.intervalHours.weekly')<=json_extract(document,'$.intervalHours.monthly'),0)
 AND COALESCE(json_type(document,'$.minEditorialPercent')='integer' AND json_extract(document,'$.minEditorialPercent') BETWEEN 0 AND 100 AND json_extract(document,'$.locale')='es',0)
 AND COALESCE(json_type(document,'$.quietHours')='null' OR (json_type(document,'$.quietHours')='object' AND json_type(document,'$.quietHours.startMinute')='integer' AND json_type(document,'$.quietHours.endMinute')='integer'
 AND json_extract(document,'$.quietHours.startMinute') BETWEEN 0 AND 1439 AND json_extract(document,'$.quietHours.endMinute') BETWEEN 0 AND 1439
 AND json_extract(document,'$.quietHours.startMinute')<>json_extract(document,'$.quietHours.endMinute') AND json_extract(document,'$.quietHours.timezone')='Europe/Madrid'),0)),
 actor_id TEXT NOT NULL REFERENCES identities(id), created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE TABLE newsletter_editorial_policy_head (
 id TEXT PRIMARY KEY CHECK(id='global'), revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740990), policy_id TEXT REFERENCES newsletter_editorial_policies(id)
) STRICT;
CREATE TABLE newsletter_editorial_topics (
 id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND length(replace(id,'-',''))=32 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'), code TEXT NOT NULL UNIQUE CHECK(length(code) BETWEEN 1 AND 60 AND code NOT GLOB '*[^a-z0-9-]*' AND substr(code,1,1) GLOB '[a-z]' AND instr(code,char(0))=0),
 label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 3 AND 120), active INTEGER NOT NULL CHECK(active IN(0,1)), revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740990)
) STRICT;
CREATE TABLE newsletter_editorial_preferences (
 subscription_id TEXT PRIMARY KEY REFERENCES newsletter_subscriptions(id), revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740990),
 document TEXT CHECK(document IS NULL OR (json_valid(document) AND json_type(document)='object'
 AND COALESCE(json_extract(document,'$.frequency') IN('immediate','weekly','monthly'),0) AND COALESCE(json_type(document,'$.topics')='array',0)
 AND COALESCE(json_extract(document,'$.locale')='es',0)
 AND COALESCE(json_type(document,'$.quietHours')='null' OR (json_type(document,'$.quietHours')='object' AND json_type(document,'$.quietHours.startMinute')='integer' AND json_type(document,'$.quietHours.endMinute')='integer'
 AND json_extract(document,'$.quietHours.startMinute') BETWEEN 0 AND 1439 AND json_extract(document,'$.quietHours.endMinute') BETWEEN 0 AND 1439
 AND json_extract(document,'$.quietHours.startMinute')<>json_extract(document,'$.quietHours.endMinute') AND json_extract(document,'$.quietHours.timezone')='Europe/Madrid'),0))),
 updated_at TEXT NOT NULL CHECK(length(updated_at)=20 AND updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),''))
) STRICT;
CREATE TABLE newsletter_editorial_access (
 id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND length(replace(id,'-',''))=32 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'), subscription_id TEXT NOT NULL REFERENCES newsletter_subscriptions(id), token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
 created_at INTEGER NOT NULL CHECK(created_at>0), expires_at INTEGER NOT NULL CHECK(expires_at=created_at+1800)
) STRICT;
CREATE TABLE newsletter_editorial_campaigns (
 id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND length(replace(id,'-',''))=32 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'), revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740990),
 status TEXT NOT NULL CHECK(status IN('draft','approved','cancelled','completed')), draft_version_id TEXT REFERENCES newsletter_editorial_versions(id),
 approved_version_id TEXT REFERENCES newsletter_editorial_versions(id), policy_id TEXT REFERENCES newsletter_editorial_policies(id),
 starts_at TEXT CHECK(starts_at IS NULL OR (length(starts_at)=20 AND starts_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',starts_at),''))),
 ends_at TEXT CHECK(ends_at IS NULL OR (length(ends_at)=20 AND ends_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',ends_at),''))),
 approved_at TEXT CHECK(approved_at IS NULL OR (length(approved_at)=20 AND approved_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',approved_at),''))),
 cursor TEXT CHECK(cursor IS NULL OR (length(cursor)=36 AND substr(cursor,9,1)='-' AND substr(cursor,14,1)='-' AND substr(cursor,19,1)='-' AND substr(cursor,24,1)='-' AND length(replace(cursor,'-',''))=32 AND replace(cursor,'-','') NOT GLOB '*[^0-9a-f]*')), fanout_complete INTEGER NOT NULL DEFAULT 0 CHECK(fanout_complete IN(0,1)),
 created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 CHECK(status NOT IN('approved','completed') OR (approved_version_id IS NOT NULL AND policy_id IS NOT NULL AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND approved_at IS NOT NULL AND ends_at>starts_at AND ends_at>approved_at))
) STRICT;
CREATE TABLE newsletter_editorial_versions (
 id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND length(replace(id,'-',''))=32 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'), campaign_id TEXT NOT NULL REFERENCES newsletter_editorial_campaigns(id),
 document TEXT NOT NULL CHECK(json_valid(document) AND json_type(document)='object' AND length(CAST(document AS BLOB))<=262144
 AND COALESCE(json_type(document,'$.blocks')='array' AND json_array_length(document,'$.blocks') BETWEEN 1 AND 50,0)
 AND COALESCE(json_type(document,'$.topics')='array' AND json_array_length(document,'$.topics')<=20 AND json_type(document,'$.frequencies')='array' AND json_array_length(document,'$.frequencies') BETWEEN 1 AND 3 AND json_extract(document,'$.locale')='es',0)
 AND COALESCE(json_type(document,'$.name')='text' AND length(trim(json_extract(document,'$.name'))) BETWEEN 3 AND 160
 AND json_type(document,'$.subject')='text' AND length(trim(json_extract(document,'$.subject'))) BETWEEN 3 AND 160
 AND json_type(document,'$.changeSummary')='text' AND length(trim(json_extract(document,'$.changeSummary'))) BETWEEN 3 AND 500
 AND json_extract(document,'$.topicMatch') IN('any','all'),0)),
 actor_id TEXT NOT NULL REFERENCES identities(id), created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE TABLE newsletter_editorial_deliveries (
 id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND length(replace(id,'-',''))=32 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'), campaign_id TEXT NOT NULL REFERENCES newsletter_editorial_campaigns(id), version_id TEXT NOT NULL REFERENCES newsletter_editorial_versions(id),
 subscription_id TEXT NOT NULL REFERENCES newsletter_subscriptions(id), approval_revision INTEGER NOT NULL CHECK(approval_revision>0),
 status TEXT NOT NULL CHECK(status IN('pending','leased','sending','accepted','skipped','manual_review')),
 available_at TEXT NOT NULL CHECK(length(available_at)=20 AND available_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',available_at),'')),
 lease_token TEXT CHECK(lease_token IS NULL OR (length(lease_token)=36 AND substr(lease_token,9,1)='-' AND substr(lease_token,14,1)='-' AND substr(lease_token,19,1)='-' AND substr(lease_token,24,1)='-' AND length(replace(lease_token,'-',''))=32 AND replace(lease_token,'-','') NOT GLOB '*[^0-9a-f]*')), lease_until TEXT CHECK(lease_until IS NULL OR (length(lease_until)=20 AND lease_until=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',lease_until),''))),
 sending_at TEXT CHECK(sending_at IS NULL OR (length(sending_at)=20 AND sending_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',sending_at),''))),
 finished_at TEXT CHECK(finished_at IS NULL OR (length(finished_at)=20 AND finished_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',finished_at),''))),
 provider TEXT CHECK(provider IS NULL OR provider IN('local-fake','cloudflare-email')),
 provider_message_id TEXT CHECK(provider_message_id IS NULL OR (length(provider_message_id) BETWEEN 1 AND 200 AND provider_message_id NOT GLOB '*[^a-zA-Z0-9._:-]*' AND instr(provider_message_id,char(0))=0)),
 feedback_status TEXT CHECK(feedback_status IS NULL OR feedback_status IN('delivered','bounced','complained')),
 last_error_code TEXT CHECK(last_error_code IS NULL OR last_error_code IN('campaign_cancelled','window_closed','policy_unavailable','consent_unavailable','preference_unavailable','segment_changed','topic_unavailable','source_unavailable','frequency_cap','quiet_hours','local_recipient_forbidden','preprod_recipient_forbidden','provider_outcome_unknown','provider_receipt_invalid','provider_ack_failed','sending_lease_expired','preparation_failed')),
 created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(campaign_id,subscription_id), UNIQUE(provider,provider_message_id),
 CHECK((status IN('leased','sending') AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (status NOT IN('leased','sending') AND lease_token IS NULL AND lease_until IS NULL)),
 CHECK(status<>'sending' OR sending_at IS NOT NULL), CHECK(status NOT IN('accepted','skipped','manual_review') OR finished_at IS NOT NULL),
 CHECK(status<>'accepted' OR (provider IS NOT NULL AND provider_message_id IS NOT NULL)),
 CHECK(feedback_status IS NULL OR status='accepted'), CHECK(status<>'manual_review' OR last_error_code IS NOT NULL),
 CHECK(available_at>=created_at), CHECK(sending_at IS NULL OR sending_at>=created_at), CHECK(finished_at IS NULL OR (finished_at>=created_at AND (sending_at IS NULL OR finished_at>=sending_at)))
) STRICT;
CREATE INDEX newsletter_editorial_due ON newsletter_editorial_deliveries(status,available_at,id);
CREATE TABLE newsletter_editorial_caps (
 subscription_id TEXT PRIMARY KEY REFERENCES newsletter_subscriptions(id), last_delivery_id TEXT NOT NULL REFERENCES newsletter_editorial_deliveries(id),
 last_attempt_at TEXT NOT NULL CHECK(length(last_attempt_at)=20 AND last_attempt_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',last_attempt_at),'')),
 next_eligible_at TEXT NOT NULL CHECK(length(next_eligible_at)=20 AND next_eligible_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',next_eligible_at),'') AND next_eligible_at>last_attempt_at)
) STRICT;
CREATE TABLE newsletter_editorial_feedback (
 id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND length(replace(id,'-',''))=32 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'), provider TEXT NOT NULL CHECK(provider IN('local-fake','cloudflare-email')),
 event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 3 AND 200 AND event_id NOT GLOB '*[^a-zA-Z0-9._:-]*' AND instr(event_id,char(0))=0), delivery_id TEXT NOT NULL REFERENCES newsletter_editorial_deliveries(id),
 event_type TEXT NOT NULL CHECK(event_type IN('delivered','hard_bounce','complaint')),
 occurred_at TEXT NOT NULL CHECK(length(occurred_at)=20 AND occurred_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',occurred_at),'')),
 received_at TEXT NOT NULL CHECK(length(received_at)=20 AND received_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',received_at),'') AND occurred_at<=received_at),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'), UNIQUE(provider,event_id)
) STRICT;
CREATE TABLE newsletter_editorial_commands (
 id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND length(replace(id,'-',''))=32 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'), scope TEXT NOT NULL CHECK(scope IN('admin','subscription')), actor_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN('set_policy','retire_policy','create_topic','update_topic','create_campaign','update_campaign','approve_campaign','cancel_campaign','save','unsubscribe')),
 resource_id TEXT NOT NULL CHECK(length(resource_id)=36 AND substr(resource_id,9,1)='-' AND substr(resource_id,14,1)='-' AND substr(resource_id,19,1)='-' AND substr(resource_id,24,1)='-' AND length(replace(resource_id,'-',''))=32 AND replace(resource_id,'-','') NOT GLOB '*[^0-9a-f]*'), idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200 AND idempotency_key NOT GLOB '*[^a-zA-Z0-9._:-]*'),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'), input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object'),
 expected_revision INTEGER NOT NULL CHECK(expected_revision BETWEEN 0 AND 9007199254740989),
 before_state TEXT NOT NULL CHECK(json_valid(before_state) AND json_type(before_state) IN('object','null')), after_state TEXT NOT NULL CHECK(json_valid(after_state) AND json_type(after_state)='object'),
 response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object' AND length(CAST(response AS BLOB))<=16384),
 created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')), UNIQUE(scope,actor_id,idempotency_key),
 CHECK(COALESCE(json_extract(input,'$.action')=action AND json_type(input,'$.expectedRevision')='integer' AND json_extract(input,'$.expectedRevision')=expected_revision,0)),
 CHECK(COALESCE(json_extract(response,'$.source')='cloudflare' AND json_extract(response,'$.action')=action AND json_extract(response,'$.resourceId')=resource_id AND json_type(response,'$.updated')='true'
 AND json_type(response,'$.revision')='integer' AND json_extract(response,'$.revision')=expected_revision+1 AND json_type(after_state,'$.revision')='integer' AND json_extract(after_state,'$.revision')=expected_revision+1,0)),
 CHECK((scope='subscription')=(action IN('save','unsubscribe')))
) STRICT;
CREATE TABLE newsletter_editorial_audit (
 command_id TEXT PRIMARY KEY REFERENCES newsletter_editorial_commands(id), scope TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, resource_id TEXT NOT NULL,
 input TEXT NOT NULL,before_state TEXT NOT NULL,after_state TEXT NOT NULL,response TEXT NOT NULL,created_at TEXT NOT NULL
) STRICT;
CREATE TABLE newsletter_editorial_guards (id TEXT PRIMARY KEY,satisfied INTEGER NOT NULL CONSTRAINT newsletter_editorial_atomic_guard CHECK(satisfied=1)) STRICT;
CREATE TABLE newsletter_editorial_limits (
 subject_hash TEXT NOT NULL CHECK(length(subject_hash)=64 AND subject_hash NOT GLOB '*[^a-f0-9]*'),
 scope TEXT NOT NULL CHECK(scope IN('admin','account','bearer','preview','dispatch','feedback')),
 used INTEGER NOT NULL CHECK(used BETWEEN 1 AND 121), expires_at INTEGER NOT NULL CHECK(expires_at>0), PRIMARY KEY(subject_hash,scope)
) STRICT;
CREATE TRIGGER newsletter_editorial_audit_match BEFORE INSERT ON newsletter_editorial_audit WHEN NOT EXISTS(SELECT 1 FROM newsletter_editorial_commands c
 WHERE c.id=NEW.command_id AND c.scope=NEW.scope AND c.actor_id=NEW.actor_id AND c.action=NEW.action AND c.resource_id=NEW.resource_id AND c.input=NEW.input
 AND c.before_state=NEW.before_state AND c.after_state=NEW.after_state AND c.response=NEW.response AND c.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'newsletter_editorial_audit_mismatch'); END;
CREATE TRIGGER newsletter_editorial_campaign_pointer BEFORE UPDATE ON newsletter_editorial_campaigns
WHEN NEW.id<>OLD.id OR NEW.created_at<>OLD.created_at OR NEW.revision NOT IN(OLD.revision,OLD.revision+1)
 OR NOT EXISTS(SELECT 1 FROM newsletter_editorial_versions WHERE id=NEW.draft_version_id AND campaign_id=NEW.id)
 OR (NEW.approved_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM newsletter_editorial_versions WHERE id=NEW.approved_version_id AND campaign_id=NEW.id))
 OR (OLD.status<>'draft' AND NEW.draft_version_id IS NOT OLD.draft_version_id)
 OR (OLD.approved_version_id IS NOT NULL AND (NEW.approved_version_id IS NOT OLD.approved_version_id OR NEW.policy_id IS NOT OLD.policy_id OR NEW.starts_at IS NOT OLD.starts_at OR NEW.ends_at IS NOT OLD.ends_at OR NEW.approved_at IS NOT OLD.approved_at))
 OR (OLD.status='approved' AND NEW.status NOT IN('approved','cancelled','completed'))
 OR (OLD.status IN('cancelled','completed') AND NEW.status<>OLD.status)
BEGIN SELECT RAISE(ABORT,'newsletter_editorial_campaign_head'); END;
CREATE TRIGGER newsletter_editorial_campaign_initial BEFORE INSERT ON newsletter_editorial_campaigns
WHEN NEW.revision<>1 OR NEW.status<>'draft' OR NEW.draft_version_id IS NOT NULL OR NEW.approved_version_id IS NOT NULL OR NEW.policy_id IS NOT NULL OR NEW.starts_at IS NOT NULL OR NEW.ends_at IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.cursor IS NOT NULL OR NEW.fanout_complete<>0
BEGIN SELECT RAISE(ABORT,'newsletter_editorial_campaign_initial'); END;
CREATE TRIGGER newsletter_editorial_preference_initial BEFORE INSERT ON newsletter_editorial_preferences WHEN NEW.revision<>1
BEGIN SELECT RAISE(ABORT,'newsletter_editorial_preference_initial'); END;
CREATE TRIGGER newsletter_editorial_topic_initial BEFORE INSERT ON newsletter_editorial_topics WHEN NEW.revision<>1
BEGIN SELECT RAISE(ABORT,'newsletter_editorial_topic_initial'); END;
CREATE TRIGGER newsletter_editorial_policy_head_initial BEFORE INSERT ON newsletter_editorial_policy_head WHEN NEW.revision<>1
BEGIN SELECT RAISE(ABORT,'newsletter_editorial_policy_head_initial'); END;
CREATE TRIGGER newsletter_editorial_delivery_source BEFORE INSERT ON newsletter_editorial_deliveries
WHEN NOT EXISTS(SELECT 1 FROM newsletter_editorial_campaigns c JOIN newsletter_editorial_versions v ON v.id=NEW.version_id AND v.campaign_id=c.id
 WHERE c.id=NEW.campaign_id AND c.status='approved' AND c.approved_version_id=v.id AND c.revision=NEW.approval_revision)
BEGIN SELECT RAISE(ABORT,'newsletter_editorial_delivery_source'); END;
CREATE TRIGGER newsletter_editorial_delivery_identity BEFORE UPDATE ON newsletter_editorial_deliveries
WHEN NEW.id<>OLD.id OR NEW.campaign_id<>OLD.campaign_id OR NEW.version_id<>OLD.version_id OR NEW.subscription_id<>OLD.subscription_id OR NEW.approval_revision<>OLD.approval_revision OR NEW.created_at<>OLD.created_at
 OR (OLD.status IN('accepted','skipped','manual_review') AND NEW.status<>OLD.status)
 OR (OLD.status='sending' AND NEW.status NOT IN('sending','accepted','skipped','manual_review'))
 OR (OLD.provider_message_id IS NOT NULL AND (NEW.provider_message_id IS NOT OLD.provider_message_id OR NEW.provider IS NOT OLD.provider))
 OR (OLD.feedback_status='complained' AND NEW.feedback_status IS NOT OLD.feedback_status)
 OR (OLD.feedback_status='bounced' AND (NEW.feedback_status IS NULL OR NEW.feedback_status NOT IN('bounced','complained')))
BEGIN SELECT RAISE(ABORT,'newsletter_editorial_delivery_identity'); END;
CREATE TRIGGER newsletter_editorial_topic_head BEFORE UPDATE ON newsletter_editorial_topics WHEN NEW.id<>OLD.id OR NEW.code<>OLD.code OR NEW.revision<>OLD.revision+1
BEGIN SELECT RAISE(ABORT,'newsletter_editorial_topic_head'); END;
CREATE TRIGGER newsletter_editorial_policy_head_revision BEFORE UPDATE ON newsletter_editorial_policy_head WHEN NEW.id<>OLD.id OR NEW.revision<>OLD.revision+1
BEGIN SELECT RAISE(ABORT,'newsletter_editorial_policy_head'); END;
CREATE TRIGGER newsletter_editorial_preference_revision BEFORE UPDATE ON newsletter_editorial_preferences WHEN NEW.subscription_id<>OLD.subscription_id OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
BEGIN SELECT RAISE(ABORT,'newsletter_editorial_preference_head'); END;
CREATE TRIGGER newsletter_editorial_cap_owner BEFORE INSERT ON newsletter_editorial_caps WHEN NOT EXISTS(SELECT 1 FROM newsletter_editorial_deliveries WHERE id=NEW.last_delivery_id AND subscription_id=NEW.subscription_id)
BEGIN SELECT RAISE(ABORT,'newsletter_editorial_cap_owner'); END;
CREATE TRIGGER newsletter_editorial_cap_update BEFORE UPDATE ON newsletter_editorial_caps WHEN NEW.subscription_id<>OLD.subscription_id OR NEW.last_attempt_at<OLD.last_attempt_at OR NOT EXISTS(SELECT 1 FROM newsletter_editorial_deliveries WHERE id=NEW.last_delivery_id AND subscription_id=NEW.subscription_id)
BEGIN SELECT RAISE(ABORT,'newsletter_editorial_cap_owner'); END;
CREATE TRIGGER newsletter_editorial_policy_no_update BEFORE UPDATE ON newsletter_editorial_policies BEGIN SELECT RAISE(ABORT,'newsletter_editorial_immutable'); END;
CREATE TRIGGER newsletter_editorial_policy_no_delete BEFORE DELETE ON newsletter_editorial_policies BEGIN SELECT RAISE(ABORT,'newsletter_editorial_immutable'); END;
CREATE TRIGGER newsletter_editorial_version_no_update BEFORE UPDATE ON newsletter_editorial_versions BEGIN SELECT RAISE(ABORT,'newsletter_editorial_immutable'); END;
CREATE TRIGGER newsletter_editorial_version_no_delete BEFORE DELETE ON newsletter_editorial_versions BEGIN SELECT RAISE(ABORT,'newsletter_editorial_immutable'); END;
CREATE TRIGGER newsletter_editorial_access_no_update BEFORE UPDATE ON newsletter_editorial_access BEGIN SELECT RAISE(ABORT,'newsletter_editorial_immutable'); END;
CREATE TRIGGER newsletter_editorial_access_no_delete BEFORE DELETE ON newsletter_editorial_access BEGIN SELECT RAISE(ABORT,'newsletter_editorial_immutable'); END;
CREATE TRIGGER newsletter_editorial_command_no_update BEFORE UPDATE ON newsletter_editorial_commands BEGIN SELECT RAISE(ABORT,'newsletter_editorial_immutable'); END;
CREATE TRIGGER newsletter_editorial_command_no_delete BEFORE DELETE ON newsletter_editorial_commands BEGIN SELECT RAISE(ABORT,'newsletter_editorial_immutable'); END;
CREATE TRIGGER newsletter_editorial_audit_no_update BEFORE UPDATE ON newsletter_editorial_audit BEGIN SELECT RAISE(ABORT,'newsletter_editorial_immutable'); END;
CREATE TRIGGER newsletter_editorial_audit_no_delete BEFORE DELETE ON newsletter_editorial_audit BEGIN SELECT RAISE(ABORT,'newsletter_editorial_immutable'); END;
CREATE TRIGGER newsletter_editorial_feedback_no_update BEFORE UPDATE ON newsletter_editorial_feedback BEGIN SELECT RAISE(ABORT,'newsletter_editorial_immutable'); END;
CREATE TRIGGER newsletter_editorial_feedback_no_delete BEFORE DELETE ON newsletter_editorial_feedback BEGIN SELECT RAISE(ABORT,'newsletter_editorial_immutable'); END;
CREATE TRIGGER newsletter_editorial_delivery_no_delete BEFORE DELETE ON newsletter_editorial_deliveries BEGIN SELECT RAISE(ABORT,'newsletter_editorial_immutable'); END;
CREATE TRIGGER newsletter_editorial_campaign_no_delete BEFORE DELETE ON newsletter_editorial_campaigns BEGIN SELECT RAISE(ABORT,'newsletter_editorial_immutable'); END;
CREATE TRIGGER newsletter_editorial_topic_no_delete BEFORE DELETE ON newsletter_editorial_topics BEGIN SELECT RAISE(ABORT,'newsletter_editorial_immutable'); END;
CREATE TRIGGER newsletter_editorial_preference_no_delete BEFORE DELETE ON newsletter_editorial_preferences BEGIN SELECT RAISE(ABORT,'newsletter_editorial_immutable'); END;
CREATE TRIGGER newsletter_editorial_policy_head_no_delete BEFORE DELETE ON newsletter_editorial_policy_head BEGIN SELECT RAISE(ABORT,'newsletter_editorial_immutable'); END;
