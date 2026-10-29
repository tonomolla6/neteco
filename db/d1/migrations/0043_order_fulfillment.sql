-- Manual operational fulfillment of the existing single warehouse only.
-- Payment already applies the allocate decrement. This migration neither
-- creates warehouses/grants nor changes orders, lines, payments or inventory.
-- Historical orders have no fabricated fulfillment: pending/version zero is
-- a read-time default; the first confirmed command creates the projection.
CREATE TABLE order_fulfillment_commands (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  claim_nonce TEXT NOT NULL UNIQUE CHECK(length(claim_nonce)=36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  action TEXT NOT NULL CHECK(action IN ('picking','packed','ready_for_pickup','in_transit','delivered','exception')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object' AND json_extract(input,'$.action')=action),
  expected_version INTEGER NOT NULL CHECK(expected_version BETWEEN 0 AND 9007199254740990 AND json_extract(input,'$.expectedVersion')=expected_version),
  result_version INTEGER NOT NULL CHECK(result_version=expected_version+1),
  from_state TEXT NOT NULL CHECK(from_state IN ('pending','picking','packed','ready_for_pickup','in_transit','delivered','exception')),
  to_state TEXT NOT NULL CHECK(to_state=action),
  interrupted_state TEXT CHECK(interrupted_state IS NULL OR interrupted_state IN ('pending','picking','packed','ready_for_pickup','in_transit')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 500 AND json_extract(input,'$.reason')=reason),
  evidence TEXT CHECK(evidence IS NULL OR (length(trim(evidence)) BETWEEN 10 AND 500 AND json_extract(input,'$.evidence')=evidence)),
  source_snapshot TEXT NOT NULL CHECK(json_valid(source_snapshot) AND json_type(source_snapshot)='object'),
  response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object'
    AND COALESCE(json_extract(response,'$.source')='cloudflare',0)
    AND COALESCE(json_extract(response,'$.action')=action,0)
    AND COALESCE(json_extract(response,'$.commandId')=id,0)
    AND COALESCE(json_extract(response,'$.orderId')=order_id,0)
    AND COALESCE(json_extract(response,'$.warehouseId')=location_id,0)
    AND COALESCE(json_extract(response,'$.state')=to_state,0)
    AND json_extract(response,'$.interruptedState') IS interrupted_state
    AND COALESCE(json_extract(response,'$.version')=result_version,0)
    AND COALESCE(json_extract(response,'$.inventoryEffect')='none',0)
    AND COALESCE(json_type(response,'$.updated')='true',0)),
  created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(actor_id,idempotency_key),UNIQUE(order_id,result_version),
  CHECK((to_state='exception' AND interrupted_state=from_state AND from_state NOT IN ('exception','delivered'))
    OR (to_state<>'exception' AND interrupted_state IS NULL)),
  CHECK(action NOT IN ('in_transit','delivered','exception') OR evidence IS NOT NULL)
) STRICT;
CREATE TRIGGER order_fulfillment_commands_duplicate BEFORE INSERT ON order_fulfillment_commands
WHEN EXISTS(SELECT 1 FROM order_fulfillment_commands WHERE id=NEW.id OR claim_nonce=NEW.claim_nonce
  OR (actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key) OR (order_id=NEW.order_id AND result_version=NEW.result_version))
BEGIN SELECT RAISE(ABORT,'order_fulfillment_commands_immutable'); END;
CREATE TRIGGER order_fulfillment_commands_no_update BEFORE UPDATE ON order_fulfillment_commands
BEGIN SELECT RAISE(ABORT,'order_fulfillment_commands_immutable'); END;
CREATE TRIGGER order_fulfillment_commands_no_delete BEFORE DELETE ON order_fulfillment_commands
BEGIN SELECT RAISE(ABORT,'order_fulfillment_commands_immutable'); END;

CREATE TABLE order_fulfillments (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  status TEXT NOT NULL CHECK(status IN ('picking','packed','ready_for_pickup','in_transit','delivered','exception')),
  interrupted_state TEXT CHECK(interrupted_state IS NULL OR interrupted_state IN ('pending','picking','packed','ready_for_pickup','in_transit')),
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
  last_command_id TEXT NOT NULL UNIQUE REFERENCES order_fulfillment_commands(id),
  created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  updated_at TEXT NOT NULL CHECK(length(updated_at)=20 AND updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'') AND updated_at>=created_at),
  CHECK((status='exception')=(interrupted_state IS NOT NULL))
) STRICT;
CREATE TRIGGER order_fulfillments_insert BEFORE INSERT ON order_fulfillments
WHEN NOT EXISTS(SELECT 1 FROM order_fulfillment_commands c WHERE c.id=NEW.last_command_id AND c.order_id=NEW.order_id
  AND c.location_id=NEW.location_id AND c.expected_version=0 AND c.result_version=1 AND c.to_state=NEW.status
  AND c.interrupted_state IS NEW.interrupted_state AND NEW.version=1 AND c.created_at=NEW.created_at AND NEW.updated_at=NEW.created_at)
  OR EXISTS(SELECT 1 FROM order_fulfillments WHERE order_id=NEW.order_id OR last_command_id=NEW.last_command_id)
BEGIN SELECT RAISE(ABORT,'order_fulfillment_projection_invalid'); END;
CREATE TRIGGER order_fulfillments_update BEFORE UPDATE ON order_fulfillments
WHEN NEW.order_id<>OLD.order_id OR NEW.location_id<>OLD.location_id OR NEW.created_at<>OLD.created_at
  OR NEW.version<>OLD.version+1 OR NOT EXISTS(SELECT 1 FROM order_fulfillment_commands c
    WHERE c.id=NEW.last_command_id AND c.order_id=NEW.order_id AND c.location_id=NEW.location_id
      AND c.expected_version=OLD.version AND c.result_version=NEW.version AND c.from_state=OLD.status
      AND c.to_state=NEW.status AND c.interrupted_state IS NEW.interrupted_state AND c.created_at=NEW.updated_at)
BEGIN SELECT RAISE(ABORT,'order_fulfillment_projection_invalid'); END;
CREATE TRIGGER order_fulfillments_no_delete BEFORE DELETE ON order_fulfillments
BEGIN SELECT RAISE(ABORT,'order_fulfillment_projection_immutable'); END;

CREATE TRIGGER order_fulfillment_commands_transition BEFORE INSERT ON order_fulfillment_commands
WHEN NOT EXISTS(SELECT 1 FROM orders o LEFT JOIN order_fulfillments f ON f.order_id=o.id
  WHERE o.id=NEW.order_id AND o.status<>'cancelled' AND NEW.expected_version=COALESCE(f.version,0)
    AND NEW.from_state=COALESCE(f.status,'pending') AND (f.order_id IS NULL OR f.location_id=NEW.location_id)
    AND ((NEW.from_state='pending' AND NEW.action IN ('picking','exception'))
      OR (NEW.from_state='picking' AND NEW.action IN ('packed','exception'))
      OR (NEW.from_state='packed' AND (NEW.action='exception'
        OR (NEW.action='ready_for_pickup' AND o.shipping_method_code='pickup')
        OR (NEW.action='in_transit' AND o.shipping_method_code IN ('own_delivery','parcel'))))
      OR (NEW.from_state IN ('ready_for_pickup','in_transit') AND NEW.action IN ('delivered','exception'))
      OR (NEW.from_state='exception' AND NEW.action=CASE f.interrupted_state WHEN 'pending' THEN 'picking' ELSE f.interrupted_state END)))
BEGIN SELECT RAISE(ABORT,'order_fulfillment_transition_invalid'); END;

CREATE TABLE order_fulfillment_audit (
  id TEXT PRIMARY KEY CHECK(length(id)=36),command_id TEXT NOT NULL UNIQUE REFERENCES order_fulfillment_commands(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),order_id TEXT NOT NULL REFERENCES orders(id),location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  action TEXT NOT NULL,input TEXT NOT NULL,expected_version INTEGER NOT NULL,result_version INTEGER NOT NULL,
  from_state TEXT NOT NULL,to_state TEXT NOT NULL,interrupted_state TEXT,reason TEXT NOT NULL,evidence TEXT,
  source_snapshot TEXT NOT NULL,response TEXT NOT NULL,created_at TEXT NOT NULL
) STRICT;
CREATE INDEX order_fulfillment_audit_timeline ON order_fulfillment_audit(order_id,result_version DESC);
CREATE TRIGGER order_fulfillment_audit_duplicate BEFORE INSERT ON order_fulfillment_audit
WHEN EXISTS(SELECT 1 FROM order_fulfillment_audit WHERE id=NEW.id OR command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'order_fulfillment_audit_immutable'); END;
CREATE TRIGGER order_fulfillment_audit_command BEFORE INSERT ON order_fulfillment_audit
WHEN NOT EXISTS(SELECT 1 FROM order_fulfillment_commands c WHERE c.id=NEW.command_id
  AND c.actor_id=NEW.actor_id AND c.order_id=NEW.order_id AND c.location_id=NEW.location_id AND c.action=NEW.action
  AND c.input=NEW.input AND c.expected_version=NEW.expected_version AND c.result_version=NEW.result_version
  AND c.from_state=NEW.from_state AND c.to_state=NEW.to_state AND c.interrupted_state IS NEW.interrupted_state
  AND c.reason=NEW.reason AND c.evidence IS NEW.evidence AND c.source_snapshot=NEW.source_snapshot AND c.response=NEW.response AND c.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'order_fulfillment_audit_invalid'); END;
CREATE TRIGGER order_fulfillment_audit_no_update BEFORE UPDATE ON order_fulfillment_audit
BEGIN SELECT RAISE(ABORT,'order_fulfillment_audit_immutable'); END;
CREATE TRIGGER order_fulfillment_audit_no_delete BEFORE DELETE ON order_fulfillment_audit
BEGIN SELECT RAISE(ABORT,'order_fulfillment_audit_immutable'); END;
CREATE TABLE order_fulfillment_guards(id TEXT PRIMARY KEY,satisfied INTEGER NOT NULL CONSTRAINT order_fulfillment_atomic_guard CHECK(satisfied=1)) STRICT;
