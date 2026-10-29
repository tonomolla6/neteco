-- Optional contractual reference. Historical orders retain NULL and all money,
-- foreign keys and existing snapshot triggers remain unchanged.
ALTER TABLE orders ADD COLUMN purchase_order_reference TEXT
  CHECK (purchase_order_reference IS NULL OR (
    length(purchase_order_reference) BETWEEN 1 AND 120
    AND purchase_order_reference = trim(purchase_order_reference)
    AND instr(purchase_order_reference,char(0)) = 0
    AND purchase_order_reference NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(8232) || char(8233) || ']*')
  ));

CREATE TRIGGER order_purchase_reference_immutable
BEFORE UPDATE OF purchase_order_reference ON orders
WHEN OLD.purchase_order_reference IS NOT NEW.purchase_order_reference
BEGIN SELECT RAISE(ABORT,'order_purchase_reference_immutable'); END;

CREATE TRIGGER order_purchase_reference_no_delete
BEFORE DELETE ON orders WHEN OLD.purchase_order_reference IS NOT NULL
BEGIN SELECT RAISE(ABORT,'order_purchase_reference_immutable'); END;

-- REPLACE may skip DELETE triggers when recursive_triggers is disabled.
CREATE TRIGGER order_purchase_reference_no_replace
BEFORE INSERT ON orders WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'order_purchase_reference_immutable'); END;
