export interface InventoryPosition {
  physicalQuantity: number
  reservedQuantity: number
  blockedQuantity: number
  safetyStock: number
  backorderAllowed: boolean
}

function requireNonNegativeInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`)
}

export function sellableQuantity(position: InventoryPosition) {
  requireNonNegativeInteger(position.physicalQuantity, 'physicalQuantity')
  requireNonNegativeInteger(position.reservedQuantity, 'reservedQuantity')
  requireNonNegativeInteger(position.blockedQuantity, 'blockedQuantity')
  requireNonNegativeInteger(position.safetyStock, 'safetyStock')
  return Math.max(
    0,
    position.physicalQuantity - position.reservedQuantity - position.blockedQuantity - position.safetyStock
  )
}

export function canReserve(position: InventoryPosition, requestedQuantity: number) {
  requireNonNegativeInteger(requestedQuantity, 'requestedQuantity')
  if (requestedQuantity === 0) return false
  return position.backorderAllowed || sellableQuantity(position) >= requestedQuantity
}

export function assertReservable(position: InventoryPosition, requestedQuantity: number) {
  if (!canReserve(position, requestedQuantity)) throw new Error('Insufficient sellable inventory')
}
