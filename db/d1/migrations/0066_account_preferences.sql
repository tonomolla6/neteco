-- Explicit email-only product/replenishment choices. This is not newsletter
-- consent, a delivery queue, a schedule, or authority to send a message.
CREATE TABLE account_preference_commands (
 customer_id TEXT NOT NULL REFERENCES customers(id),
 command_id TEXT NOT NULL CHECK(length(command_id)=36),
 actor_id TEXT NOT NULL REFERENCES identities(id),
 session_id TEXT NOT NULL REFERENCES auth_sessions(id),
 session_version INTEGER NOT NULL CHECK(session_version>0),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
 expected_version INTEGER NOT NULL CHECK(expected_version BETWEEN 0 AND 9007199254740989),
 applied_version INTEGER NOT NULL CHECK(applied_version=expected_version+1),
 product_updates INTEGER NOT NULL CHECK(product_updates IN(0,1)),
 replenishment INTEGER NOT NULL CHECK(replenishment IN(0,1)),
 policy_version TEXT NOT NULL CHECK(policy_version='communications-2026-10-08'),
 text_hash TEXT NOT NULL CHECK(length(text_hash)=64 AND text_hash NOT GLOB '*[^a-f0-9]*'),
 recorded_at TEXT NOT NULL CHECK(recorded_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',recorded_at),'')),
 PRIMARY KEY(customer_id,command_id), UNIQUE(customer_id,applied_version)
) STRICT;
CREATE TABLE customer_account_preferences (
 customer_id TEXT PRIMARY KEY REFERENCES customers(id),
 version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740990),
 product_updates INTEGER NOT NULL CHECK(product_updates IN(0,1)),
 replenishment INTEGER NOT NULL CHECK(replenishment IN(0,1)),
 updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'')),
 command_id TEXT NOT NULL,
 FOREIGN KEY(customer_id,command_id) REFERENCES account_preference_commands(customer_id,command_id)
) STRICT;
CREATE TRIGGER account_preference_command_no_update BEFORE UPDATE ON account_preference_commands
BEGIN SELECT RAISE(ABORT,'account_preferences_immutable'); END;
CREATE TRIGGER account_preference_command_no_delete BEFORE DELETE ON account_preference_commands
BEGIN SELECT RAISE(ABORT,'account_preferences_immutable'); END;
CREATE TRIGGER account_preference_command_guard BEFORE INSERT ON account_preference_commands
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id JOIN customers c ON c.id=i.customer_id
 WHERE i.id=NEW.actor_id AND c.id=NEW.customer_id AND c.status='active' AND i.status='active'
 AND s.id=NEW.session_id AND s.session_version=NEW.session_version AND i.session_version=s.session_version
 AND s.revoked_at IS NULL AND s.created_at<=NEW.recorded_at AND s.expires_at>NEW.recorded_at
 AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.recorded_at
 AND(s.mfa_verified=1 OR NOT EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id=i.id AND m.verified_at IS NOT NULL))
 AND COALESCE((SELECT version FROM customer_account_preferences WHERE customer_id=c.id),0)=NEW.expected_version
 AND NOT EXISTS(SELECT 1 FROM customer_account_preferences WHERE customer_id=c.id AND updated_at>NEW.recorded_at))
BEGIN SELECT RAISE(ABORT,'account_preferences_conflict'); END;
CREATE TRIGGER account_preference_snapshot_insert BEFORE INSERT ON customer_account_preferences
WHEN NOT EXISTS(SELECT 1 FROM account_preference_commands c WHERE c.customer_id=NEW.customer_id AND c.command_id=NEW.command_id
 AND c.applied_version=NEW.version AND c.product_updates=NEW.product_updates AND c.replenishment=NEW.replenishment AND c.recorded_at=NEW.updated_at)
BEGIN SELECT RAISE(ABORT,'account_preferences_unconfirmed'); END;
CREATE TRIGGER account_preference_snapshot_update BEFORE UPDATE ON customer_account_preferences
WHEN NEW.customer_id<>OLD.customer_id OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at
 OR NOT EXISTS(SELECT 1 FROM account_preference_commands c WHERE c.customer_id=NEW.customer_id AND c.command_id=NEW.command_id
 AND c.expected_version=OLD.version AND c.applied_version=NEW.version AND c.product_updates=NEW.product_updates
 AND c.replenishment=NEW.replenishment AND c.recorded_at=NEW.updated_at)
BEGIN SELECT RAISE(ABORT,'account_preferences_unconfirmed'); END;
CREATE TRIGGER account_preference_snapshot_no_delete BEFORE DELETE ON customer_account_preferences
BEGIN SELECT RAISE(ABORT,'account_preferences_immutable'); END;
CREATE TRIGGER account_preference_command_apply AFTER INSERT ON account_preference_commands
BEGIN
 INSERT INTO customer_account_preferences(customer_id,version,product_updates,replenishment,updated_at,command_id)
 VALUES(NEW.customer_id,NEW.applied_version,NEW.product_updates,NEW.replenishment,NEW.recorded_at,NEW.command_id)
 ON CONFLICT(customer_id) DO UPDATE SET version=excluded.version,product_updates=excluded.product_updates,
 replenishment=excluded.replenishment,updated_at=excluded.updated_at,command_id=excluded.command_id;
END;
