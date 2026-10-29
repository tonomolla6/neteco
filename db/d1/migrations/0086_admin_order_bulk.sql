CREATE TABLE admin_order_bulk_groups (
  id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL UNIQUE,
  command_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES identities(id),
  session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  session_version INTEGER NOT NULL CHECK(session_version>=1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  preview_json TEXT NOT NULL CHECK(json_valid(preview_json)),
  sources_json TEXT NOT NULL CHECK(json_valid(sources_json)),
  children_json TEXT NOT NULL CHECK(json_valid(children_json) AND json_array_length(children_json) BETWEEN 1 AND 25),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  claim_nonce TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(actor_id,command_id)
) STRICT;
CREATE TABLE admin_order_bulk_attempts (
  group_id TEXT NOT NULL REFERENCES admin_order_bulk_groups(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  PRIMARY KEY(group_id,order_id)
) STRICT;
CREATE TABLE admin_order_bulk_results (
  group_id TEXT NOT NULL REFERENCES admin_order_bulk_groups(id),
  order_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('applied','rejected','not_attempted')),
  reason TEXT,
  receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  recorded_at TEXT NOT NULL CHECK(recorded_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',recorded_at),'')),
  CHECK((status='applied' AND reason IS NULL AND receipt_json IS NOT NULL) OR (status<>'applied' AND reason IS NOT NULL AND receipt_json IS NULL)),
  PRIMARY KEY(group_id,order_id)
) STRICT;
CREATE TABLE admin_order_bulk_pauses (
  group_id TEXT PRIMARY KEY REFERENCES admin_order_bulk_groups(id),
  reason TEXT NOT NULL CHECK(reason IN('unauthenticated','email_unverified','mfa_required','forbidden')),
  recorded_at TEXT NOT NULL CHECK(recorded_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',recorded_at),''))
) STRICT;
CREATE TABLE admin_order_bulk_guards (id TEXT PRIMARY KEY, satisfied INTEGER NOT NULL CHECK(satisfied=1)) STRICT;
CREATE TRIGGER admin_order_bulk_group_no_update BEFORE UPDATE ON admin_order_bulk_groups BEGIN SELECT RAISE(ABORT,'admin_order_bulk_immutable'); END;
CREATE TRIGGER admin_order_bulk_group_no_delete BEFORE DELETE ON admin_order_bulk_groups BEGIN SELECT RAISE(ABORT,'admin_order_bulk_immutable'); END;
CREATE TRIGGER admin_order_bulk_group_no_replace BEFORE INSERT ON admin_order_bulk_groups WHEN EXISTS(SELECT 1 FROM admin_order_bulk_groups WHERE id=NEW.id OR dispatch_id=NEW.dispatch_id OR (actor_id=NEW.actor_id AND command_id=NEW.command_id)) BEGIN SELECT RAISE(ABORT,'admin_order_bulk_immutable'); END;
CREATE TRIGGER admin_order_bulk_group_receipt BEFORE INSERT ON admin_order_bulk_groups BEGIN
 SELECT CASE WHEN json_extract(NEW.receipt_json,'$.groupId') IS NOT NEW.id
 OR json_extract(NEW.receipt_json,'$.dispatchId') IS NOT NEW.dispatch_id
 OR json_extract(NEW.receipt_json,'$.commandId') IS NOT NEW.command_id
 OR json_extract(NEW.receipt_json,'$.payloadHash') IS NOT NEW.payload_hash
 OR json_extract(NEW.receipt_json,'$.recordedAt') IS NOT NEW.created_at
 OR json_extract(NEW.receipt_json,'$.previewHash') IS NOT json_extract(NEW.input_json,'$.previewHash')
 OR json_array_length(NEW.children_json) IS NOT json_array_length(NEW.input_json,'$.orders')
 OR json_array_length(NEW.children_json) IS NOT json_extract(NEW.receipt_json,'$.selected')
 THEN RAISE(ABORT,'admin_order_bulk_receipt') END;
END;
CREATE TRIGGER admin_order_bulk_attempt_source BEFORE INSERT ON admin_order_bulk_attempts BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM admin_order_bulk_groups g,json_each(g.children_json) c
 WHERE g.id=NEW.group_id AND json_extract(c.value,'$.orderId')=NEW.order_id
 AND NOT EXISTS(SELECT 1 FROM admin_order_bulk_results r WHERE r.group_id=g.id AND r.order_id=NEW.order_id)
 AND NOT EXISTS(SELECT 1 FROM admin_order_bulk_pauses p WHERE p.group_id=g.id)) THEN RAISE(ABORT,'admin_order_bulk_attempt') END;
END;
CREATE TRIGGER admin_order_bulk_result_source BEFORE INSERT ON admin_order_bulk_results BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM admin_order_bulk_groups g,json_each(g.children_json) child
 WHERE g.id=NEW.group_id AND json_extract(child.value,'$.orderId')=NEW.order_id
 AND (NEW.status<>'applied' OR EXISTS(SELECT 1 FROM order_fulfillment_commands c JOIN order_fulfillment_audit a ON a.command_id=c.id
 WHERE c.actor_id=g.actor_id AND c.order_id=NEW.order_id AND c.idempotency_key=json_extract(child.value,'$.childKey')
 AND c.expected_version=json_extract(child.value,'$.expectedVersion') AND c.action=json_extract(g.input_json,'$.action')
 AND c.response=NEW.receipt_json AND a.response=c.response))) THEN RAISE(ABORT,'admin_order_bulk_result') END;
END;
CREATE TRIGGER admin_order_bulk_attempt_no_update BEFORE UPDATE ON admin_order_bulk_attempts BEGIN SELECT RAISE(ABORT,'admin_order_bulk_immutable'); END;
CREATE TRIGGER admin_order_bulk_attempt_no_delete BEFORE DELETE ON admin_order_bulk_attempts BEGIN SELECT RAISE(ABORT,'admin_order_bulk_immutable'); END;
CREATE TRIGGER admin_order_bulk_result_no_update BEFORE UPDATE ON admin_order_bulk_results BEGIN SELECT RAISE(ABORT,'admin_order_bulk_immutable'); END;
CREATE TRIGGER admin_order_bulk_result_no_delete BEFORE DELETE ON admin_order_bulk_results BEGIN SELECT RAISE(ABORT,'admin_order_bulk_immutable'); END;
CREATE TRIGGER admin_order_bulk_pause_no_update BEFORE UPDATE ON admin_order_bulk_pauses BEGIN SELECT RAISE(ABORT,'admin_order_bulk_immutable'); END;
CREATE TRIGGER admin_order_bulk_pause_no_delete BEFORE DELETE ON admin_order_bulk_pauses BEGIN SELECT RAISE(ABORT,'admin_order_bulk_immutable'); END;
CREATE TRIGGER admin_order_bulk_attempt_no_replace BEFORE INSERT ON admin_order_bulk_attempts WHEN EXISTS(SELECT 1 FROM admin_order_bulk_attempts WHERE group_id=NEW.group_id AND order_id=NEW.order_id) BEGIN SELECT RAISE(ABORT,'admin_order_bulk_immutable'); END;
CREATE TRIGGER admin_order_bulk_result_no_replace BEFORE INSERT ON admin_order_bulk_results WHEN EXISTS(SELECT 1 FROM admin_order_bulk_results WHERE group_id=NEW.group_id AND order_id=NEW.order_id) BEGIN SELECT RAISE(ABORT,'admin_order_bulk_immutable'); END;
CREATE TRIGGER admin_order_bulk_pause_no_replace BEFORE INSERT ON admin_order_bulk_pauses WHEN EXISTS(SELECT 1 FROM admin_order_bulk_pauses WHERE group_id=NEW.group_id) BEGIN SELECT RAISE(ABORT,'admin_order_bulk_immutable'); END;
