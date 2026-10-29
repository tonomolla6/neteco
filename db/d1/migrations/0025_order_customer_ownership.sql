-- An order belongs to a customer only when checkout was confirmed with a
-- verified, active session. Historical and guest orders remain unassigned;
-- matching their contact email to a login must never claim them retroactively.
ALTER TABLE orders ADD COLUMN customer_id TEXT REFERENCES customers(id);

CREATE INDEX orders_customer_created_idx
  ON orders(customer_id, created_at DESC, id DESC)
  WHERE customer_id IS NOT NULL;

-- Ownership, including the guest/unassigned state, is fixed at insertion.
CREATE TRIGGER orders_customer_immutable BEFORE UPDATE OF customer_id ON orders
WHEN OLD.customer_id IS NOT NEW.customer_id
BEGIN
  SELECT RAISE(ABORT, 'order customer ownership is immutable');
END;
