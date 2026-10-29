-- Commercial offers authorize only their immutable, reviewed server prices.
-- No stock, order, promotion, consent or monetary policy is seeded here.
CREATE TABLE sales_quotes (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id),
 current_version INTEGER NOT NULL CHECK(current_version>=1),
 created_by TEXT NOT NULL REFERENCES identities(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE sales_quote_versions (
 quote_id TEXT NOT NULL REFERENCES sales_quotes(id), version INTEGER NOT NULL CHECK(version>=1),
 status TEXT NOT NULL CHECK(status IN('draft','reviewed','approved','revoked','converted')),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'),
 actor_id TEXT NOT NULL REFERENCES identities(id), created_at TEXT NOT NULL,
 PRIMARY KEY(quote_id,version),
 CHECK(json_extract(snapshot_json,'$.id') IS quote_id AND json_extract(snapshot_json,'$.version') IS version
 AND json_extract(snapshot_json,'$.status') IS status AND json_extract(snapshot_json,'$.updatedAt') IS created_at)
) STRICT;
CREATE TABLE sales_quote_commands (
 actor_id TEXT NOT NULL REFERENCES identities(id), command_id TEXT NOT NULL,
 session_id TEXT NOT NULL REFERENCES auth_sessions(id), session_version INTEGER NOT NULL CHECK(session_version>=1),
 quote_id TEXT NOT NULL REFERENCES sales_quotes(id), action TEXT NOT NULL CHECK(action IN('create','revise','review','approve','revoke','convert')),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 input_json TEXT NOT NULL CHECK(json_valid(input_json)), receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 result_version INTEGER NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(actor_id,command_id), UNIQUE(quote_id,result_version),
 FOREIGN KEY(quote_id,result_version) REFERENCES sales_quote_versions(quote_id,version) DEFERRABLE INITIALLY DEFERRED,
 CHECK(json_extract(receipt_json,'$.commandId') IS command_id AND json_extract(receipt_json,'$.quoteId') IS quote_id
 AND json_extract(receipt_json,'$.version') IS result_version AND json_extract(receipt_json,'$.payloadHash') IS payload_hash
 AND json_extract(receipt_json,'$.action') IS action AND json_extract(receipt_json,'$.recordedAt') IS created_at)
) STRICT;
CREATE TABLE sales_quote_audit (
 actor_id TEXT NOT NULL, command_id TEXT NOT NULL, quote_id TEXT NOT NULL, result_version INTEGER NOT NULL,
 input_json TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(actor_id,command_id),
 FOREIGN KEY(actor_id,command_id) REFERENCES sales_quote_commands(actor_id,command_id)
) STRICT;
CREATE TABLE sales_quote_conversions (
 quote_id TEXT PRIMARY KEY REFERENCES sales_quotes(id), quote_version INTEGER NOT NULL,
 approved_hash TEXT NOT NULL CHECK(length(approved_hash)=64 AND approved_hash NOT GLOB '*[^0-9a-f]*'),
 customer_id TEXT NOT NULL REFERENCES customers(id), cart_id TEXT NOT NULL UNIQUE REFERENCES carts(id),
 checkout_quote_id TEXT NOT NULL UNIQUE REFERENCES checkout_quotes(id), checkout_key TEXT NOT NULL UNIQUE,
 actor_id TEXT NOT NULL REFERENCES identities(id), session_id TEXT NOT NULL REFERENCES auth_sessions(id), session_version INTEGER NOT NULL,
 command_id TEXT NOT NULL, payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 input_json TEXT NOT NULL CHECK(json_valid(input_json)), created_at TEXT NOT NULL,
 FOREIGN KEY(quote_id,quote_version) REFERENCES sales_quote_versions(quote_id,version)
) STRICT;
CREATE TABLE sales_quote_guards(id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1)) STRICT;
CREATE TRIGGER sales_quote_version_no_update BEFORE UPDATE ON sales_quote_versions BEGIN SELECT RAISE(ABORT,'sales_quote_immutable'); END;
CREATE TRIGGER sales_quote_version_no_delete BEFORE DELETE ON sales_quote_versions BEGIN SELECT RAISE(ABORT,'sales_quote_immutable'); END;
CREATE TRIGGER sales_quote_version_no_replace BEFORE INSERT ON sales_quote_versions WHEN EXISTS(SELECT 1 FROM sales_quote_versions WHERE quote_id=NEW.quote_id AND version=NEW.version) BEGIN SELECT RAISE(ABORT,'sales_quote_immutable'); END;
CREATE TRIGGER sales_quote_command_no_update BEFORE UPDATE ON sales_quote_commands BEGIN SELECT RAISE(ABORT,'sales_quote_immutable'); END;
CREATE TRIGGER sales_quote_command_no_delete BEFORE DELETE ON sales_quote_commands BEGIN SELECT RAISE(ABORT,'sales_quote_immutable'); END;
CREATE TRIGGER sales_quote_command_no_replace BEFORE INSERT ON sales_quote_commands WHEN EXISTS(SELECT 1 FROM sales_quote_commands WHERE actor_id=NEW.actor_id AND command_id=NEW.command_id) BEGIN SELECT RAISE(ABORT,'sales_quote_immutable'); END;
CREATE TRIGGER sales_quote_audit_no_update BEFORE UPDATE ON sales_quote_audit BEGIN SELECT RAISE(ABORT,'sales_quote_immutable'); END;
CREATE TRIGGER sales_quote_audit_no_delete BEFORE DELETE ON sales_quote_audit BEGIN SELECT RAISE(ABORT,'sales_quote_immutable'); END;
CREATE TRIGGER sales_quote_audit_no_replace BEFORE INSERT ON sales_quote_audit WHEN EXISTS(SELECT 1 FROM sales_quote_audit WHERE actor_id=NEW.actor_id AND command_id=NEW.command_id) BEGIN SELECT RAISE(ABORT,'sales_quote_immutable'); END;
CREATE TRIGGER sales_quote_audit_match BEFORE INSERT ON sales_quote_audit WHEN NOT EXISTS(SELECT 1 FROM sales_quote_commands c WHERE c.actor_id=NEW.actor_id AND c.command_id=NEW.command_id AND c.quote_id=NEW.quote_id AND c.result_version=NEW.result_version AND c.input_json=NEW.input_json AND c.receipt_json=NEW.receipt_json AND c.created_at=NEW.created_at) BEGIN SELECT RAISE(ABORT,'sales_quote_audit_mismatch'); END;
CREATE TRIGGER sales_quote_conversion_no_update BEFORE UPDATE ON sales_quote_conversions BEGIN SELECT RAISE(ABORT,'sales_quote_immutable'); END;
CREATE TRIGGER sales_quote_conversion_no_delete BEFORE DELETE ON sales_quote_conversions BEGIN SELECT RAISE(ABORT,'sales_quote_immutable'); END;
CREATE TRIGGER sales_quote_conversion_no_replace BEFORE INSERT ON sales_quote_conversions WHEN EXISTS(SELECT 1 FROM sales_quote_conversions WHERE quote_id=NEW.quote_id OR cart_id=NEW.cart_id OR checkout_key=NEW.checkout_key) BEGIN SELECT RAISE(ABORT,'sales_quote_immutable'); END;
CREATE TRIGGER sales_quote_head_no_delete BEFORE DELETE ON sales_quotes BEGIN SELECT RAISE(ABORT,'sales_quote_immutable'); END;
CREATE TRIGGER sales_quote_head_no_replace BEFORE INSERT ON sales_quotes WHEN EXISTS(SELECT 1 FROM sales_quotes WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'sales_quote_immutable'); END;
CREATE TRIGGER sales_quote_head_transition BEFORE UPDATE ON sales_quotes WHEN NEW.id IS NOT OLD.id OR NEW.customer_id IS NOT OLD.customer_id OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at OR NEW.current_version<>OLD.current_version+1 OR NOT EXISTS(SELECT 1 FROM sales_quote_versions v WHERE v.quote_id=NEW.id AND v.version=NEW.current_version AND v.created_at=NEW.updated_at) BEGIN SELECT RAISE(ABORT,'sales_quote_head_invalid'); END;

-- Reservation and order gates are independent of JavaScript timing. They also
-- apply to cross-cart attempts; a quote can bind only one canonical checkout.
CREATE TRIGGER sales_quote_reservation_authority BEFORE INSERT ON inventory_reservations
WHEN EXISTS(SELECT 1 FROM checkout_attempts a JOIN sales_quote_conversions c ON c.cart_id=a.cart_id WHERE NEW.id=a.id||':reserve')
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM checkout_attempts a JOIN sales_quote_conversions c ON c.cart_id=a.cart_id
 JOIN sales_quotes q ON q.id=c.quote_id AND q.current_version=c.quote_version AND q.customer_id=c.customer_id
 JOIN sales_quote_versions v ON v.quote_id=q.id AND v.version=q.current_version AND v.status='approved'
 JOIN auth_sessions s ON s.id=c.session_id AND s.identity_id=c.actor_id AND s.session_version=c.session_version
 JOIN identities i ON i.id=s.identity_id AND i.customer_id=c.customer_id AND i.session_version=s.session_version AND i.status='active'
 JOIN customers customer ON customer.id=c.customer_id AND customer.status='active'
 WHERE NEW.id=a.id||':reserve' AND a.command_key=c.checkout_key
 AND json_extract(v.snapshot_json,'$.approvedHash')=c.approved_hash
 AND json_extract(v.snapshot_json,'$.definition.validUntil')>strftime('%Y-%m-%dT%H:%M:%SZ','now')
 AND s.revoked_at IS NULL AND s.created_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
 AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now') AND i.email_verified_at IS NOT NULL
 AND i.email_verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 THEN RAISE(ABORT,'sales_quote_authority_changed') END;
END;
CREATE TRIGGER sales_quote_order_authority BEFORE INSERT ON orders
WHEN EXISTS(SELECT 1 FROM sales_quote_conversions c WHERE c.cart_id=NEW.cart_id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sales_quote_conversions c JOIN sales_quotes q ON q.id=c.quote_id
 JOIN sales_quote_versions v ON v.quote_id=q.id AND v.version=q.current_version AND v.status='approved'
 JOIN auth_sessions s ON s.id=c.session_id AND s.identity_id=c.actor_id AND s.session_version=c.session_version
 JOIN identities i ON i.id=s.identity_id AND i.customer_id=c.customer_id AND i.session_version=s.session_version AND i.status='active'
 JOIN customers customer ON customer.id=c.customer_id AND customer.status='active'
 WHERE c.cart_id=NEW.cart_id AND c.checkout_quote_id=NEW.quote_id AND q.current_version=c.quote_version
 AND NEW.customer_id=c.customer_id AND json_extract(v.snapshot_json,'$.approvedHash')=c.approved_hash
 AND json_extract(v.snapshot_json,'$.definition.validUntil')>strftime('%Y-%m-%dT%H:%M:%SZ','now')
 AND NEW.total_net_cents=json_extract(v.snapshot_json,'$.total.netCents') AND NEW.total_tax_cents=json_extract(v.snapshot_json,'$.total.taxCents')
 AND NEW.total_gross_cents=json_extract(v.snapshot_json,'$.total.grossCents')
 AND s.revoked_at IS NULL AND s.created_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
 AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now') AND i.email_verified_at IS NOT NULL
 AND i.email_verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 THEN RAISE(ABORT,'sales_quote_authority_changed') END;
END;
