import { describe, expect, it } from 'vitest'
import { buildPaymentSchedule, reconcileSchedule } from '../../shared/payment-schedule'

const at = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
const now = at()
const base = { totalGrossCents: 100001, depositBasisPoints: 3000, installments: 2, intervalDays: 30, now }

describe('payment schedules (PRI-021)', () => {
  it('splits deposit + installments + balance so the parts sum exactly to the total', () => {
    const s = buildPaymentSchedule(base)
    expect(s.map((p) => p.kind)).toEqual(['deposit', 'installment', 'balance'])
    expect(s[0]!.dueCents).toBe(30000) // 100001 * 30 % = 30000.3 -> 30000
    expect(s.reduce((n, p) => n + p.dueCents, 0)).toBe(100001)
    expect(s.map((p) => p.seq)).toEqual([1, 2, 3])
  })
  it('puts rounding remainders in the final balance and rounds deposit half-up', () => {
    const s = buildPaymentSchedule({ ...base, totalGrossCents: 1001, depositBasisPoints: 5000, installments: 2 })
    expect(s[0]!.dueCents).toBe(501) // 500.5 -> 501
    expect(s.reduce((n, p) => n + p.dueCents, 0)).toBe(1001)
    expect(s.every((p) => p.dueCents >= 1)).toBe(true)
  })
  it('derives due dates from the server clock and the interval', () => {
    const s = buildPaymentSchedule(base)
    expect(s[0]!.dueAt).toBe(now)
    expect(Date.parse(s[1]!.dueAt) - Date.parse(now)).toBe(30 * 86_400_000)
    expect(Date.parse(s[2]!.dueAt) - Date.parse(now)).toBe(60 * 86_400_000)
  })
  it('supports deposit + single balance', () => {
    const s = buildPaymentSchedule({ ...base, installments: 1 })
    expect(s.map((p) => p.kind)).toEqual(['deposit', 'balance'])
  })
  it('rejects unsafe plans', () => {
    for (const bad of [
      { depositBasisPoints: 499 },
      { depositBasisPoints: 9001 },
      { installments: 0 },
      { installments: 12 },
      { intervalDays: 6 },
      { intervalDays: 91 },
      { totalGrossCents: 0 },
      { totalGrossCents: 2 },
      { totalGrossCents: 10.5 },
      { depositBasisPoints: 1000.5 },
      { now: 'yesterday' }
    ])
      expect(() => buildPaymentSchedule({ ...base, ...bad })).toThrow()
  })
  it('reconciles due, captured, remaining and invoiced amounts', () => {
    const plan = buildPaymentSchedule(base)
    const r = reconcileSchedule(100001, plan, [
      { entryType: 'capture', seq: 1, amountCents: 30000 },
      { entryType: 'invoice', seq: null, amountCents: 30000 },
      { entryType: 'capture', seq: 2, amountCents: 20000 }
    ])
    expect(r).toMatchObject({
      dueCents: 100001,
      capturedCents: 50000,
      refundedCents: 0,
      remainingCents: 50001,
      invoicedCents: 30000,
      toInvoiceCents: 20000,
      creditNoteDueCents: 0,
      settled: false,
      consistent: true
    })
    expect(r.installments.map((i) => i.remainingCents)).toEqual([0, plan[1]!.dueCents - 20000, plan[2]!.dueCents])
  })
  it('a refund after invoicing demands a credit note; fully paid and invoiced is settled', () => {
    const plan = buildPaymentSchedule(base)
    const full = plan.map((p) => ({ entryType: 'capture' as const, seq: p.seq, amountCents: p.dueCents }))
    const settled = reconcileSchedule(100001, plan, [...full, { entryType: 'invoice', seq: null, amountCents: 100001 }])
    expect(settled).toMatchObject({ remainingCents: 0, settled: true, toInvoiceCents: 0, creditNoteDueCents: 0 })
    const refunded = reconcileSchedule(100001, plan, [
      ...full,
      { entryType: 'invoice', seq: null, amountCents: 100001 },
      { entryType: 'refund', seq: null, amountCents: 4000 }
    ])
    expect(refunded).toMatchObject({
      capturedCents: 100001,
      refundedCents: 4000,
      remainingCents: 4000,
      settled: false,
      creditNoteDueCents: 4000
    })
    const credited = reconcileSchedule(100001, plan, [
      ...full,
      { entryType: 'invoice', seq: null, amountCents: 100001 },
      { entryType: 'refund', seq: null, amountCents: 4000 },
      { entryType: 'credit_note', seq: null, amountCents: 4000 }
    ])
    expect(credited.creditNoteDueCents).toBe(0)
  })
  it('flags impossible ledgers instead of hiding them', () => {
    const plan = buildPaymentSchedule(base)
    const over = reconcileSchedule(100001, plan, [{ entryType: 'capture', seq: 1, amountCents: 30001 }])
    expect(over.consistent).toBe(false)
    expect(over.issues).toContain('installment_overpaid:1')
    const refundTooMuch = reconcileSchedule(100001, plan, [
      { entryType: 'capture', seq: 1, amountCents: 10 },
      { entryType: 'refund', seq: null, amountCents: 11 }
    ])
    expect(refundTooMuch.issues).toContain('refund_exceeds_capture')
  })
})
