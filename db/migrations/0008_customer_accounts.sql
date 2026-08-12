-- Customer portal, communication preferences and privacy workflows.

ALTER TABLE addresses
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX addresses_customer_idx ON addresses (customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL;

CREATE UNIQUE INDEX addresses_one_default_per_customer_kind_idx
  ON addresses (customer_id, kind)
  WHERE customer_id IS NOT NULL AND is_default;

ALTER TABLE companies
  ADD COLUMN rejection_reason text,
  ADD COLUMN reviewed_by uuid REFERENCES identities(id),
  ADD COLUMN reviewed_at timestamptz;

CREATE TABLE customer_preferences (
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('transactional', 'newsletter', 'product_updates', 'replenishment')),
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp')),
  enabled boolean NOT NULL DEFAULT false,
  frequency text NOT NULL DEFAULT 'immediate' CHECK (frequency IN ('immediate', 'weekly', 'monthly')),
  topics jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, purpose, channel),
  CHECK (purpose <> 'transactional' OR enabled)
);

CREATE TABLE privacy_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  request_type text NOT NULL CHECK (request_type IN ('export', 'anonymize')),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'processing', 'completed', 'partially_completed', 'rejected')),
  idempotency_key uuid NOT NULL,
  legal_exceptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  completed_at timestamptz,
  UNIQUE (customer_id, idempotency_key)
);

CREATE INDEX privacy_requests_customer_idx ON privacy_requests (customer_id, requested_at DESC);

CREATE TABLE favorite_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Favoritos',
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, name)
);

CREATE UNIQUE INDEX favorite_lists_one_default_idx ON favorite_lists (customer_id) WHERE is_default;

CREATE TABLE favorite_items (
  list_id uuid NOT NULL REFERENCES favorite_lists(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  quantity numeric(14,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, variant_id)
);

INSERT INTO customer_preferences (customer_id, purpose, channel, enabled)
SELECT id, 'transactional', 'email', true FROM customers
ON CONFLICT DO NOTHING;
