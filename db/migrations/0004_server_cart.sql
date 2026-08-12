CREATE TABLE cart_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('add', 'set', 'remove', 'clear')),
  resulting_version integer NOT NULL CHECK (resulting_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cart_id, idempotency_key)
);

CREATE INDEX carts_customer_active_updated_idx
  ON carts (customer_id, updated_at DESC)
  WHERE status = 'active';

CREATE INDEX cart_operations_created_idx ON cart_operations (created_at);
