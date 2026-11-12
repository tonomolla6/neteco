-- Durable customer-order synchronization. Checkout only writes local D1 work;
-- no provider traffic, new fiscal authority or money/inventory side effects.
CREATE TABLE beply_order_sync (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
  synced_version INTEGER NOT NULL DEFAULT 0 CHECK(synced_version BETWEEN 0 AND version),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','leased','synced','manual_review')),
  create_state TEXT NOT NULL DEFAULT 'none' CHECK(create_state IN('none','started','known')),
  create_payload TEXT CHECK(create_payload IS NULL OR (length(create_payload)<=262144 AND json_valid(create_payload) AND json_type(create_payload)='object')),
  create_hash TEXT CHECK(create_hash IS NULL OR (length(create_hash)=64 AND create_hash NOT GLOB '*[^0-9a-f]*')),
  provider_order_id TEXT UNIQUE CHECK(provider_order_id IS NULL OR length(provider_order_id) BETWEEN 1 AND 100),
  provider_code TEXT CHECK(provider_code IS NULL OR length(provider_code) BETWEEN 1 AND 100),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
  due_at TEXT NOT NULL CHECK(length(due_at)=20 AND due_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',due_at),'')),
  lease_token TEXT, lease_until TEXT CHECK(lease_until IS NULL OR (length(lease_until)=20 AND lease_until=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',lease_until),''))),
  queue_attempts INTEGER NOT NULL DEFAULT 0 CHECK(queue_attempts>=0),
  queue_due_at TEXT NOT NULL CHECK(length(queue_due_at)=20 AND queue_due_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',queue_due_at),'')),
  erp_json TEXT CHECK(erp_json IS NULL OR (length(erp_json)<=65536 AND json_valid(erp_json) AND json_type(erp_json)='object')),
  erp_checked_at TEXT CHECK(erp_checked_at IS NULL OR (length(erp_checked_at)=20 AND erp_checked_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',erp_checked_at),''))),
  last_error_code TEXT CHECK(last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 80),
  confirmed_at TEXT NOT NULL CHECK(length(confirmed_at)=20 AND confirmed_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',confirmed_at),'')),
  updated_at TEXT NOT NULL CHECK(length(updated_at)=20 AND updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'')),
  CHECK((status='leased' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (status<>'leased' AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK((provider_order_id IS NULL)=(provider_code IS NULL)),
  CHECK((create_payload IS NULL)=(create_hash IS NULL)),
  CHECK(create_state='none' OR create_hash IS NOT NULL),
  CHECK((create_state='known')=(provider_order_id IS NOT NULL))
) STRICT;
CREATE INDEX beply_order_sync_due ON beply_order_sync(status,due_at,order_id);
CREATE INDEX beply_order_queue_due ON beply_order_sync(queue_due_at,order_id);
CREATE TABLE beply_order_alerts (
  order_id TEXT NOT NULL REFERENCES orders(id), version INTEGER NOT NULL CHECK(version>=1),
  code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  PRIMARY KEY(order_id,version,code)
) STRICT;
CREATE TABLE beply_order_commands (
  actor_id TEXT NOT NULL REFERENCES identities(id), command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 200),
  session_id TEXT NOT NULL REFERENCES auth_sessions(id), session_version INTEGER NOT NULL CHECK(session_version>=1),
  order_id TEXT NOT NULL REFERENCES orders(id), expected_version INTEGER NOT NULL CHECK(expected_version>=1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 500),
  created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  PRIMARY KEY(actor_id,command_id), UNIQUE(order_id,expected_version)
) STRICT;
CREATE TRIGGER beply_order_commands_authority BEFORE INSERT ON beply_order_commands
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 JOIN identity_roles r ON r.identity_id=i.id JOIN role_permissions p ON p.role_code=r.role_code
 WHERE s.id=NEW.session_id AND s.identity_id=NEW.actor_id AND s.session_version=NEW.session_version
 AND i.session_version=s.session_version AND i.status IN('active','pending') AND i.email_verified_at IS NOT NULL
 AND i.email_verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND s.mfa_verified=1 AND s.revoked_at IS NULL
 AND s.created_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
 AND r.granted_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND (r.expires_at IS NULL OR r.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 AND p.permission_code='administration.manage')
BEGIN SELECT RAISE(ABORT,'beply_authorization_changed'); END;
CREATE TRIGGER beply_order_commands_version BEFORE INSERT ON beply_order_commands
WHEN NOT EXISTS(SELECT 1 FROM beply_order_sync WHERE order_id=NEW.order_id AND version=NEW.expected_version AND status='manual_review')
BEGIN SELECT RAISE(ABORT,'beply_version_conflict'); END;
CREATE TRIGGER beply_order_commands_no_update BEFORE UPDATE ON beply_order_commands
BEGIN SELECT RAISE(ABORT,'beply_commands_immutable'); END;
CREATE TRIGGER beply_order_commands_no_delete BEFORE DELETE ON beply_order_commands
BEGIN SELECT RAISE(ABORT,'beply_commands_immutable'); END;
CREATE TRIGGER beply_order_alerts_no_update BEFORE UPDATE ON beply_order_alerts
BEGIN SELECT RAISE(ABORT,'beply_alerts_immutable'); END;
CREATE TRIGGER beply_order_alerts_no_delete BEFORE DELETE ON beply_order_alerts
BEGIN SELECT RAISE(ABORT,'beply_alerts_immutable'); END;
CREATE TRIGGER beply_order_create_identity_immutable BEFORE UPDATE ON beply_order_sync
WHEN (OLD.create_hash IS NOT NULL AND (NEW.create_hash IS NOT OLD.create_hash OR NEW.create_payload IS NOT OLD.create_payload))
 OR (OLD.provider_order_id IS NOT NULL AND (NEW.provider_order_id IS NOT OLD.provider_order_id OR NEW.provider_code IS NOT OLD.provider_code))
 OR NEW.order_id<>OLD.order_id OR NEW.confirmed_at<>OLD.confirmed_at OR NEW.version<OLD.version OR NEW.synced_version<OLD.synced_version
BEGIN SELECT RAISE(ABORT,'beply_identity_immutable'); END;
CREATE TRIGGER beply_order_sync_no_delete BEFORE DELETE ON beply_order_sync
BEGIN SELECT RAISE(ABORT,'beply_sync_immutable'); END;

-- Catch both INSERT and UPDATE; some payment adapters write a final state once.
CREATE TRIGGER beply_order_payment_insert AFTER INSERT ON order_payment_states
WHEN NEW.status IN('provider_authorised','paid')
BEGIN
 INSERT INTO beply_order_sync(order_id,due_at,queue_due_at,confirmed_at,updated_at)
 VALUES(NEW.order_id,NEW.updated_at,NEW.updated_at,NEW.updated_at,NEW.updated_at)
 ON CONFLICT(order_id) DO NOTHING;
END;
CREATE TRIGGER beply_order_payment_update AFTER UPDATE OF status ON order_payment_states
WHEN NEW.status IN('provider_authorised','paid') AND NEW.status<>OLD.status
BEGIN
 INSERT INTO beply_order_sync(order_id,due_at,queue_due_at,confirmed_at,updated_at)
 VALUES(NEW.order_id,NEW.updated_at,NEW.updated_at,NEW.updated_at,NEW.updated_at)
 ON CONFLICT(order_id) DO UPDATE SET version=version+1,
 status=CASE WHEN status IN('leased','manual_review') THEN status ELSE 'pending' END,
 attempts=CASE WHEN status='leased' THEN attempts ELSE 0 END,
 due_at=excluded.due_at,queue_due_at=excluded.queue_due_at,updated_at=excluded.updated_at;
END;
-- Acceptance means a completed checkout saga plus the immutable credit proof,
-- not merely a credit reservation that may later fail/roll back.
CREATE TRIGGER beply_order_credit_accept AFTER UPDATE OF state ON checkout_attempts
WHEN NEW.state='completed' AND OLD.state<>'completed'
 AND EXISTS(SELECT 1 FROM b2b_credit_reservations c JOIN orders o ON o.attempt_id=c.attempt_id
 WHERE c.attempt_id=NEW.id AND o.id=NEW.order_id AND c.customer_id=o.customer_id AND c.amount_cents=o.total_gross_cents)
BEGIN
 INSERT INTO beply_order_sync(order_id,due_at,queue_due_at,confirmed_at,updated_at)
 VALUES(NEW.order_id,NEW.updated_at,NEW.updated_at,NEW.updated_at,NEW.updated_at)
 ON CONFLICT(order_id) DO NOTHING;
END;

CREATE TRIGGER beply_orders_update AFTER UPDATE OF status ON orders
WHEN NEW.status<>OLD.status
BEGIN
 UPDATE beply_order_sync SET version=version+1,
 status=CASE WHEN status IN('leased','manual_review') THEN status ELSE 'pending' END,
 attempts=CASE WHEN status='leased' THEN attempts ELSE 0 END,
 due_at=NEW.updated_at,queue_due_at=NEW.updated_at,updated_at=NEW.updated_at
 WHERE order_id=NEW.id;
END;

CREATE TRIGGER beply_order_fulfillments_insert AFTER INSERT ON order_fulfillments
WHEN 1
BEGIN
 UPDATE beply_order_sync SET version=version+1,
 status=CASE WHEN status IN('leased','manual_review') THEN status ELSE 'pending' END,
 attempts=CASE WHEN status='leased' THEN attempts ELSE 0 END,
 due_at=NEW.updated_at,queue_due_at=NEW.updated_at,updated_at=NEW.updated_at
 WHERE order_id=NEW.order_id;
END;

CREATE TRIGGER beply_order_fulfillments_update AFTER UPDATE ON order_fulfillments
WHEN 1
BEGIN
 UPDATE beply_order_sync SET version=version+1,
 status=CASE WHEN status IN('leased','manual_review') THEN status ELSE 'pending' END,
 attempts=CASE WHEN status='leased' THEN attempts ELSE 0 END,
 due_at=NEW.updated_at,queue_due_at=NEW.updated_at,updated_at=NEW.updated_at
 WHERE order_id=NEW.order_id;
END;

CREATE TRIGGER beply_order_packings_insert AFTER INSERT ON order_packings
WHEN 1
BEGIN
 UPDATE beply_order_sync SET version=version+1,
 status=CASE WHEN status IN('leased','manual_review') THEN status ELSE 'pending' END,
 attempts=CASE WHEN status='leased' THEN attempts ELSE 0 END,
 due_at=NEW.updated_at,queue_due_at=NEW.updated_at,updated_at=NEW.updated_at
 WHERE order_id=NEW.order_id;
END;

CREATE TRIGGER beply_order_packings_update AFTER UPDATE ON order_packings
WHEN 1
BEGIN
 UPDATE beply_order_sync SET version=version+1,
 status=CASE WHEN status IN('leased','manual_review') THEN status ELSE 'pending' END,
 attempts=CASE WHEN status='leased' THEN attempts ELSE 0 END,
 due_at=NEW.updated_at,queue_due_at=NEW.updated_at,updated_at=NEW.updated_at
 WHERE order_id=NEW.order_id;
END;

CREATE TRIGGER beply_order_returns_insert AFTER INSERT ON order_returns
WHEN 1
BEGIN
 UPDATE beply_order_sync SET version=version+1,
 status=CASE WHEN status IN('leased','manual_review') THEN status ELSE 'pending' END,
 attempts=CASE WHEN status='leased' THEN attempts ELSE 0 END,
 due_at=NEW.updated_at,queue_due_at=NEW.updated_at,updated_at=NEW.updated_at
 WHERE order_id=NEW.order_id;
END;

CREATE TRIGGER beply_order_returns_update AFTER UPDATE ON order_returns
WHEN 1
BEGIN
 UPDATE beply_order_sync SET version=version+1,
 status=CASE WHEN status IN('leased','manual_review') THEN status ELSE 'pending' END,
 attempts=CASE WHEN status='leased' THEN attempts ELSE 0 END,
 due_at=NEW.updated_at,queue_due_at=NEW.updated_at,updated_at=NEW.updated_at
 WHERE order_id=NEW.order_id;
END;

-- Backfill confirmed orders during migration, without provider traffic.
INSERT INTO beply_order_sync(order_id,due_at,queue_due_at,confirmed_at,updated_at)
SELECT order_id,updated_at,updated_at,updated_at,updated_at FROM order_payment_states
WHERE status IN('provider_authorised','paid') ON CONFLICT(order_id) DO NOTHING;
INSERT INTO beply_order_sync(order_id,due_at,queue_due_at,confirmed_at,updated_at)
SELECT o.id,a.updated_at,a.updated_at,a.updated_at,a.updated_at FROM orders o
JOIN checkout_attempts a ON a.id=o.attempt_id AND a.state='completed' AND a.order_id=o.id
JOIN b2b_credit_reservations c ON c.attempt_id=a.id AND c.customer_id=o.customer_id AND c.amount_cents=o.total_gross_cents
ON CONFLICT(order_id) DO NOTHING;
