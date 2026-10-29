-- Expand the existing transport, preserving pending work and receipts. D1
-- executes a migration transaction; FK enforcement is deferred, never disabled.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE email_outbox_events_expanded (
 id TEXT PRIMARY KEY CHECK(length(id)=70 AND substr(id,1,6)='email:' AND substr(id,7) NOT GLOB '*[^0-9a-f]*'),
 source_event_id TEXT NOT NULL CHECK(length(source_event_id)=36 AND source_event_id=lower(source_event_id)
  AND substr(source_event_id,9,1)='-' AND substr(source_event_id,14,1)='-' AND substr(source_event_id,19,1)='-' AND substr(source_event_id,24,1)='-'
  AND replace(source_event_id,'-','') NOT GLOB '*[^0-9a-f]*'),
 event_type TEXT NOT NULL CHECK(event_type IN(
  'identity.verification.requested','identity.password_reset.requested','identity.email_change.requested',
  'identity.security.password_changed','identity.security.password_rotated','identity.security.email_changed','identity.security.mfa_changed','identity.security.fiscal_changed',
  'order.created','order.confirmed','order.status.updated','order.cancelled','order.cancellation.requested',
  'order.reservation.expired','order.shipped','order.delivered','refund.succeeded.email','return.requested',
  'return.status.updated','support.ticket.received','support.ticket.reply','invoice.issued')),
 source_kind TEXT NOT NULL CHECK(source_kind IN('identity','order','refund','return','support','invoice')),
 source_id TEXT NOT NULL CHECK(length(source_id)=36 AND source_id=lower(source_id)
  AND substr(source_id,9,1)='-' AND substr(source_id,14,1)='-' AND substr(source_id,19,1)='-' AND substr(source_id,24,1)='-'
  AND replace(source_id,'-','') NOT GLOB '*[^0-9a-f]*'),
 schema_version INTEGER NOT NULL CHECK(schema_version=1),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(source_event_id,event_type)
) STRICT;
INSERT INTO email_outbox_events_expanded SELECT * FROM email_outbox_events;
-- This external trigger references the parent while ALTER validates the schema.
-- Recreate its unchanged definition after the transactional table replacement.
DROP TRIGGER operational_email_suppressions_insert_guard;
DROP TABLE email_outbox_events;
ALTER TABLE email_outbox_events_expanded RENAME TO email_outbox_events;
CREATE TRIGGER email_outbox_replay_guard BEFORE INSERT ON email_outbox_events
WHEN EXISTS(SELECT 1 FROM email_outbox_events previous
 WHERE previous.source_event_id=NEW.source_event_id AND previous.event_type=NEW.event_type
 AND(previous.id<>NEW.id OR previous.source_kind<>NEW.source_kind OR previous.source_id<>NEW.source_id OR previous.schema_version<>NEW.schema_version))
BEGIN SELECT RAISE(ABORT,'email_outbox_replay_conflict'); END;
CREATE TRIGGER email_outbox_events_no_update BEFORE UPDATE ON email_outbox_events
BEGIN SELECT RAISE(ABORT,'email_outbox_event_immutable'); END;
CREATE TRIGGER email_outbox_events_no_delete BEFORE DELETE ON email_outbox_events
BEGIN SELECT RAISE(ABORT,'email_outbox_event_immutable'); END;
CREATE TRIGGER email_outbox_delivery_on_event AFTER INSERT ON email_outbox_events
BEGIN INSERT INTO email_outbox_delivery(event_id,available_at) VALUES(NEW.id,NEW.created_at); END;
CREATE TRIGGER operational_email_suppressions_insert_guard BEFORE INSERT ON operational_email_suppressions
WHEN NOT EXISTS(
 SELECT 1 FROM email_outbox_events e
 JOIN orders o ON o.id=e.source_id
 JOIN delivery_preferences p ON p.customer_id=o.customer_id
 JOIN delivery_preference_commands c ON c.customer_id=p.customer_id AND c.command_id=p.command_id
 JOIN transactional_email_deliveries d ON d.event_id=e.id
 WHERE e.id=NEW.event_id AND e.event_type='order.status.updated' AND e.source_kind='order' AND e.schema_version=1
 AND o.customer_id=NEW.customer_id AND p.command_id=NEW.preference_command_id AND p.version=NEW.preference_version
 AND p.delivery_updates=0 AND c.applied_version=p.version AND c.delivery_updates=0
 AND c.recorded_at=p.updated_at AND p.updated_at<=NEW.suppressed_at
 AND d.status='leased' AND d.lease_until>NEW.suppressed_at
)
BEGIN SELECT RAISE(ABORT,'unconfirmed_operational_email_suppression'); END;

-- Minimal immutable occurrence evidence. Historical recipients are necessary
-- to warn the OLD address after a verified email change, never retargeted.
CREATE TABLE identity_account_security_events (
 id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'),
 identity_id TEXT NOT NULL REFERENCES identities(id),
 kind TEXT NOT NULL CHECK(kind IN('password_changed','mfa_enabled','email_changed','fiscal_details_submitted')),
 recipient TEXT NOT NULL CHECK(length(recipient) BETWEEN 3 AND 254 AND recipient=lower(trim(recipient))),
 audience TEXT NOT NULL CHECK(audience IN('current','previous')),
 session_version INTEGER NOT NULL CHECK(session_version>=1),
 domain_event_id TEXT CHECK(domain_event_id IS NULL OR (length(domain_event_id)=36 AND substr(domain_event_id,9,1)='-' AND substr(domain_event_id,14,1)='-' AND substr(domain_event_id,19,1)='-' AND substr(domain_event_id,24,1)='-' AND replace(domain_event_id,'-','') NOT GLOB '*[^0-9a-f]*')),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 CHECK(audience='current' OR kind='email_changed'),
 CHECK(kind='password_changed' OR domain_event_id IS NOT NULL),
 UNIQUE(domain_event_id,kind,audience)
) STRICT;
CREATE INDEX identity_account_security_events_identity_time ON identity_account_security_events(identity_id,created_at,id);
CREATE TRIGGER identity_account_security_events_no_update BEFORE UPDATE ON identity_account_security_events
BEGIN SELECT RAISE(ABORT,'immutable_account_security_event'); END;
CREATE TRIGGER identity_account_security_events_no_delete BEFORE DELETE ON identity_account_security_events
BEGIN SELECT RAISE(ABORT,'immutable_account_security_event'); END;
CREATE TABLE identity_account_security_guards (
 id TEXT PRIMARY KEY,
 passed INTEGER NOT NULL CONSTRAINT account_security_notice_atomic_guard CHECK(passed=1)
) STRICT;
-- Replacing a populated parent can leave SQLite's deferred counter referring
-- to the removed b-tree. Check ACTUAL final relationships before resetting
-- that bookkeeping. A real orphan aborts the entire migration, never passes.
INSERT INTO identity_account_security_guards(id,passed)
SELECT 'migration-0071-foreign-keys',CASE WHEN EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 0 ELSE 1 END;
DELETE FROM identity_account_security_guards WHERE id='migration-0071-foreign-keys';
PRAGMA defer_foreign_keys = OFF;
