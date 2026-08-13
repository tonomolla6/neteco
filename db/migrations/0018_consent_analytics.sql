-- Consent-aware first-party measurement with server-authoritative commerce events.

CREATE TABLE analytics_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE,
  event_name text NOT NULL CHECK (event_name IN (
    'page_view', 'catalog_viewed', 'search_completed', 'product_viewed',
    'cart_item_added', 'cart_item_removed', 'checkout_started',
    'payment_initiated', 'payment_confirmed', 'payment_failed',
    'order_confirmed', 'refund_confirmed', 'shipment_status_changed'
  )),
  taxonomy_version text NOT NULL DEFAULT 'v1',
  source text NOT NULL CHECK (source IN ('client', 'server')),
  anonymous_id uuid,
  order_id uuid REFERENCES orders(id),
  dedupe_key text UNIQUE,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX analytics_events_name_occurred_idx ON analytics_events (event_name, occurred_at DESC);

COMMENT ON TABLE analytics_events IS
  'PII-free v1 measurement. Client events require analytics consent; purchase/refund facts are emitted server-side from commercial state.';
