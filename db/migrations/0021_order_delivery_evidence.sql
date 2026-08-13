-- Delivery is a contractual event: retain its own timestamp instead of inferring it
-- from the last generic order update.

ALTER TABLE orders ADD COLUMN delivered_at timestamptz;

UPDATE orders
SET delivered_at = updated_at
WHERE fulfillment_status = 'delivered' AND delivered_at IS NULL;

CREATE INDEX orders_delivered_at_idx ON orders (delivered_at)
  WHERE delivered_at IS NOT NULL;

