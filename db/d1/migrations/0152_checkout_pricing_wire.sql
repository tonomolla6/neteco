-- Checkout wiring of the BR pricing rules (PRI-014 automatic discounts, PRI-017 free shipping,
-- PRI-018 store credit). These tables only hold immutable EVIDENCE of what the server applied, so a
-- quote, a shipping snapshot and an order can be recomputed and audited. Rules, credit grants and the
-- credit ledger stay in 0146. Requires 0072 (coupons), 0006 (checkout) and 0146.

-- Automatic discounts applied to one checkout quote (rule ids + versions + per-line amounts).
CREATE TABLE checkout_quote_auto_discounts (
  quote_id TEXT PRIMARY KEY REFERENCES checkout_quotes(id),
  discount_gross_cents INTEGER NOT NULL CHECK(discount_gross_cents > 0),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json) = 'object' AND length(evidence_json) <= 32768),
  evidence_hash TEXT NOT NULL CHECK(length(evidence_hash) = 64 AND evidence_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE TRIGGER checkout_quote_auto_discounts_no_update BEFORE UPDATE ON checkout_quote_auto_discounts
BEGIN SELECT RAISE(ABORT, 'checkout_pricing_immutable'); END;
CREATE TRIGGER checkout_quote_auto_discounts_no_delete BEFORE DELETE ON checkout_quote_auto_discounts
BEGIN SELECT RAISE(ABORT, 'checkout_pricing_immutable'); END;
-- A coupon and automatic discounts never stack on one quote (coupon precedence), enforced in both directions.
CREATE TRIGGER checkout_quote_auto_discounts_no_coupon BEFORE INSERT ON checkout_quote_auto_discounts
WHEN EXISTS(SELECT 1 FROM checkout_quote_promotions WHERE quote_id = NEW.quote_id)
BEGIN SELECT RAISE(ABORT, 'checkout_pricing_coupon_precedence'); END;
CREATE TRIGGER checkout_quote_promotions_no_auto BEFORE INSERT ON checkout_quote_promotions
WHEN EXISTS(SELECT 1 FROM checkout_quote_auto_discounts WHERE quote_id = NEW.quote_id)
BEGIN SELECT RAISE(ABORT, 'checkout_pricing_coupon_precedence'); END;

-- The free-shipping rule that governed one shipping snapshot, with every decision it made.
CREATE TABLE shipping_quote_free_shipping (
  shipping_quote_id TEXT PRIMARY KEY REFERENCES shipping_quotes(id),
  rule_id TEXT NOT NULL CHECK(length(rule_id) = 36),
  rule_version INTEGER NOT NULL CHECK(rule_version >= 1),
  free INTEGER NOT NULL CHECK(free IN (0, 1)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json) = 'object' AND length(evidence_json) <= 16384),
  evidence_hash TEXT NOT NULL CHECK(length(evidence_hash) = 64 AND evidence_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE TRIGGER shipping_quote_free_shipping_no_update BEFORE UPDATE ON shipping_quote_free_shipping
BEGIN SELECT RAISE(ABORT, 'checkout_pricing_immutable'); END;
CREATE TRIGGER shipping_quote_free_shipping_no_delete BEFORE DELETE ON shipping_quote_free_shipping
BEGIN SELECT RAISE(ABORT, 'checkout_pricing_immutable'); END;

-- Reproducible pricing snapshot of an order. Written in the same atomic batch as the order, only when
-- an automatic discount, a free-shipping rule or a store-credit redemption took part.
CREATE TABLE order_pricing_snapshots (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND json_type(snapshot_json) = 'object' AND length(snapshot_json) <= 65536),
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash) = 64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE TRIGGER order_pricing_snapshots_no_update BEFORE UPDATE ON order_pricing_snapshots
BEGIN SELECT RAISE(ABORT, 'checkout_pricing_immutable'); END;
CREATE TRIGGER order_pricing_snapshots_no_delete BEFORE DELETE ON order_pricing_snapshots
BEGIN SELECT RAISE(ABORT, 'checkout_pricing_immutable'); END;

-- PRI-018: store credit reduces the amount to CHARGE, so the ledger of an order and its payment intents
-- must agree. Credit can no longer be spent once a payment intent exists, and an intent for an order
-- with redeemed credit must charge exactly total - credit. Orders without credit are unaffected.
CREATE TRIGGER store_credit_ledger_no_redeem_after_payment BEFORE INSERT ON store_credit_ledger
WHEN NEW.entry_type = 'redeem' AND EXISTS(SELECT 1 FROM payment_intents WHERE order_id = NEW.order_ref)
BEGIN SELECT RAISE(ABORT, 'checkout_credit_after_payment'); END;
CREATE TRIGGER payment_intents_amount_due BEFORE INSERT ON payment_intents
WHEN COALESCE((SELECT -SUM(amount_cents) FROM store_credit_ledger WHERE order_ref = NEW.order_id AND entry_type IN ('redeem', 'restore')), 0) > 0
  AND NEW.amount_gross_cents <> (SELECT total_gross_cents FROM orders WHERE id = NEW.order_id)
    - COALESCE((SELECT -SUM(amount_cents) FROM store_credit_ledger WHERE order_ref = NEW.order_id AND entry_type IN ('redeem', 'restore')), 0)
BEGIN SELECT RAISE(ABORT, 'payment_amount_due_mismatch'); END;

-- PRI-018 compensation: cancelling an unpaid order gives back, in the same statement/transaction as the
-- status change, exactly the credit still applied to it (net of earlier restores) to the grants it came
-- from. Idempotent by construction: a second cancellation finds a net of zero and a cancelled order never
-- changes status again. command_id = order id (unique per order), actor = the identity that redeemed.
CREATE TRIGGER orders_cancel_restore_store_credit AFTER UPDATE OF status ON orders
WHEN NEW.status = 'cancelled' AND OLD.status <> 'cancelled' AND NEW.customer_id IS NOT NULL
  AND COALESCE((SELECT -SUM(amount_cents) FROM store_credit_ledger WHERE order_ref = NEW.id AND entry_type IN ('redeem', 'restore')), 0) > 0
BEGIN
  INSERT INTO pricing_commands(command_id, actor_id, domain, action, target_id, idempotency_key,
    expected_version, applied_version, payload_hash, receipt_json, created_at)
  SELECT NEW.id,
    (SELECT c.actor_id FROM pricing_commands c WHERE c.command_id IN
      (SELECT command_id FROM store_credit_ledger WHERE order_ref = NEW.id AND entry_type = 'redeem') LIMIT 1),
    'store_credit', 'restore', NEW.customer_id, 'cancel-restore:' || NEW.id, 0, a.version + 1,
    substr(replace(NEW.id, '-', '') || replace(NEW.id, '-', ''), 1, 64),
    json_object('commandId', NEW.id, 'domain', 'store_credit', 'action', 'restore', 'targetId', NEW.customer_id,
      'appliedVersion', a.version + 1, 'recordedAt', NEW.updated_at,
      'result', json_object('orderId', NEW.id, 'source', 'cancellation')),
    NEW.updated_at
  FROM store_credit_accounts a WHERE a.customer_id = NEW.customer_id;

  INSERT INTO store_credit_ledger(customer_id, grant_id, entry_type, amount_cents, order_ref, command_id, created_at)
  SELECT l.customer_id, l.grant_id, 'restore', -SUM(l.amount_cents), NEW.id, NEW.id, NEW.updated_at
  FROM store_credit_ledger l JOIN store_credit_grants g ON g.id = l.grant_id AND g.voided_at IS NULL
  WHERE l.order_ref = NEW.id AND l.entry_type IN ('redeem', 'restore')
  GROUP BY l.customer_id, l.grant_id HAVING -SUM(l.amount_cents) > 0;

  UPDATE store_credit_grants SET remaining_cents = remaining_cents + (
    SELECT SUM(r.amount_cents) FROM store_credit_ledger r
    WHERE r.grant_id = store_credit_grants.id AND r.command_id = NEW.id AND r.entry_type = 'restore')
  WHERE id IN (SELECT grant_id FROM store_credit_ledger WHERE command_id = NEW.id AND entry_type = 'restore');

  UPDATE store_credit_accounts SET
    balance_cents = (SELECT COALESCE(SUM(remaining_cents), 0) FROM store_credit_grants
                     WHERE customer_id = store_credit_accounts.customer_id AND voided_at IS NULL),
    version = version + 1, updated_at = NEW.updated_at
  WHERE customer_id = NEW.customer_id;

  INSERT INTO pricing_audit(domain, target_id, action, actor_id, outcome, detail_json, created_at)
  SELECT 'store_credit', NEW.customer_id, 'restore', c.actor_id, 'applied',
    json_object('commandId', NEW.id, 'orderId', NEW.id, 'restoredCents',
      (SELECT COALESCE(SUM(amount_cents), 0) FROM store_credit_ledger WHERE command_id = NEW.id AND entry_type = 'restore'),
      'source', 'cancellation'), NEW.updated_at
  FROM pricing_commands c WHERE c.command_id = NEW.id;
END;
