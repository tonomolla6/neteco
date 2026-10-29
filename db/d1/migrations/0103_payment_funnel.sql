-- Migration: 0103_payment_funnel.sql
-- PAY-018: Payment funnel tracking, decline cause classification, and segmentation without prohibited data.

CREATE TABLE payment_funnel_events (
  id TEXT PRIMARY KEY CHECK (
    length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-'
    AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'
    AND length(replace(id, '-', '')) = 32
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  intent_id TEXT NOT NULL REFERENCES payment_intents(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  step TEXT NOT NULL CHECK (
    step IN ('intent_created', 'redirected', 'authorized', 'captured', 'declined', 'cancelled', 'expired')
  ),
  method TEXT NOT NULL CHECK (method IN ('card', 'bizum', 'bank_transfer', 'unknown')),
  device TEXT NOT NULL CHECK (device IN ('desktop', 'mobile', 'tablet', 'unknown')),
  bank TEXT CHECK (bank IS NULL OR (length(bank) BETWEEN 1 AND 80 AND bank NOT GLOB '*[0-9][0-9][0-9][0-9][0-9]*')),
  response_code TEXT CHECK (response_code IS NULL OR length(response_code) <= 10),
  decline_category TEXT CHECK (
    decline_category IS NULL OR decline_category IN (
      'insufficient_funds',
      'expired_card',
      'auth_failed_3ds',
      'card_restriction',
      'invalid_card_details',
      'pin_attempts_exceeded',
      'user_cancelled',
      'issuer_declined',
      'issuer_unavailable',
      'fraud_suspicion',
      'bizum_error',
      'system_error',
      'other'
    )
  ),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency = 'EUR'),
  created_at TEXT NOT NULL CHECK (
    created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')
  )
) STRICT;

CREATE INDEX payment_funnel_period_idx ON payment_funnel_events(created_at, step);
CREATE INDEX payment_funnel_intent_idx ON payment_funnel_events(intent_id, step);
CREATE INDEX payment_funnel_order_idx ON payment_funnel_events(order_id);
CREATE INDEX payment_funnel_segment_idx ON payment_funnel_events(device, method, bank);

-- Immutable append-only triggers
CREATE TRIGGER payment_funnel_no_update BEFORE UPDATE ON payment_funnel_events
BEGIN
  SELECT RAISE(ABORT, 'payment_funnel_events is append-only');
END;

CREATE TRIGGER payment_funnel_no_delete BEFORE DELETE ON payment_funnel_events
BEGIN
  SELECT RAISE(ABORT, 'payment_funnel_events is append-only');
END;

-- Security guard against prohibited data: PAN (13-19 consecutive digits), raw payload leaks
CREATE TRIGGER payment_funnel_prohibited_data_guard BEFORE INSERT ON payment_funnel_events
WHEN (
  NEW.bank GLOB '*[0-9][0-9][0-9][0-9][0-9]*'
  OR (NEW.response_code IS NOT NULL AND NEW.response_code GLOB '*[^0-9A-Za-z_-]*')
)
BEGIN
  SELECT RAISE(ABORT, 'payment_funnel_prohibited_data');
END;
