-- Audited, purpose-specific evidence for high-value messaging. Proof is an opaque reference, never contact data.
CREATE TABLE high_value_consent_commands (
 command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
 customer_id TEXT NOT NULL REFERENCES customers(id),
 channel TEXT NOT NULL CHECK(channel IN ('sms','whatsapp')),
 action TEXT NOT NULL CHECK(action IN ('grant','revoke')),
 proof TEXT NOT NULL CHECK(length(proof) BETWEEN 8 AND 100 AND proof NOT GLOB '*[^a-zA-Z0-9_-]*'),
 actor_id TEXT NOT NULL REFERENCES identities(id), session_id TEXT NOT NULL REFERENCES auth_sessions(id),
 session_version INTEGER NOT NULL CHECK(session_version>0), payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 expected_version INTEGER NOT NULL CHECK(expected_version>=0), version INTEGER NOT NULL CHECK(version=expected_version+1),
 created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(customer_id,channel,version)
) STRICT;
CREATE TRIGGER high_value_consent_no_update BEFORE UPDATE ON high_value_consent_commands BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER high_value_consent_no_delete BEFORE DELETE ON high_value_consent_commands BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER high_value_consent_cas BEFORE INSERT ON high_value_consent_commands
WHEN NEW.expected_version<>COALESCE((SELECT max(version) FROM high_value_consent_commands WHERE customer_id=NEW.customer_id AND channel=NEW.channel),0)
BEGIN SELECT RAISE(ABORT,'conflict'); END;
CREATE TRIGGER high_value_consent_authority BEFORE INSERT ON high_value_consent_commands
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE s.id=NEW.session_id AND s.identity_id=NEW.actor_id AND s.session_version=NEW.session_version AND i.session_version=s.session_version
 AND s.revoked_at IS NULL AND s.mfa_verified=1 AND i.status IN('active','pending')
 AND s.created_at<=NEW.created_at AND s.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.created_at
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=NEW.created_at
 AND (r.expires_at IS NULL OR r.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')))))
BEGIN SELECT RAISE(ABORT,'authority'); END;

-- Recall commands form an immutable versioned history per lot.
CREATE TABLE product_recall_commands (
 command_id TEXT PRIMARY KEY CHECK(length(command_id)=36), lot_id TEXT NOT NULL REFERENCES inventory_lots(id),
 action TEXT NOT NULL CHECK(action IN ('open','communicate','resolve')),
 order_id TEXT, line_index INTEGER,
 evidence TEXT NOT NULL CHECK(length(evidence) BETWEEN 8 AND 100 AND evidence NOT GLOB '*[^a-zA-Z0-9_-]*'),
 actor_id TEXT NOT NULL REFERENCES identities(id), session_id TEXT NOT NULL REFERENCES auth_sessions(id),
 session_version INTEGER NOT NULL CHECK(session_version>0), payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 expected_version INTEGER NOT NULL CHECK(expected_version>=0), version INTEGER NOT NULL CHECK(version=expected_version+1),
 created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(lot_id,version), FOREIGN KEY(order_id,line_index) REFERENCES order_lines(order_id,line_index),
 CHECK((action='communicate' AND order_id IS NOT NULL AND line_index IS NOT NULL) OR (action<>'communicate' AND order_id IS NULL AND line_index IS NULL))
) STRICT;
CREATE TRIGGER product_recall_no_update BEFORE UPDATE ON product_recall_commands BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER product_recall_no_delete BEFORE DELETE ON product_recall_commands BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER product_recall_cas BEFORE INSERT ON product_recall_commands
WHEN NEW.expected_version<>COALESCE((SELECT max(version) FROM product_recall_commands WHERE lot_id=NEW.lot_id),0)
 OR (NEW.action='open')<>(COALESCE((SELECT action FROM product_recall_commands WHERE lot_id=NEW.lot_id ORDER BY version DESC LIMIT 1),'resolve')='resolve')
BEGIN SELECT RAISE(ABORT,'conflict'); END;
CREATE TRIGGER product_recall_authority BEFORE INSERT ON product_recall_commands
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE s.id=NEW.session_id AND s.identity_id=NEW.actor_id AND s.session_version=NEW.session_version AND i.session_version=s.session_version
 AND s.revoked_at IS NULL AND s.mfa_verified=1 AND i.status IN('active','pending') AND s.created_at<=NEW.created_at
 AND s.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.created_at
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id
 AND p.permission_code='administration.manage' AND r.granted_at<=NEW.created_at
 AND (r.expires_at IS NULL OR r.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')))))
BEGIN SELECT RAISE(ABORT,'authority'); END;
-- Conservatively block every lot of the variant, including backorders, until all recalls are resolved.
CREATE TRIGGER product_recall_reservation_guard BEFORE INSERT ON inventory_reservation_lines
WHEN EXISTS(SELECT 1 FROM inventory_lots l WHERE l.variant_id=NEW.variant_id AND
 (SELECT c.action FROM product_recall_commands c WHERE c.lot_id=l.id ORDER BY c.version DESC LIMIT 1) IN ('open','communicate'))
BEGIN SELECT RAISE(ABORT,'product_recall_active'); END;
CREATE TRIGGER product_recall_assignment_guard BEFORE UPDATE OF status ON inventory_reservations
WHEN NEW.status='assigned' AND OLD.status<>'assigned' AND EXISTS(
 SELECT 1 FROM inventory_reservation_lines r JOIN inventory_lots l ON l.variant_id=r.variant_id
 WHERE r.reservation_id=NEW.id AND (SELECT c.action FROM product_recall_commands c WHERE c.lot_id=l.id ORDER BY c.version DESC LIMIT 1) IN ('open','communicate'))
BEGIN SELECT RAISE(ABORT,'product_recall_active'); END;
CREATE TRIGGER product_recall_order_guard BEFORE INSERT ON orders
WHEN EXISTS(SELECT 1 FROM inventory_reservation_lines r JOIN inventory_lots l ON l.variant_id=r.variant_id
 WHERE r.reservation_id=NEW.reservation_id AND (SELECT c.action FROM product_recall_commands c WHERE c.lot_id=l.id ORDER BY c.version DESC LIMIT 1) IN ('open','communicate'))
BEGIN SELECT RAISE(ABORT,'product_recall_active'); END;
CREATE TRIGGER product_recall_fulfillment_guard BEFORE INSERT ON order_fulfillment_commands
WHEN NEW.action NOT IN ('exception') AND EXISTS(SELECT 1 FROM order_lines ol JOIN inventory_lots l ON l.variant_id=ol.variant_id
 WHERE ol.order_id=NEW.order_id AND (SELECT c.action FROM product_recall_commands c WHERE c.lot_id=l.id ORDER BY c.version DESC LIMIT 1) IN ('open','communicate'))
BEGIN SELECT RAISE(ABORT,'product_recall_active'); END;
CREATE TRIGGER product_recall_lot_allocation_guard BEFORE INSERT ON inventory_lot_allocations
WHEN EXISTS(SELECT 1 FROM inventory_lots selected JOIN inventory_lots recalled ON recalled.variant_id=selected.variant_id
 WHERE selected.id=NEW.lot_id AND (SELECT c.action FROM product_recall_commands c WHERE c.lot_id=recalled.id ORDER BY c.version DESC LIMIT 1) IN ('open','communicate'))
BEGIN SELECT RAISE(ABORT,'product_recall_active'); END;

CREATE TRIGGER product_recall_transition_evidence BEFORE INSERT ON product_recall_commands
WHEN (NEW.action='communicate' AND NOT EXISTS(SELECT 1 FROM inventory_lot_allocations a JOIN order_lines ol ON ol.order_id=a.order_id AND ol.line_index=a.order_line_index JOIN inventory_lots l ON l.id=a.lot_id AND l.variant_id=ol.variant_id WHERE a.lot_id=NEW.lot_id AND a.order_id=NEW.order_id AND a.order_line_index=NEW.line_index))
 OR (NEW.action='resolve' AND EXISTS(SELECT 1 FROM inventory_lot_allocations a WHERE a.lot_id=NEW.lot_id AND NOT EXISTS(SELECT 1 FROM product_recall_commands c WHERE c.lot_id=NEW.lot_id AND c.action='communicate' AND c.order_id=a.order_id AND c.line_index=a.order_line_index AND c.version>(SELECT max(version) FROM product_recall_commands WHERE lot_id=NEW.lot_id AND action='open'))))
BEGIN SELECT RAISE(ABORT,'recall_transition_conflict'); END;
-- Missing historical allocations are uncertainty, not proof that a customer was unaffected.
CREATE TRIGGER product_recall_traceability_guard BEFORE INSERT ON product_recall_commands
WHEN NEW.action='resolve' AND EXISTS(
 SELECT 1 FROM order_lines ol JOIN inventory_lots recalled ON recalled.id=NEW.lot_id AND recalled.variant_id=ol.variant_id
 WHERE ol.quantity<>(SELECT COALESCE(sum(a.quantity),0) FROM inventory_lot_allocations a JOIN inventory_lots source ON source.id=a.lot_id
 WHERE a.order_id=ol.order_id AND a.order_line_index=ol.line_index AND source.variant_id=ol.variant_id))
BEGIN SELECT RAISE(ABORT,'recall_transition_conflict'); END;

-- Simulation journal: no phone numbers, payloads, provider credentials or real sends.
CREATE TABLE high_value_delivery_commands (
 command_id TEXT PRIMARY KEY CHECK(length(command_id)=36), event_id TEXT NOT NULL CHECK(length(event_id)=36),
 customer_id TEXT NOT NULL REFERENCES customers(id), channel TEXT NOT NULL CHECK(channel='sms'),
 event_type TEXT NOT NULL CHECK(event_type IN('recall','delivery_exception','security_alert')),
 actor_id TEXT NOT NULL REFERENCES identities(id), session_id TEXT NOT NULL REFERENCES auth_sessions(id),
 session_version INTEGER NOT NULL CHECK(session_version>0), payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 consent_version INTEGER NOT NULL CHECK(consent_version>0), cost_minor INTEGER NOT NULL CHECK(cost_minor>=0), budget_minor INTEGER NOT NULL CHECK(budget_minor>=0),
 created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(event_id,channel)
) STRICT;
CREATE INDEX high_value_delivery_day ON high_value_delivery_commands(created_at);
CREATE TRIGGER high_value_delivery_no_update BEFORE UPDATE ON high_value_delivery_commands BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER high_value_delivery_no_delete BEFORE DELETE ON high_value_delivery_commands BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER high_value_delivery_budget BEFORE INSERT ON high_value_delivery_commands
WHEN NEW.cost_minor+COALESCE((SELECT sum(cost_minor) FROM high_value_delivery_commands WHERE substr(created_at,1,10)=substr(NEW.created_at,1,10)),0)>NEW.budget_minor
BEGIN SELECT RAISE(ABORT,'budget_exceeded'); END;
CREATE TRIGGER high_value_delivery_consent BEFORE INSERT ON high_value_delivery_commands
WHEN NOT EXISTS(SELECT 1 FROM high_value_consent_commands c WHERE c.customer_id=NEW.customer_id AND c.channel=NEW.channel AND c.version=NEW.consent_version AND c.action='grant' AND c.version=(SELECT max(version) FROM high_value_consent_commands WHERE customer_id=NEW.customer_id AND channel=NEW.channel))
BEGIN SELECT RAISE(ABORT,'consent_required'); END;
CREATE TRIGGER high_value_delivery_authority BEFORE INSERT ON high_value_delivery_commands
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE s.id=NEW.session_id AND s.identity_id=NEW.actor_id AND s.session_version=NEW.session_version AND i.session_version=s.session_version
 AND s.revoked_at IS NULL AND s.mfa_verified=1 AND i.status IN('active','pending') AND s.created_at<=NEW.created_at
 AND s.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.created_at
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id AND p.permission_code='administration.manage'
 AND r.granted_at<=NEW.created_at AND (r.expires_at IS NULL OR r.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')))))
BEGIN SELECT RAISE(ABORT,'authority'); END;
