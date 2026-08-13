ALTER TABLE inventory_movements
  ADD COLUMN physical_delta integer,
  ADD COLUMN reserved_delta integer;

UPDATE inventory_movements
SET physical_delta = CASE movement_type
      WHEN 'reserve' THEN 0
      WHEN 'release' THEN 0
      WHEN 'allocate' THEN -abs(quantity)
      ELSE quantity
    END,
    reserved_delta = CASE movement_type
      WHEN 'reserve' THEN abs(quantity)
      WHEN 'release' THEN -abs(quantity)
      WHEN 'allocate' THEN -abs(quantity)
      ELSE 0
    END;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM inventory_balances balance
    JOIN (
      SELECT variant_id, location_id, sum(quantity)::integer AS allocated
      FROM inventory_reservations
      WHERE status = 'allocated'
      GROUP BY variant_id, location_id
    ) reservations USING (variant_id, location_id)
    WHERE balance.physical_quantity < reservations.allocated
  ) THEN
    RAISE EXCEPTION 'Cannot backfill allocated inventory: physical stock reconciliation is required';
  END IF;
END
$$;

UPDATE inventory_balances balance
SET physical_quantity = balance.physical_quantity - reservations.allocated,
    version = balance.version + 1,
    updated_at = now()
FROM (
  SELECT variant_id, location_id, sum(quantity)::integer AS allocated
  FROM inventory_reservations
  WHERE status = 'allocated'
  GROUP BY variant_id, location_id
) reservations
WHERE balance.variant_id = reservations.variant_id
  AND balance.location_id = reservations.location_id;

ALTER TABLE inventory_movements
  ALTER COLUMN physical_delta SET NOT NULL,
  ALTER COLUMN reserved_delta SET NOT NULL;

ALTER TABLE inventory_balances
  ADD CONSTRAINT inventory_balances_physical_nonnegative CHECK (physical_quantity >= 0),
  ADD CONSTRAINT inventory_balances_blocked_within_physical CHECK (blocked_quantity <= physical_quantity);

ALTER TABLE inventory_reservations
  DROP CONSTRAINT inventory_reservations_check,
  ADD CONSTRAINT inventory_reservations_single_owner CHECK ((cart_id IS NULL) <> (order_id IS NULL));

COMMENT ON COLUMN inventory_movements.physical_delta IS
  'Authoritative physical stock delta; sum by variant/location reconstructs inventory_balances.physical_quantity.';
COMMENT ON COLUMN inventory_movements.reserved_delta IS
  'Authoritative reservation delta; active commitments are independently verifiable against inventory_reservations.';
