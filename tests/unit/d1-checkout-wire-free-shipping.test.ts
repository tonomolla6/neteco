import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testNow } from '../support/deterministic'
import {
  MADRID,
  insertAutoRule,
  insertFreeShippingRule,
  order,
  prepare,
  updateFreeShippingRule,
  wireFixture
} from './d1-checkout-wire-fixture'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(testNow() + 1000)
})
afterEach(() => vi.useRealTimers())

const FOUR = [{ variantId: 'v-1-1', quantity: 4 }] // 2000 gross, 1653 net, cost 800
const parcel = (p: Awaited<ReturnType<typeof prepare>>) => p.options.find((o) => o.methodCode === 'parcel')!

describe('PRI-017 free-shipping rules wired through the allowFree hook', () => {
  it('keeps the legacy threshold behaviour when no rule is active (byte-identical options)', async () => {
    const f = await wireFixture()
    try {
      insertFreeShippingRule(f, { status: 'paused' })
      insertFreeShippingRule(f, { zone: 'local', status: 'draft' })
      const p = await prepare(f, { lines: FOUR, address: MADRID, threshold: 1000 })
      expect(parcel(p)).toMatchObject({ netCents: 0, grossCents: 0 })
      expect(f.sqlite.prepare('SELECT count(*) n FROM shipping_quote_free_shipping').get()).toEqual({ n: 0 })
      const below = await prepare(f, { lines: FOUR, address: MADRID, threshold: 5000 })
      expect(parcel(below)).toMatchObject({ netCents: 600, grossCents: 726 })
      const none = await prepare(f, { lines: FOUR, address: MADRID })
      expect(parcel(none)).toMatchObject({ netCents: 600 })
    } finally {
      f.sqlite.close()
    }
  })

  it('frees the standard parcel when the active rule threshold and margin allow it, with versioned evidence', async () => {
    const f = await wireFixture()
    try {
      const rule = insertFreeShippingRule(f, { threshold_gross_cents: 1500 })
      const p = await prepare(f, { lines: FOUR, address: MADRID, expectedTotalGrossCents: 2000 })
      expect(parcel(p)).toMatchObject({ netCents: 0, grossCents: 0 })
      const evidence = f.sqlite.prepare('SELECT * FROM shipping_quote_free_shipping').get() as Record<string, unknown>
      expect(evidence).toMatchObject({
        shipping_quote_id: p.shippingQuoteId,
        rule_id: rule.id,
        rule_version: 1,
        free: 1
      })
      const parsed = JSON.parse(String(evidence.evidence_json))
      expect(parsed).toMatchObject({
        ruleId: rule.id,
        version: 1,
        zone: 'peninsular',
        customerProfile: 'consumer',
        thresholdGrossCents: 1500,
        facts: { goodsGrossCents: 2000, goodsNetCents: 1653, goodsCostNetCents: 800 },
        decisions: [{ shippingNetCents: 600, free: true, reason: 'granted', subsidyNetCents: 600 }]
      })
      expect(() => f.sqlite.prepare('DELETE FROM shipping_quote_free_shipping').run()).toThrow(
        /checkout_pricing_immutable/
      )

      const placed = await order(f, p, 'parcel')
      if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
      expect(placed.body).toMatchObject({ totalGrossCents: 2000, shippingGrossCents: 0 })
      const snapshot = JSON.parse(
        (f.sqlite.prepare('SELECT snapshot_json FROM order_pricing_snapshots').get() as { snapshot_json: string })
          .snapshot_json
      )
      expect(snapshot.freeShipping).toMatchObject({ ruleId: rule.id, ruleVersion: 1, free: true })
      expect(snapshot.shipping).toMatchObject({ methodCode: 'parcel', netCents: 0, grossCents: 0 })
    } finally {
      f.sqlite.close()
    }
  })

  it('the rule threshold replaces the legacy threshold (stricter and looser)', async () => {
    const f = await wireFixture()
    try {
      const strict = insertFreeShippingRule(f, { threshold_gross_cents: 5000 })
      const stricter = await prepare(f, { lines: FOUR, address: MADRID, threshold: 100 })
      expect(parcel(stricter)).toMatchObject({ netCents: 600 })
      const looser = await prepare(f, { lines: [{ variantId: 'v-1-1', quantity: 2 }], address: MADRID })
      expect(parcel(looser)).toMatchObject({ netCents: 600 })
      updateFreeShippingRule(f, strict.id, { status: 'paused' })
      insertFreeShippingRule(f, { threshold_gross_cents: 999, min_margin_basis_points: 0 })
      const grant = await prepare(f, { lines: [{ variantId: 'v-1-1', quantity: 3 }], address: MADRID })
      expect(parcel(grant)).toMatchObject({ netCents: 0 })
    } finally {
      f.sqlite.close()
    }
  })

  it('does not free shipping below the margin floor or with an unknown cost (fail closed)', async () => {
    const f = await wireFixture()
    try {
      const rule = insertFreeShippingRule(f, { threshold_gross_cents: 1000, min_margin_basis_points: 2000 })
      const margin = await prepare(f, { lines: FOUR, address: MADRID })
      expect(parcel(margin)).toMatchObject({ netCents: 600 })
      const denied = JSON.parse(
        (f.sqlite.prepare('SELECT evidence_json FROM shipping_quote_free_shipping').get() as { evidence_json: string })
          .evidence_json
      )
      expect(denied.decisions).toEqual([
        { shippingNetCents: 600, free: false, reason: 'margin_floor', subsidyNetCents: 0 }
      ])
      updateFreeShippingRule(f, rule.id, { min_margin_basis_points: 1000 })
      f.sqlite.exec('UPDATE variants SET cost_net_cents = NULL')
      const unknown = await prepare(f, { lines: FOUR, address: MADRID })
      expect(parcel(unknown)).toMatchObject({ netCents: 600 })
    } finally {
      f.sqlite.close()
    }
  })

  it('once parcel rules exist they govern: a missing zone/profile rule never inherits the legacy threshold', async () => {
    const f = await wireFixture()
    try {
      insertFreeShippingRule(f, { zone: 'local' })
      const noMatch = await prepare(f, { lines: FOUR, address: MADRID, threshold: 100 })
      expect(parcel(noMatch)).toMatchObject({ netCents: 600 })
      expect(f.sqlite.prepare('SELECT count(*) n FROM shipping_quote_free_shipping').get()).toEqual({ n: 0 })
      insertFreeShippingRule(f, { customer_profile: 'company', zone: 'peninsular' })
      const consumer = await prepare(f, { lines: FOUR, address: MADRID, threshold: 100 })
      expect(parcel(consumer)).toMatchObject({ netCents: 600 })
      // A pallet-only rule does not install the parcel guard: legacy behaviour is kept.
      const g = await wireFixture()
      try {
        insertFreeShippingRule(g, {
          profile: 'pallet',
          conscious_subsidy: 1,
          subsidy_cap_net_cents: 5000,
          subsidy_reason: 'Subvencion consciente de palets grandes'
        })
        const legacy = await prepare(g, { lines: FOUR, address: MADRID, threshold: 100 })
        expect(parcel(legacy)).toMatchObject({ netCents: 0 })
      } finally {
        g.sqlite.close()
      }
    } finally {
      f.sqlite.close()
    }
  })

  it('never touches pickup or own delivery', async () => {
    const f = await wireFixture()
    try {
      insertFreeShippingRule(f, { zone: 'local' })
      const p = await prepare(f, { lines: FOUR })
      expect(p.options.find((o) => o.methodCode === 'pickup')).toMatchObject({ netCents: 0 })
      expect(p.options.find((o) => o.methodCode === 'own_delivery')).toMatchObject({ netCents: 500 })
    } finally {
      f.sqlite.close()
    }
  })

  it('requires the shipping option to be re-requested when the rule changes before the order', async () => {
    const f = await wireFixture()
    try {
      const rule = insertFreeShippingRule(f, { threshold_gross_cents: 1500 })
      const p = await prepare(f, { lines: FOUR, address: MADRID })
      updateFreeShippingRule(f, rule.id, { threshold_gross_cents: 2500 })
      const changed = await order(f, p, 'parcel')
      expect(changed).toMatchObject({ outcome: 'revalidation_required', reason: 'shipping_option_changed' })
      updateFreeShippingRule(f, rule.id, { threshold_gross_cents: 1500, status: 'paused' })
      const paused = await order(f, p, 'parcel')
      expect(paused).toMatchObject({ outcome: 'revalidation_required', reason: 'shipping_option_changed' })
      expect(f.sqlite.prepare('SELECT count(*) n FROM orders').get()).toEqual({ n: 0 })
      expect(f.sqlite.prepare("SELECT count(*) n FROM inventory_reservations WHERE status = 'reserved'").get()).toEqual(
        { n: 0 }
      )
    } finally {
      f.sqlite.close()
    }
  })

  it('margin is judged on the goods net after automatic discounts (no subsidy below the floor)', async () => {
    const f = await wireFixture()
    try {
      insertFreeShippingRule(f, { threshold_gross_cents: 1000, min_margin_basis_points: 1000 })
      const plain = await prepare(f, { lines: FOUR, address: MADRID })
      expect(parcel(plain)).toMatchObject({ netCents: 0 })
      insertAutoRule(f, { basis_points: 2000, margin_floor_basis_points: 0 })
      const discounted = await prepare(f, { lines: FOUR, address: MADRID })
      // goods gross 2000 still meets the threshold, but net after 20 % off (1323) - cost 800 - ship 600 < 10 %.
      expect(parcel(discounted)).toMatchObject({ netCents: 600 })
    } finally {
      f.sqlite.close()
    }
  })
})
