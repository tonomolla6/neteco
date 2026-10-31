-- PRI-014 automatic discounts, PRI-017 margin-aware free shipping, PRI-018 store credit,
-- PRI-021 deposits / partial-payment schedules. Integer cents only; CAS versions,
-- strict idempotency and an append-only audit trail shared by the four domains.

CREATE TABLE pricing_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  domain TEXT NOT NULL CHECK(domain IN ('auto_discount', 'free_shipping', 'store_credit', 'payment_schedule')),
  action TEXT NOT NULL CHECK(length(action) BETWEEN 3 AND 40),
  target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 128),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  applied_version INTEGER NOT NULL CHECK(applied_version >= 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(receipt_json) <= 16384),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(actor_id, idempotency_key)
) STRICT;
CREATE TRIGGER pricing_commands_no_update BEFORE UPDATE ON pricing_commands BEGIN SELECT RAISE(ABORT, 'pricing_command_immutable'); END;
CREATE TRIGGER pricing_commands_no_delete BEFORE DELETE ON pricing_commands BEGIN SELECT RAISE(ABORT, 'pricing_command_immutable'); END;

-- Append-only audit: before/after images, blocked fraud attempts included.
CREATE TABLE pricing_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL CHECK(domain IN ('auto_discount', 'free_shipping', 'store_credit', 'payment_schedule')),
  target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK(length(action) BETWEEN 3 AND 40),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  outcome TEXT NOT NULL CHECK(outcome IN ('applied', 'blocked')),
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json) AND length(detail_json) <= 16384),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE INDEX pricing_audit_target ON pricing_audit(domain, target_id, id);
CREATE TRIGGER pricing_audit_no_update BEFORE UPDATE ON pricing_audit BEGIN SELECT RAISE(ABORT, 'pricing_audit_immutable'); END;
CREATE TRIGGER pricing_audit_no_delete BEFORE DELETE ON pricing_audit BEGIN SELECT RAISE(ABORT, 'pricing_audit_immutable'); END;

-- ------------------------------------------------------------------ PRI-014
CREATE TABLE auto_discount_rules (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  code TEXT NOT NULL UNIQUE CHECK(length(code) BETWEEN 3 AND 40 AND code = upper(code) AND code NOT GLOB '*[^A-Z0-9_-]*'),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 3 AND 120),
  status TEXT NOT NULL CHECK(status IN ('draft', 'active', 'paused', 'archived')),
  version INTEGER NOT NULL CHECK(version >= 1),
  kind TEXT NOT NULL CHECK(kind IN ('product', 'category', 'basket', 'volume')),
  scope_ids_json TEXT NOT NULL CHECK(json_valid(scope_ids_json) AND json_type(scope_ids_json) = 'array' AND json_array_length(scope_ids_json) <= 100),
  benefit_kind TEXT NOT NULL CHECK(benefit_kind IN ('percent', 'fixed', 'tiers')),
  basis_points INTEGER CHECK(basis_points IS NULL OR basis_points BETWEEN 1 AND 10000),
  fixed_gross_cents INTEGER CHECK(fixed_gross_cents IS NULL OR fixed_gross_cents >= 1),
  tiers_json TEXT NOT NULL CHECK(json_valid(tiers_json) AND json_type(tiers_json) = 'array' AND json_array_length(tiers_json) <= 10),
  min_basket_gross_cents INTEGER NOT NULL CHECK(min_basket_gross_cents >= 0),
  priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 1000),
  stacking TEXT NOT NULL CHECK(stacking IN ('exclusive', 'stackable')),
  segment TEXT NOT NULL CHECK(segment IN ('all', 'registered', 'approved_company')),
  margin_floor_basis_points INTEGER NOT NULL CHECK(margin_floor_basis_points BETWEEN 0 AND 9000),
  customer_message TEXT NOT NULL CHECK(length(customer_message) BETWEEN 3 AND 160),
  starts_at TEXT NOT NULL CHECK(starts_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', starts_at), '')),
  ends_at TEXT CHECK(ends_at IS NULL OR (ends_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', ends_at), '') AND ends_at > starts_at)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  updated_by TEXT NOT NULL REFERENCES identities(id),
  CHECK((benefit_kind = 'percent') = (basis_points IS NOT NULL)),
  CHECK((benefit_kind = 'fixed') = (fixed_gross_cents IS NOT NULL)),
  CHECK((benefit_kind = 'tiers') = (json_array_length(tiers_json) > 0)),
  CHECK((kind IN ('product', 'category')) = (json_array_length(scope_ids_json) > 0) OR kind IN ('basket', 'volume')),
  CHECK(kind <> 'volume' OR benefit_kind = 'tiers'),
  CHECK(kind = 'volume' OR benefit_kind <> 'tiers')
) STRICT;
CREATE INDEX auto_discount_rules_active ON auto_discount_rules(status, priority, code);
CREATE TRIGGER auto_discount_rules_update_guard BEFORE UPDATE ON auto_discount_rules
WHEN NEW.id IS NOT OLD.id OR NEW.code IS NOT OLD.code OR NEW.created_at IS NOT OLD.created_at
  OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at OR OLD.status = 'archived'
BEGIN SELECT RAISE(ABORT, 'pricing_version_conflict'); END;
CREATE TRIGGER auto_discount_rules_no_delete BEFORE DELETE ON auto_discount_rules BEGIN SELECT RAISE(ABORT, 'pricing_immutable'); END;

-- ------------------------------------------------------------------ PRI-017
CREATE TABLE free_shipping_rules (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  code TEXT NOT NULL UNIQUE CHECK(length(code) BETWEEN 3 AND 40 AND code = upper(code) AND code NOT GLOB '*[^A-Z0-9_-]*'),
  status TEXT NOT NULL CHECK(status IN ('draft', 'active', 'paused', 'archived')),
  version INTEGER NOT NULL CHECK(version >= 1),
  profile TEXT NOT NULL CHECK(profile IN ('parcel', 'pallet', 'adr')),
  zone TEXT NOT NULL CHECK(zone IN ('local', 'peninsular', 'remote')),
  customer_profile TEXT NOT NULL CHECK(customer_profile IN ('any', 'consumer', 'company')),
  threshold_gross_cents INTEGER NOT NULL CHECK(threshold_gross_cents >= 0),
  min_margin_basis_points INTEGER NOT NULL CHECK(min_margin_basis_points BETWEEN 0 AND 9000),
  conscious_subsidy INTEGER NOT NULL CHECK(conscious_subsidy IN (0, 1)),
  subsidy_cap_net_cents INTEGER CHECK(subsidy_cap_net_cents IS NULL OR subsidy_cap_net_cents >= 1),
  subsidy_reason TEXT CHECK(subsidy_reason IS NULL OR length(subsidy_reason) BETWEEN 20 AND 500),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  updated_by TEXT NOT NULL REFERENCES identities(id),
  -- Pallet, ADR and remote zones are never subsidised by accident.
  CHECK(conscious_subsidy = 1 OR (profile = 'parcel' AND zone <> 'remote')),
  CHECK(conscious_subsidy = 0 OR (subsidy_cap_net_cents IS NOT NULL AND subsidy_reason IS NOT NULL)),
  CHECK(conscious_subsidy = 1 OR (subsidy_cap_net_cents IS NULL AND subsidy_reason IS NULL))
) STRICT;
CREATE UNIQUE INDEX free_shipping_rules_one_active ON free_shipping_rules(profile, zone, customer_profile) WHERE status = 'active';
CREATE TRIGGER free_shipping_rules_update_guard BEFORE UPDATE ON free_shipping_rules
WHEN NEW.id IS NOT OLD.id OR NEW.code IS NOT OLD.code OR NEW.created_at IS NOT OLD.created_at
  OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at OR OLD.status = 'archived'
BEGIN SELECT RAISE(ABORT, 'pricing_version_conflict'); END;
CREATE TRIGGER free_shipping_rules_no_delete BEFORE DELETE ON free_shipping_rules BEGIN SELECT RAISE(ABORT, 'pricing_immutable'); END;

-- ------------------------------------------------------------------ PRI-018
CREATE TABLE store_credit_accounts (
  customer_id TEXT PRIMARY KEY REFERENCES customers(id),
  balance_cents INTEGER NOT NULL CHECK(balance_cents >= 0),
  version INTEGER NOT NULL CHECK(version >= 1),
  frozen INTEGER NOT NULL DEFAULT 0 CHECK(frozen IN (0, 1)),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;
CREATE TRIGGER store_credit_accounts_guard BEFORE UPDATE ON store_credit_accounts
WHEN NEW.customer_id IS NOT OLD.customer_id OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'pricing_version_conflict'); END;
CREATE TRIGGER store_credit_accounts_no_delete BEFORE DELETE ON store_credit_accounts BEGIN SELECT RAISE(ABORT, 'pricing_immutable'); END;

CREATE TABLE store_credit_grants (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  customer_id TEXT NOT NULL REFERENCES store_credit_accounts(customer_id),
  kind TEXT NOT NULL CHECK(kind IN ('refund_credit', 'compensation_coupon')),
  source_ref TEXT NOT NULL CHECK(length(source_ref) BETWEEN 3 AND 128),
  amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 1000000),
  remaining_cents INTEGER NOT NULL CHECK(remaining_cents >= 0 AND remaining_cents <= amount_cents),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 10 AND 300),
  issued_by TEXT NOT NULL REFERENCES identities(id),
  issued_at TEXT NOT NULL CHECK(issued_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', issued_at), '')),
  expires_at TEXT NOT NULL CHECK(expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at), '') AND expires_at > issued_at),
  voided_at TEXT CHECK(voided_at IS NULL OR voided_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', voided_at), '')),
  UNIQUE(kind, source_ref)
) STRICT;
CREATE INDEX store_credit_grants_spend ON store_credit_grants(customer_id, expires_at) WHERE remaining_cents > 0;
CREATE TRIGGER store_credit_grants_guard BEFORE UPDATE ON store_credit_grants
WHEN NEW.id IS NOT OLD.id OR NEW.customer_id IS NOT OLD.customer_id OR NEW.amount_cents IS NOT OLD.amount_cents
  OR NEW.expires_at IS NOT OLD.expires_at OR NEW.issued_at IS NOT OLD.issued_at
BEGIN SELECT RAISE(ABORT, 'pricing_immutable'); END;
CREATE TRIGGER store_credit_grants_no_delete BEFORE DELETE ON store_credit_grants BEGIN SELECT RAISE(ABORT, 'pricing_immutable'); END;

CREATE TABLE store_credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL REFERENCES store_credit_accounts(customer_id),
  grant_id TEXT NOT NULL REFERENCES store_credit_grants(id),
  entry_type TEXT NOT NULL CHECK(entry_type IN ('issue', 'redeem', 'restore', 'expire', 'void')),
  amount_cents INTEGER NOT NULL CHECK(amount_cents <> 0),
  order_ref TEXT CHECK(order_ref IS NULL OR length(order_ref) BETWEEN 1 AND 128),
  command_id TEXT NOT NULL REFERENCES pricing_commands(command_id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  CHECK((entry_type IN ('issue', 'restore')) = (amount_cents > 0)),
  CHECK((entry_type IN ('redeem', 'restore')) = (order_ref IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX store_credit_ledger_redeem_once ON store_credit_ledger(grant_id, order_ref) WHERE entry_type = 'redeem';
CREATE UNIQUE INDEX store_credit_ledger_restore_once ON store_credit_ledger(grant_id, order_ref) WHERE entry_type = 'restore';
CREATE UNIQUE INDEX store_credit_ledger_expire_once ON store_credit_ledger(grant_id) WHERE entry_type IN ('expire', 'void');
-- A redemption may never exceed the order total (net of restores), nor use a void/expired grant.
CREATE TRIGGER store_credit_ledger_over_redeem BEFORE INSERT ON store_credit_ledger
WHEN NEW.entry_type = 'redeem' AND (
  COALESCE((SELECT -SUM(amount_cents) FROM store_credit_ledger WHERE order_ref = NEW.order_ref AND entry_type IN ('redeem', 'restore')), 0) - NEW.amount_cents
  > COALESCE((SELECT total_gross_cents FROM orders WHERE id = NEW.order_ref), -1))
BEGIN SELECT RAISE(ABORT, 'pricing_over_redeem'); END;
CREATE TRIGGER store_credit_ledger_usable_grant BEFORE INSERT ON store_credit_ledger
WHEN NEW.entry_type = 'redeem' AND NOT EXISTS (
  SELECT 1 FROM store_credit_grants g WHERE g.id = NEW.grant_id AND g.voided_at IS NULL AND g.expires_at > NEW.created_at)
BEGIN SELECT RAISE(ABORT, 'pricing_credit_unusable'); END;
CREATE INDEX store_credit_ledger_customer ON store_credit_ledger(customer_id, id);
CREATE TRIGGER store_credit_ledger_no_update BEFORE UPDATE ON store_credit_ledger BEGIN SELECT RAISE(ABORT, 'pricing_immutable'); END;
CREATE TRIGGER store_credit_ledger_no_delete BEFORE DELETE ON store_credit_ledger BEGIN SELECT RAISE(ABORT, 'pricing_immutable'); END;

-- ------------------------------------------------------------------ PRI-021
CREATE TABLE payment_schedules (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  quote_id TEXT NOT NULL REFERENCES sales_quotes(id),
  quote_version INTEGER NOT NULL CHECK(quote_version >= 1),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  total_gross_cents INTEGER NOT NULL CHECK(total_gross_cents >= 1),
  status TEXT NOT NULL CHECK(status IN ('active', 'cancelled')),
  version INTEGER NOT NULL CHECK(version >= 1),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;
CREATE UNIQUE INDEX payment_schedules_one_live_per_quote ON payment_schedules(quote_id) WHERE status <> 'cancelled';
CREATE TRIGGER payment_schedules_guard BEFORE UPDATE ON payment_schedules
WHEN NEW.id IS NOT OLD.id OR NEW.quote_id IS NOT OLD.quote_id OR NEW.customer_id IS NOT OLD.customer_id
  OR NEW.total_gross_cents IS NOT OLD.total_gross_cents OR NEW.version <> OLD.version + 1
  OR NEW.updated_at < OLD.updated_at OR OLD.status <> 'active'
BEGIN SELECT RAISE(ABORT, 'pricing_version_conflict'); END;
CREATE TRIGGER payment_schedules_no_delete BEFORE DELETE ON payment_schedules BEGIN SELECT RAISE(ABORT, 'pricing_immutable'); END;

CREATE TABLE payment_schedule_installments (
  schedule_id TEXT NOT NULL REFERENCES payment_schedules(id),
  seq INTEGER NOT NULL CHECK(seq BETWEEN 1 AND 12),
  kind TEXT NOT NULL CHECK(kind IN ('deposit', 'installment', 'balance')),
  due_cents INTEGER NOT NULL CHECK(due_cents >= 1),
  due_at TEXT NOT NULL CHECK(due_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', due_at), '')),
  PRIMARY KEY(schedule_id, seq)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER payment_schedule_installments_no_update BEFORE UPDATE ON payment_schedule_installments BEGIN SELECT RAISE(ABORT, 'pricing_immutable'); END;
CREATE TRIGGER payment_schedule_installments_no_delete BEFORE DELETE ON payment_schedule_installments BEGIN SELECT RAISE(ABORT, 'pricing_immutable'); END;

-- Ledger of money and fiscal documents. Amounts are positive; entry_type gives the sign.
CREATE TABLE payment_schedule_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id TEXT NOT NULL REFERENCES payment_schedules(id),
  seq INTEGER CHECK(seq IS NULL OR seq BETWEEN 1 AND 12),
  entry_type TEXT NOT NULL CHECK(entry_type IN ('capture', 'refund', 'invoice', 'credit_note')),
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 1),
  external_ref TEXT NOT NULL CHECK(length(external_ref) BETWEEN 3 AND 128),
  command_id TEXT NOT NULL REFERENCES pricing_commands(command_id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(schedule_id, entry_type, external_ref),
  FOREIGN KEY(schedule_id, seq) REFERENCES payment_schedule_installments(schedule_id, seq),
  CHECK(entry_type <> 'capture' OR seq IS NOT NULL)
) STRICT;
CREATE INDEX payment_schedule_ledger_schedule ON payment_schedule_ledger(schedule_id, id);
CREATE TRIGGER payment_schedule_ledger_no_update BEFORE UPDATE ON payment_schedule_ledger BEGIN SELECT RAISE(ABORT, 'pricing_immutable'); END;
CREATE TRIGGER payment_schedule_ledger_no_delete BEFORE DELETE ON payment_schedule_ledger BEGIN SELECT RAISE(ABORT, 'pricing_immutable'); END;
-- A capture may never exceed what the schedule asks for, whatever the application does.
CREATE TRIGGER payment_schedule_ledger_capture_cap BEFORE INSERT ON payment_schedule_ledger
WHEN NEW.entry_type = 'capture' AND (
  COALESCE((SELECT SUM(amount_cents) FROM payment_schedule_ledger WHERE schedule_id = NEW.schedule_id AND entry_type = 'capture'), 0) + NEW.amount_cents
  > (SELECT total_gross_cents FROM payment_schedules WHERE id = NEW.schedule_id)
  OR COALESCE((SELECT SUM(amount_cents) FROM payment_schedule_ledger WHERE schedule_id = NEW.schedule_id AND entry_type = 'capture' AND seq = NEW.seq), 0) + NEW.amount_cents
  > (SELECT due_cents FROM payment_schedule_installments WHERE schedule_id = NEW.schedule_id AND seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'pricing_overpayment'); END;
CREATE TRIGGER payment_schedule_ledger_refund_cap BEFORE INSERT ON payment_schedule_ledger
WHEN NEW.entry_type = 'refund' AND
  COALESCE((SELECT SUM(amount_cents) FROM payment_schedule_ledger WHERE schedule_id = NEW.schedule_id AND entry_type = 'refund'), 0) + NEW.amount_cents
  > COALESCE((SELECT SUM(amount_cents) FROM payment_schedule_ledger WHERE schedule_id = NEW.schedule_id AND entry_type = 'capture'), 0)
BEGIN SELECT RAISE(ABORT, 'pricing_overrefund'); END;
CREATE TRIGGER payment_schedule_ledger_invoice_cap BEFORE INSERT ON payment_schedule_ledger
WHEN NEW.entry_type = 'invoice' AND
  COALESCE((SELECT SUM(amount_cents) FROM payment_schedule_ledger WHERE schedule_id = NEW.schedule_id AND entry_type = 'invoice'), 0) + NEW.amount_cents
  > (SELECT total_gross_cents FROM payment_schedules WHERE id = NEW.schedule_id)
BEGIN SELECT RAISE(ABORT, 'pricing_overinvoice'); END;
CREATE TRIGGER payment_schedule_ledger_credit_cap BEFORE INSERT ON payment_schedule_ledger
WHEN NEW.entry_type = 'credit_note' AND
  COALESCE((SELECT SUM(amount_cents) FROM payment_schedule_ledger WHERE schedule_id = NEW.schedule_id AND entry_type = 'credit_note'), 0) + NEW.amount_cents
  > COALESCE((SELECT SUM(amount_cents) FROM payment_schedule_ledger WHERE schedule_id = NEW.schedule_id AND entry_type = 'invoice'), 0)
BEGIN SELECT RAISE(ABORT, 'pricing_overcredit'); END;

-- Compare-and-set at the command boundary; a stale writer aborts the whole batch.
CREATE TRIGGER pricing_commands_cas BEFORE INSERT ON pricing_commands
WHEN NEW.expected_version > 0 AND NEW.expected_version <> COALESCE(CASE NEW.domain
    WHEN 'auto_discount' THEN (SELECT version FROM auto_discount_rules WHERE id = NEW.target_id)
    WHEN 'free_shipping' THEN (SELECT version FROM free_shipping_rules WHERE id = NEW.target_id)
    WHEN 'store_credit' THEN (SELECT version FROM store_credit_accounts WHERE customer_id = NEW.target_id)
    ELSE (SELECT version FROM payment_schedules WHERE id = NEW.target_id) END, -1)
BEGIN SELECT RAISE(ABORT, 'pricing_version_conflict'); END;
