-- PRI-018 downstream: an order may be paid partly with store credit (0146 ledger, 0152 checkout wiring).
-- The order total stays contractual (invoice total, tax base, refundable value); the card/provider is
-- charged total - credit. Requires 0006 (order_events), 0048 (refunds), 0126 (pre-authorisations),
-- 0146 and 0152.

-- 1) Every credit movement tied to an order (redeem, restore) is mirrored, in the same statement, into the
-- append-only order history. Payment, fulfilment, returns, refunds and fiscal proofs read the credit
-- applied to an order from order_events (present in every database since 0006), so the amount due is
-- always total_gross_cents - SUM(appliedCents).
CREATE TRIGGER store_credit_ledger_order_event AFTER INSERT ON store_credit_ledger
WHEN NEW.order_ref IS NOT NULL AND NEW.entry_type IN ('redeem', 'restore')
BEGIN
  INSERT INTO order_events(id, order_id, event_type, payload_json, correlation_id, created_at)
  VALUES ('store-credit-ledger:' || NEW.id, NEW.order_ref, 'store_credit.applied',
    json_object('ledgerId', NEW.id, 'entryType', NEW.entry_type, 'grantId', NEW.grant_id,
      'appliedCents', -NEW.amount_cents, 'commandId', NEW.command_id),
    NEW.command_id, NEW.created_at);
END;
INSERT INTO order_events(id, order_id, event_type, payload_json, correlation_id, created_at)
SELECT 'store-credit-ledger:' || l.id, l.order_ref, 'store_credit.applied',
  json_object('ledgerId', l.id, 'entryType', l.entry_type, 'grantId', l.grant_id,
    'appliedCents', -l.amount_cents, 'commandId', l.command_id),
  l.command_id, l.created_at
FROM store_credit_ledger l JOIN orders o ON o.id = l.order_ref
WHERE l.entry_type IN ('redeem', 'restore')
  AND NOT EXISTS (SELECT 1 FROM order_events e WHERE e.id = 'store-credit-ledger:' || l.id);

-- 2) A pre-authorisation fixes the amount to charge, exactly like a payment intent (0152): credit can no
-- longer be spent on that order afterwards.
CREATE TRIGGER store_credit_ledger_no_redeem_after_preauth BEFORE INSERT ON store_credit_ledger
WHEN NEW.entry_type = 'redeem' AND EXISTS(SELECT 1 FROM payment_preauths WHERE order_id = NEW.order_ref)
BEGIN SELECT RAISE(ABORT, 'checkout_credit_after_payment'); END;

-- 3) Refund budget = what the card captured + the store credit applied to the order (= order total).
DROP TRIGGER refund_allocation_capture_budget;
CREATE TRIGGER refund_allocation_capture_budget BEFORE INSERT ON refund_allocations
WHEN (SELECT COALESCE(sum(a.gross_cents),0) FROM refund_allocations a JOIN refund_contracts c ON c.id=a.refund_id
 JOIN refund_work w ON w.refund_id=c.id WHERE c.payment_intent_id=(SELECT payment_intent_id FROM refund_contracts WHERE id=NEW.refund_id) AND w.status<>'cancelled')+NEW.gross_cents>
 (SELECT intent.amount_gross_cents+COALESCE((SELECT -SUM(l.amount_cents) FROM store_credit_ledger l WHERE l.order_ref=c.order_id AND l.entry_type IN('redeem','restore')),0)
  FROM refund_contracts c JOIN payment_intents intent ON intent.id=c.payment_intent_id WHERE c.id=NEW.refund_id)
BEGIN SELECT RAISE(ABORT,'refund_capture_budget_exceeded'); END;

-- 4) Tender split of every refund of an order with store credit ($.tender, see shared/refund-tender.ts):
-- mandatory exactly when the order has credit, exact (card + credit = amount), and neither tender may be
-- over-allocated across the order's non-cancelled refunds. Serialises competing planners.
CREATE TRIGGER refund_contract_tender BEFORE INSERT ON refund_contracts
WHEN (CASE WHEN COALESCE((SELECT -SUM(amount_cents) FROM store_credit_ledger WHERE order_ref=NEW.order_id AND entry_type IN('redeem','restore')),0)>0 THEN 1 ELSE 0 END)
  <>(CASE WHEN json_type(NEW.contract_json,'$.tender')='object' THEN 1 ELSE 0 END)
 OR (json_type(NEW.contract_json,'$.tender')='object' AND (
  COALESCE(json_type(NEW.contract_json,'$.tender.cardCents'),'')<>'integer'
  OR COALESCE(json_type(NEW.contract_json,'$.tender.storeCreditCents'),'')<>'integer'
  OR json_extract(NEW.contract_json,'$.tender.cardCents')<0 OR json_extract(NEW.contract_json,'$.tender.storeCreditCents')<0
  OR json_extract(NEW.contract_json,'$.tender.cardCents')+json_extract(NEW.contract_json,'$.tender.storeCreditCents')<>NEW.amount_gross_cents
  OR json_extract(NEW.contract_json,'$.tender.cardCents')+COALESCE((SELECT SUM(COALESCE(json_extract(c.contract_json,'$.tender.cardCents'),c.amount_gross_cents))
   FROM refund_contracts c JOIN refund_work w ON w.refund_id=c.id WHERE c.order_id=NEW.order_id AND w.status<>'cancelled'),0)
   >COALESCE((SELECT amount_gross_cents FROM payment_intents WHERE id=NEW.payment_intent_id),-1)
  OR json_extract(NEW.contract_json,'$.tender.storeCreditCents')+COALESCE((SELECT SUM(COALESCE(json_extract(c.contract_json,'$.tender.storeCreditCents'),0))
   FROM refund_contracts c JOIN refund_work w ON w.refund_id=c.id WHERE c.order_id=NEW.order_id AND w.status<>'cancelled'),0)
   >COALESCE((SELECT -SUM(amount_cents) FROM store_credit_ledger WHERE order_ref=NEW.order_id AND entry_type IN('redeem','restore')),0)))
BEGIN SELECT RAISE(ABORT,'refund_tender_invalid'); END;

-- 5) The provider (card) receipt attests the card share only; a store-credit-only refund records 0.
DROP TRIGGER refund_receipt_contract;
CREATE TRIGGER refund_receipt_contract BEFORE INSERT ON refund_receipts
WHEN NOT EXISTS(SELECT 1 FROM refund_contracts c JOIN refund_work w ON w.refund_id=c.id WHERE c.id=NEW.refund_id AND w.submitted_at IS NOT NULL
 AND json_extract(NEW.receipt_json,'$.status')=NEW.status AND json_extract(NEW.receipt_json,'$.contractFingerprint')=c.contract_fingerprint
 AND json_extract(NEW.receipt_json,'$.amountCents')=COALESCE(json_extract(c.contract_json,'$.tender.cardCents'),c.amount_gross_cents)
 AND json_extract(NEW.receipt_json,'$.currency')='EUR'
 AND json_extract(NEW.receipt_json,'$.merchantOrder')=json_extract(c.contract_json,'$.capture.merchantOrder')
 AND json_extract(NEW.receipt_json,'$.validationOnly')=c.validation_only)
BEGIN SELECT RAISE(ABORT,'refund_receipt_invalid'); END;

-- 6) Restitution of the store-credit share of a completed refund: a NEW refund_credit grant
-- (source_ref 'refund:<refundId>', append-only 'issue' ledger entry, command_id = refund id), written in
-- the same batch as the refund completion. One per refund; never above the credit applied to the order.
CREATE TABLE refund_store_credit_restitutions (
  refund_id TEXT PRIMARY KEY REFERENCES refund_contracts(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  customer_id TEXT NOT NULL REFERENCES store_credit_accounts(customer_id),
  grant_id TEXT NOT NULL UNIQUE REFERENCES store_credit_grants(id),
  command_id TEXT NOT NULL UNIQUE REFERENCES pricing_commands(command_id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE INDEX refund_store_credit_restitutions_order ON refund_store_credit_restitutions(order_id);
CREATE TRIGGER refund_store_credit_restitution_valid BEFORE INSERT ON refund_store_credit_restitutions
WHEN NOT EXISTS(SELECT 1 FROM refund_contracts c JOIN refund_work w ON w.refund_id=c.id AND w.status='completed'
  JOIN refund_receipts r ON r.refund_id=c.id AND r.status='succeeded'
  JOIN orders o ON o.id=c.order_id AND o.customer_id=NEW.customer_id
  JOIN store_credit_grants g ON g.id=NEW.grant_id AND g.customer_id=NEW.customer_id AND g.kind='refund_credit'
   AND g.source_ref='refund:'||c.id AND g.amount_cents=NEW.amount_cents
  JOIN store_credit_ledger l ON l.grant_id=g.id AND l.entry_type='issue' AND l.amount_cents=NEW.amount_cents AND l.command_id=NEW.command_id
  WHERE c.id=NEW.refund_id AND c.order_id=NEW.order_id AND NEW.command_id=c.id
   AND json_extract(c.contract_json,'$.tender.storeCreditCents')=NEW.amount_cents)
 OR NEW.amount_cents+COALESCE((SELECT SUM(amount_cents) FROM refund_store_credit_restitutions WHERE order_id=NEW.order_id),0)
  >COALESCE((SELECT -SUM(amount_cents) FROM store_credit_ledger WHERE order_ref=NEW.order_id AND entry_type IN('redeem','restore')),0)
BEGIN SELECT RAISE(ABORT,'refund_store_credit_restitution_invalid'); END;
CREATE TRIGGER refund_store_credit_restitutions_no_update BEFORE UPDATE ON refund_store_credit_restitutions
BEGIN SELECT RAISE(ABORT,'refund_store_credit_restitution_immutable'); END;
CREATE TRIGGER refund_store_credit_restitutions_no_delete BEFORE DELETE ON refund_store_credit_restitutions
BEGIN SELECT RAISE(ABORT,'refund_store_credit_restitution_immutable'); END;
