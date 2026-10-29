-- Bank facts are not mutually exclusive: an older issued redirect can succeed
-- after a retry. Only one authorised intent may fulfil each order.
CREATE UNIQUE INDEX payment_intents_order_identity_idx ON payment_intents(order_id, id);
CREATE TABLE payment_fulfilment_claims (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  payment_intent_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK (
    created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  ),
  FOREIGN KEY (order_id, payment_intent_id) REFERENCES payment_intents(order_id, id)
) STRICT;

-- Preserve an existing operational winner when upgrading a local 0007 database.
INSERT INTO payment_fulfilment_claims (order_id, payment_intent_id, created_at)
SELECT p.order_id, p.id, p.updated_at FROM payment_intents p
WHERE p.status IN ('provider_authorised', 'captured', 'stock_exception')
  AND p.id = (
    SELECT candidate.id FROM payment_intents candidate
    LEFT JOIN order_payment_states state ON state.order_id = candidate.order_id
    WHERE candidate.order_id = p.order_id
      AND candidate.status IN ('provider_authorised', 'captured', 'stock_exception')
    ORDER BY (candidate.id = state.active_intent_id) DESC, candidate.created_at, candidate.id
    LIMIT 1
  );

UPDATE payment_recovery_jobs SET status = 'manual_review', last_error_code = 'duplicate_provider_capture'
WHERE EXISTS (
  SELECT 1 FROM payment_fulfilment_claims claim
  WHERE claim.order_id = payment_recovery_jobs.order_id
    AND claim.payment_intent_id <> payment_recovery_jobs.payment_intent_id
);

CREATE TRIGGER payment_fulfilment_claims_no_update BEFORE UPDATE ON payment_fulfilment_claims
BEGIN SELECT RAISE(ABORT, 'payment fulfilment claim is immutable'); END;
CREATE TRIGGER payment_fulfilment_claims_no_delete BEFORE DELETE ON payment_fulfilment_claims
BEGIN SELECT RAISE(ABORT, 'payment fulfilment claim is immutable'); END;

-- This index governs new redirects, not facts confirmed by the bank. New
-- initiation also checks claims inside its atomic batch to close read/write races.
DROP INDEX payment_intents_one_live_per_order_idx;
CREATE UNIQUE INDEX payment_intents_one_live_per_order_idx ON payment_intents(order_id)
  WHERE status IN ('redirect_ready', 'processing');
