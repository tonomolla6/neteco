-- Dedicated, opt-in recovery. No sender, timing policy, stock or price is seeded.
CREATE TABLE cart_recovery_associations (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), actor_id TEXT NOT NULL REFERENCES identities(id),
 cart_id TEXT NOT NULL REFERENCES carts(id), cart_version INTEGER NOT NULL CHECK(cart_version>=1),
 cart_token_hash TEXT NOT NULL CHECK(length(cart_token_hash)=64 AND cart_token_hash NOT GLOB '*[^0-9a-f]*'),
 stage TEXT NOT NULL CHECK(stage IN('cart','checkout')), recipient TEXT NOT NULL,
 consent_version INTEGER NOT NULL CHECK(consent_version>=1), policy_version TEXT NOT NULL,
 lines_json TEXT NOT NULL CHECK(json_valid(lines_json) AND json_type(lines_json)='array' AND json_array_length(lines_json) BETWEEN 1 AND 100),
 activity_at TEXT NOT NULL CHECK(activity_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',activity_at),'')),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(customer_id,cart_id,cart_version,stage)
) STRICT;
CREATE TABLE cart_recovery_commands (
 actor_id TEXT NOT NULL REFERENCES identities(id), customer_id TEXT NOT NULL REFERENCES customers(id), command_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN('preferences','associate','resume')),
 association_id TEXT REFERENCES cart_recovery_associations(id), cart_id TEXT REFERENCES carts(id),
 expected_version INTEGER NOT NULL CHECK(expected_version>=0), applied_version INTEGER NOT NULL CHECK(applied_version>=1),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 input_json TEXT NOT NULL CHECK(json_valid(input_json)), receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 grant_hash TEXT CHECK(grant_hash IS NULL OR(length(grant_hash)=64 AND grant_hash NOT GLOB '*[^0-9a-f]*')),
 recorded_at TEXT NOT NULL CHECK(recorded_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',recorded_at),'')),
 PRIMARY KEY(actor_id,command_id),
 CHECK(json_extract(receipt_json,'$.commandId') IS command_id AND json_extract(receipt_json,'$.payloadHash') IS payload_hash
 AND json_extract(receipt_json,'$.action') IS action AND json_extract(receipt_json,'$.version') IS applied_version
 AND json_extract(receipt_json,'$.recordedAt') IS recorded_at AND json_extract(receipt_json,'$.associationId') IS association_id),
 CHECK((action='preferences' AND association_id IS NULL AND cart_id IS NULL AND grant_hash IS NULL)
 OR(action='associate' AND association_id IS NOT NULL AND cart_id IS NOT NULL AND grant_hash IS NULL)
 OR(action='resume' AND association_id IS NOT NULL AND cart_id IS NOT NULL AND grant_hash IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX cart_recovery_preference_version ON cart_recovery_commands(customer_id,applied_version) WHERE action='preferences';
CREATE UNIQUE INDEX cart_recovery_resume_version ON cart_recovery_commands(cart_id,applied_version) WHERE action='resume';
CREATE TABLE cart_recovery_preferences (
 customer_id TEXT PRIMARY KEY REFERENCES customers(id), version INTEGER NOT NULL CHECK(version>=1), recovery_enabled INTEGER NOT NULL CHECK(recovery_enabled IN(0,1)),
 actor_id TEXT NOT NULL, command_id TEXT NOT NULL, updated_at TEXT NOT NULL,
 FOREIGN KEY(actor_id,command_id) REFERENCES cart_recovery_commands(actor_id,command_id)
) STRICT;
CREATE TRIGGER cart_recovery_preference_insert BEFORE INSERT ON cart_recovery_preferences WHEN NEW.version<>1 OR NOT EXISTS(
 SELECT 1 FROM cart_recovery_commands c WHERE c.customer_id=NEW.customer_id AND c.actor_id=NEW.actor_id AND c.command_id=NEW.command_id
 AND c.action='preferences' AND c.applied_version=NEW.version AND json_extract(c.input_json,'$.recoveryEnabled')=NEW.recovery_enabled AND c.recorded_at=NEW.updated_at
) BEGIN SELECT RAISE(ABORT,'unconfirmed_cart_recovery_preference'); END;
CREATE TRIGGER cart_recovery_preference_update BEFORE UPDATE ON cart_recovery_preferences WHEN NEW.customer_id<>OLD.customer_id OR NEW.version<>OLD.version+1 OR NOT EXISTS(
 SELECT 1 FROM cart_recovery_commands c WHERE c.customer_id=NEW.customer_id AND c.actor_id=NEW.actor_id AND c.command_id=NEW.command_id
 AND c.action='preferences' AND c.expected_version=OLD.version AND c.applied_version=NEW.version
 AND json_extract(c.input_json,'$.recoveryEnabled')=NEW.recovery_enabled AND c.recorded_at=NEW.updated_at
) BEGIN SELECT RAISE(ABORT,'unconfirmed_cart_recovery_preference'); END;
CREATE TRIGGER cart_recovery_preference_project AFTER INSERT ON cart_recovery_commands WHEN NEW.action='preferences' BEGIN
 INSERT INTO cart_recovery_preferences(customer_id,version,recovery_enabled,actor_id,command_id,updated_at)
 SELECT NEW.customer_id,NEW.applied_version,json_extract(NEW.input_json,'$.recoveryEnabled'),NEW.actor_id,NEW.command_id,NEW.recorded_at WHERE NEW.expected_version=0;
 UPDATE cart_recovery_preferences SET version=NEW.applied_version,recovery_enabled=json_extract(NEW.input_json,'$.recoveryEnabled'),actor_id=NEW.actor_id,command_id=NEW.command_id,updated_at=NEW.recorded_at
 WHERE customer_id=NEW.customer_id AND NEW.expected_version>0;
END;
CREATE TRIGGER cart_recovery_preference_no_replace BEFORE INSERT ON cart_recovery_preferences WHEN EXISTS(SELECT 1 FROM cart_recovery_preferences WHERE customer_id=NEW.customer_id) BEGIN SELECT RAISE(ABORT,'unconfirmed_cart_recovery_preference'); END;
CREATE TRIGGER cart_recovery_preference_no_delete BEFORE DELETE ON cart_recovery_preferences BEGIN SELECT RAISE(ABORT,'immutable_cart_recovery_preference'); END;
CREATE TABLE cart_recovery_deliveries (
 id TEXT PRIMARY KEY, association_id TEXT NOT NULL UNIQUE REFERENCES cart_recovery_associations(id), customer_id TEXT NOT NULL REFERENCES customers(id),
 status TEXT NOT NULL CHECK(status IN('pending','sending','sent','skipped','manual_review')),
 source_hash TEXT NOT NULL CHECK(length(source_hash)=64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 expires_at TEXT NOT NULL CHECK(expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',expires_at),'') AND expires_at>created_at),
 next_eligible_at TEXT NOT NULL CHECK(next_eligible_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',next_eligible_at),'') AND next_eligible_at>created_at),
 claimed_at TEXT, finished_at TEXT, provider_message_id TEXT,
 CHECK((status='pending' AND claimed_at IS NULL AND finished_at IS NULL AND provider_message_id IS NULL)
 OR(status='sending' AND claimed_at IS NOT NULL AND finished_at IS NULL AND provider_message_id IS NULL)
 OR(status='sent' AND claimed_at IS NOT NULL AND finished_at IS NOT NULL AND length(provider_message_id) BETWEEN 1 AND 200)
 OR(status='skipped' AND claimed_at IS NULL AND finished_at IS NOT NULL AND provider_message_id IS NULL)
 OR(status='manual_review' AND claimed_at IS NOT NULL AND finished_at IS NOT NULL AND provider_message_id IS NULL))
) STRICT;
CREATE INDEX cart_recovery_delivery_due ON cart_recovery_deliveries(status,created_at,id);
CREATE INDEX cart_recovery_customer_cap ON cart_recovery_deliveries(customer_id,next_eligible_at);
CREATE TABLE cart_recovery_evaluation_cursor(id INTEGER PRIMARY KEY CHECK(id=1),last_id TEXT NOT NULL) STRICT;
INSERT INTO cart_recovery_evaluation_cursor VALUES(1,'');
CREATE TABLE cart_recovery_atomic_guards(id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1)) STRICT;
CREATE TRIGGER cart_recovery_association_no_update BEFORE UPDATE ON cart_recovery_associations BEGIN SELECT RAISE(ABORT,'immutable_cart_recovery_association'); END;
CREATE TRIGGER cart_recovery_association_no_delete BEFORE DELETE ON cart_recovery_associations BEGIN SELECT RAISE(ABORT,'immutable_cart_recovery_association'); END;
CREATE TRIGGER cart_recovery_association_no_replace BEFORE INSERT ON cart_recovery_associations WHEN EXISTS(SELECT 1 FROM cart_recovery_associations WHERE id=NEW.id OR(customer_id=NEW.customer_id AND cart_id=NEW.cart_id AND cart_version=NEW.cart_version AND stage=NEW.stage)) BEGIN SELECT RAISE(ABORT,'immutable_cart_recovery_association'); END;
CREATE TRIGGER cart_recovery_command_no_update BEFORE UPDATE ON cart_recovery_commands BEGIN SELECT RAISE(ABORT,'immutable_cart_recovery_command'); END;
CREATE TRIGGER cart_recovery_command_no_delete BEFORE DELETE ON cart_recovery_commands BEGIN SELECT RAISE(ABORT,'immutable_cart_recovery_command'); END;
CREATE TRIGGER cart_recovery_command_no_replace BEFORE INSERT ON cart_recovery_commands WHEN EXISTS(SELECT 1 FROM cart_recovery_commands WHERE actor_id=NEW.actor_id AND command_id=NEW.command_id) BEGIN SELECT RAISE(ABORT,'immutable_cart_recovery_command'); END;
CREATE TRIGGER cart_recovery_delivery_no_delete BEFORE DELETE ON cart_recovery_deliveries BEGIN SELECT RAISE(ABORT,'immutable_cart_recovery_delivery'); END;
CREATE TRIGGER cart_recovery_delivery_no_replace BEFORE INSERT ON cart_recovery_deliveries WHEN EXISTS(SELECT 1 FROM cart_recovery_deliveries WHERE id=NEW.id OR association_id=NEW.association_id) BEGIN SELECT RAISE(ABORT,'immutable_cart_recovery_delivery'); END;
CREATE TRIGGER cart_recovery_delivery_update BEFORE UPDATE ON cart_recovery_deliveries WHEN NEW.id<>OLD.id OR NEW.association_id<>OLD.association_id OR NEW.customer_id<>OLD.customer_id OR NEW.source_hash<>OLD.source_hash OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at OR NEW.next_eligible_at<>OLD.next_eligible_at
 OR NOT((OLD.status='pending' AND NEW.status IN('sending','skipped')) OR(OLD.status='sending' AND NEW.status IN('sent','manual_review')))
 BEGIN SELECT RAISE(ABORT,'immutable_cart_recovery_delivery'); END;
