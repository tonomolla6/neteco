import { describe, expect, it } from 'vitest'
import {
  bxgyRuleInputSchema,
  evaluateBuyXGetY,
  mulDivRound,
  quoteBxgyReturn,
  type BxgyContext,
  type BxgyRule
} from '../../shared/buy-x-get-y'

const NOW = '2026-10-29T12:00:00Z'
const RULE: BxgyRule = {
  id: '70000000-0000-4000-8000-000000000001',
  version: 1,
  status: 'active',
  triggerVariantId: 'v-trigger',
  buyQuantity: 2,
  giftVariantId: 'v-gift',
  giftQuantity: 1,
  maxApplicationsPerOrder: 5,
  totalLimit: null,
  perCustomerLimit: null,
  marginFloorBasisPoints: 0,
  startsAt: '2026-10-01T00:00:00Z',
  endsAt: null
}
function ctx(overrides: Partial<BxgyContext> = {}, quantity = 4): BxgyContext {
  return {
    now: NOW,
    customerId: 'c-1',
    lines: [
      { variantId: 'v-trigger', quantity, unitGrossCents: 1000, taxRateBasisPoints: 2100, costUnitNetCents: 300 }
    ],
    gift: { unitGrossCents: 500, taxRateBasisPoints: 2100, availableQuantity: 10, costUnitNetCents: 100 },
    redemptions: { total: 0, customer: 0 },
    ...overrides
  }
}
const rule = (o: Partial<BxgyRule> = {}): BxgyRule => ({ ...RULE, ...o })

describe('PRI-015 buy X get Y: input schema', () => {
  const valid = {
    code: 'COMPRA2REGALO1',
    name: 'Compra 2 y llévate 1',
    triggerVariantId: 'v-1-1',
    buyQuantity: 2,
    giftVariantId: 'v-2-1',
    giftQuantity: 1,
    maxApplicationsPerOrder: 3,
    totalLimit: null,
    perCustomerLimit: 2,
    marginFloorBasisPoints: 1000,
    startsAt: '2026-10-01T00:00:00Z',
    endsAt: '2026-12-01T00:00:00Z'
  }
  it('accepts a complete rule', () => {
    expect(bxgyRuleInputSchema.parse(valid)).toMatchObject({ code: 'COMPRA2REGALO1' })
  })
  it.each([
    ['lowercase code', { code: 'compra' }],
    ['zero buy quantity', { buyQuantity: 0 }],
    ['fractional gift quantity', { giftQuantity: 1.5 }],
    ['zero gift quantity', { giftQuantity: 0 }],
    ['negative margin floor', { marginFloorBasisPoints: -1 }],
    ['excessive margin floor', { marginFloorBasisPoints: 9001 }],
    ['end before start', { endsAt: '2026-09-01T00:00:00Z' }],
    ['unknown field', { status: 'active' }],
    ['zero limit', { totalLimit: 0 }]
  ])('rejects %s', (_label, patch) => {
    expect(bxgyRuleInputSchema.safeParse({ ...valid, ...patch }).success).toBe(false)
  })
})

describe('PRI-015 buy X get Y: eligibility', () => {
  it('applies floor(qty / X) times and adds the gift as separate lines', () => {
    const r = evaluateBuyXGetY(rule(), ctx())
    expect(r.eligible).toBe(true)
    expect(r.reason).toBeNull()
    expect(r.applications).toBe(2)
    const gift = r.lines.find((l) => l.kind === 'gift')!
    expect(gift).toMatchObject({ variantId: 'v-gift', quantity: 2, listGrossCents: 1000 })
  })
  it('leaves leftover trigger units at list price', () => {
    const r = evaluateBuyXGetY(rule(), ctx({}, 5))
    expect(r.applications).toBe(2)
    expect(r.totals.payableGrossCents).toBe(4000 + 1000)
  })
  it('caps applications by maxApplicationsPerOrder', () => {
    const r = evaluateBuyXGetY(rule({ maxApplicationsPerOrder: 1 }), ctx({}, 10))
    expect(r.applications).toBe(1)
    expect(r.lines.find((l) => l.kind === 'gift')!.quantity).toBe(1)
  })
  it('is not eligible below the buy quantity', () => {
    const r = evaluateBuyXGetY(rule(), ctx({}, 1))
    expect(r).toMatchObject({ eligible: false, reason: 'quantity_not_met', applications: 0 })
    expect(r.lines.some((l) => l.kind === 'gift')).toBe(false)
    expect(r.totals.discountGrossCents).toBe(0)
  })
  it('is not eligible without the trigger variant', () => {
    const r = evaluateBuyXGetY(rule({ triggerVariantId: 'other' }), ctx())
    expect(r).toMatchObject({ eligible: false, reason: 'trigger_missing' })
  })
  it.each(['draft', 'paused', 'archived'] as const)('ignores a %s rule', (status) => {
    expect(evaluateBuyXGetY(rule({ status }), ctx())).toMatchObject({ eligible: false, reason: 'rule_inactive' })
  })
  it('respects the start instant (inclusive) and the end instant (exclusive)', () => {
    expect(evaluateBuyXGetY(rule(), ctx({ now: '2026-09-30T23:59:59Z' })).reason).toBe('not_started')
    expect(evaluateBuyXGetY(rule(), ctx({ now: '2026-10-01T00:00:00Z' })).eligible).toBe(true)
    const bounded = rule({ endsAt: NOW })
    expect(evaluateBuyXGetY(bounded, ctx({ now: '2026-10-29T11:59:59Z' })).eligible).toBe(true)
    expect(evaluateBuyXGetY(bounded, ctx()).reason).toBe('expired')
  })
  it('enforces the total redemption limit and reduces applications to the remainder', () => {
    const limited = rule({ totalLimit: 10 })
    expect(evaluateBuyXGetY(limited, ctx({ redemptions: { total: 10, customer: 0 } })).reason).toBe('limit_reached')
    const partial = evaluateBuyXGetY(limited, ctx({ redemptions: { total: 9, customer: 0 } }))
    expect(partial.applications).toBe(1)
  })
  it('enforces per-customer limits and requires a customer when one is set', () => {
    const limited = rule({ perCustomerLimit: 1 })
    expect(evaluateBuyXGetY(limited, ctx({ redemptions: { total: 3, customer: 1 } })).reason).toBe(
      'customer_limit_reached'
    )
    expect(evaluateBuyXGetY(limited, ctx({ customerId: null })).reason).toBe('customer_required')
    expect(evaluateBuyXGetY(limited, ctx()).applications).toBe(1)
  })
})

describe('PRI-015 buy X get Y: stock', () => {
  it('reduces applications to what the gift stock supports', () => {
    const r = evaluateBuyXGetY(
      rule({ giftQuantity: 2 }),
      ctx({ gift: { unitGrossCents: 500, taxRateBasisPoints: 2100, availableQuantity: 3, costUnitNetCents: 100 } }, 6)
    )
    expect(r.applications).toBe(1)
    expect(r.lines.find((l) => l.kind === 'gift')!.quantity).toBe(2)
  })
  it('is not eligible when there is no gift stock, never promising a backorder', () => {
    const r = evaluateBuyXGetY(
      rule(),
      ctx({ gift: { unitGrossCents: 500, taxRateBasisPoints: 2100, availableQuantity: 0, costUnitNetCents: 100 } })
    )
    expect(r).toMatchObject({ eligible: false, reason: 'gift_out_of_stock', applications: 0 })
  })
  it('subtracts units of the gift variant already in the cart from the available stock', () => {
    const base = ctx()
    const withGiftInCart = ctx({
      lines: [
        ...base.lines,
        { variantId: 'v-gift', quantity: 9, unitGrossCents: 500, taxRateBasisPoints: 2100, costUnitNetCents: 100 }
      ]
    })
    // available 10, cart already holds 9 -> only 1 free unit can be promised
    const r = evaluateBuyXGetY(rule(), withGiftInCart)
    expect(r.applications).toBe(1)
  })
  it('works when the gift is the same product (2 + 1 free) and needs stock for both', () => {
    const same = rule({ giftVariantId: 'v-trigger' })
    const r = evaluateBuyXGetY(
      same,
      ctx({ gift: { unitGrossCents: 1000, taxRateBasisPoints: 2100, availableQuantity: 5, costUnitNetCents: 300 } }, 4)
    )
    // 4 in cart, 5 available -> only 1 free unit
    expect(r.applications).toBe(1)
  })
  it('treats negative or non-integer stock facts as unavailable', () => {
    const r = evaluateBuyXGetY(
      rule(),
      ctx({ gift: { unitGrossCents: 500, taxRateBasisPoints: 2100, availableQuantity: -3, costUnitNetCents: 100 } })
    )
    expect(r.reason).toBe('gift_out_of_stock')
  })
})

describe('PRI-015 buy X get Y: fiscality and allocation', () => {
  it('charges only the trigger price and allocates it pro rata across paid and gift units', () => {
    const r = evaluateBuyXGetY(rule(), ctx())
    expect(r.totals).toMatchObject({ listGrossCents: 5000, payableGrossCents: 4000, discountGrossCents: 1000 })
    const trigger = r.lines.find((l) => l.kind === 'paid')!
    const gift = r.lines.find((l) => l.kind === 'gift')!
    expect(trigger.allocatedGrossCents).toBe(3200)
    expect(gift.allocatedGrossCents).toBe(800)
    expect(trigger.netCents).toBe(2645)
    expect(trigger.taxCents).toBe(555)
    expect(gift.netCents).toBe(661)
    expect(gift.taxCents).toBe(139)
  })
  it('keeps VAT on the gift (never zero-rated) so tax is due on the whole consideration', () => {
    const r = evaluateBuyXGetY(rule(), ctx())
    expect(r.lines.find((l) => l.kind === 'gift')!.taxCents).toBeGreaterThan(0)
  })
  it('uses each line own VAT rate when trigger and gift differ', () => {
    const r = evaluateBuyXGetY(
      rule(),
      ctx({ gift: { unitGrossCents: 500, taxRateBasisPoints: 1000, availableQuantity: 10, costUnitNetCents: 100 } })
    )
    const gift = r.lines.find((l) => l.kind === 'gift')!
    expect(gift.taxRateBasisPoints).toBe(1000)
    expect(gift.netCents + gift.taxCents).toBe(gift.allocatedGrossCents)
    expect(gift.taxCents).toBe(gift.allocatedGrossCents - mulDivRound(gift.allocatedGrossCents, 10000, 11000))
  })
  it('always reconciles: net + tax = payable and lines sum to the payable total', () => {
    for (const qty of [2, 3, 4, 7, 11]) {
      const r = evaluateBuyXGetY(rule({ maxApplicationsPerOrder: 50 }), ctx({}, qty))
      expect(r.totals.netCents + r.totals.taxCents).toBe(r.totals.payableGrossCents)
      expect(r.lines.reduce((s, l) => s + l.allocatedGrossCents, 0)).toBe(r.totals.payableGrossCents)
      for (const l of r.lines) expect(l.netCents + l.taxCents).toBe(l.allocatedGrossCents)
    }
  })
  it('handles a free gift of price zero without dividing by zero', () => {
    const r = evaluateBuyXGetY(
      rule(),
      ctx({ gift: { unitGrossCents: 0, taxRateBasisPoints: 2100, availableQuantity: 10, costUnitNetCents: 0 } })
    )
    expect(r.eligible).toBe(true)
    expect(r.lines.find((l) => l.kind === 'gift')!.allocatedGrossCents).toBe(0)
    expect(r.totals.payableGrossCents).toBe(4000)
  })
  it('does not overflow with very large prices', () => {
    const r = evaluateBuyXGetY(
      rule(),
      ctx({
        lines: [
          {
            variantId: 'v-trigger',
            quantity: 2,
            unitGrossCents: 4_000_000_000,
            taxRateBasisPoints: 2100,
            costUnitNetCents: null
          }
        ]
      })
    )
    expect(r.lines.reduce((s, l) => s + l.allocatedGrossCents, 0)).toBe(8_000_000_000)
  })
  it('reports incremental net margin including the gift cost, null when a cost is unknown', () => {
    const known = evaluateBuyXGetY(rule(), ctx())
    // net revenue 3306 - cost (4 * 300 + 2 * 100)
    expect(known.marginNetCents).toBe(3306 - 1400)
    const unknown = evaluateBuyXGetY(
      rule(),
      ctx({ gift: { unitGrossCents: 500, taxRateBasisPoints: 2100, availableQuantity: 10, costUnitNetCents: null } })
    )
    expect(unknown.marginNetCents).toBeNull()
  })
})

describe('PRI-015 buy X get Y: margin floor', () => {
  it('blocks the offer when the bundle margin is below the floor', () => {
    // margin 1906 / net 3306 = 57 % -> floor 60 % blocks, floor 50 % passes
    expect(evaluateBuyXGetY(rule({ marginFloorBasisPoints: 6000 }), ctx()).reason).toBe('margin_floor')
    expect(evaluateBuyXGetY(rule({ marginFloorBasisPoints: 5000 }), ctx()).eligible).toBe(true)
  })
  it('blocks when a floor is set but the cost is unknown', () => {
    const r = evaluateBuyXGetY(
      rule({ marginFloorBasisPoints: 1000 }),
      ctx({ gift: { unitGrossCents: 500, taxRateBasisPoints: 2100, availableQuantity: 10, costUnitNetCents: null } })
    )
    expect(r.reason).toBe('margin_unknown')
  })
})

describe('PRI-015 buy X get Y: returns', () => {
  const sale = () => evaluateBuyXGetY(rule(), ctx()).snapshot
  it('refunds the allocated amount of a returned gift without breaking the offer', () => {
    const q = quoteBxgyReturn(sale(), [], [{ kind: 'gift', variantId: 'v-gift', quantity: 1 }])
    expect(q.refundGrossCents).toBe(400)
    expect(q.clawbackGrossCents).toBe(0)
  })
  it('returning all units refunds exactly what was paid', () => {
    const q = quoteBxgyReturn(
      sale(),
      [],
      [
        { kind: 'paid', variantId: 'v-trigger', quantity: 4 },
        { kind: 'gift', variantId: 'v-gift', quantity: 2 }
      ]
    )
    expect(q.refundGrossCents).toBe(4000)
    expect(q.netRefundGrossCents).toBe(4000)
    expect(q.refundTaxCents + q.refundNetCents).toBe(4000)
  })
  it('claws back the gift value when the trigger is returned but the gift is kept', () => {
    // 2 of 4 trigger units returned -> one application lost, one gift must come back
    const q = quoteBxgyReturn(sale(), [], [{ kind: 'paid', variantId: 'v-trigger', quantity: 2 }])
    expect(q.refundGrossCents).toBe(1600)
    // unreturned gift list 500 - allocated 400 = 100
    expect(q.clawbackGrossCents).toBe(100)
    expect(q.netRefundGrossCents).toBe(1500)
  })
  it('does not claw back when the required gift units are returned too', () => {
    const q = quoteBxgyReturn(
      sale(),
      [],
      [
        { kind: 'paid', variantId: 'v-trigger', quantity: 2 },
        { kind: 'gift', variantId: 'v-gift', quantity: 1 }
      ]
    )
    expect(q.clawbackGrossCents).toBe(0)
    expect(q.netRefundGrossCents).toBe(1600 + 400)
  })
  it('does not claw back when the remaining units still qualify', () => {
    const q = quoteBxgyReturn(sale(), [], [{ kind: 'paid', variantId: 'v-trigger', quantity: 0 }])
    expect(q.refundGrossCents).toBe(0)
  })
  it('is incremental: previous returns are not refunded twice', () => {
    const first = quoteBxgyReturn(sale(), [], [{ kind: 'gift', variantId: 'v-gift', quantity: 1 }])
    const second = quoteBxgyReturn(
      sale(),
      [{ kind: 'gift', variantId: 'v-gift', quantity: 1 }],
      [{ kind: 'gift', variantId: 'v-gift', quantity: 1 }]
    )
    expect(first.netRefundGrossCents + second.netRefundGrossCents).toBe(800)
  })
  it('rejects returning more units than were sold, cumulatively', () => {
    expect(() => quoteBxgyReturn(sale(), [], [{ kind: 'gift', variantId: 'v-gift', quantity: 3 }])).toThrow(
      'return_exceeds_sold'
    )
    expect(() =>
      quoteBxgyReturn(
        sale(),
        [{ kind: 'gift', variantId: 'v-gift', quantity: 2 }],
        [{ kind: 'gift', variantId: 'v-gift', quantity: 1 }]
      )
    ).toThrow('return_exceeds_sold')
  })
  it('rejects units that were not part of the sale', () => {
    expect(() => quoteBxgyReturn(sale(), [], [{ kind: 'paid', variantId: 'ghost', quantity: 1 }])).toThrow(
      'return_line_unknown'
    )
  })
  it('never refunds more than was paid even when clawback and rounding interact', () => {
    const everything = quoteBxgyReturn(sale(), [], [{ kind: 'paid', variantId: 'v-trigger', quantity: 4 }])
    expect(everything.netRefundGrossCents).toBeLessThanOrEqual(4000)
    expect(everything.netRefundGrossCents).toBeGreaterThanOrEqual(0)
  })
})

describe('mulDivRound', () => {
  it('rounds half up using exact integer arithmetic', () => {
    expect(mulDivRound(1, 1, 2)).toBe(1)
    expect(mulDivRound(1, 1, 3)).toBe(0)
    expect(mulDivRound(4_000_000_000, 4_000_000_000, 8_000_000_000)).toBe(2_000_000_000)
  })
  it('rejects a zero divisor', () => {
    expect(() => mulDivRound(1, 1, 0)).toThrow()
  })
})
