-- Persist the obligation to evaluate invoicing, not authority to issue a fiscal
-- document. Dispatch remains blocked until the BEP-002 policy is configured.
CREATE TABLE fiscal_outbox_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  payment_intent_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type = 'invoice.evaluate.requested'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  amount_gross_cents INTEGER NOT NULL CHECK (amount_gross_cents > 0),
  currency TEXT NOT NULL CHECK (currency = 'EUR'),
  created_at TEXT NOT NULL CHECK (
    created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  ),
  FOREIGN KEY (order_id, payment_intent_id) REFERENCES payment_intents(order_id, id)
) STRICT;

CREATE TABLE fiscal_outbox_delivery (
  event_id TEXT PRIMARY KEY REFERENCES fiscal_outbox_events(id),
  status TEXT NOT NULL DEFAULT 'blocked_policy'
    CHECK (status IN ('blocked_policy', 'ready', 'leased', 'published', 'manual_review')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL CHECK (
    available_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', available_at), '')
  ),
  lease_token TEXT,
  lease_until TEXT CHECK (
    lease_until IS NULL OR lease_until = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', lease_until), '')
  ),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 80),
  CHECK ((status = 'leased' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (status <> 'leased' AND lease_token IS NULL AND lease_until IS NULL))
) STRICT;
CREATE INDEX fiscal_outbox_delivery_due_idx ON fiscal_outbox_delivery(status, available_at);

CREATE TRIGGER fiscal_outbox_events_no_update BEFORE UPDATE ON fiscal_outbox_events
BEGIN SELECT RAISE(ABORT, 'fiscal outbox event is immutable'); END;
CREATE TRIGGER fiscal_outbox_events_no_delete BEFORE DELETE ON fiscal_outbox_events
BEGIN SELECT RAISE(ABORT, 'fiscal outbox event is immutable'); END;

CREATE TRIGGER fiscal_outbox_delivery_on_event AFTER INSERT ON fiscal_outbox_events
BEGIN
  INSERT INTO fiscal_outbox_delivery (event_id, available_at)
  VALUES (NEW.id, NEW.created_at);
END;

-- This trigger executes inside the payment finalisation batch: failure to
-- persist its event also rolls back the paid transition and captured intent.
CREATE TRIGGER fiscal_outbox_on_payment_paid AFTER UPDATE ON order_payment_states
WHEN NEW.status = 'paid' AND OLD.status <> 'paid'
BEGIN
  INSERT INTO fiscal_outbox_events (
    id, order_id, payment_intent_id, event_type, schema_version,
    amount_gross_cents, currency, created_at
  ) VALUES (
    'invoice-evaluation:' || NEW.order_id, NEW.order_id, NEW.active_intent_id,
    'invoice.evaluate.requested', 1, NEW.paid_gross_cents, 'EUR', NEW.updated_at
  ) ON CONFLICT (order_id) DO NOTHING;
END;

-- Upgrade previously finalised local orders without losing their fiscal work.
INSERT INTO fiscal_outbox_events (
  id, order_id, payment_intent_id, event_type, schema_version,
  amount_gross_cents, currency, created_at
)
SELECT 'invoice-evaluation:' || order_id, order_id, active_intent_id,
       'invoice.evaluate.requested', 1, paid_gross_cents, 'EUR', updated_at
FROM order_payment_states WHERE status = 'paid';
