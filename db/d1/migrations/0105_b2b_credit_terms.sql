-- Immutable, versioned commercial decisions. Commands are the source of truth;
-- the view is derived, so there is no unaudited mutable terms row.
CREATE TABLE b2b_credit_commands (
  actor_id TEXT NOT NULL REFERENCES identities(id),
  command_id TEXT NOT NULL CHECK(length(trim(command_id)) BETWEEN 1 AND 128 AND command_id=trim(command_id)),
  session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  session_version INTEGER NOT NULL CHECK(session_version>=1),
  company_id TEXT NOT NULL REFERENCES companies(id),
  expected_version INTEGER NOT NULL CHECK(expected_version>=0 AND expected_version<9007199254740991),
  payment_days INTEGER NOT NULL CHECK(payment_days IN (0,15,30,60)),
  credit_limit_cents INTEGER NOT NULL CHECK(credit_limit_cents BETWEEN 0 AND 9007199254740991),
  blocked INTEGER NOT NULL CHECK(blocked IN (0,1)),
  block_reason TEXT CHECK((blocked=0 AND block_reason IS NULL) OR
    (blocked=1 AND block_reason IS NOT NULL AND length(trim(block_reason)) BETWEEN 1 AND 500 AND block_reason=trim(block_reason))),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500 AND reason=trim(reason)),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  PRIMARY KEY(actor_id,command_id),
  UNIQUE(company_id,expected_version)
) STRICT;
CREATE INDEX b2b_credit_commands_company_version ON b2b_credit_commands(company_id,expected_version DESC);
CREATE VIEW b2b_credit_terms AS
SELECT company_id,payment_days,credit_limit_cents,blocked,block_reason,
       expected_version+1 AS version,created_at AS updated_at
FROM b2b_credit_commands c
WHERE NOT EXISTS(SELECT 1 FROM b2b_credit_commands newer
  WHERE newer.company_id=c.company_id AND newer.expected_version>c.expected_version);

CREATE TRIGGER b2b_credit_command_authority BEFORE INSERT ON b2b_credit_commands
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE s.id=NEW.session_id AND s.identity_id=NEW.actor_id AND s.session_version=NEW.session_version
 AND i.session_version=s.session_version AND i.status IN ('pending','active') AND i.email_verified_at IS NOT NULL
 AND i.email_verified_at<=NEW.created_at AND s.mfa_verified=1 AND s.revoked_at IS NULL
 AND s.created_at<=NEW.created_at AND s.expires_at>NEW.created_at
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=NEW.created_at
 AND (r.expires_at IS NULL OR r.expires_at>NEW.created_at)))
BEGIN SELECT RAISE(ABORT,'b2b_credit_authorization_changed'); END;
CREATE TRIGGER b2b_credit_command_company BEFORE INSERT ON b2b_credit_commands
WHEN NOT EXISTS(SELECT 1 FROM companies c JOIN customers customer ON customer.id=c.customer_id
 WHERE c.id=NEW.company_id AND c.status='approved' AND customer.status='active')
BEGIN SELECT RAISE(ABORT,'b2b_credit_company_not_approved'); END;
CREATE TRIGGER b2b_credit_command_version BEFORE INSERT ON b2b_credit_commands
WHEN NEW.expected_version<>COALESCE((SELECT MAX(expected_version)+1 FROM b2b_credit_commands WHERE company_id=NEW.company_id),0)
BEGIN SELECT RAISE(ABORT,'b2b_credit_version_conflict'); END;
CREATE TRIGGER b2b_credit_command_no_replace BEFORE INSERT ON b2b_credit_commands
WHEN EXISTS(SELECT 1 FROM b2b_credit_commands WHERE actor_id=NEW.actor_id AND command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'b2b_credit_command_immutable'); END;
CREATE TRIGGER b2b_credit_command_no_update BEFORE UPDATE ON b2b_credit_commands
BEGIN SELECT RAISE(ABORT,'b2b_credit_command_immutable'); END;
CREATE TRIGGER b2b_credit_command_no_delete BEFORE DELETE ON b2b_credit_commands
BEGIN SELECT RAISE(ABORT,'b2b_credit_command_immutable'); END;

-- Each checkout saga owns exactly one immutable credit reservation. D1 batches
-- serialize the guard and insert across carts, including different DO instances.
CREATE TABLE b2b_credit_reservations (
  attempt_id TEXT PRIMARY KEY REFERENCES checkout_attempts(id),
  company_id TEXT NOT NULL REFERENCES companies(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 9007199254740991),
  payment_days INTEGER NOT NULL CHECK(payment_days IN (15,30,60)),
  terms_version INTEGER NOT NULL CHECK(terms_version>=1),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE INDEX b2b_credit_reservations_company ON b2b_credit_reservations(company_id);
CREATE VIEW b2b_credit_open_amounts AS
SELECT r.attempt_id,r.company_id,r.amount_cents,a.state,a.reservation_expires_at,
 o.id AS order_id,o.status AS order_status,
 CASE WHEN o.id IS NULL THEN r.amount_cents
      WHEN o.status='cancelled' OR p.status='paid' THEN 0
      ELSE max(0,r.amount_cents-COALESCE(p.paid_gross_cents,0)-COALESCE((
        SELECT SUM(contract.amount_gross_cents) FROM refund_contracts contract
        JOIN refund_work work ON work.refund_id=contract.id AND work.status='completed'
        JOIN refund_receipts receipt ON receipt.refund_id=contract.id AND receipt.status='succeeded'
        WHERE contract.order_id=o.id),0)) END AS outstanding_cents
FROM b2b_credit_reservations r JOIN checkout_attempts a ON a.id=r.attempt_id
LEFT JOIN orders o ON o.attempt_id=a.id LEFT JOIN order_payment_states p ON p.order_id=o.id;
CREATE TRIGGER b2b_credit_reservation_eligibility BEFORE INSERT ON b2b_credit_reservations
WHEN NOT EXISTS(SELECT 1 FROM companies c JOIN customers customer ON customer.id=c.customer_id
 JOIN b2b_credit_terms terms ON terms.company_id=c.id
 JOIN checkout_attempts a ON a.id=NEW.attempt_id
 WHERE c.id=NEW.company_id AND c.customer_id=NEW.customer_id AND c.status='approved'
 AND customer.status='active' AND terms.blocked=0 AND terms.payment_days=NEW.payment_days
 AND terms.version=NEW.terms_version AND terms.payment_days IN(15,30,60)
 AND a.state='reserving' AND a.reservation_expires_at>NEW.created_at)
BEGIN SELECT RAISE(ABORT,'b2b_credit_unavailable'); END;
CREATE TRIGGER b2b_credit_reservation_limit BEFORE INSERT ON b2b_credit_reservations
WHEN NEW.amount_cents > (SELECT credit_limit_cents FROM b2b_credit_terms WHERE company_id=NEW.company_id) -
 COALESCE((SELECT SUM(outstanding_cents) FROM b2b_credit_open_amounts
 WHERE company_id=NEW.company_id AND (order_id IS NOT NULL OR
 (state IN('reserving','reserved') AND reservation_expires_at>NEW.created_at))),0)
BEGIN SELECT RAISE(ABORT,'b2b_credit_limit_exceeded'); END;
CREATE TRIGGER b2b_credit_reservation_no_update BEFORE UPDATE ON b2b_credit_reservations
BEGIN SELECT RAISE(ABORT,'b2b_credit_immutable'); END;
CREATE TRIGGER b2b_credit_reservation_no_delete BEFORE DELETE ON b2b_credit_reservations
BEGIN SELECT RAISE(ABORT,'b2b_credit_immutable'); END;
CREATE TRIGGER b2b_credit_reservation_no_replace BEFORE INSERT ON b2b_credit_reservations
WHEN EXISTS(SELECT 1 FROM b2b_credit_reservations WHERE attempt_id=NEW.attempt_id)
BEGIN SELECT RAISE(ABORT,'b2b_credit_immutable'); END;

-- Local validation ledger: never updates payment state, fiscal events or the
-- real credit exposure. Its receipts are simulations, not bank evidence.
CREATE TABLE b2b_transfer_simulations (
  actor_id TEXT NOT NULL REFERENCES identities(id), command_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES auth_sessions(id), session_version INTEGER NOT NULL CHECK(session_version>=1),
  order_id TEXT NOT NULL REFERENCES orders(id), expected_outstanding_cents INTEGER NOT NULL CHECK(expected_outstanding_cents>0),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0 AND amount_cents<=expected_outstanding_cents),
  bank_reference TEXT NOT NULL CHECK(length(bank_reference) BETWEEN 6 AND 105 AND bank_reference GLOB 'FAKE-*'
    AND bank_reference NOT GLOB '*[^A-Z0-9-]*'),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND reason=trim(reason)),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  PRIMARY KEY(actor_id,command_id), UNIQUE(order_id,bank_reference)
) STRICT;
CREATE INDEX b2b_transfer_simulations_order ON b2b_transfer_simulations(order_id);
CREATE TRIGGER b2b_transfer_simulations_authority BEFORE INSERT ON b2b_transfer_simulations
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE s.id=NEW.session_id AND s.identity_id=NEW.actor_id AND s.session_version=NEW.session_version
 AND i.session_version=s.session_version AND i.status IN('pending','active') AND i.email_verified_at IS NOT NULL
 AND i.email_verified_at<=NEW.created_at AND s.mfa_verified=1 AND s.revoked_at IS NULL
 AND s.created_at<=NEW.created_at AND s.expires_at>NEW.created_at
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=NEW.created_at
 AND (r.expires_at IS NULL OR r.expires_at>NEW.created_at)))
BEGIN SELECT RAISE(ABORT,'b2b_transfer_authorization_changed'); END;
CREATE TRIGGER b2b_transfer_simulations_cas BEFORE INSERT ON b2b_transfer_simulations
WHEN NOT EXISTS(SELECT 1 FROM b2b_credit_open_amounts open WHERE open.order_id=NEW.order_id
 AND open.order_status<>'cancelled' AND open.outstanding_cents>0
 AND max(0,open.outstanding_cents-COALESCE((SELECT SUM(amount_cents) FROM b2b_transfer_simulations WHERE order_id=NEW.order_id),0))=NEW.expected_outstanding_cents)
BEGIN SELECT RAISE(ABORT,'b2b_transfer_conflict'); END;
CREATE TRIGGER b2b_transfer_simulations_no_replace BEFORE INSERT ON b2b_transfer_simulations
WHEN EXISTS(SELECT 1 FROM b2b_transfer_simulations WHERE (actor_id=NEW.actor_id AND command_id=NEW.command_id)
 OR (order_id=NEW.order_id AND bank_reference=NEW.bank_reference))
BEGIN SELECT RAISE(ABORT,'b2b_transfer_conflict'); END;
CREATE TRIGGER b2b_transfer_simulations_no_update BEFORE UPDATE ON b2b_transfer_simulations
BEGIN SELECT RAISE(ABORT,'b2b_transfer_immutable'); END;
CREATE TRIGGER b2b_transfer_simulations_no_delete BEFORE DELETE ON b2b_transfer_simulations
BEGIN SELECT RAISE(ABORT,'b2b_transfer_immutable'); END;
