CREATE TABLE product_contribution_commands (
 id TEXT PRIMARY KEY,actor_id TEXT NOT NULL REFERENCES identities(id),session_id TEXT NOT NULL REFERENCES auth_sessions(id),session_version INTEGER NOT NULL CHECK(session_version>=1),
 audience TEXT NOT NULL CHECK(audience IN('customer','admin')),customer_id TEXT NOT NULL REFERENCES customers(id),contribution_id TEXT NOT NULL,product_id TEXT NOT NULL REFERENCES products(id),order_id TEXT REFERENCES orders(id),
 action TEXT NOT NULL CHECK(action IN('submit','reply','publish','answer','close','withdraw')),expected_version INTEGER NOT NULL CHECK(expected_version>=0 AND expected_version<100),version INTEGER NOT NULL CHECK(version=expected_version + 1),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),input TEXT NOT NULL CHECK(json_valid(input)),snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),response TEXT NOT NULL CHECK(json_valid(response)),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),UNIQUE(contribution_id,version)
);
CREATE INDEX product_contributions_product ON product_contribution_commands(product_id,contribution_id,version);
CREATE INDEX product_contributions_owner ON product_contribution_commands(customer_id,contribution_id,version);
CREATE TRIGGER product_contributions_no_replace BEFORE INSERT ON product_contribution_commands WHEN EXISTS(SELECT 1 FROM product_contribution_commands WHERE id=NEW.id) BEGIN
 SELECT RAISE(ABORT,'product_contribution_immutable');
END;
CREATE TRIGGER product_contributions_no_update BEFORE UPDATE ON product_contribution_commands BEGIN
 SELECT RAISE(ABORT,'product_contribution_immutable');
END;
CREATE TRIGGER product_contributions_no_delete BEFORE DELETE ON product_contribution_commands BEGIN
 SELECT RAISE(ABORT,'product_contribution_immutable');
END;
CREATE TRIGGER product_contributions_guard BEFORE INSERT ON product_contribution_commands BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM identities i JOIN auth_sessions s ON s.identity_id=i.id
 WHERE i.id=NEW.actor_id AND s.id=NEW.session_id AND i.status='active' AND i.session_version=NEW.session_version AND s.session_version=i.session_version
 AND s.revoked_at IS NULL AND s.created_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
 AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
 AND((NEW.audience='customer' AND i.customer_id=NEW.customer_id AND EXISTS(SELECT 1 FROM customers cu WHERE cu.id=i.customer_id AND cu.status='active') AND(s.mfa_verified=1 OR NOT EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id=i.id AND m.verified_at IS NOT NULL)))
 OR(NEW.audience='admin' AND s.mfa_verified=1 AND EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id=i.id AND m.verified_at IS NOT NULL AND m.verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id AND p.permission_code='support.manage' AND r.granted_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND(r.expires_at IS NULL OR r.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')))))) THEN RAISE(ABORT,'product_contribution_authority') END;
 SELECT CASE WHEN json_extract(NEW.response,'$.commandId') IS NOT NEW.id OR json_extract(NEW.response,'$.contributionId') IS NOT NEW.contribution_id OR json_extract(NEW.response,'$.action') IS NOT NEW.action OR json_extract(NEW.response,'$.payloadHash') IS NOT NEW.payload_hash OR json_extract(NEW.response,'$.expectedVersion') IS NOT NEW.expected_version OR json_extract(NEW.response,'$.version') IS NOT NEW.version OR json_extract(NEW.response,'$.recordedAt') IS NOT NEW.created_at OR json_extract(NEW.snapshot,'$.id') IS NOT NEW.contribution_id OR json_extract(NEW.snapshot,'$.version') IS NOT NEW.version OR json_extract(NEW.snapshot,'$.updatedAt') IS NOT NEW.created_at THEN RAISE(ABORT,'product_contribution_receipt') END;
 SELECT CASE WHEN NEW.action='submit' AND(NEW.audience<>'customer' OR NEW.expected_version<>0 OR EXISTS(SELECT 1 FROM product_contribution_commands WHERE contribution_id=NEW.contribution_id)) THEN RAISE(ABORT,'product_contribution_cas') END;
 SELECT CASE WHEN NEW.action<>'submit' AND NOT EXISTS(SELECT 1 FROM product_contribution_commands c WHERE c.contribution_id=NEW.contribution_id AND c.version=NEW.expected_version AND c.version=(SELECT max(version) FROM product_contribution_commands WHERE contribution_id=NEW.contribution_id) AND c.product_id=NEW.product_id AND c.customer_id=NEW.customer_id AND c.order_id IS NEW.order_id) THEN RAISE(ABORT,'product_contribution_cas') END;
 SELECT CASE WHEN(NEW.action IN('submit','reply') AND NEW.audience<>'customer') OR(NEW.action NOT IN('submit','reply') AND NEW.audience<>'admin') THEN RAISE(ABORT,'product_contribution_authority') END;
END;
CREATE TABLE product_contribution_guards(id TEXT PRIMARY KEY,passed INTEGER NOT NULL CONSTRAINT product_contribution_atomic_guard CHECK(passed=1));
