-- Operator-reviewed operating calendars. No holiday seeds or carrier SLA.
CREATE TABLE shipping_calendar_commands (
 actor_id TEXT NOT NULL REFERENCES identities(id), command_id TEXT NOT NULL,
 expected_version INTEGER NOT NULL CHECK(expected_version BETWEEN 0 AND 9007199254740990),
 result_version INTEGER NOT NULL UNIQUE CHECK(result_version=expected_version+1),
 input_json TEXT NOT NULL CHECK(json_valid(input_json) AND json_type(input_json)='object'),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json)='object'),
 recorded_at TEXT NOT NULL CHECK(recorded_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',recorded_at),'')),
 PRIMARY KEY(actor_id,command_id),
 CHECK(COALESCE(json_extract(input_json,'$.expectedVersion')=expected_version
 AND json_type(input_json,'$.configuration')='object'
 AND length(trim(json_extract(input_json,'$.reason'))) BETWEEN 10 AND 500
 AND length(trim(json_extract(input_json,'$.reviewReference'))) BETWEEN 3 AND 200,0)),
 CHECK(COALESCE(json_extract(receipt_json,'$.source')='cloudflare'
 AND json_extract(receipt_json,'$.commandId')=command_id AND json_extract(receipt_json,'$.payloadHash')=payload_hash
 AND json_extract(receipt_json,'$.expectedVersion')=expected_version AND json_extract(receipt_json,'$.version')=result_version
 AND json_extract(receipt_json,'$.recordedAt')=recorded_at,0))
) STRICT;
CREATE TABLE shipping_calendar_heads (
 id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version>=1),
 actor_id TEXT NOT NULL,command_id TEXT NOT NULL,updated_at TEXT NOT NULL,
 FOREIGN KEY(actor_id,command_id) REFERENCES shipping_calendar_commands(actor_id,command_id)
) STRICT;
CREATE TRIGGER shipping_calendar_command_admission BEFORE INSERT ON shipping_calendar_commands
WHEN NEW.expected_version<>COALESCE((SELECT version FROM shipping_calendar_heads WHERE id=1),0)
 OR EXISTS(SELECT 1 FROM shipping_calendar_commands WHERE actor_id=NEW.actor_id AND command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'shipping_calendar_command_invalid'); END;
CREATE TRIGGER shipping_calendar_command_project AFTER INSERT ON shipping_calendar_commands
BEGIN INSERT INTO shipping_calendar_heads(id,version,actor_id,command_id,updated_at)
 VALUES(1,NEW.result_version,NEW.actor_id,NEW.command_id,NEW.recorded_at)
 ON CONFLICT(id) DO UPDATE SET version=excluded.version,actor_id=excluded.actor_id,command_id=excluded.command_id,updated_at=excluded.updated_at; END;
CREATE TRIGGER shipping_calendar_head_insert BEFORE INSERT ON shipping_calendar_heads
WHEN NOT EXISTS(SELECT 1 FROM shipping_calendar_commands c WHERE c.actor_id=NEW.actor_id AND c.command_id=NEW.command_id
 AND c.result_version=NEW.version AND c.recorded_at=NEW.updated_at)
BEGIN SELECT RAISE(ABORT,'shipping_calendar_head_invalid'); END;
CREATE TRIGGER shipping_calendar_head_update BEFORE UPDATE ON shipping_calendar_heads
WHEN NEW.id IS NOT OLD.id OR NEW.version<>OLD.version+1 OR NOT EXISTS(SELECT 1 FROM shipping_calendar_commands c
 WHERE c.actor_id=NEW.actor_id AND c.command_id=NEW.command_id AND c.result_version=NEW.version AND c.recorded_at=NEW.updated_at)
BEGIN SELECT RAISE(ABORT,'shipping_calendar_head_invalid'); END;
CREATE TRIGGER shipping_calendar_head_no_delete BEFORE DELETE ON shipping_calendar_heads BEGIN SELECT RAISE(ABORT,'immutable_shipping_calendar_head'); END;
CREATE TRIGGER shipping_calendar_head_no_replace BEFORE INSERT ON shipping_calendar_heads
WHEN EXISTS(SELECT 1 FROM shipping_calendar_heads WHERE id=NEW.id) AND NEW.version<=(SELECT version FROM shipping_calendar_heads WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'immutable_shipping_calendar_head'); END;
CREATE TRIGGER shipping_calendar_command_no_update BEFORE UPDATE ON shipping_calendar_commands BEGIN SELECT RAISE(ABORT,'immutable_shipping_calendar_command'); END;
CREATE TRIGGER shipping_calendar_command_no_delete BEFORE DELETE ON shipping_calendar_commands BEGIN SELECT RAISE(ABORT,'immutable_shipping_calendar_command'); END;
CREATE TABLE shipping_calendar_guards(id TEXT PRIMARY KEY,valid INTEGER NOT NULL CONSTRAINT shipping_calendar_atomic_guard CHECK(valid=1)) STRICT;
