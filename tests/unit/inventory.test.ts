import { describe, expect, it } from 'vitest'
import { assertReservable, canReserve, sellableQuantity } from '../../server/domain/inventory'

const position = {
  physicalQuantity: 10,
  reservedQuantity: 2,
  blockedQuantity: 1,
  safetyStock: 2,
  backorderAllowed: false
}

describe('inventory availability', () => {
  it('derives sellable inventory from the ledger position and policy', () => {
    expect(sellableQuantity(position)).toBe(5)
    expect(sellableQuantity({ ...position, physicalQuantity: 1 })).toBe(0)
  })

  it('validates all inventory values', () => {
    for (const key of ['physicalQuantity', 'reservedQuantity', 'blockedQuantity', 'safetyStock'] as const) {
      expect(() => sellableQuantity({ ...position, [key]: -1 })).toThrow(`${key} must be a non-negative integer`)
    }
    expect(() => sellableQuantity({ ...position, physicalQuantity: 1.5 })).toThrow(
      'physicalQuantity must be a non-negative integer'
    )
  })

  it('accepts available or explicitly backordered reservations', () => {
    expect(canReserve(position, 5)).toBe(true)
    expect(canReserve(position, 6)).toBe(false)
    expect(canReserve({ ...position, backorderAllowed: true }, 100)).toBe(true)
    expect(canReserve(position, 0)).toBe(false)
    expect(() => canReserve(position, -1)).toThrow('requestedQuantity must be a non-negative integer')
    expect(() => assertReservable(position, 6)).toThrow('Insufficient sellable inventory')
    expect(assertReservable(position, 5)).toBeUndefined()
  })
})
