import { describe, expect, it } from 'vitest'
import { returnRequestInputSchema, returnTransitionInputSchema, allowedReturnActions } from '../../shared/order-returns'

const reason = 'Documented operational review only'
describe('native custody RMA strict contracts', () => {
  it('accepts a request using immutable historical line indices', () => {
    expect(
      returnRequestInputSchema.parse({ expectedVersion: 0, reason, lines: [{ lineIndex: 0, quantity: 2 }] }).lines
    ).toEqual([{ lineIndex: 0, quantity: 2 }])
  })
  it.each([
    {},
    { expectedVersion: 0, reason, lines: [] },
    {
      expectedVersion: 0,
      reason,
      lines: [
        { lineIndex: 0, quantity: 1 },
        { lineIndex: 0, quantity: 1 }
      ]
    },
    { expectedVersion: 0, reason, lines: [{ orderLineId: crypto.randomUUID(), quantity: 1 }] },
    { expectedVersion: 0, reason, lines: [{ lineIndex: 0, quantity: 1 }], customerId: crypto.randomUUID() }
  ])('rejects malformed or externally owned request %#', (value) => {
    expect(returnRequestInputSchema.safeParse(value).success).toBe(false)
  })
  it('does not execute input getters', () => {
    let calls = 0
    const value = {
      get reason() {
        calls++
        return reason
      },
      expectedVersion: 0,
      lines: [{ lineIndex: 0, quantity: 1 }]
    }
    expect(returnRequestInputSchema.safeParse(value).success).toBe(false)
    expect(calls).toBe(0)
  })
  it('requires explicitly documented admission and unique line quantities', () => {
    const value = {
      action: 'approved',
      expectedVersion: 1,
      reason,
      publicMessage: reason,
      evidence: reason,
      decisionRef: 'manual-reviewed-case-01',
      lines: [{ lineIndex: 0, quantity: 1 }]
    }
    expect(returnTransitionInputSchema.safeParse(value).success).toBe(true)
    expect(returnTransitionInputSchema.safeParse({ ...value, decisionRef: undefined }).success).toBe(false)
    expect(returnTransitionInputSchema.safeParse({ ...value, refundAmountCents: 500 }).success).toBe(false)
  })
  it('requires inspection condition/disposition and never accepts resolved money state', () => {
    const value = {
      action: 'inspected',
      expectedVersion: 3,
      reason,
      publicMessage: reason,
      evidence: reason,
      lines: [{ lineIndex: 0, quantity: 1, condition: 'damaged', disposition: 'non_restockable' }]
    }
    expect(returnTransitionInputSchema.safeParse(value).success).toBe(true)
    expect(returnTransitionInputSchema.safeParse({ ...value, lines: [{ lineIndex: 0, quantity: 1 }] }).success).toBe(
      false
    )
    expect(returnTransitionInputSchema.safeParse({ ...value, action: 'resolved' }).success).toBe(false)
  })
  it('guides partial reception/inspection without releasing received claims', () => {
    expect(allowedReturnActions('requested', false, false)).toEqual(['approved', 'rejected'])
    expect(allowedReturnActions('received', false, false)).toEqual(['received'])
    expect(allowedReturnActions('received', true, false)).toEqual(['inspected'])
    expect(allowedReturnActions('inspected', true, false)).toEqual(['inspected'])
    expect(allowedReturnActions('inspected', true, true)).toEqual(['resolution_ready'])
    expect(allowedReturnActions('resolution_ready', true, true)).toEqual([])
  })
})
