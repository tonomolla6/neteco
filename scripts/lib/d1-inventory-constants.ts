/** Shared constants for the deterministic D1 inventory seed. */
export const INVENTORY_SEED_LOCATION_CODE = 'ALM-ONI'

/** Deterministic variant policy buffer (0..3 units) used by the demo catalog seed. */
export function seededSafetyStock(productIndex: number, variantIndex: number) {
  return (productIndex + variantIndex) % 4
}
