-- Durable receipt, not a record of an issued invoice. Policy evaluation and
-- provider reconciliation must precede any external fiscal operation.
CREATE TABLE fiscal_evaluation_inbox (
  event_id TEXT PRIMARY KEY REFERENCES fiscal_outbox_events(id),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  status TEXT NOT NULL DEFAULT 'blocked_policy' CHECK (status = 'blocked_policy'),
  received_at TEXT NOT NULL CHECK (
    received_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', received_at), '')
  )
) STRICT;
