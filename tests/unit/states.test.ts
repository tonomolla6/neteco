import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { checkProperty } from '../support/property'
import {
  FULFILLMENT_STATES,
  INVOICE_STATES,
  INVENTORY_STATES,
  ORDER_STATES,
  PAYMENT_STATES,
  RETURN_STATES,
  assertTransition,
  canTransition,
  fulfillmentTransitions,
  inventoryTransitions,
  invoiceTransitions,
  orderTransitions,
  paymentTransitions,
  returnTransitions
} from '../../server/domain/states'

type PropertyTransitionMap = Readonly<Record<string, readonly string[]>>

const transitionTables: ReadonlyArray<{
  name: string
  states: readonly string[]
  map: PropertyTransitionMap
}> = [
  { name: 'order', states: ORDER_STATES, map: orderTransitions },
  { name: 'payment', states: PAYMENT_STATES, map: paymentTransitions },
  { name: 'inventory', states: INVENTORY_STATES, map: inventoryTransitions },
  { name: 'fulfillment', states: FULFILLMENT_STATES, map: fulfillmentTransitions },
  { name: 'invoice', states: INVOICE_STATES, map: invoiceTransitions },
  { name: 'return', states: RETURN_STATES, map: returnTransitions }
]

const allowedEdges = transitionTables.flatMap(({ map }) =>
  Object.entries(map).flatMap(([from, destinations]) => destinations.map((to) => ({ map, from, to })))
)
const rejectedEdges = transitionTables.flatMap(({ map, states }) =>
  states.flatMap((from) => states.filter((to) => !map[from]?.includes(to)).map((to) => ({ map, from, to })))
)
const terminalStates = transitionTables.flatMap(({ map, states }) =>
  states.filter((state) => (map[state] ?? []).length === 0).map((state) => ({ map, state }))
)

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

  it('accepts every declared edge and rejects every undeclared edge', async () => {
    await checkProperty(
      'TST038-states-transitions',
      fc.property(fc.constantFrom(...allowedEdges), ({ map, from, to }) => {
        expect(canTransition(map, from, to)).toBe(true)
        expect(assertTransition(map, from, to)).toBeUndefined()
      })
    )
    await checkProperty(
      'TST038-states-undeclared-transitions',
      fc.property(fc.constantFrom(...rejectedEdges), ({ map, from, to }) => {
        expect(canTransition(map, from, to)).toBe(false)
        expect(() => assertTransition(map, from, to)).toThrow(`Invalid transition: ${from} -> ${to}`)
      })
    )
    await checkProperty(
      'TST038-states-terminal-states',
      fc.property(fc.constantFrom(...terminalStates), ({ map, state }) => {
        expect(map[state]).toEqual([])
      })
    )
  })
})
