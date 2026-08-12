import { describe, expect, it } from 'vitest'
import {
  assertTransition,
  canTransition,
  fulfillmentTransitions,
  inventoryTransitions,
  invoiceTransitions,
  orderTransitions,
  paymentTransitions,
  returnTransitions
} from '../../server/domain/states'

describe('domain state machines', () => {
  it.each([
    [orderTransitions, 'draft', 'awaiting_payment'],
    [paymentTransitions, 'pending', 'captured'],
    [inventoryTransitions, 'reserved', 'allocated'],
    [fulfillmentTransitions, 'packed', 'in_transit'],
    [invoiceTransitions, 'queued', 'issuing'],
    [returnTransitions, 'received', 'inspected']
  ] as const)('accepts an allowed transition', (map, from, to) => {
    expect(canTransition(map, from, to)).toBe(true)
    expect(assertTransition(map, from, to)).toBeUndefined()
  })

  it('rejects a state jump', () => {
    expect(canTransition(orderTransitions, 'draft', 'completed')).toBe(false)
    expect(() => assertTransition(orderTransitions, 'draft', 'completed')).toThrow(
      'Invalid transition: draft -> completed'
    )
  })
})
