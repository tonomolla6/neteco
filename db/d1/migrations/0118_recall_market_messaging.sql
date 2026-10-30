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
AND NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE NEW.action='revoke' AND s.id=NEW.session_id AND s.identity_id=NEW.actor_id AND s.session_version=NEW.session_version
 AND i.session_version=s.session_version AND i.customer_id=NEW.customer_id AND s.revoked_at IS NULL AND i.status IN('active','pending')
 AND s.created_at<=NEW.created_at AND s.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'authority'); END;

-- Recall commands form an immutable versioned history per lot.
CREATE TABLE product_recall_commands (
 command_id TEXT PRIMARY KEY CHECK(length(command_id)=36), lot_id TEXT NOT NULL REFERENCES inventory_lots(id),
 action TEXT NOT NULL CHECK(action IN ('open','communicate','trace','resolve')),
 order_id TEXT, line_index INTEGER, target_lot_id TEXT REFERENCES inventory_lots(id), trace_quantity INTEGER,
 evidence TEXT NOT NULL CHECK(length(evidence) BETWEEN 8 AND 100 AND evidence NOT GLOB '*[^a-zA-Z0-9_-]*'),
 actor_id TEXT NOT NULL REFERENCES identities(id), session_id TEXT NOT NULL REFERENCES auth_sessions(id),
 session_version INTEGER NOT NULL CHECK(session_version>0), payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 expected_version INTEGER NOT NULL CHECK(expected_version>=0), version INTEGER NOT NULL CHECK(version=expected_version+1),
 created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(lot_id,version), FOREIGN KEY(order_id,line_index) REFERENCES order_lines(order_id,line_index),
 CHECK((action='communicate' AND order_id IS NOT NULL AND line_index IS NOT NULL AND target_lot_id IS NULL AND trace_quantity IS NULL)
 OR (action='trace' AND order_id IS NOT NULL AND line_index IS NOT NULL AND target_lot_id IS NOT NULL AND trace_quantity BETWEEN 1 AND 999)
 OR (action IN('open','resolve') AND order_id IS NULL AND line_index IS NULL AND target_lot_id IS NULL AND trace_quantity IS NULL))
) STRICT;
CREATE INDEX product_recall_lines_variant ON order_lines(variant_id,order_id,line_index);
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
 (SELECT c.action FROM product_recall_commands c WHERE c.lot_id=l.id ORDER BY c.version DESC LIMIT 1) IN ('open','communicate','trace'))
BEGIN SELECT RAISE(ABORT,'product_recall_active'); END;
CREATE TRIGGER product_recall_assignment_guard BEFORE UPDATE OF status ON inventory_reservations
WHEN NEW.status='assigned' AND OLD.status<>'assigned' AND EXISTS(
 SELECT 1 FROM inventory_reservation_lines r JOIN inventory_lots l ON l.variant_id=r.variant_id
 WHERE r.reservation_id=NEW.id AND (SELECT c.action FROM product_recall_commands c WHERE c.lot_id=l.id ORDER BY c.version DESC LIMIT 1) IN ('open','communicate','trace'))
BEGIN SELECT RAISE(ABORT,'product_recall_active'); END;
CREATE TRIGGER product_recall_order_guard BEFORE INSERT ON orders
WHEN EXISTS(SELECT 1 FROM inventory_reservation_lines r JOIN inventory_lots l ON l.variant_id=r.variant_id
 WHERE r.reservation_id=NEW.reservation_id AND (SELECT c.action FROM product_recall_commands c WHERE c.lot_id=l.id ORDER BY c.version DESC LIMIT 1) IN ('open','communicate','trace'))
BEGIN SELECT RAISE(ABORT,'product_recall_active'); END;
CREATE TRIGGER product_recall_fulfillment_guard BEFORE INSERT ON order_fulfillment_commands
WHEN NEW.action NOT IN ('exception') AND EXISTS(SELECT 1 FROM order_lines ol JOIN inventory_lots l ON l.variant_id=ol.variant_id
 WHERE ol.order_id=NEW.order_id AND (SELECT c.action FROM product_recall_commands c WHERE c.lot_id=l.id ORDER BY c.version DESC LIMIT 1) IN ('open','communicate','trace'))
BEGIN SELECT RAISE(ABORT,'product_recall_active'); END;
CREATE TRIGGER product_recall_lot_allocation_guard BEFORE INSERT ON inventory_lot_allocations
WHEN EXISTS(SELECT 1 FROM inventory_lots selected JOIN inventory_lots recalled ON recalled.variant_id=selected.variant_id
 WHERE selected.id=NEW.lot_id AND (SELECT c.action FROM product_recall_commands c WHERE c.lot_id=recalled.id ORDER BY c.version DESC LIMIT 1) IN ('open','communicate','trace'))
 AND NOT EXISTS(SELECT 1 FROM product_recall_commands c WHERE c.command_id=NEW.id AND c.action='trace'
 AND c.target_lot_id=NEW.lot_id AND c.order_id=NEW.order_id AND c.line_index=NEW.order_line_index AND c.trace_quantity=NEW.quantity)
BEGIN SELECT RAISE(ABORT,'product_recall_active'); END;

-- An open recall must remove real sellable stock, not only reject new writes. The hold remembers the
-- pre-recall blocked quantity per balance so resolution restores it exactly; recall wins over manual blocks.
CREATE VIEW product_recall_active_variants AS
 SELECT DISTINCT l.variant_id variant_id FROM inventory_lots l
 WHERE (SELECT c.action FROM product_recall_commands c WHERE c.lot_id=l.id ORDER BY c.version DESC LIMIT 1) IN('open','communicate','trace');
CREATE TABLE product_recall_stock_holds (
 variant_id TEXT NOT NULL, location_id TEXT NOT NULL, previous_blocked INTEGER NOT NULL CHECK(previous_blocked>=0),
 created_at TEXT NOT NULL CHECK(length(created_at)=20), PRIMARY KEY(variant_id,location_id),
 FOREIGN KEY(variant_id,location_id) REFERENCES inventory_balances(variant_id,location_id)
) STRICT;
CREATE TRIGGER product_recall_stock_hold AFTER INSERT ON product_recall_commands WHEN NEW.action='open'
BEGIN
 INSERT INTO product_recall_stock_holds(variant_id,location_id,previous_blocked,created_at)
 SELECT b.variant_id,b.location_id,b.blocked_quantity,NEW.created_at FROM inventory_balances b
 WHERE b.variant_id=(SELECT variant_id FROM inventory_lots WHERE id=NEW.lot_id)
 AND NOT EXISTS(SELECT 1 FROM product_recall_stock_holds h WHERE h.variant_id=b.variant_id AND h.location_id=b.location_id);
 UPDATE inventory_balances SET blocked_quantity=physical_quantity,version=version+1,updated_at=NEW.created_at
 WHERE variant_id=(SELECT variant_id FROM inventory_lots WHERE id=NEW.lot_id) AND blocked_quantity<physical_quantity;
END;
CREATE TRIGGER product_recall_stock_release AFTER INSERT ON product_recall_commands WHEN NEW.action='resolve'
BEGIN
 UPDATE inventory_balances SET blocked_quantity=min(physical_quantity,(SELECT h.previous_blocked FROM product_recall_stock_holds h
  WHERE h.variant_id=inventory_balances.variant_id AND h.location_id=inventory_balances.location_id)),
  version=version+1,updated_at=NEW.created_at
 WHERE variant_id=(SELECT variant_id FROM inventory_lots WHERE id=NEW.lot_id)
 AND NOT EXISTS(SELECT 1 FROM product_recall_active_variants a WHERE a.variant_id=inventory_balances.variant_id)
 AND EXISTS(SELECT 1 FROM product_recall_stock_holds h WHERE h.variant_id=inventory_balances.variant_id AND h.location_id=inventory_balances.location_id);
 DELETE FROM product_recall_stock_holds WHERE variant_id=(SELECT variant_id FROM inventory_lots WHERE id=NEW.lot_id)
 AND NOT EXISTS(SELECT 1 FROM product_recall_active_variants a WHERE a.variant_id=product_recall_stock_holds.variant_id);
END;
-- Stock received or counted during a recall is conservatively blocked as well.
CREATE TRIGGER product_recall_balance_guard AFTER UPDATE OF physical_quantity ON inventory_balances
WHEN NEW.blocked_quantity<NEW.physical_quantity AND EXISTS(SELECT 1 FROM product_recall_active_variants a WHERE a.variant_id=NEW.variant_id)
BEGIN
 UPDATE inventory_balances SET blocked_quantity=physical_quantity,version=version+1
 WHERE variant_id=NEW.variant_id AND location_id=NEW.location_id AND blocked_quantity<physical_quantity;
END;
CREATE TRIGGER product_recall_balance_insert_guard AFTER INSERT ON inventory_balances
WHEN NEW.blocked_quantity<NEW.physical_quantity AND EXISTS(SELECT 1 FROM product_recall_active_variants a WHERE a.variant_id=NEW.variant_id)
BEGIN
 INSERT OR IGNORE INTO product_recall_stock_holds(variant_id,location_id,previous_blocked,created_at) VALUES(NEW.variant_id,NEW.location_id,NEW.blocked_quantity,NEW.updated_at);
 UPDATE inventory_balances SET blocked_quantity=physical_quantity WHERE variant_id=NEW.variant_id AND location_id=NEW.location_id;
END;

-- Historical trace correction is an audited, atomic command backed by an
-- operator evidence reference. It never invents a lot from missing data.
CREATE TRIGGER product_recall_trace_validate BEFORE INSERT ON product_recall_commands
WHEN NEW.action='trace' AND NOT EXISTS(
 SELECT 1 FROM order_lines ol JOIN inventory_lots recalled ON recalled.id=NEW.lot_id AND recalled.variant_id=ol.variant_id
 JOIN inventory_lots target ON target.id=NEW.target_lot_id AND target.variant_id=ol.variant_id AND target.location_id=ol.location_id
 WHERE ol.order_id=NEW.order_id AND ol.line_index=NEW.line_index AND target.status IN('active','quarantined')
 AND target.available_quantity>=NEW.trace_quantity AND NEW.trace_quantity<=ol.quantity-(SELECT COALESCE(sum(a.quantity),0)
 FROM inventory_lot_allocations a JOIN inventory_lots source ON source.id=a.lot_id AND source.variant_id=ol.variant_id
 WHERE a.order_id=ol.order_id AND a.order_line_index=ol.line_index))
BEGIN SELECT RAISE(ABORT,'recall_transition_conflict'); END;
CREATE TRIGGER product_recall_trace_apply AFTER INSERT ON product_recall_commands
WHEN NEW.action='trace'
BEGIN
 UPDATE inventory_lots SET available_quantity=available_quantity-NEW.trace_quantity,
 status=iif(status='active' AND available_quantity=NEW.trace_quantity,'depleted',status),
 version=version+1,updated_at=NEW.created_at WHERE id=NEW.target_lot_id;
 INSERT INTO inventory_lot_allocations(id,lot_id,order_id,order_line_index,customer_id,quantity,correlation_id,created_at)
 SELECT NEW.command_id,NEW.target_lot_id,NEW.order_id,NEW.line_index,o.customer_id,NEW.trace_quantity,NEW.command_id,NEW.created_at
 FROM orders o WHERE o.id=NEW.order_id;
END;

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
 command_id TEXT PRIMARY KEY CHECK(length(command_id)=36), event_id TEXT NOT NULL CHECK(length(event_id) IN(32,36)),
 customer_id TEXT NOT NULL REFERENCES customers(id), channel TEXT NOT NULL CHECK(channel='sms'),
 event_type TEXT NOT NULL CHECK(event_type IN('recall','delivery_exception','security_alert')), source_verified INTEGER NOT NULL DEFAULT 0 CHECK(source_verified IN(0,1)),
 actor_id TEXT NOT NULL REFERENCES identities(id), session_id TEXT NOT NULL REFERENCES auth_sessions(id),
 session_version INTEGER NOT NULL CHECK(session_version>0), payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 consent_version INTEGER NOT NULL CHECK(consent_version>0), cost_minor INTEGER NOT NULL CHECK(cost_minor>=0), budget_minor INTEGER NOT NULL CHECK(budget_minor>=0),
 created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(event_id,channel,customer_id)
) STRICT;
CREATE INDEX high_value_delivery_day ON high_value_delivery_commands(created_at);
CREATE TRIGGER high_value_delivery_no_update BEFORE UPDATE ON high_value_delivery_commands BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER high_value_delivery_no_delete BEFORE DELETE ON high_value_delivery_commands BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER high_value_delivery_budget BEFORE INSERT ON high_value_delivery_commands
WHEN NEW.cost_minor+COALESCE((SELECT sum(cost_minor) FROM high_value_delivery_commands WHERE substr(created_at,1,10)=substr(NEW.created_at,1,10)),0)+COALESCE((SELECT sum(cost_minor) FROM high_value_whatsapp_delivery WHERE substr(created_at,1,10)=substr(NEW.created_at,1,10)),0)>NEW.budget_minor
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

CREATE TABLE high_value_fallback_commands (
 command_id TEXT PRIMARY KEY CHECK(length(command_id)=36), event_id TEXT NOT NULL CHECK(length(event_id) IN(32,36)),
 customer_id TEXT NOT NULL REFERENCES customers(id), channel TEXT NOT NULL CHECK(channel='sms'),
 event_type TEXT NOT NULL CHECK(event_type IN('recall','delivery_exception','security_alert')), source_verified INTEGER NOT NULL DEFAULT 0 CHECK(source_verified IN(0,1)),
 reason TEXT NOT NULL CHECK(reason IN('consent_required','budget_exceeded','delivery_disabled')),
 actor_id TEXT NOT NULL REFERENCES identities(id), session_id TEXT NOT NULL REFERENCES auth_sessions(id),
 session_version INTEGER NOT NULL CHECK(session_version>0), payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(event_id,channel,customer_id)
) STRICT;
CREATE TRIGGER high_value_fallback_no_update BEFORE UPDATE ON high_value_fallback_commands BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER high_value_fallback_no_delete BEFORE DELETE ON high_value_fallback_commands BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER high_value_fallback_duplicate BEFORE INSERT ON high_value_fallback_commands
WHEN EXISTS(SELECT 1 FROM high_value_delivery_commands WHERE command_id=NEW.command_id OR (customer_id=NEW.customer_id AND event_id=NEW.event_id AND channel=NEW.channel))
BEGIN SELECT RAISE(ABORT,'fallback_conflict'); END;
CREATE TRIGGER high_value_delivery_fallback_duplicate BEFORE INSERT ON high_value_delivery_commands
WHEN EXISTS(SELECT 1 FROM high_value_fallback_commands WHERE command_id=NEW.command_id OR (customer_id=NEW.customer_id AND event_id=NEW.event_id AND channel=NEW.channel))
BEGIN SELECT RAISE(ABORT,'fallback_conflict'); END;
CREATE TRIGGER high_value_fallback_authority BEFORE INSERT ON high_value_fallback_commands
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE s.id=NEW.session_id AND s.identity_id=NEW.actor_id AND s.session_version=NEW.session_version AND i.session_version=s.session_version
 AND s.revoked_at IS NULL AND s.mfa_verified=1 AND i.status IN('active','pending') AND s.created_at<=NEW.created_at
 AND s.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.created_at
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id AND p.permission_code='administration.manage'
 AND r.granted_at<=NEW.created_at AND (r.expires_at IS NULL OR r.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')))))
BEGIN SELECT RAISE(ABORT,'authority'); END;

-- WhatsApp local simulation state: no phone number, conversation text or provider credential.
CREATE TABLE high_value_whatsapp_state (
 command_id TEXT PRIMARY KEY CHECK(length(command_id)=36), customer_id TEXT NOT NULL REFERENCES customers(id),
 action TEXT NOT NULL CHECK(action IN('approve_template','inbound','handoff','resume')),
 event_type TEXT CHECK(event_type IS NULL OR event_type IN('recall','delivery_exception','security_alert')),
 template_id TEXT CHECK(template_id IS NULL OR (length(template_id) BETWEEN 1 AND 64 AND template_id NOT GLOB '*[^a-z0-9_]*')),
 approval_ref TEXT CHECK(approval_ref IS NULL OR (length(approval_ref) BETWEEN 8 AND 100 AND approval_ref NOT GLOB '*[^a-zA-Z0-9_-]*')),
 actor_id TEXT NOT NULL REFERENCES identities(id),session_id TEXT NOT NULL REFERENCES auth_sessions(id),session_version INTEGER NOT NULL CHECK(session_version>0),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 expected_version INTEGER NOT NULL CHECK(expected_version>=0),version INTEGER NOT NULL CHECK(version=expected_version+1),
 created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(customer_id,version),
 CHECK((action='approve_template' AND event_type IS NOT NULL AND template_id IS NOT NULL AND approval_ref IS NOT NULL) OR (action<>'approve_template' AND event_type IS NULL AND template_id IS NULL AND approval_ref IS NULL))
) STRICT;
CREATE TRIGGER high_value_whatsapp_state_no_update BEFORE UPDATE ON high_value_whatsapp_state BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER high_value_whatsapp_state_no_delete BEFORE DELETE ON high_value_whatsapp_state BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER high_value_whatsapp_state_cas BEFORE INSERT ON high_value_whatsapp_state
WHEN NEW.expected_version<>COALESCE((SELECT max(version) FROM high_value_whatsapp_state WHERE customer_id=NEW.customer_id),0)
BEGIN SELECT RAISE(ABORT,'state_conflict'); END;
CREATE TRIGGER high_value_whatsapp_state_authority BEFORE INSERT ON high_value_whatsapp_state
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id WHERE s.id=NEW.session_id AND s.identity_id=NEW.actor_id
 AND s.session_version=NEW.session_version AND i.session_version=s.session_version AND s.revoked_at IS NULL AND s.mfa_verified=1 AND i.status IN('active','pending')
 AND s.created_at<=NEW.created_at AND s.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.created_at
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=NEW.created_at AND (r.expires_at IS NULL OR r.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')))))
BEGIN SELECT RAISE(ABORT,'authority'); END;
CREATE TABLE high_value_whatsapp_delivery (
 command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),event_id TEXT NOT NULL CHECK(length(event_id) IN(32,36)),customer_id TEXT NOT NULL REFERENCES customers(id),
 event_type TEXT NOT NULL CHECK(event_type IN('recall','delivery_exception','security_alert')),source_verified INTEGER NOT NULL DEFAULT 0 CHECK(source_verified IN(0,1)),mode TEXT NOT NULL CHECK(mode IN('template','session')),
 template_id TEXT,actor_id TEXT NOT NULL REFERENCES identities(id),session_id TEXT NOT NULL REFERENCES auth_sessions(id),session_version INTEGER NOT NULL CHECK(session_version>0),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),consent_version INTEGER NOT NULL CHECK(consent_version>0),state_version INTEGER NOT NULL CHECK(state_version>0),
 cost_minor INTEGER NOT NULL CHECK(cost_minor>=0),budget_minor INTEGER NOT NULL CHECK(budget_minor>=0),
 created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(event_id,customer_id),CHECK((mode='template' AND template_id IS NOT NULL) OR (mode='session' AND template_id IS NULL))
) STRICT;
CREATE TRIGGER high_value_whatsapp_delivery_no_update BEFORE UPDATE ON high_value_whatsapp_delivery BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER high_value_whatsapp_delivery_no_delete BEFORE DELETE ON high_value_whatsapp_delivery BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER high_value_whatsapp_delivery_authority BEFORE INSERT ON high_value_whatsapp_delivery
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id WHERE s.id=NEW.session_id AND s.identity_id=NEW.actor_id AND s.session_version=NEW.session_version AND i.session_version=s.session_version AND s.revoked_at IS NULL AND s.mfa_verified=1 AND i.status IN('active','pending') AND s.created_at<=NEW.created_at AND s.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.created_at AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=NEW.created_at AND (r.expires_at IS NULL OR r.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')))))
BEGIN SELECT RAISE(ABORT,'authority'); END;
CREATE TRIGGER high_value_whatsapp_delivery_consent BEFORE INSERT ON high_value_whatsapp_delivery
WHEN NOT EXISTS(SELECT 1 FROM high_value_consent_commands c WHERE c.customer_id=NEW.customer_id AND c.channel='whatsapp' AND c.action='grant' AND c.version=NEW.consent_version AND c.version=(SELECT max(version) FROM high_value_consent_commands WHERE customer_id=NEW.customer_id AND channel='whatsapp'))
BEGIN SELECT RAISE(ABORT,'consent_required'); END;
CREATE TRIGGER high_value_whatsapp_delivery_state BEFORE INSERT ON high_value_whatsapp_delivery
WHEN NEW.state_version<>COALESCE((SELECT max(version) FROM high_value_whatsapp_state WHERE customer_id=NEW.customer_id),0)
 OR COALESCE((SELECT action FROM high_value_whatsapp_state WHERE customer_id=NEW.customer_id AND action IN('handoff','resume') ORDER BY version DESC LIMIT 1),'resume')='handoff'
 OR (NEW.mode='template' AND NOT EXISTS(SELECT 1 FROM high_value_whatsapp_state WHERE customer_id=NEW.customer_id AND action='approve_template' AND event_type=NEW.event_type AND template_id=NEW.template_id AND version=(SELECT max(version) FROM high_value_whatsapp_state WHERE customer_id=NEW.customer_id AND action='approve_template' AND event_type=NEW.event_type)))
 OR (NEW.mode='session' AND NOT EXISTS(SELECT 1 FROM high_value_whatsapp_state WHERE customer_id=NEW.customer_id AND action='inbound' AND created_at<=NEW.created_at AND julianday(NEW.created_at)<julianday(created_at)+1))
BEGIN SELECT RAISE(ABORT,'state_conflict'); END;
CREATE TRIGGER high_value_whatsapp_delivery_budget BEFORE INSERT ON high_value_whatsapp_delivery
WHEN NEW.cost_minor+COALESCE((SELECT sum(cost_minor) FROM high_value_delivery_commands WHERE substr(created_at,1,10)=substr(NEW.created_at,1,10)),0)+COALESCE((SELECT sum(cost_minor) FROM high_value_whatsapp_delivery WHERE substr(created_at,1,10)=substr(NEW.created_at,1,10)),0)>NEW.budget_minor
BEGIN SELECT RAISE(ABORT,'budget_exceeded'); END;

-- Explicit market profiles are immutable snapshots, never implicit tax or exchange defaults.
CREATE TABLE checkout_market_commands (
 command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),market TEXT NOT NULL CHECK(length(market)=2 AND market NOT GLOB '*[^A-Z]*'),
 currency TEXT NOT NULL CHECK(length(currency)=3 AND currency NOT GLOB '*[^A-Z]*'),
 exchange_numerator INTEGER NOT NULL CHECK(exchange_numerator BETWEEN 1 AND 1000000),exchange_denominator INTEGER NOT NULL CHECK(exchange_denominator BETWEEN 1 AND 1000000),
 goods_tax_bps INTEGER NOT NULL CHECK(goods_tax_bps BETWEEN 0 AND 10000),shipping_net_minor INTEGER NOT NULL CHECK(shipping_net_minor BETWEEN 0 AND 100000000),shipping_tax_bps INTEGER NOT NULL CHECK(shipping_tax_bps BETWEEN 0 AND 10000),
 terms_version TEXT NOT NULL CHECK(length(terms_version) BETWEEN 3 AND 100 AND terms_version NOT GLOB '*[^a-zA-Z0-9_-]*'),
 payment_methods TEXT NOT NULL CHECK(json_valid(payment_methods) AND json_type(payment_methods)='array' AND json_array_length(payment_methods) BETWEEN 1 AND 3),
 actor_id TEXT NOT NULL REFERENCES identities(id),session_id TEXT NOT NULL REFERENCES auth_sessions(id),session_version INTEGER NOT NULL CHECK(session_version>0),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),expected_version INTEGER NOT NULL CHECK(expected_version>=0),version INTEGER NOT NULL CHECK(version=expected_version+1),
 created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),UNIQUE(market,version)
) STRICT;
CREATE TRIGGER checkout_market_no_update BEFORE UPDATE ON checkout_market_commands BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER checkout_market_no_delete BEFORE DELETE ON checkout_market_commands BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER checkout_market_cas BEFORE INSERT ON checkout_market_commands
WHEN NEW.expected_version<>COALESCE((SELECT max(version) FROM checkout_market_commands WHERE market=NEW.market),0)
BEGIN SELECT RAISE(ABORT,'market_conflict'); END;
CREATE TRIGGER checkout_market_methods BEFORE INSERT ON checkout_market_commands
WHEN EXISTS(SELECT 1 FROM json_each(NEW.payment_methods) WHERE type<>'text' OR value NOT IN('card','bank_transfer','credit'))
 OR (SELECT count(*) FROM json_each(NEW.payment_methods))<>(SELECT count(DISTINCT value) FROM json_each(NEW.payment_methods))
BEGIN SELECT RAISE(ABORT,'market_methods_invalid'); END;
CREATE TRIGGER checkout_market_authority BEFORE INSERT ON checkout_market_commands
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id WHERE s.id=NEW.session_id AND s.identity_id=NEW.actor_id AND s.session_version=NEW.session_version AND i.session_version=s.session_version AND s.revoked_at IS NULL AND s.mfa_verified=1 AND i.status IN('active','pending') AND s.created_at<=NEW.created_at AND s.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.created_at AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=NEW.created_at AND (r.expires_at IS NULL OR r.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')))))
BEGIN SELECT RAISE(ABORT,'authority'); END;

-- The HTTP entrypoints require a live source at the same transaction as the
-- simulated delivery or manual fallback, including customer ownership.
CREATE VIEW high_value_event_sources AS
 SELECT 'security_alert' event_type,e.id event_id,i.customer_id,e.created_at
 FROM identity_security_events e JOIN identities i ON i.id=e.identity_id
 WHERE e.event_type IN('password_changed','session_revoked') AND i.customer_id IS NOT NULL
 UNION ALL
 SELECT 'delivery_exception',c.id,o.customer_id,c.created_at
 FROM order_fulfillment_commands c JOIN orders o ON o.id=c.order_id
 WHERE c.action='exception' AND o.customer_id IS NOT NULL
 UNION ALL
 SELECT 'recall',c.command_id,o.customer_id,c.created_at
 FROM product_recall_commands c JOIN inventory_lot_allocations a ON a.lot_id=c.lot_id
 JOIN orders o ON o.id=a.order_id JOIN order_lines line ON line.order_id=a.order_id AND line.line_index=a.order_line_index
 JOIN inventory_lots lot ON lot.id=c.lot_id AND lot.variant_id=line.variant_id
 WHERE c.action='open' AND o.customer_id IS NOT NULL AND
 (SELECT last.action FROM product_recall_commands last WHERE last.lot_id=c.lot_id ORDER BY last.version DESC LIMIT 1) IN('open','communicate','trace');
CREATE TRIGGER high_value_delivery_source BEFORE INSERT ON high_value_delivery_commands
WHEN NEW.source_verified=1 AND NOT EXISTS(SELECT 1 FROM high_value_event_sources e WHERE e.event_type=NEW.event_type AND e.event_id=NEW.event_id AND e.customer_id=NEW.customer_id AND e.created_at<=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'event_unavailable'); END;
CREATE TRIGGER high_value_fallback_source BEFORE INSERT ON high_value_fallback_commands
WHEN NEW.source_verified=1 AND NOT EXISTS(SELECT 1 FROM high_value_event_sources e WHERE e.event_type=NEW.event_type AND e.event_id=NEW.event_id AND e.customer_id=NEW.customer_id AND e.created_at<=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'event_unavailable'); END;
CREATE TRIGGER high_value_whatsapp_source BEFORE INSERT ON high_value_whatsapp_delivery
WHEN NEW.source_verified=1 AND NOT EXISTS(SELECT 1 FROM high_value_event_sources e WHERE e.event_type=NEW.event_type AND e.event_id=NEW.event_id AND e.customer_id=NEW.customer_id AND e.created_at<=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'event_unavailable'); END;
CREATE TRIGGER high_value_whatsapp_frequency BEFORE INSERT ON high_value_whatsapp_delivery
WHEN NEW.source_verified=1 AND EXISTS(SELECT 1 FROM high_value_whatsapp_delivery prior
 WHERE prior.customer_id=NEW.customer_id AND prior.source_verified=1 AND prior.created_at<=NEW.created_at
 AND prior.created_at>strftime('%Y-%m-%dT%H:%M:%SZ',NEW.created_at,'-1 day'))
BEGIN SELECT RAISE(ABORT,'frequency_limited'); END;

-- CHK-023: destination addresses are no longer Spain-only. Spanish rows keep the five-digit contract; other
-- markets accept a bounded alphanumeric postcode. Tables are rebuilt because SQLite cannot drop a CHECK.
CREATE TABLE order_shipping_address_market (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  recipient_name TEXT NOT NULL CHECK (length(recipient_name) BETWEEN 2 AND 120),
  line1 TEXT NOT NULL CHECK (length(line1) BETWEEN 3 AND 160),
  line2 TEXT CHECK (line2 IS NULL OR length(line2) <= 160),
  city TEXT NOT NULL CHECK (length(city) BETWEEN 1 AND 80),
  province TEXT NOT NULL CHECK (length(province) BETWEEN 1 AND 80),
  postal_code TEXT NOT NULL CHECK (length(postal_code) BETWEEN 3 AND 12 AND postal_code NOT GLOB '*[^A-Za-z0-9 -]*'),
  country_code TEXT NOT NULL CHECK (length(country_code) = 2 AND country_code NOT GLOB '*[^A-Z]*'),
  phone TEXT NOT NULL CHECK (length(phone) BETWEEN 6 AND 24),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  company_name TEXT CHECK (company_name IS NULL OR length(trim(company_name)) BETWEEN 2 AND 160),
  tax_id TEXT CHECK (tax_id IS NULL OR length(tax_id) BETWEEN 6 AND 20),
  instructions TEXT CHECK (instructions IS NULL OR length(instructions) BETWEEN 1 AND 500),
  CHECK (country_code <> 'ES' OR postal_code GLOB '[0-9][0-9][0-9][0-9][0-9]')
) STRICT;
INSERT INTO order_shipping_address_market(order_id,recipient_name,line1,line2,city,province,postal_code,country_code,phone,created_at,company_name,tax_id,instructions)
 SELECT order_id,recipient_name,line1,line2,city,province,postal_code,country_code,phone,created_at,company_name,tax_id,instructions FROM order_shipping_address;
DROP TABLE order_shipping_address;
ALTER TABLE order_shipping_address_market RENAME TO order_shipping_address;
CREATE TRIGGER order_shipping_address_no_update BEFORE UPDATE ON order_shipping_address
BEGIN SELECT RAISE(ABORT, 'shipping address is a contractual snapshot'); END;
CREATE TRIGGER order_shipping_address_no_delete BEFORE DELETE ON order_shipping_address
BEGIN SELECT RAISE(ABORT, 'shipping address is a contractual snapshot'); END;
CREATE TABLE order_billing_address_market (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  recipient_name TEXT NOT NULL CHECK (length(recipient_name) BETWEEN 2 AND 120),
  line1 TEXT NOT NULL CHECK (length(line1) BETWEEN 3 AND 160),
  line2 TEXT CHECK (line2 IS NULL OR length(line2) <= 160),
  city TEXT NOT NULL CHECK (length(city) BETWEEN 1 AND 80),
  province TEXT NOT NULL CHECK (province IS NOT NULL AND length(province) <= 80),
  postal_code TEXT NOT NULL CHECK (length(postal_code) BETWEEN 3 AND 12 AND postal_code NOT GLOB '*[^A-Za-z0-9 -]*'),
  country_code TEXT NOT NULL CHECK (length(country_code) = 2 AND country_code NOT GLOB '*[^A-Z]*'),
  nif TEXT CHECK (nif IS NULL OR length(nif) BETWEEN 6 AND 20),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  company_name TEXT CHECK (company_name IS NULL OR length(trim(company_name)) BETWEEN 2 AND 160),
  instructions TEXT CHECK (instructions IS NULL OR length(instructions) BETWEEN 1 AND 500),
  CHECK (country_code <> 'ES' OR postal_code GLOB '[0-9][0-9][0-9][0-9][0-9]')
) STRICT;
INSERT INTO order_billing_address_market(order_id,recipient_name,line1,line2,city,province,postal_code,country_code,nif,created_at,company_name,instructions)
 SELECT order_id,recipient_name,line1,line2,city,province,postal_code,country_code,nif,created_at,company_name,instructions FROM order_billing_address;
DROP TABLE order_billing_address;
ALTER TABLE order_billing_address_market RENAME TO order_billing_address;
CREATE TRIGGER order_billing_address_no_update BEFORE UPDATE ON order_billing_address
BEGIN SELECT RAISE(ABORT, 'billing address is a contractual snapshot'); END;
CREATE TRIGGER order_billing_address_no_delete BEFORE DELETE ON order_billing_address
BEGIN SELECT RAISE(ABORT, 'billing address is a contractual snapshot'); END;

-- CHK-023: immutable per-order snapshot of the market profile the buyer accepted. Ledger columns are the EUR
-- amounts stored on the order (payments stay EUR); presentment columns are the amounts shown in the market currency.
CREATE TABLE order_market_snapshots (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  market TEXT NOT NULL CHECK(length(market)=2 AND market NOT GLOB '*[^A-Z]*'),
  market_version INTEGER NOT NULL CHECK(market_version>0),
  currency TEXT NOT NULL CHECK(length(currency)=3 AND currency NOT GLOB '*[^A-Z]*'),
  exchange_numerator INTEGER NOT NULL CHECK(exchange_numerator>0), exchange_denominator INTEGER NOT NULL CHECK(exchange_denominator>0),
  terms_version TEXT NOT NULL, payment_method TEXT NOT NULL CHECK(payment_method IN('card','bank_transfer','credit')),
  ledger_goods_net_cents INTEGER NOT NULL CHECK(ledger_goods_net_cents>=0), ledger_goods_tax_cents INTEGER NOT NULL CHECK(ledger_goods_tax_cents>=0),
  ledger_shipping_net_cents INTEGER NOT NULL CHECK(ledger_shipping_net_cents>=0), ledger_shipping_tax_cents INTEGER NOT NULL CHECK(ledger_shipping_tax_cents>=0),
  goods_net_minor INTEGER NOT NULL CHECK(goods_net_minor>=0), goods_tax_minor INTEGER NOT NULL CHECK(goods_tax_minor>=0),
  shipping_net_minor INTEGER NOT NULL CHECK(shipping_net_minor>=0), shipping_tax_minor INTEGER NOT NULL CHECK(shipping_tax_minor>=0),
  total_minor INTEGER NOT NULL CHECK(total_minor=goods_net_minor+goods_tax_minor+shipping_net_minor+shipping_tax_minor),
  created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE TRIGGER order_market_snapshots_no_update BEFORE UPDATE ON order_market_snapshots BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER order_market_snapshots_no_delete BEFORE DELETE ON order_market_snapshots BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER order_market_snapshots_profile BEFORE INSERT ON order_market_snapshots
WHEN NOT EXISTS(SELECT 1 FROM checkout_market_commands c WHERE c.market=NEW.market AND c.version=NEW.market_version
  AND c.version=(SELECT max(version) FROM checkout_market_commands WHERE market=NEW.market)
  AND c.currency=NEW.currency AND c.exchange_numerator=NEW.exchange_numerator AND c.exchange_denominator=NEW.exchange_denominator
  AND c.terms_version=NEW.terms_version AND c.shipping_net_minor=NEW.shipping_net_minor
  AND EXISTS(SELECT 1 FROM json_each(c.payment_methods) m WHERE m.value=NEW.payment_method))
BEGIN SELECT RAISE(ABORT,'market_changed'); END;
CREATE TRIGGER order_market_snapshots_order BEFORE INSERT ON order_market_snapshots
WHEN NOT EXISTS(SELECT 1 FROM orders o JOIN order_shipping_address a ON a.order_id=o.id WHERE o.id=NEW.order_id AND a.country_code=NEW.market
  AND o.shipping_net_cents=NEW.ledger_shipping_net_cents AND o.shipping_tax_cents=NEW.ledger_shipping_tax_cents
  AND o.total_net_cents=NEW.ledger_goods_net_cents+NEW.ledger_shipping_net_cents
  AND o.total_tax_cents=NEW.ledger_goods_tax_cents+NEW.ledger_shipping_tax_cents)
 OR NOT EXISTS(SELECT 1 FROM catalog_markets m WHERE m.code=NEW.market AND m.is_active=1)
BEGIN SELECT RAISE(ABORT,'market_order_mismatch'); END;
