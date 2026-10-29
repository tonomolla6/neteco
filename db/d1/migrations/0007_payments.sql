-- Cloudflare-native payment intents, signed provider notifications and
-- recoverable payment/inventory finalisation. Incremental over 0001-0006.

CREATE TABLE order_payment_states (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  status TEXT NOT NULL DEFAULT 'awaiting_payment'
    CHECK (status IN (
      'awaiting_payment', 'processing', 'provider_authorised', 'paid',
      'failed', 'cancelled', 'stock_exception'
    )),
  active_intent_id TEXT,
  paid_gross_cents INTEGER NOT NULL DEFAULT 0 CHECK (paid_gross_cents >= 0),
  provider_reference TEXT CHECK (provider_reference IS NULL OR length(provider_reference) <= 100),
  response_code TEXT CHECK (response_code IS NULL OR response_code GLOB '[0-9][0-9][0-9][0-9]'),
  updated_at TEXT NOT NULL CHECK (
    updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')
  )
) STRICT;

CREATE TABLE payment_intents (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  provider TEXT NOT NULL CHECK (provider = 'redsys'),
  merchant_order TEXT NOT NULL UNIQUE
    CHECK (
      length(merchant_order) BETWEEN 4 AND 12
      AND merchant_order NOT GLOB '*[^0-9A-Za-z]*'
      AND substr(merchant_order, 1, 4) NOT GLOB '*[^0-9]*'
    ),
  method TEXT NOT NULL CHECK (method IN ('card', 'bizum')),
  status TEXT NOT NULL CHECK (status IN (
    'redirect_ready', 'processing', 'provider_authorised', 'captured',
    'failed', 'cancelled', 'expired', 'stock_exception'
  )),
  amount_gross_cents INTEGER NOT NULL CHECK (amount_gross_cents > 0),
  currency TEXT NOT NULL CHECK (currency = 'EUR'),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  redirect_envelope_hash TEXT NOT NULL
    CHECK (length(redirect_envelope_hash) = 64 AND redirect_envelope_hash NOT GLOB '*[^0-9a-f]*'),
  provider_reference TEXT CHECK (provider_reference IS NULL OR length(provider_reference) <= 100),
  response_code TEXT CHECK (response_code IS NULL OR response_code GLOB '[0-9][0-9][0-9][0-9]'),
  expires_at TEXT NOT NULL CHECK (
    expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at), '')
  ),
  correlation_id TEXT NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL CHECK (
    created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')
  )
) STRICT;

CREATE INDEX payment_intents_order_idx ON payment_intents(order_id, created_at DESC);
CREATE INDEX payment_intents_status_idx ON payment_intents(status, updated_at);
CREATE UNIQUE INDEX payment_intents_one_live_per_order_idx
  ON payment_intents(order_id)
  WHERE status IN ('redirect_ready', 'processing', 'provider_authorised');

CREATE TABLE payment_commands (
  order_id TEXT NOT NULL REFERENCES orders(id),
  command_id TEXT NOT NULL CHECK (length(command_id) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL
    CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  response_status INTEGER NOT NULL CHECK (response_status BETWEEN 200 AND 499),
  response_body TEXT NOT NULL CHECK (
    length(response_body) <= 65536 AND json_valid(response_body) AND json_type(response_body) = 'object'
  ),
  correlation_id TEXT NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL CHECK (
    created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  ),
  PRIMARY KEY (order_id, command_id)
) STRICT;

-- Only safe, normalized provider facts are stored. The signed payload itself,
-- PAN/CVC and secrets never enter D1.
CREATE TABLE payment_events (
  id TEXT PRIMARY KEY,
  payment_intent_id TEXT NOT NULL REFERENCES payment_intents(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  provider_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'notification_pending', 'notification_failed', 'notification_cancelled',
    'provider_authorised', 'captured', 'stock_exception', 'notification_mismatch'
  )),
  payload_hash TEXT NOT NULL
    CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  response_code TEXT NOT NULL CHECK (response_code GLOB '[0-9][0-9][0-9][0-9]'),
  provider_reference TEXT CHECK (provider_reference IS NULL OR length(provider_reference) <= 100),
  correlation_id TEXT NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL CHECK (
    created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  )
) STRICT;

CREATE INDEX payment_events_order_idx ON payment_events(order_id, created_at);
CREATE INDEX payment_events_intent_idx ON payment_events(payment_intent_id, created_at);

CREATE TRIGGER payment_events_no_update BEFORE UPDATE ON payment_events
BEGIN
  SELECT RAISE(ABORT, 'payment_events is append-only');
END;
CREATE TRIGGER payment_events_no_delete BEFORE DELETE ON payment_events
BEGIN
  SELECT RAISE(ABORT, 'payment_events is append-only');
END;

-- A provider-authorised payment is persisted before inventory assignment. This
-- row makes the second half of that saga discoverable after any Worker crash.
CREATE TABLE payment_recovery_jobs (
  payment_intent_id TEXT PRIMARY KEY REFERENCES payment_intents(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'manual_review')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  due_at TEXT NOT NULL CHECK (
    due_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', due_at), '')
  ),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 80),
  created_at TEXT NOT NULL CHECK (
    created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')
  )
) STRICT;

CREATE INDEX payment_recovery_jobs_due_idx ON payment_recovery_jobs(status, due_at);
