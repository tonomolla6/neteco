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
  it('publishes the complete reviewed transition tables', () => {
    expect(orderTransitions).toEqual({
      draft: ['awaiting_payment', 'cancelled'],
      awaiting_payment: ['confirmed', 'on_hold', 'cancelled'],
      confirmed: ['on_hold', 'cancelled', 'completed'],
      on_hold: ['awaiting_payment', 'confirmed', 'cancelled'],
      cancelled: [],
      completed: []
    })
    expect(paymentTransitions).toEqual({
      initiated: ['pending', 'authorized', 'captured', 'failed', 'cancelled'],
      pending: ['authorized', 'captured', 'failed', 'cancelled'],
      authorized: ['captured', 'cancelled'],
      captured: ['partially_refunded', 'refunded', 'chargeback'],
      failed: ['pending', 'cancelled'],
      cancelled: [],
      partially_refunded: ['partially_refunded', 'refunded', 'chargeback'],
      refunded: ['chargeback'],
      chargeback: []
    })
    expect(inventoryTransitions).toEqual({
      unreserved: ['reserved'],
      reserved: ['allocated', 'released'],
      allocated: ['picked', 'released'],
      picked: ['shipped', 'released'],
      shipped: ['returned', 'damaged'],
      released: ['reserved'],
      returned: ['reserved', 'damaged'],
      damaged: []
    })
    expect(fulfillmentTransitions).toEqual({
      pending: ['picking', 'exception'],
      picking: ['packed', 'exception'],
      packed: ['ready_for_pickup', 'in_transit', 'exception'],
      ready_for_pickup: ['delivered', 'exception', 'returned'],
      in_transit: ['delivered', 'exception', 'returned'],
      delivered: ['returned'],
      exception: ['picking', 'packed', 'in_transit', 'returned'],
      returned: []
    })
    expect(invoiceTransitions).toEqual({
      not_requested: ['queued'],
      queued: ['issuing', 'failed'],
      issuing: ['issued', 'fiscal_pending', 'failed'],
      issued: ['rectified'],
      fiscal_pending: ['issued', 'failed'],
      failed: ['queued'],
      rectified: []
    })
    expect(returnTransitions).toEqual({
      requested: ['approved', 'rejected'],
      approved: ['in_transit', 'received'],
      rejected: [],
      in_transit: ['received'],
      received: ['inspected'],
      inspected: ['resolved'],
      resolved: []
    })
  })

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
