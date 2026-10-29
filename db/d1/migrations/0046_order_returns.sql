-- Single-warehouse RMA custody, not financial resolution or inventory receipt.
-- No policy/grant/customer ownership is invented, no historical order changes,
-- and no stock/payment/fiscal/provider/outbox side effect is granted here.
CREATE TABLE order_return_commands (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  claim_nonce TEXT NOT NULL UNIQUE CHECK(length(claim_nonce)=36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('admin','customer')),
  order_id TEXT NOT NULL REFERENCES orders(id),
  return_id TEXT NOT NULL CHECK(length(return_id)=36),
  public_ref TEXT NOT NULL CHECK(length(public_ref)=28 AND public_ref GLOB 'RMA-*' AND substr(public_ref,5) NOT GLOB '*[^0-9A-F]*'),
  location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  action TEXT NOT NULL CHECK(action IN ('requested','approved','rejected','received','inspected','resolution_ready')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object'),
  expected_version INTEGER NOT NULL CHECK(expected_version BETWEEN 0 AND 9007199254740990),
  result_version INTEGER NOT NULL CHECK(result_version=expected_version+1),
  expected_order_version INTEGER NOT NULL CHECK(expected_order_version BETWEEN 0 AND 9007199254740990),
  result_order_version INTEGER NOT NULL CHECK(result_order_version=expected_order_version+1),
  from_state TEXT CHECK(from_state IN ('requested','approved','received','inspected')),
  to_state TEXT NOT NULL CHECK(to_state=action),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 500 AND json_extract(input,'$.reason')=reason),
  public_message TEXT NOT NULL CHECK(length(trim(public_message)) BETWEEN 10 AND 500),
  source_snapshot TEXT NOT NULL CHECK(json_valid(source_snapshot) AND json_type(source_snapshot)='object'),
  response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object'
    AND COALESCE(json_extract(response,'$.source')='cloudflare',0)
    AND COALESCE(json_extract(response,'$.commandId')=id,0)
    AND COALESCE(json_extract(response,'$.returnId')=return_id,0)
    AND COALESCE(json_extract(response,'$.publicRef')=public_ref,0)
    AND COALESCE(json_extract(response,'$.orderId')=order_id,0)
    AND COALESCE(json_extract(response,'$.action')=action,0)
    AND COALESCE(json_extract(response,'$.state')=to_state,0)
    AND COALESCE(json_extract(response,'$.version')=result_version,0)
    AND COALESCE(json_extract(response,'$.orderVersion')=result_order_version,0)
    AND COALESCE(json_extract(response,'$.inventoryEffect')='none',0)
    AND COALESCE(json_extract(response,'$.custody')='non_sellable',0)
    AND COALESCE(json_type(response,'$.updated')='true',0)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(actor_id,idempotency_key),UNIQUE(return_id,result_version),UNIQUE(order_id,result_order_version),
  CHECK((action='requested' AND actor_type='customer' AND expected_version=0 AND from_state IS NULL
      AND COALESCE(json_extract(input,'$.expectedVersion')=expected_order_version,0))
    OR (action<>'requested' AND actor_type='admin' AND expected_version>=1 AND from_state IS NOT NULL
      AND COALESCE(json_extract(input,'$.expectedVersion')=expected_version,0)
      AND COALESCE(json_extract(input,'$.action')=action,0)
      AND COALESCE(json_extract(input,'$.publicMessage')=public_message,0)
      AND COALESCE(length(trim(json_extract(input,'$.evidence'))) BETWEEN 10 AND 500,0)))
) STRICT;
CREATE INDEX order_return_commands_order ON order_return_commands(order_id,result_order_version);
CREATE TRIGGER order_return_commands_duplicate BEFORE INSERT ON order_return_commands
WHEN EXISTS(SELECT 1 FROM order_return_commands WHERE id=NEW.id OR claim_nonce=NEW.claim_nonce
  OR (actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key)
  OR (return_id=NEW.return_id AND result_version=NEW.result_version)
  OR (order_id=NEW.order_id AND result_order_version=NEW.result_order_version))
BEGIN SELECT RAISE(ABORT,'order_return_commands_immutable'); END;
CREATE TRIGGER order_return_commands_no_update BEFORE UPDATE ON order_return_commands
BEGIN SELECT RAISE(ABORT,'order_return_commands_immutable'); END;
CREATE TRIGGER order_return_commands_no_delete BEFORE DELETE ON order_return_commands
BEGIN SELECT RAISE(ABORT,'order_return_commands_immutable'); END;

CREATE TABLE order_returns (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  public_ref TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL REFERENCES orders(id),
  location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  state TEXT NOT NULL CHECK(state IN ('requested','approved','rejected','received','inspected','resolution_ready')),
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 500),
  last_command_id TEXT NOT NULL UNIQUE REFERENCES order_return_commands(id),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'') AND updated_at>=created_at)
) STRICT;
CREATE INDEX order_returns_order ON order_returns(order_id,created_at DESC,id DESC);
CREATE INDEX order_returns_state ON order_returns(state,updated_at,id);
CREATE TRIGGER order_returns_insert BEFORE INSERT ON order_returns
WHEN EXISTS(SELECT 1 FROM order_returns WHERE id=NEW.id OR public_ref=NEW.public_ref OR last_command_id=NEW.last_command_id)
  OR NOT EXISTS(SELECT 1 FROM order_return_commands c WHERE c.id=NEW.last_command_id AND c.return_id=NEW.id
    AND c.public_ref=NEW.public_ref AND c.order_id=NEW.order_id AND c.location_id=NEW.location_id
    AND c.action='requested' AND c.reason=NEW.reason AND c.result_version=NEW.version AND NEW.version=1
    AND c.created_at=NEW.created_at AND NEW.updated_at=NEW.created_at AND NEW.state='requested')
BEGIN SELECT RAISE(ABORT,'order_return_projection_invalid'); END;
CREATE TRIGGER order_returns_update BEFORE UPDATE ON order_returns
WHEN NEW.id<>OLD.id OR NEW.public_ref<>OLD.public_ref OR NEW.order_id<>OLD.order_id OR NEW.location_id<>OLD.location_id
  OR NEW.created_at<>OLD.created_at OR NEW.reason<>OLD.reason OR NEW.version<>OLD.version+1
  OR NOT EXISTS(SELECT 1 FROM order_return_commands c WHERE c.id=NEW.last_command_id AND c.return_id=NEW.id
    AND c.public_ref=NEW.public_ref AND c.order_id=NEW.order_id AND c.location_id=NEW.location_id
    AND c.from_state=OLD.state AND c.to_state=NEW.state AND c.expected_version=OLD.version
    AND c.result_version=NEW.version AND c.created_at=NEW.updated_at)
BEGIN SELECT RAISE(ABORT,'order_return_projection_invalid'); END;
CREATE TRIGGER order_returns_no_delete BEFORE DELETE ON order_returns
BEGIN SELECT RAISE(ABORT,'order_return_projection_immutable'); END;

CREATE TABLE order_return_lines (
  return_id TEXT NOT NULL REFERENCES order_returns(id),
  order_id TEXT NOT NULL,
  line_index INTEGER NOT NULL CHECK(line_index BETWEEN 0 AND 99),
  requested_quantity INTEGER NOT NULL CHECK(requested_quantity BETWEEN 1 AND 999),
  authorized_quantity INTEGER NOT NULL DEFAULT 0 CHECK(authorized_quantity BETWEEN 0 AND requested_quantity),
  received_quantity INTEGER NOT NULL DEFAULT 0 CHECK(received_quantity BETWEEN 0 AND authorized_quantity),
  inspected_quantity INTEGER NOT NULL DEFAULT 0 CHECK(inspected_quantity BETWEEN 0 AND received_quantity),
  claimed_quantity INTEGER NOT NULL CHECK(claimed_quantity BETWEEN received_quantity AND requested_quantity),
  last_command_id TEXT NOT NULL REFERENCES order_return_commands(id),
  PRIMARY KEY(return_id,line_index),
  FOREIGN KEY(order_id,line_index) REFERENCES order_lines(order_id,line_index)
) STRICT;
CREATE INDEX order_return_line_budget ON order_return_lines(order_id,line_index,claimed_quantity);
CREATE TRIGGER order_return_lines_insert BEFORE INSERT ON order_return_lines
WHEN EXISTS(SELECT 1 FROM order_return_lines WHERE return_id=NEW.return_id AND line_index=NEW.line_index)
  OR NEW.authorized_quantity<>0 OR NEW.received_quantity<>0 OR NEW.inspected_quantity<>0 OR NEW.claimed_quantity<>NEW.requested_quantity
  OR NOT EXISTS(SELECT 1 FROM order_returns r JOIN order_return_commands c ON c.id=r.last_command_id
    JOIN json_each(c.input,'$.lines') line WHERE r.id=NEW.return_id AND r.order_id=NEW.order_id AND c.id=NEW.last_command_id
    AND c.action='requested' AND json_extract(line.value,'$.lineIndex')=NEW.line_index
    AND json_extract(line.value,'$.quantity')=NEW.requested_quantity)
BEGIN SELECT RAISE(ABORT,'order_return_line_projection_invalid'); END;
CREATE TRIGGER order_return_lines_update BEFORE UPDATE ON order_return_lines
WHEN NEW.return_id<>OLD.return_id OR NEW.order_id<>OLD.order_id OR NEW.line_index<>OLD.line_index
  OR NEW.requested_quantity<>OLD.requested_quantity
  OR NOT EXISTS(SELECT 1 FROM order_returns r JOIN order_return_commands c ON c.id=r.last_command_id
    WHERE r.id=NEW.return_id AND c.id=NEW.last_command_id AND c.order_id=NEW.order_id
      AND NEW.authorized_quantity=CASE WHEN c.action='approved' THEN
        (SELECT json_extract(value,'$.quantity') FROM json_each(c.input,'$.lines') WHERE json_extract(value,'$.lineIndex')=OLD.line_index)
        ELSE OLD.authorized_quantity END
      AND NEW.received_quantity=OLD.received_quantity+CASE WHEN c.action='received' THEN COALESCE(
        (SELECT json_extract(value,'$.quantity') FROM json_each(c.input,'$.lines') WHERE json_extract(value,'$.lineIndex')=OLD.line_index),0) ELSE 0 END
      AND NEW.inspected_quantity=OLD.inspected_quantity+CASE WHEN c.action='inspected' THEN COALESCE(
        (SELECT json_extract(value,'$.quantity') FROM json_each(c.input,'$.lines') WHERE json_extract(value,'$.lineIndex')=OLD.line_index),0) ELSE 0 END
      AND NEW.claimed_quantity=CASE WHEN c.action='approved' THEN NEW.authorized_quantity
        WHEN c.action='rejected' AND OLD.received_quantity=0 THEN 0 ELSE OLD.claimed_quantity END)
BEGIN SELECT RAISE(ABORT,'order_return_line_projection_invalid'); END;
CREATE TRIGGER order_return_lines_insert_budget BEFORE INSERT ON order_return_lines
WHEN NEW.claimed_quantity+COALESCE((SELECT SUM(claimed_quantity) FROM order_return_lines
  WHERE order_id=NEW.order_id AND line_index=NEW.line_index),0)>
  COALESCE((SELECT quantity FROM order_lines WHERE order_id=NEW.order_id AND line_index=NEW.line_index),-1)
BEGIN SELECT RAISE(ABORT,'order_return_quantity_unavailable'); END;
CREATE TRIGGER order_return_lines_update_budget BEFORE UPDATE ON order_return_lines
WHEN NEW.claimed_quantity+COALESCE((SELECT SUM(claimed_quantity) FROM order_return_lines
  WHERE order_id=NEW.order_id AND line_index=NEW.line_index AND return_id<>NEW.return_id),0)>
  COALESCE((SELECT quantity FROM order_lines WHERE order_id=NEW.order_id AND line_index=NEW.line_index),-1)
BEGIN SELECT RAISE(ABORT,'order_return_quantity_unavailable'); END;
CREATE TRIGGER order_return_lines_no_delete BEFORE DELETE ON order_return_lines
BEGIN SELECT RAISE(ABORT,'order_return_line_projection_immutable'); END;

CREATE TRIGGER order_return_commands_transition BEFORE INSERT ON order_return_commands
WHEN NEW.expected_order_version<>(SELECT count(*) FROM order_return_commands WHERE order_id=NEW.order_id)
  OR (NEW.action='requested' AND (EXISTS(SELECT 1 FROM order_returns WHERE id=NEW.return_id OR public_ref=NEW.public_ref)
    OR COALESCE(json_type(NEW.input,'$.lines'),'')<>'array' OR json_array_length(NEW.input,'$.lines') NOT BETWEEN 1 AND 100
    OR (SELECT count(DISTINCT json_extract(value,'$.lineIndex')) FROM json_each(NEW.input,'$.lines'))<>json_array_length(NEW.input,'$.lines')
    OR EXISTS(SELECT 1 FROM json_each(NEW.input,'$.lines') line WHERE
      COALESCE(json_type(line.value,'$.quantity'),'')<>'integer' OR json_extract(line.value,'$.quantity') NOT BETWEEN 1 AND 999
      OR COALESCE(json_type(line.value,'$.lineIndex'),'')<>'integer'
      OR NOT EXISTS(SELECT 1 FROM order_lines WHERE order_id=NEW.order_id AND line_index=json_extract(line.value,'$.lineIndex')))))
  OR (NEW.action<>'requested' AND NOT EXISTS(SELECT 1 FROM order_returns r
    WHERE r.id=NEW.return_id AND r.public_ref=NEW.public_ref AND r.order_id=NEW.order_id AND r.location_id=NEW.location_id
      AND r.state=NEW.from_state AND r.version=NEW.expected_version
      AND ((r.state='requested' AND NEW.action IN ('approved','rejected'))
        OR (r.state IN ('approved','received') AND NEW.action='received'
          AND EXISTS(SELECT 1 FROM order_return_lines WHERE return_id=r.id AND received_quantity<authorized_quantity))
        OR (r.state IN ('received','inspected') AND NEW.action='inspected'
          AND NOT EXISTS(SELECT 1 FROM order_return_lines WHERE return_id=r.id AND received_quantity<>authorized_quantity)
          AND EXISTS(SELECT 1 FROM order_return_lines WHERE return_id=r.id AND inspected_quantity<received_quantity))
        OR (r.state='inspected' AND NEW.action='resolution_ready'
          AND NOT EXISTS(SELECT 1 FROM order_return_lines WHERE return_id=r.id
            AND (received_quantity<>authorized_quantity OR inspected_quantity<>received_quantity))))))
BEGIN SELECT RAISE(ABORT,'order_return_transition_invalid'); END;
CREATE TRIGGER order_return_commands_quantity BEFORE INSERT ON order_return_commands
WHEN NEW.action IN ('approved','received','inspected') AND (
  COALESCE(json_type(NEW.input,'$.lines'),'')<>'array' OR json_array_length(NEW.input,'$.lines') NOT BETWEEN 1 AND 100
  OR (SELECT count(DISTINCT json_extract(value,'$.lineIndex')) FROM json_each(NEW.input,'$.lines'))<>json_array_length(NEW.input,'$.lines')
  OR EXISTS(SELECT 1 FROM json_each(NEW.input,'$.lines') line WHERE COALESCE(json_type(line.value,'$.quantity'),'')<>'integer'
    OR json_extract(line.value,'$.quantity') NOT BETWEEN CASE WHEN NEW.action='approved' THEN 0 ELSE 1 END AND 999
    OR NOT EXISTS(SELECT 1 FROM order_return_lines stored WHERE stored.return_id=NEW.return_id
      AND stored.line_index=json_extract(line.value,'$.lineIndex')
      AND CASE NEW.action WHEN 'approved' THEN json_extract(line.value,'$.quantity')<=stored.requested_quantity
        WHEN 'received' THEN stored.received_quantity+json_extract(line.value,'$.quantity')<=stored.authorized_quantity
        WHEN 'inspected' THEN stored.inspected_quantity+json_extract(line.value,'$.quantity')<=stored.received_quantity END))
  OR (NEW.action='approved' AND (COALESCE(length(trim(json_extract(NEW.input,'$.decisionRef'))),0)<3
    OR NOT EXISTS(SELECT 1 FROM json_each(NEW.input,'$.lines') WHERE json_extract(value,'$.quantity')>0)
    OR (SELECT count(*) FROM order_return_lines WHERE return_id=NEW.return_id)<>json_array_length(NEW.input,'$.lines')))
  OR (NEW.action='inspected' AND EXISTS(SELECT 1 FROM json_each(NEW.input,'$.lines') WHERE
    COALESCE(json_extract(value,'$.condition'),'') NOT IN ('sealed','opened','damaged','unknown')
    OR COALESCE(json_extract(value,'$.disposition'),'') NOT IN ('quarantine','non_restockable','review_restock'))))
BEGIN SELECT RAISE(ABORT,'order_return_quantity_unavailable'); END;
CREATE TRIGGER order_return_commands_resolution BEFORE INSERT ON order_return_commands
WHEN NEW.action='resolution_ready' AND COALESCE(length(trim(json_extract(NEW.input,'$.resolution'))),0)<10
BEGIN SELECT RAISE(ABORT,'order_return_transition_invalid'); END;

CREATE TABLE order_return_events (
  command_id TEXT PRIMARY KEY REFERENCES order_return_commands(id),
  return_id TEXT NOT NULL REFERENCES order_returns(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  actor_type TEXT NOT NULL,order_id TEXT NOT NULL REFERENCES orders(id),action TEXT NOT NULL,
  version INTEGER NOT NULL,input TEXT NOT NULL,response TEXT NOT NULL,public_message TEXT NOT NULL,created_at TEXT NOT NULL
) STRICT;
CREATE INDEX order_return_events_timeline ON order_return_events(return_id,version DESC);
CREATE TRIGGER order_return_events_insert BEFORE INSERT ON order_return_events
WHEN EXISTS(SELECT 1 FROM order_return_events WHERE command_id=NEW.command_id)
  OR NOT EXISTS(SELECT 1 FROM order_return_commands c JOIN order_returns r ON r.id=c.return_id AND r.last_command_id=c.id
    WHERE c.id=NEW.command_id AND c.return_id=NEW.return_id AND c.actor_id=NEW.actor_id AND c.actor_type=NEW.actor_type
      AND c.order_id=NEW.order_id AND c.action=NEW.action AND c.result_version=NEW.version
      AND c.input=NEW.input AND c.response=NEW.response AND c.public_message=NEW.public_message AND c.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'order_return_event_invalid'); END;
CREATE TRIGGER order_return_events_no_update BEFORE UPDATE ON order_return_events
BEGIN SELECT RAISE(ABORT,'order_return_events_immutable'); END;
CREATE TRIGGER order_return_events_no_delete BEFORE DELETE ON order_return_events
BEGIN SELECT RAISE(ABORT,'order_return_events_immutable'); END;
CREATE TABLE order_return_guards(id TEXT PRIMARY KEY,satisfied INTEGER NOT NULL CHECK(satisfied=1)) STRICT;
