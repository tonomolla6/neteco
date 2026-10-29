-- Explicit alert thresholds are not safety stock and never change availability.
CREATE TABLE inventory_alert_commands (
 id TEXT PRIMARY KEY CHECK(length(id)=36), actor_id TEXT REFERENCES identities(id),
 source TEXT NOT NULL CHECK(source IN ('admin','cron')),
 action TEXT NOT NULL CHECK(action IN ('threshold','ack','evaluate')),
 target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 200),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object'),
 response TEXT NOT NULL CHECK(json_valid(response) AND COALESCE(
   json_extract(response,'$.source')='cloudflare' AND json_extract(response,'$.commandId')=id
   AND json_extract(response,'$.action')=action AND json_extract(response,'$.targetId')=target_id
   AND json_extract(response,'$.payloadHash')=payload_hash,0)),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 CHECK((source='admin' AND actor_id IS NOT NULL) OR (source='cron' AND actor_id IS NULL AND action='evaluate'))
) STRICT;
CREATE TRIGGER inventory_alert_commands_no_update BEFORE UPDATE ON inventory_alert_commands BEGIN SELECT RAISE(ABORT,'inventory_alert_command_immutable'); END;
CREATE TRIGGER inventory_alert_commands_no_delete BEFORE DELETE ON inventory_alert_commands BEGIN SELECT RAISE(ABORT,'inventory_alert_command_immutable'); END;
CREATE TABLE inventory_alert_policies (
 variant_id TEXT PRIMARY KEY REFERENCES variants(id), threshold INTEGER CHECK(threshold BETWEEN 0 AND 9007199254740990),
 version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740990),
 command_id TEXT NOT NULL UNIQUE REFERENCES inventory_alert_commands(id), updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE inventory_alert_episodes (
 id TEXT PRIMARY KEY CHECK(length(id)=36), variant_id TEXT NOT NULL REFERENCES variants(id),
 kind TEXT NOT NULL CHECK(kind IN ('low','out_of_stock','anomaly')),
 state TEXT NOT NULL CHECK(state IN ('open','acknowledged','resolved')),
 version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740990),
 command_id TEXT NOT NULL REFERENCES inventory_alert_commands(id),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX inventory_alert_current_episode ON inventory_alert_episodes(variant_id) WHERE state<>'resolved';
CREATE INDEX inventory_alert_queue ON inventory_alert_episodes(state,updated_at DESC,id DESC);
CREATE TABLE inventory_alert_audit (
 id TEXT PRIMARY KEY CHECK(length(id)=36), command_id TEXT NOT NULL REFERENCES inventory_alert_commands(id),
 variant_id TEXT NOT NULL REFERENCES variants(id), episode_id TEXT REFERENCES inventory_alert_episodes(id),
 action TEXT NOT NULL CHECK(action IN ('threshold','opened','changed','resolved','ack')),
 before_state TEXT NOT NULL CHECK(json_valid(before_state)), after_state TEXT NOT NULL CHECK(json_valid(after_state)),
 created_at TEXT NOT NULL, UNIQUE(command_id,variant_id,action)
) STRICT;
CREATE TRIGGER inventory_alert_audit_no_update BEFORE UPDATE ON inventory_alert_audit BEGIN SELECT RAISE(ABORT,'inventory_alert_audit_immutable'); END;
CREATE TRIGGER inventory_alert_audit_no_delete BEFORE DELETE ON inventory_alert_audit BEGIN SELECT RAISE(ABORT,'inventory_alert_audit_immutable'); END;
CREATE TABLE inventory_alert_evaluations (
 command_id TEXT NOT NULL REFERENCES inventory_alert_commands(id), variant_id TEXT NOT NULL REFERENCES variants(id),
 evaluated_at TEXT NOT NULL, PRIMARY KEY(command_id,variant_id)
) STRICT;
CREATE TRIGGER inventory_alert_evaluations_no_update BEFORE UPDATE ON inventory_alert_evaluations BEGIN SELECT RAISE(ABORT,'inventory_alert_evaluation_immutable'); END;
CREATE TRIGGER inventory_alert_evaluations_no_delete BEFORE DELETE ON inventory_alert_evaluations BEGIN SELECT RAISE(ABORT,'inventory_alert_evaluation_immutable'); END;
CREATE TABLE inventory_alert_guards(id TEXT PRIMARY KEY,satisfied INTEGER NOT NULL CHECK(satisfied=1)) STRICT;
