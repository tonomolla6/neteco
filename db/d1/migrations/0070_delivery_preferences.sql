-- Operational preparation/delivery choices, separate from commercial consent.
CREATE TABLE delivery_preference_commands (
 customer_id TEXT NOT NULL REFERENCES customers(id),
 command_id TEXT NOT NULL CHECK(length(command_id)=36),
 actor_id TEXT NOT NULL REFERENCES identities(id),
 session_id TEXT NOT NULL REFERENCES auth_sessions(id),
 session_version INTEGER NOT NULL CHECK(session_version>0),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
 expected_version INTEGER NOT NULL CHECK(expected_version BETWEEN 0 AND 9007199254740989),
 applied_version INTEGER NOT NULL CHECK(applied_version=expected_version+1),
 delivery_updates INTEGER NOT NULL CHECK(delivery_updates IN(0,1)),
 policy_version TEXT NOT NULL CHECK(policy_version='delivery-notices-2026-10-09'),
 text_hash TEXT NOT NULL CHECK(length(text_hash)=64 AND text_hash NOT GLOB '*[^a-f0-9]*'),
 recorded_at TEXT NOT NULL CHECK(recorded_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',recorded_at),'')),
 PRIMARY KEY(customer_id,command_id), UNIQUE(customer_id,applied_version)
) STRICT;
CREATE TABLE delivery_preferences (
 customer_id TEXT PRIMARY KEY REFERENCES customers(id),
 version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740990),
 delivery_updates INTEGER NOT NULL CHECK(delivery_updates IN(0,1)),
 updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'')),
 command_id TEXT NOT NULL,
 FOREIGN KEY(customer_id,command_id) REFERENCES delivery_preference_commands(customer_id,command_id)
) STRICT;
CREATE TRIGGER delivery_preference_command_no_update BEFORE UPDATE ON delivery_preference_commands
BEGIN SELECT RAISE(ABORT,'delivery_preferences_immutable'); END;
CREATE TRIGGER delivery_preference_command_no_delete BEFORE DELETE ON delivery_preference_commands
BEGIN SELECT RAISE(ABORT,'delivery_preferences_immutable'); END;
CREATE TRIGGER delivery_preference_command_guard BEFORE INSERT ON delivery_preference_commands
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id JOIN customers c ON c.id=i.customer_id
 WHERE i.id=NEW.actor_id AND c.id=NEW.customer_id AND c.status='active' AND i.status='active'
 AND s.id=NEW.session_id AND s.session_version=NEW.session_version AND i.session_version=s.session_version
 AND s.revoked_at IS NULL AND s.created_at<=NEW.recorded_at AND s.expires_at>NEW.recorded_at
 AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.recorded_at
 AND(s.mfa_verified=1 OR NOT EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id=i.id AND m.verified_at IS NOT NULL))
 AND COALESCE((SELECT version FROM delivery_preferences WHERE customer_id=c.id),0)=NEW.expected_version
 AND NOT EXISTS(SELECT 1 FROM delivery_preferences WHERE customer_id=c.id AND updated_at>NEW.recorded_at))
BEGIN SELECT RAISE(ABORT,'delivery_preferences_conflict'); END;
CREATE TRIGGER delivery_preference_snapshot_insert BEFORE INSERT ON delivery_preferences
WHEN NOT EXISTS(SELECT 1 FROM delivery_preference_commands c WHERE c.customer_id=NEW.customer_id AND c.command_id=NEW.command_id
 AND c.applied_version=NEW.version AND c.delivery_updates=NEW.delivery_updates AND c.recorded_at=NEW.updated_at)
BEGIN SELECT RAISE(ABORT,'delivery_preferences_unconfirmed'); END;
CREATE TRIGGER delivery_preference_snapshot_update BEFORE UPDATE ON delivery_preferences
WHEN NEW.customer_id<>OLD.customer_id OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at
 OR NOT EXISTS(SELECT 1 FROM delivery_preference_commands c WHERE c.customer_id=NEW.customer_id AND c.command_id=NEW.command_id
 AND c.expected_version=OLD.version AND c.applied_version=NEW.version AND c.delivery_updates=NEW.delivery_updates AND c.recorded_at=NEW.updated_at)
BEGIN SELECT RAISE(ABORT,'delivery_preferences_unconfirmed'); END;
CREATE TRIGGER delivery_preference_snapshot_no_delete BEFORE DELETE ON delivery_preferences
BEGIN SELECT RAISE(ABORT,'delivery_preferences_immutable'); END;
CREATE TRIGGER delivery_preference_command_apply AFTER INSERT ON delivery_preference_commands
BEGIN
 INSERT INTO delivery_preferences(customer_id,version,delivery_updates,updated_at,command_id)
 VALUES(NEW.customer_id,NEW.applied_version,NEW.delivery_updates,NEW.recorded_at,NEW.command_id)
 ON CONFLICT(customer_id) DO UPDATE SET version=excluded.version,delivery_updates=excluded.delivery_updates,
 updated_at=excluded.updated_at,command_id=excluded.command_id;
END;
CREATE TABLE operational_email_suppressions (
 event_id TEXT PRIMARY KEY REFERENCES transactional_email_deliveries(event_id),
 customer_id TEXT NOT NULL REFERENCES customers(id),
 preference_command_id TEXT NOT NULL,
 preference_version INTEGER NOT NULL CHECK(preference_version>=1),
 source_hash TEXT NOT NULL CHECK(length(source_hash)=64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
 suppressed_at TEXT NOT NULL CHECK(suppressed_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',suppressed_at),'')),
 reason TEXT NOT NULL CHECK(reason='delivery_updates_disabled'),
 FOREIGN KEY(customer_id,preference_command_id) REFERENCES delivery_preference_commands(customer_id,command_id)
) STRICT;
CREATE TRIGGER operational_email_suppressions_no_update BEFORE UPDATE ON operational_email_suppressions
BEGIN SELECT RAISE(ABORT,'immutable_operational_email_suppression'); END;
CREATE TRIGGER operational_email_suppressions_no_delete BEFORE DELETE ON operational_email_suppressions
BEGIN SELECT RAISE(ABORT,'immutable_operational_email_suppression'); END;
-- The renderer supplies its full domain proof in the atomic suppression batch.
-- These guards also reject unsupported or stale direct ledger writes.
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
CREATE TRIGGER operational_email_suppressions_delivery_guard BEFORE UPDATE ON transactional_email_deliveries
WHEN NEW.status IN('leased','sending','sent')
 AND EXISTS(SELECT 1 FROM operational_email_suppressions s WHERE s.event_id=NEW.event_id)
BEGIN SELECT RAISE(ABORT,'suppressed_operational_email_delivery'); END;
