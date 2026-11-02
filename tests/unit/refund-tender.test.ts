import { describe, expect, it } from 'vitest'
import { allocateRefundTender } from '../../shared/refund-tender'

// Order of 1000 cents paid 600 by card and 400 with store credit.
const order = { cardCapturedCents: 600, storeCreditCents: 400 }
const none = { heldCardCents: 0, heldStoreCreditCents: 0 }

/** Applies refunds in sequence, carrying the held amounts like the D1 planner does. */
function sequence(amounts: number[], tender = order) {
  let heldCardCents = 0,
    heldStoreCreditCents = 0
  return amounts.map((amountCents) => {
    const split = allocateRefundTender({ ...tender, heldCardCents, heldStoreCreditCents, amountCents })
    heldCardCents += split.cardCents
    heldStoreCreditCents += split.storeCreditCents
    return split
  })
}

describe('refund tender allocation for orders partly paid with store credit (PRI-018 downstream)', () => {
  it('splits a refund in proportion to the original tender', () => {
    expect(allocateRefundTender({ ...order, ...none, amountCents: 500 })).toEqual({
      cardCents: 300,
      storeCreditCents: 200
    })
  })

  it('closes both tenders exactly when the whole order is refunded in parts', () => {
    const parts = sequence([500, 500])
    expect(parts).toEqual([
      { cardCents: 300, storeCreditCents: 200 },
      { cardCents: 300, storeCreditCents: 200 }
    ])
    const uneven = sequence([333, 1, 1, 665], { cardCapturedCents: 701, storeCreditCents: 299 })
    expect(uneven.reduce((sum, part) => sum + part.cardCents, 0)).toBe(701)
    expect(uneven.reduce((sum, part) => sum + part.storeCreditCents, 0)).toBe(299)
  })

  it('rounds the card share down: the cumulative card refund is floor(refunded x card / total)', () => {
    // 1 cent of a 600/400 order: floor(0.6) = 0 -> store credit only.
    expect(allocateRefundTender({ ...order, ...none, amountCents: 1 })).toEqual({ cardCents: 0, storeCreditCents: 1 })
    const cents = sequence(Array.from({ length: 10 }, () => 1))
    let cumulative = 0
    cents.forEach((part, index) => {
      cumulative += part.cardCents
      expect(cumulative).toBe(Math.floor(((index + 1) * 600) / 1000))
    })
  })

  it('never refunds to card more than was captured, for any partition of the order', () => {
    for (let seed = 1; seed <= 200; seed++) {
      let state = seed
      const random = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648) as number
      const card = 1 + Math.floor(random() * 5000),
        credit = 1 + Math.floor(random() * 5000)
      let left = card + credit
      const amounts: number[] = []
      while (left > 0) {
        const amount = Math.min(left, 1 + Math.floor(random() * 900))
        amounts.push(amount)
        left -= amount
      }
      const parts = sequence(amounts, { cardCapturedCents: card, storeCreditCents: credit })
      let heldCard = 0,
        heldCredit = 0
      parts.forEach((part, index) => {
        expect(part.cardCents + part.storeCreditCents).toBe(amounts[index])
        expect(part.cardCents).toBeGreaterThanOrEqual(0)
        expect(part.storeCreditCents).toBeGreaterThanOrEqual(0)
        heldCard += part.cardCents
        heldCredit += part.storeCreditCents
        expect(heldCard).toBeLessThanOrEqual(card)
        expect(heldCredit).toBeLessThanOrEqual(credit)
      })
      expect([heldCard, heldCredit]).toEqual([card, credit])
    }
  })

  it('stays within both budgets when earlier holds do not follow the proportional path (cancelled refunds)', () => {
    // A held 1-cent refund went fully to card (e.g. planned before a cancellation reshuffled holds).
    const split = allocateRefundTender({ ...order, heldCardCents: 600, heldStoreCreditCents: 0, amountCents: 400 })
    expect(split).toEqual({ cardCents: 0, storeCreditCents: 400 })
    const other = allocateRefundTender({ ...order, heldCardCents: 0, heldStoreCreditCents: 400, amountCents: 600 })
    expect(other).toEqual({ cardCents: 600, storeCreditCents: 0 })
  })

  it('rejects amounts above the remaining refundable budget and invalid inputs', () => {
    expect(() =>
      allocateRefundTender({ ...order, heldCardCents: 300, heldStoreCreditCents: 200, amountCents: 501 })
    ).toThrow(/amount_unavailable/)
    for (const amountCents of [0, -1, 1.5, Number.NaN])
      expect(() => allocateRefundTender({ ...order, ...none, amountCents })).toThrow()
    expect(() =>
      allocateRefundTender({ cardCapturedCents: 600, storeCreditCents: 0, ...none, amountCents: 1 })
    ).toThrow()
    expect(() =>
      allocateRefundTender({ ...order, heldCardCents: 601, heldStoreCreditCents: 0, amountCents: 1 })
    ).toThrow()
  })
})
