import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { checkProperty } from '../support/property'
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

  it('preserves the stock ledger formula and monotonicity', async () => {
    await checkProperty(
      'TST038-inventory-sellable',
      fc.property(
        fc.record({
          physicalQuantity: fc.integer({ min: 0, max: 10_000 }),
          reservedQuantity: fc.integer({ min: 0, max: 10_000 }),
          blockedQuantity: fc.integer({ min: 0, max: 10_000 }),
          safetyStock: fc.integer({ min: 0, max: 10_000 }),
          physicalIncrease: fc.integer({ min: 0, max: 1_000 }),
          reservedIncrease: fc.integer({ min: 0, max: 1_000 })
        }),
        ({ physicalQuantity, reservedQuantity, blockedQuantity, safetyStock, physicalIncrease, reservedIncrease }) => {
          const position = {
            physicalQuantity,
            reservedQuantity,
            blockedQuantity,
            safetyStock,
            backorderAllowed: false
          }
          const expected = Math.max(0, physicalQuantity - reservedQuantity - blockedQuantity - safetyStock)
          const sellable = sellableQuantity(position)
          const withMorePhysical = sellableQuantity({
            ...position,
            physicalQuantity: physicalQuantity + physicalIncrease
          })
          const withMoreReserved = sellableQuantity({
            ...position,
            reservedQuantity: reservedQuantity + reservedIncrease
          })

          expect(sellable).toBe(expected)
          expect(withMorePhysical).toBeGreaterThanOrEqual(sellable)
          expect(withMoreReserved).toBeLessThanOrEqual(sellable)
        }
      )
    )
  })

  it('keeps reservation decisions equivalent to assertions, including backorders', async () => {
    await checkProperty(
      'TST038-inventory-reservation',
      fc.property(
        fc.record({
          physicalQuantity: fc.integer({ min: 0, max: 1_000 }),
          reservedQuantity: fc.integer({ min: 0, max: 1_000 }),
          blockedQuantity: fc.integer({ min: 0, max: 1_000 }),
          safetyStock: fc.integer({ min: 0, max: 1_000 }),
          backorderAllowed: fc.boolean(),
          requestedQuantity: fc.integer({ min: 0, max: 2_000 })
        }),
        ({ physicalQuantity, reservedQuantity, blockedQuantity, safetyStock, backorderAllowed, requestedQuantity }) => {
          const position = {
            physicalQuantity,
            reservedQuantity,
            blockedQuantity,
            safetyStock,
            backorderAllowed
          }
          const expected =
            requestedQuantity > 0 && (backorderAllowed || sellableQuantity(position) >= requestedQuantity)

          expect(canReserve(position, requestedQuantity)).toBe(expected)
          if (expected) {
            expect(assertReservable(position, requestedQuantity)).toBeUndefined()
          } else {
            expect(() => assertReservable(position, requestedQuantity)).toThrow('Insufficient sellable inventory')
          }
        }
      )
    )
  })
})
