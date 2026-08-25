import { PRODUCTS } from '../../server/db/seed'
import { INVENTORY_SEED_LOCATION_CODE } from './d1-inventory-constants'
import { stableUuid, sqlText } from './d1-category-seed'

const SEED_TIMESTAMP = '2026-08-12T00:00:00Z'
export const INVENTORY_SEED_LOCATION_ID = stableUuid(`inventory-location:${INVENTORY_SEED_LOCATION_CODE}`)

/** Deterministic initial stock per demo variant (20..50 units). */
export function seededInventoryQuantity(productIndex: number, variantIndex: number) {
  return 20 + ((productIndex * 7 + variantIndex * 5) % 31)
}

export function renderD1InventorySeed() {
  const statements = [
    'BEGIN TRANSACTION;',
    `INSERT INTO inventory_locations (id, code, name, kind, active, created_at)
VALUES (${sqlText(INVENTORY_SEED_LOCATION_ID)}, '${INVENTORY_SEED_LOCATION_CODE}',
        'Almacén central Ontinyent', 'warehouse', 1, ${sqlText(SEED_TIMESTAMP)})
ON CONFLICT (id) DO UPDATE SET
  code = excluded.code,
  name = excluded.name,
  kind = excluded.kind,
  active = excluded.active,
  created_at = excluded.created_at;`
  ]

  for (const [productIndex, product] of PRODUCTS.entries()) {
    for (const [variantIndex] of product.variants.entries()) {
      const variantId = stableUuid(`variant:${productIndex + 1}:${variantIndex + 1}`)
      const quantity = seededInventoryQuantity(productIndex + 1, variantIndex + 1)
      const movementId = stableUuid(`inventory-movement:${productIndex + 1}:${variantIndex + 1}`)
      statements.push(`INSERT INTO inventory_balances (
  variant_id, location_id, physical_quantity, blocked_quantity, version, created_at, updated_at
) VALUES (
  ${sqlText(variantId)}, ${sqlText(INVENTORY_SEED_LOCATION_ID)}, ${quantity}, 0, 1,
  ${sqlText(SEED_TIMESTAMP)}, ${sqlText(SEED_TIMESTAMP)}
)
ON CONFLICT (variant_id, location_id) DO NOTHING;`)
      statements.push(`INSERT INTO inventory_movements (
  id, variant_id, location_id, movement_type, physical_delta, reserved_delta,
  reference_type, reference_id, idempotency_key, correlation_id, reason, created_at
) VALUES (
  ${sqlText(movementId)}, ${sqlText(variantId)}, ${sqlText(INVENTORY_SEED_LOCATION_ID)},
  'initial', ${quantity}, 0, 'seed', NULL, ${sqlText(movementId)}, 'seed',
  'Saldo inicial determinista del dataset canary', ${sqlText(SEED_TIMESTAMP)}
)
ON CONFLICT (id) DO NOTHING;`)
    }
  }

  statements.push('COMMIT;')
  return `${statements.join('\n\n')}\n`
}
