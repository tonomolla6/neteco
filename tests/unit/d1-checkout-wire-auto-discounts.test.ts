import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { quoteCart } from '../../workers/catalog/cart'
import { placeOrder } from '../../workers/catalog/checkout'
import { provisionPromotionFixture } from '../support/promotion-fixture'
import type { PromotionRule } from '../../shared/promotions'
import { CLAIMS, insertAutoRule, order, prepare, updateAutoRule, utc, wireFixture } from './d1-checkout-wire-fixture'
import { testNow, testUuid } from '../support/deterministic'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(testNow() + 1000)
})
afterEach(() => vi.useRealTimers())

const couponRule = (): PromotionRule => ({
  id: testUuid(),
  version: 1,
  code: 'TEST101',
  status: 'active',
  channel: 'online',
  startsAt: utc(-3600000),
  endsAt: utc(3600000),
  benefit: { kind: 'fixed', grossCents: 101 },
  scope: { kind: 'all' },
  segment: 'all',
  totalLimit: null,
  perCustomerLimit: null,
  volumeMode: 'stack_volume',
  ...{}
})

async function quote(f: Awaited<ReturnType<typeof wireFixture>>, owner = true, couponCode?: string) {
  const p = await prepare(f, { owner, ...(couponCode ? { couponCode } : {}) })
  const row = f.sqlite
    .prepare('SELECT * FROM checkout_quote_lines WHERE quote_id = ? ORDER BY line_index')
    .all(p.quoteId) as Array<Record<string, number>>
  return { p, row }
}

describe('PRI-014 automatic discounts wired into the checkout quote', () => {
  it('generates distinct command keys for independently prepared carts', async () => {
    const f = await wireFixture()
    try {
      const first = await prepare(f)
      const second = await prepare(f)
      expect(first.base.idempotencyKey).not.toBe(second.base.idempotencyKey)
    } finally {
      f.sqlite.close()
    }
  })
  it('leaves quotes untouched when no automatic rule is active (legacy behaviour)', async () => {
    const f = await wireFixture()
    try {
      insertAutoRule(f, { status: 'paused' })
      insertAutoRule(f, { status: 'draft' })
      insertAutoRule(f, { status: 'archived' })
      insertAutoRule(f, { starts_at: utc(3600000) })
      insertAutoRule(f, { starts_at: utc(-7200000), ends_at: utc(-3600000) })
      const { p, row } = await quote(f)
      expect(row).toHaveLength(1)
      expect(row[0]).toMatchObject({ unit_gross_cents: 500, gross_cents: 1000, discount_gross_cents: 0 })
      expect(f.sqlite.prepare('SELECT count(*) n FROM checkout_quote_auto_discounts').get()).toEqual({ n: 0 })
      const stored = JSON.parse(
        (
          f.sqlite.prepare("SELECT response_body FROM cart_commands WHERE command_id LIKE 'quote-%'").get() as {
            response_body: string
          }
        ).response_body
      )
      expect(stored.quote.autoDiscounts).toBeUndefined()
      expect(stored.quote.lines[0].discountGrossCents).toBeUndefined()
      expect(p.quoteId).toBeTruthy()
    } finally {
      f.sqlite.close()
    }
  })

  it('applies a percent rule in integer cents, stores line discounts and immutable evidence with rule version', async () => {
    const f = await wireFixture()
    try {
      const rule = insertAutoRule(f, { basis_points: 1000 })
      const { p, row } = await quote(f)
      expect(row[0]).toMatchObject({ unit_gross_cents: 500, gross_cents: 900, discount_gross_cents: 100 })
      const quoteRow = f.sqlite.prepare('SELECT total_gross_cents FROM checkout_quotes WHERE id = ?').get(p.quoteId)
      expect(quoteRow).toEqual({ total_gross_cents: 900 })
      const evidence = f.sqlite
        .prepare(
          'SELECT discount_gross_cents, evidence_json, evidence_hash FROM checkout_quote_auto_discounts WHERE quote_id = ?'
        )
        .get(p.quoteId) as { discount_gross_cents: number; evidence_json: string; evidence_hash: string }
      expect(evidence.discount_gross_cents).toBe(100)
      const parsed = JSON.parse(evidence.evidence_json)
      expect(parsed.rules).toEqual([
        expect.objectContaining({ ruleId: rule.id, code: rule.code, version: 1, discountGrossCents: 100, priority: 10 })
      ])
      expect(evidence.evidence_hash).toMatch(/^[0-9a-f]{64}$/)
      // Evidence is append-only.
      expect(() => f.sqlite.prepare('UPDATE checkout_quote_auto_discounts SET discount_gross_cents = 1').run()).toThrow(
        /checkout_pricing_immutable/
      )
      expect(() => f.sqlite.prepare('DELETE FROM checkout_quote_auto_discounts').run()).toThrow(
        /checkout_pricing_immutable/
      )
      // The customer-facing quote shows message and amount only, never rule codes or costs.
      const stored = JSON.parse(
        (
          f.sqlite.prepare("SELECT response_body FROM cart_commands WHERE command_id LIKE 'quote-%'").get() as {
            response_body: string
          }
        ).response_body
      )
      expect(stored.quote.autoDiscounts).toEqual({
        discountGrossCents: 100,
        explanations: [{ message: 'Descuento automatico', discountGrossCents: 100 }]
      })
      expect(JSON.stringify(stored.quote)).not.toContain(rule.code)
    } finally {
      f.sqlite.close()
    }
  })

  it('rounds half-up exactly once per percentage (odd amounts)', async () => {
    const f = await wireFixture()
    try {
      insertAutoRule(f, { basis_points: 333, margin_floor_basis_points: 0 })
      const { row } = await quote(f)
      // 1000 * 3.33 % = 33.3 -> 33
      expect(row[0]).toMatchObject({ discount_gross_cents: 33, gross_cents: 967 })
    } finally {
      f.sqlite.close()
    }
  })

  it('fails closed when the cost is unknown and caps the discount at the margin floor', async () => {
    const f = await wireFixture()
    try {
      insertAutoRule(f)
      f.sqlite.exec('UPDATE variants SET cost_net_cents = NULL')
      let q = await quote(f)
      expect(q.row[0]).toMatchObject({ discount_gross_cents: 0 })
      expect(f.sqlite.prepare('SELECT count(*) n FROM checkout_quote_auto_discounts').get()).toEqual({ n: 0 })
      // net price 413/unit, cost 380: a 10 % floor leaves no room at all.
      f.sqlite.exec('UPDATE variants SET cost_net_cents = 380')
      q = await quote(f)
      expect(q.row[0]).toMatchObject({ discount_gross_cents: 0 })
      // cost 350: some room, never below cost / (1 - floor).
      f.sqlite.exec('UPDATE variants SET cost_net_cents = 350')
      q = await quote(f)
      const discount = q.row[0]!.discount_gross_cents!
      expect(discount).toBeGreaterThan(0)
      expect(discount).toBeLessThan(100)
      expect(q.row[0]!.net_cents! * 9000).toBeGreaterThanOrEqual(350 * 2 * 10000)
    } finally {
      f.sqlite.close()
    }
  })

  it('does not stack with an eligible coupon: the coupon wins and no automatic evidence exists', async () => {
    const f = await wireFixture()
    try {
      await provisionPromotionFixture(f.sqlite, couponRule(), CLAIMS.identityId)
      insertAutoRule(f)
      const { p, row } = await quote(f, true, 'TEST101')
      expect(row[0]).toMatchObject({ gross_cents: 899, discount_gross_cents: 101 })
      expect(f.sqlite.prepare('SELECT count(*) n FROM checkout_quote_auto_discounts').get()).toEqual({ n: 0 })
      expect(
        f.sqlite.prepare('SELECT count(*) n FROM checkout_quote_promotions WHERE quote_id = ?').get(p.quoteId)
      ).toEqual({
        n: 1
      })
    } finally {
      f.sqlite.close()
    }
  })

  it('still applies automatic discounts when the coupon is unknown or not eligible', async () => {
    const f = await wireFixture()
    try {
      insertAutoRule(f)
      const { row } = await quote(f, true, 'NOPE1234')
      expect(row[0]).toMatchObject({ gross_cents: 900, discount_gross_cents: 100 })
    } finally {
      f.sqlite.close()
    }
  })

  it('enforces coupon precedence at database level in both directions', async () => {
    const f = await wireFixture()
    try {
      await provisionPromotionFixture(f.sqlite, couponRule(), CLAIMS.identityId)
      insertAutoRule(f)
      const { p } = await quote(f)
      expect(() =>
        f.sqlite
          .prepare(
            `INSERT INTO checkout_quote_promotions(quote_id,rule_id,rule_version,rule_json,rule_hash,customer_id,discount_gross_cents)
             SELECT ?, rule_id, version, rule_json, rule_hash, NULL, 1 FROM promotion_rule_versions LIMIT 1`
          )
          .run(p.quoteId)
      ).toThrow(/checkout_pricing_coupon_precedence/)
    } finally {
      f.sqlite.close()
    }
  })

  it('segment registered needs a signed-in customer', async () => {
    const f = await wireFixture()
    try {
      insertAutoRule(f, { segment: 'registered' })
      const guest = await quote(f, false)
      expect(guest.row[0]).toMatchObject({ discount_gross_cents: 0 })
      const member = await quote(f, true)
      expect(member.row[0]).toMatchObject({ discount_gross_cents: 100 })
    } finally {
      f.sqlite.close()
    }
  })

  it('never discounts a negotiated B2B contract line', async () => {
    const f = await wireFixture()
    try {
      insertAutoRule(f)
      const { evaluateQuoteAutoDiscounts } = await import('../../workers/pricing/auto-discount-quote')
      const line = {
        variantId: 'v-1-1',
        productId: 'p-1',
        categoryId: 'c1',
        sku: 'SKU-1-1',
        quantity: 2,
        unitGrossCents: 500,
        baseUnitGrossCents: 500,
        costUnitNetCents: 200,
        taxRateBasisPoints: 2100,
        priceVersionId: 'b2b:list:v1:a1:variant:v-1-1'
      }
      const contract = await evaluateQuoteAutoDiscounts(f.database, {
        now: utc(),
        customerId: 'c',
        companyApproved: true,
        lines: [line]
      })
      expect(contract).toBeNull()
      const publicLine = await evaluateQuoteAutoDiscounts(f.database, {
        now: utc(),
        customerId: 'c',
        companyApproved: true,
        lines: [{ ...line, priceVersionId: 'legacy:v-1-1' }]
      })
      expect(publicLine?.discountByIndex.get(0)).toBe(100)
    } finally {
      f.sqlite.close()
    }
  })
})

describe('PRI-014 automatic discounts through placeOrder', () => {
  it('creates the order from the discounted quote and records a reproducible pricing snapshot', async () => {
    const f = await wireFixture()
    try {
      const rule = insertAutoRule(f)
      const p = await prepare(f, { expectedTotalGrossCents: 900 })
      const result = await order(f, p)
      if (result.outcome !== 'order_created') throw new Error(result.outcome)
      expect(result.body).toMatchObject({
        totalGrossCents: 900,
        lines: [expect.objectContaining({ discountGrossCents: 100 })]
      })
      const line = f.sqlite.prepare('SELECT gross_cents, discount_gross_cents FROM order_lines').get()
      expect(line).toEqual({ gross_cents: 900, discount_gross_cents: 100 })
      const snapshot = f.sqlite.prepare('SELECT snapshot_json, snapshot_hash FROM order_pricing_snapshots').get() as {
        snapshot_json: string
        snapshot_hash: string
      }
      const parsed = JSON.parse(snapshot.snapshot_json)
      expect(parsed.autoDiscounts.rules[0]).toMatchObject({ ruleId: rule.id, version: 1, discountGrossCents: 100 })
      expect(parsed.totals).toMatchObject({
        goodsGrossCents: 900,
        orderTotalGrossCents: 900,
        storeCreditCents: 0,
        amountDueCents: 900
      })
      expect(parsed.precedence).toEqual([
        'base_price',
        'b2b_price_list_or_volume_tiers',
        'coupon_or_auto_discount',
        'free_shipping',
        'store_credit'
      ])
      expect(snapshot.snapshot_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(() => f.sqlite.prepare('UPDATE order_pricing_snapshots SET snapshot_hash = snapshot_hash').run()).toThrow(
        /checkout_pricing_immutable/
      )
    } finally {
      f.sqlite.close()
    }
  })

  it('is idempotent: the same command returns the same order and a single snapshot', async () => {
    const f = await wireFixture()
    try {
      insertAutoRule(f)
      const p = await prepare(f)
      const first = await order(f, p)
      const second = await order(f, p)
      if (first.outcome !== 'order_created' || second.outcome !== 'order_created') throw new Error('not created')
      expect(second.body.id).toBe(first.body.id)
      expect(f.sqlite.prepare('SELECT count(*) n FROM orders').get()).toEqual({ n: 1 })
      expect(f.sqlite.prepare('SELECT count(*) n FROM order_pricing_snapshots').get()).toEqual({ n: 1 })
    } finally {
      f.sqlite.close()
    }
  })

  it('asks for revalidation when the rule changes between quote and order, and creates nothing', async () => {
    const f = await wireFixture()
    try {
      const rule = insertAutoRule(f)
      const p = await prepare(f)
      updateAutoRule(f, rule.id, { basis_points: 2000 })
      const changed = await order(f, p)
      expect(changed).toMatchObject({ outcome: 'revalidation_required', reason: 'pricing_or_quantity_changed' })
      updateAutoRule(f, rule.id, { status: 'paused' })
      const paused = await order(f, p, 'pickup', {}, null)
      expect(paused.outcome).toBe('revalidation_required')
      expect(f.sqlite.prepare('SELECT count(*) n FROM orders').get()).toEqual({ n: 0 })
      expect(f.sqlite.prepare("SELECT count(*) n FROM inventory_reservations WHERE status = 'reserved'").get()).toEqual(
        { n: 0 }
      )
    } finally {
      f.sqlite.close()
    }
  })

  it('without any active rule the order has no snapshot and no discount columns change', async () => {
    const f = await wireFixture()
    try {
      const p = await prepare(f, { expectedTotalGrossCents: 1000 })
      const result = await order(f, p)
      if (result.outcome !== 'order_created') throw new Error(result.outcome)
      expect(result.body.totalGrossCents).toBe(1000)
      expect(JSON.stringify(result.body)).not.toContain('discountGrossCents')
      expect(JSON.stringify(result.body)).not.toContain('storeCredit')
      expect(f.sqlite.prepare('SELECT count(*) n FROM order_pricing_snapshots').get()).toEqual({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })

  it('a recovered saga (W2) is re-validated against the live automatic rules before it is finished', async () => {
    const f = await wireFixture()
    try {
      const rule = insertAutoRule(f)
      const p = await prepare(f)
      const option = p.options.find((o) => o.methodCode === 'pickup')!
      const input = { ...p.base, selectedOptionIndex: option.optionIndex, selectedOptionHash: option.optionHash }
      f.sqlite.exec(
        "CREATE TRIGGER fail_finalization BEFORE INSERT ON order_lines BEGIN SELECT RAISE(ABORT,'synthetic W2 crash'); END;"
      )
      await expect(placeOrder(f.database, input)).rejects.toThrow()
      f.sqlite.exec('DROP TRIGGER fail_finalization')
      updateAutoRule(f, rule.id, { status: 'paused' })
      const retry = await placeOrder(f.database, input)
      expect(retry).toMatchObject({ outcome: 'revalidation_required', reason: 'pricing_changed' })
      expect(f.sqlite.prepare('SELECT count(*) n FROM orders').get()).toEqual({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
})

void quoteCart
