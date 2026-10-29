import { sellableExpression } from './inventory'

/** Existing single-warehouse dashboard position authority, unchanged. No clock
 * predicate: reserved inventory remains reserved until its governed release. */
export function inventoryPositionCtes() {
  return `inventory_targets AS (
          SELECT variant_id, location_id FROM inventory_balances
          UNION SELECT variant_id, location_id FROM inventory_movements
          UNION SELECT variant_id, location_id FROM inventory_reservation_lines
        ), scope_locations AS (
          SELECT id AS location_id FROM inventory_locations WHERE active = 1
          UNION SELECT location_id FROM inventory_targets
        ), inventory_scope AS (
          SELECT CASE WHEN count(*) = 1
            AND sum(CASE WHEN location.active = 1 AND location.kind = 'warehouse' THEN 1 ELSE 0 END) = 1
            THEN 1 ELSE 0 END AS available
          FROM scope_locations scope
          LEFT JOIN inventory_locations location ON location.id = scope.location_id
        ), ledger AS (
          SELECT variant_id, location_id, sum(physical_delta) AS physical_quantity,
                 sum(reserved_delta) AS reserved_quantity
          FROM inventory_movements GROUP BY variant_id, location_id
        ), active_reserved AS (
          SELECT line.variant_id, line.location_id, sum(line.quantity) AS quantity
          FROM inventory_reservation_lines line
          JOIN inventory_reservations reservation ON reservation.id = line.reservation_id
          WHERE reservation.status = 'reserved'
          GROUP BY line.variant_id, line.location_id
        ), positions AS (
          SELECT target.variant_id, target.location_id,
            COALESCE(b.physical_quantity, 0) AS physical_quantity,
            COALESCE(b.blocked_quantity, 0) AS blocked_quantity,
            COALESCE(variant.safety_stock, 0) AS safety_stock,
            COALESCE(variant.backorder_allowed, 0) AS backorder_allowed,
            COALESCE(reserved.quantity, 0) AS reserved_quantity,
            ${sellableExpression()} AS sellable_quantity,
            CASE WHEN (b.variant_id IS NULL AND COALESCE(reserved.quantity, 0) > 0)
              OR COALESCE(b.physical_quantity, 0) <> COALESCE(ledger.physical_quantity, 0)
              OR COALESCE(reserved.quantity, 0) <> COALESCE(ledger.reserved_quantity, 0)
              THEN 1 ELSE 0 END AS ledger_divergent
          FROM inventory_targets target
          LEFT JOIN inventory_balances b
            ON b.variant_id = target.variant_id AND b.location_id = target.location_id
          LEFT JOIN variants variant ON variant.id = target.variant_id
          LEFT JOIN ledger ON ledger.variant_id = target.variant_id AND ledger.location_id = target.location_id
          LEFT JOIN active_reserved reserved
            ON reserved.variant_id = target.variant_id AND reserved.location_id = target.location_id
        ), inventory_flags AS (
          SELECT *,
            CASE WHEN backorder_allowed = 0
              AND COALESCE(sellable_quantity, 0) = 0
              AND reserved_quantity > max(0, physical_quantity - blocked_quantity - safety_stock)
              THEN 1 ELSE 0 END AS availability_deficit,
            CASE WHEN backorder_allowed = 1
              AND reserved_quantity > max(0, physical_quantity - blocked_quantity - safety_stock)
              THEN 1 ELSE 0 END AS backorder_commitment
          FROM positions
        )`
}
