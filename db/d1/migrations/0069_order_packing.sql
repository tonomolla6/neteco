-- Governed packing revisions and manually declared expeditions. This records
-- no provider verification and does not alter fulfillment, stock or money.
CREATE TABLE order_packing_commands (
 command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
 claim_nonce TEXT NOT NULL UNIQUE CHECK(length(claim_nonce)=36),
 actor_id TEXT NOT NULL REFERENCES identities(id), order_id TEXT NOT NULL REFERENCES orders(id),
 action TEXT NOT NULL CHECK(action IN('pack','manual_dispatch')),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
 input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object'),
 expected_version INTEGER NOT NULL CHECK(expected_version BETWEEN 0 AND 9007199254740990),
 result_version INTEGER NOT NULL CHECK(result_version=expected_version+1),
 fulfillment_version INTEGER NOT NULL CHECK(fulfillment_version>=1),
 source_snapshot TEXT NOT NULL CHECK(json_valid(source_snapshot) AND json_type(source_snapshot)='object'),
 parcels TEXT NOT NULL CHECK(json_valid(parcels) AND json_type(parcels)='array' AND json_array_length(parcels) BETWEEN 1 AND 20),
 dispatch TEXT CHECK(dispatch IS NULL OR (json_valid(dispatch) AND json_type(dispatch)='object')),
 response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object'),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 CHECK((action='pack' AND dispatch IS NULL) OR (action='manual_dispatch' AND dispatch IS NOT NULL)),
 UNIQUE(order_id,result_version)
) STRICT;
CREATE TABLE order_packings (
 order_id TEXT PRIMARY KEY REFERENCES orders(id), version INTEGER NOT NULL CHECK(version>=1),
 state TEXT NOT NULL CHECK(state IN('packed','manual_dispatch_recorded')),
 parcels TEXT NOT NULL CHECK(json_valid(parcels) AND json_type(parcels)='array' AND json_array_length(parcels) BETWEEN 1 AND 20),
 dispatch TEXT CHECK(dispatch IS NULL OR (json_valid(dispatch) AND json_type(dispatch)='object')),
 last_command_id TEXT NOT NULL REFERENCES order_packing_commands(command_id),
 updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'')),
 CHECK((state='packed' AND dispatch IS NULL) OR (state='manual_dispatch_recorded' AND dispatch IS NOT NULL))
) STRICT;
CREATE TABLE order_packing_audit (
 command_id TEXT PRIMARY KEY REFERENCES order_packing_commands(command_id),
 actor_id TEXT NOT NULL REFERENCES identities(id), order_id TEXT NOT NULL REFERENCES orders(id),
 action TEXT NOT NULL, payload_hash TEXT NOT NULL, input TEXT NOT NULL,
 expected_version INTEGER NOT NULL, result_version INTEGER NOT NULL, fulfillment_version INTEGER NOT NULL,
 source_snapshot TEXT NOT NULL, parcels TEXT NOT NULL, dispatch TEXT, response TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(order_id,result_version)
) STRICT;
CREATE TRIGGER order_packing_command_no_update BEFORE UPDATE ON order_packing_commands BEGIN SELECT RAISE(ABORT,'order_packing_immutable'); END;
CREATE TRIGGER order_packing_command_no_delete BEFORE DELETE ON order_packing_commands BEGIN SELECT RAISE(ABORT,'order_packing_immutable'); END;
CREATE TRIGGER order_packing_projection_insert BEFORE INSERT ON order_packings
WHEN (NEW.version<>1 AND NOT EXISTS(SELECT 1 FROM order_packings WHERE order_id=NEW.order_id)) OR NOT EXISTS(SELECT 1 FROM order_packing_commands c WHERE c.command_id=NEW.last_command_id AND c.order_id=NEW.order_id
 AND c.result_version=NEW.version AND c.parcels=NEW.parcels AND c.dispatch IS NEW.dispatch AND c.created_at=NEW.updated_at
 AND NEW.state=CASE c.action WHEN 'pack' THEN 'packed' ELSE 'manual_dispatch_recorded' END)
BEGIN SELECT RAISE(ABORT,'order_packing_unconfirmed'); END;
CREATE TRIGGER order_packing_projection_update BEFORE UPDATE ON order_packings
WHEN NEW.order_id<>OLD.order_id OR OLD.dispatch IS NOT NULL OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at
 OR NOT EXISTS(SELECT 1 FROM order_packing_commands c WHERE c.command_id=NEW.last_command_id AND c.order_id=NEW.order_id
 AND c.expected_version=OLD.version AND c.result_version=NEW.version AND c.parcels=NEW.parcels AND c.dispatch IS NEW.dispatch AND c.created_at=NEW.updated_at
 AND NEW.state=CASE c.action WHEN 'pack' THEN 'packed' ELSE 'manual_dispatch_recorded' END)
BEGIN SELECT RAISE(ABORT,'order_packing_unconfirmed'); END;
CREATE TRIGGER order_packing_projection_no_delete BEFORE DELETE ON order_packings BEGIN SELECT RAISE(ABORT,'order_packing_immutable'); END;
CREATE TRIGGER order_packing_audit_insert BEFORE INSERT ON order_packing_audit
WHEN NOT EXISTS(SELECT 1 FROM order_packing_commands c WHERE c.command_id=NEW.command_id AND c.actor_id=NEW.actor_id AND c.order_id=NEW.order_id
 AND c.action=NEW.action AND c.payload_hash=NEW.payload_hash AND c.input=NEW.input AND c.expected_version=NEW.expected_version
 AND c.result_version=NEW.result_version AND c.fulfillment_version=NEW.fulfillment_version AND c.source_snapshot=NEW.source_snapshot
 AND c.parcels=NEW.parcels AND c.dispatch IS NEW.dispatch AND c.response=NEW.response AND c.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'order_packing_audit_unconfirmed'); END;
CREATE TRIGGER order_packing_audit_no_update BEFORE UPDATE ON order_packing_audit BEGIN SELECT RAISE(ABORT,'order_packing_immutable'); END;
CREATE TRIGGER order_packing_audit_no_delete BEFORE DELETE ON order_packing_audit BEGIN SELECT RAISE(ABORT,'order_packing_immutable'); END;
CREATE TABLE order_packing_guards(id TEXT PRIMARY KEY,satisfied INTEGER NOT NULL CHECK(satisfied=1)) STRICT;
