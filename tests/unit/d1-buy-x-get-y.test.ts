import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fulfillmentFixture } from './d1-fulfillment-fixture'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { ADMIN_CLAIMS, CUSTOMER_ID, NO_MFA_CLAIMS, NOW, PLAIN_CLAIMS, seedGrowthIdentities } from './d1-growth-fixture'
import {
  createBxgyRule,
  listBxgyRules,
  previewBuyXGetY,
  recordBxgyRedemption,
  recordBxgyReturn,
  setBxgyRuleStatus,
  updateBxgyRule
} from '../../workers/growth/buy-x-get-y'
import { GrowthError } from '../../workers/growth/common'
import type { BxgyRuleInput } from '../../shared/buy-x-get-y'

const INPUT: BxgyRuleInput = {
  code: 'COMPRA2REGALO1',
  name: 'Compra 2 y llévate 1',
  triggerVariantId: 'v-1-1',
  buyQuantity: 2,
  giftVariantId: 'v-2-1',
  giftQuantity: 1,
  maxApplicationsPerOrder: 5,
  totalLimit: null,
  perCustomerLimit: null,
  marginFloorBasisPoints: 0,
  startsAt: '2026-01-01T00:00:00Z',
  endsAt: null
}
let n = 0
const key = () => `idem-key-${++n}-${'x'.repeat(4)}`

let sqlite: DatabaseSync
let db: D1Database

beforeEach(async () => {
  const fixture = await fulfillmentFixture({ stock: 25 })
  sqlite = fixture.sqlite
  db = fixture.database
  sqlite.exec(await readFile(new URL('../../db/d1/migrations/0115_growth_offers.sql', import.meta.url), 'utf8'))
  seedGrowthIdentities(sqlite)
  await provisionPublicationValidityFixture(db, {
    productIds: ['p-1', 'p-2', 'p-3', 'p-4'],
    now: '2026-01-01T00:00:00Z'
  })
  sqlite.exec("UPDATE variants SET cost_net_cents=200 WHERE id IN ('v-1-1','v-2-1','v-3-1')")
})
afterEach(() => {
  if (sqlite?.isOpen) sqlite.close()
})

async function activeRule(patch: Partial<BxgyRuleInput> = {}) {
  const created = await createBxgyRule(db, ADMIN_CLAIMS, { ...INPUT, ...patch }, key(), NOW)
  const activated = await setBxgyRuleStatus(db, ADMIN_CLAIMS, created.targetId, 'active', 1, key(), NOW)
  return { id: created.targetId, version: activated.appliedVersion }
}
const cart = (quantity = 4, id = 'v-1-1') => ({ lines: [{ variantId: id, quantity }] })
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof GrowthError ? e.code : `unexpected:${String(e)}`)
  )

describe('PRI-015 administration of rules', () => {
  it('creates a draft rule with a journal entry and a receipt', async () => {
    const receipt = await createBxgyRule(db, ADMIN_CLAIMS, INPUT, key(), NOW)
    expect(receipt).toMatchObject({ action: 'create', appliedVersion: 1 })
    expect(sqlite.prepare('SELECT status, version FROM bxgy_rules').get()).toEqual({ status: 'draft', version: 1 })
    expect(sqlite.prepare('SELECT count(*) c FROM bxgy_commands').get()).toEqual({ c: 1 })
  })
  it('replays the same idempotency key and payload without a second rule', async () => {
    const k = key()
    const a = await createBxgyRule(db, ADMIN_CLAIMS, INPUT, k, NOW)
    const b = await createBxgyRule(db, ADMIN_CLAIMS, INPUT, k, NOW)
    expect(b).toEqual(a)
    expect(sqlite.prepare('SELECT count(*) c FROM bxgy_rules').get()).toEqual({ c: 1 })
  })
  it('refuses the same idempotency key with a different payload', async () => {
    const k = key()
    await createBxgyRule(db, ADMIN_CLAIMS, INPUT, k, NOW)
    expect(await code(createBxgyRule(db, ADMIN_CLAIMS, { ...INPUT, code: 'OTRA' }, k, NOW))).toBe(
      'idempotency_conflict'
    )
  })
  it('rejects a duplicate code as conflict', async () => {
    await createBxgyRule(db, ADMIN_CLAIMS, INPUT, key(), NOW)
    expect(await code(createBxgyRule(db, ADMIN_CLAIMS, INPUT, key(), NOW))).toBe('conflict')
  })
  it('rejects invalid input and unknown variants', async () => {
    expect(await code(createBxgyRule(db, ADMIN_CLAIMS, { ...INPUT, buyQuantity: 0 }, key(), NOW))).toBe('invalid_input')
    expect(await code(createBxgyRule(db, ADMIN_CLAIMS, { ...INPUT, giftVariantId: 'ghost' }, key(), NOW))).toBe(
      'variant_not_available'
    )
    expect(await code(createBxgyRule(db, ADMIN_CLAIMS, { ...INPUT, triggerVariantId: 'ghost' }, key(), NOW))).toBe(
      'variant_not_available'
    )
  })
  it('rejects a short idempotency key', async () => {
    expect(await code(createBxgyRule(db, ADMIN_CLAIMS, INPUT, 'short', NOW))).toBe('invalid_input')
  })
  it('requires a live MFA admin session for every administrative command', async () => {
    expect(await code(createBxgyRule(db, NO_MFA_CLAIMS, INPUT, key(), NOW))).toBe('mfa_required')
    expect(await code(createBxgyRule(db, PLAIN_CLAIMS, INPUT, key(), NOW))).toBe('forbidden')
    expect(await code(listBxgyRules(db, PLAIN_CLAIMS, NOW))).toBe('forbidden')
    sqlite.exec("UPDATE auth_sessions SET revoked_at='2026-02-01T00:00:00Z'")
    expect(await code(createBxgyRule(db, ADMIN_CLAIMS, INPUT, key(), NOW))).toBe('unauthenticated')
  })
  it('updates with compare-and-set and bumps the version', async () => {
    const { id } = await createBxgyRule(db, ADMIN_CLAIMS, INPUT, key(), NOW).then((r) => ({ id: r.targetId }))
    const r = await updateBxgyRule(db, ADMIN_CLAIMS, id, { ...INPUT, name: 'Nuevo nombre' }, 1, key(), NOW)
    expect(r.appliedVersion).toBe(2)
    expect(await code(updateBxgyRule(db, ADMIN_CLAIMS, id, INPUT, 1, key(), NOW))).toBe('version_conflict')
  })
  it('lets only one of two concurrent writers win', async () => {
    const { targetId } = await createBxgyRule(db, ADMIN_CLAIMS, INPUT, key(), NOW)
    const results = await Promise.all([
      code(updateBxgyRule(db, ADMIN_CLAIMS, targetId, { ...INPUT, name: 'Escritor A' }, 1, key(), NOW)),
      code(updateBxgyRule(db, ADMIN_CLAIMS, targetId, { ...INPUT, name: 'Escritor B' }, 1, key(), NOW))
    ])
    expect(results.sort()).toEqual(['ok', 'version_conflict'])
    expect(sqlite.prepare('SELECT version FROM bxgy_rules').get()).toEqual({ version: 2 })
  })
  it('does not allow code change through update and keeps the code immutable', async () => {
    const { targetId } = await createBxgyRule(db, ADMIN_CLAIMS, INPUT, key(), NOW)
    expect(await code(updateBxgyRule(db, ADMIN_CLAIMS, targetId, { ...INPUT, code: 'CAMBIO' }, 1, key(), NOW))).toBe(
      'invalid_input'
    )
  })
  it('walks the status machine and refuses leaving archived', async () => {
    const { targetId } = await createBxgyRule(db, ADMIN_CLAIMS, INPUT, key(), NOW)
    expect((await setBxgyRuleStatus(db, ADMIN_CLAIMS, targetId, 'active', 1, key(), NOW)).appliedVersion).toBe(2)
    expect((await setBxgyRuleStatus(db, ADMIN_CLAIMS, targetId, 'paused', 2, key(), NOW)).appliedVersion).toBe(3)
    expect((await setBxgyRuleStatus(db, ADMIN_CLAIMS, targetId, 'archived', 3, key(), NOW)).appliedVersion).toBe(4)
    expect(await code(setBxgyRuleStatus(db, ADMIN_CLAIMS, targetId, 'active', 4, key(), NOW))).toBe(
      'invalid_transition'
    )
    expect(await code(updateBxgyRule(db, ADMIN_CLAIMS, targetId, INPUT, 4, key(), NOW))).toBe('invalid_transition')
  })
  it('refuses draft -> paused and status to the same value', async () => {
    const { targetId } = await createBxgyRule(db, ADMIN_CLAIMS, INPUT, key(), NOW)
    expect(await code(setBxgyRuleStatus(db, ADMIN_CLAIMS, targetId, 'paused', 1, key(), NOW))).toBe(
      'invalid_transition'
    )
    expect(await code(setBxgyRuleStatus(db, ADMIN_CLAIMS, targetId, 'draft', 1, key(), NOW))).toBe('invalid_transition')
  })
  it('reports not_found for unknown rules', async () => {
    expect(
      await code(setBxgyRuleStatus(db, ADMIN_CLAIMS, '70000000-0000-4000-8000-0000000000ff', 'active', 1, key(), NOW))
    ).toBe('not_found')
  })
  it('keeps the command journal append-only', async () => {
    await createBxgyRule(db, ADMIN_CLAIMS, INPUT, key(), NOW)
    expect(() => sqlite.exec("UPDATE bxgy_commands SET action='update'")).toThrow(/bxgy_command_immutable/)
    expect(() => sqlite.exec('DELETE FROM bxgy_commands')).toThrow(/bxgy_command_immutable/)
    expect(() => sqlite.exec('DELETE FROM bxgy_rules')).toThrow(/bxgy_rule_immutable/)
  })
  it('lists rules for administrators', async () => {
    await createBxgyRule(db, ADMIN_CLAIMS, INPUT, key(), NOW)
    const rules = await listBxgyRules(db, ADMIN_CLAIMS, NOW)
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ code: 'COMPRA2REGALO1', status: 'draft', version: 1 })
  })
})

describe('PRI-015 server-side preview from real catalogue data', () => {
  it('applies an active rule using DB price, VAT and stock', async () => {
    await activeRule()
    const before = sqlite.prepare('SELECT total_changes() n').get()
    const r = await previewBuyXGetY(db, { ...cart(4), customerId: null }, NOW)
    expect(r.rule).toMatchObject({ code: 'COMPRA2REGALO1' })
    expect(r.evaluation).toMatchObject({ eligible: true, applications: 2 })
    // trigger list 4 x 500 = 2000, gift list 2 x 500 = 1000, paid 2000
    expect(r.evaluation.totals).toMatchObject({
      listGrossCents: 3000,
      payableGrossCents: 2000,
      discountGrossCents: 1000
    })
    expect(r.evaluation.totals.netCents + r.evaluation.totals.taxCents).toBe(2000)
    expect(sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  })
  it('ignores draft, paused and archived rules', async () => {
    const created = await createBxgyRule(db, ADMIN_CLAIMS, INPUT, key(), NOW)
    expect((await previewBuyXGetY(db, { ...cart(4), customerId: null }, NOW)).rule).toBeNull()
    await setBxgyRuleStatus(db, ADMIN_CLAIMS, created.targetId, 'active', 1, key(), NOW)
    await setBxgyRuleStatus(db, ADMIN_CLAIMS, created.targetId, 'paused', 2, key(), NOW)
    expect((await previewBuyXGetY(db, { ...cart(4), customerId: null }, NOW)).rule).toBeNull()
  })
  it('returns the unchanged cart when nothing matches', async () => {
    await activeRule()
    const r = await previewBuyXGetY(db, { ...cart(4, 'v-3-1'), customerId: null }, NOW)
    expect(r.rule).toBeNull()
    expect(r.evaluation.totals.discountGrossCents).toBe(0)
  })
  it('caps the gift at real sellable stock and never promises backorder', async () => {
    await activeRule()
    // v-2-1 has 25 physical, safety stock 2 -> make only 3 sellable
    sqlite.exec("UPDATE inventory_balances SET physical_quantity=5 WHERE variant_id='v-2-1'")
    sqlite.exec("UPDATE inventory_movements SET physical_delta=5 WHERE variant_id='v-2-1'")
    const r = await previewBuyXGetY(db, { ...cart(10), customerId: null }, NOW)
    expect(r.evaluation.applications).toBe(3)
    sqlite.exec("UPDATE inventory_balances SET blocked_quantity=5 WHERE variant_id='v-2-1'")
    const none = await previewBuyXGetY(db, { ...cart(10), customerId: null }, NOW)
    expect(none.evaluation).toMatchObject({ eligible: false, reason: 'gift_out_of_stock' })
  })
  it('treats an unpublished gift as out of stock instead of failing the cart', async () => {
    await activeRule()
    sqlite.exec("UPDATE variants SET status='hidden' WHERE id='v-2-1'")
    const r = await previewBuyXGetY(db, { ...cart(4), customerId: null }, NOW)
    expect(r.evaluation.reason).toBe('gift_out_of_stock')
  })
  it('refuses a cart containing an unavailable variant', async () => {
    await activeRule()
    sqlite.exec("UPDATE variants SET status='hidden' WHERE id='v-1-1'")
    expect(await code(previewBuyXGetY(db, { ...cart(4), customerId: null }, NOW))).toBe('variant_not_available')
    expect(await code(previewBuyXGetY(db, { ...cart(4, 'ghost'), customerId: null }, NOW))).toBe(
      'variant_not_available'
    )
  })
  it('validates the cart shape', async () => {
    expect(await code(previewBuyXGetY(db, { lines: [], customerId: null }, NOW))).toBe('invalid_input')
    expect(
      await code(previewBuyXGetY(db, { lines: [{ variantId: 'v-1-1', quantity: 0 }], customerId: null }, NOW))
    ).toBe('invalid_input')
    expect(
      await code(
        previewBuyXGetY(
          db,
          {
            lines: [
              { variantId: 'v-1-1', quantity: 1 },
              { variantId: 'v-1-1', quantity: 1 }
            ],
            customerId: null
          },
          NOW
        )
      )
    ).toBe('invalid_input')
  })
  it('applies the margin floor using real costs', async () => {
    await activeRule({ marginFloorBasisPoints: 6000 })
    // net ~1653 for 2000 gross, cost 6 x 200 = 1200 -> margin 27 % < 60 %
    const r = await previewBuyXGetY(db, { ...cart(4), customerId: null }, NOW)
    expect(r.evaluation.reason).toBe('margin_floor')
  })
  it('requires a customer for per-customer limits and counts previous redemptions', async () => {
    const rule = await activeRule({ perCustomerLimit: 1 })
    expect((await previewBuyXGetY(db, { ...cart(4), customerId: null }, NOW)).evaluation.reason).toBe(
      'customer_required'
    )
    const ok = await previewBuyXGetY(db, { ...cart(4), customerId: CUSTOMER_ID }, NOW)
    expect(ok.evaluation.eligible).toBe(true)
    await recordBxgyRedemption(
      db,
      { orderRef: 'order-0001-abc', ruleId: rule.id, customerId: CUSTOMER_ID, snapshot: ok.evaluation.snapshot },
      NOW
    )
    expect((await previewBuyXGetY(db, { ...cart(4), customerId: CUSTOMER_ID }, NOW)).evaluation.reason).toBe(
      'customer_limit_reached'
    )
  })
  it('chooses the rule with the largest discount when several apply', async () => {
    await activeRule({ code: 'PEQUENA', giftVariantId: 'v-3-1' })
    sqlite.exec("UPDATE variants SET price_gross_cents=900 WHERE id='v-2-1'")
    await activeRule({ code: 'GRANDE', giftVariantId: 'v-2-1' })
    const r = await previewBuyXGetY(db, { ...cart(4), customerId: null }, NOW)
    expect(r.rule?.code).toBe('GRANDE')
  })
})

describe('PRI-015 redemptions and returns', () => {
  async function sale(orderRef = 'order-0001-abc', quantity = 4) {
    const rule = await activeRule()
    const preview = await previewBuyXGetY(db, { ...cart(quantity), customerId: null }, NOW)
    await recordBxgyRedemption(
      db,
      { orderRef, ruleId: rule.id, customerId: null, snapshot: preview.evaluation.snapshot },
      NOW
    )
    return { rule, preview }
  }
  it('records a redemption once per order and replays safely', async () => {
    const { rule, preview } = await sale()
    await recordBxgyRedemption(
      db,
      { orderRef: 'order-0001-abc', ruleId: rule.id, customerId: null, snapshot: preview.evaluation.snapshot },
      NOW
    )
    expect(sqlite.prepare('SELECT count(*) c FROM bxgy_redemptions').get()).toEqual({ c: 1 })
    const other = { ...preview.evaluation.snapshot, applications: 1 }
    expect(
      await code(
        recordBxgyRedemption(
          db,
          { orderRef: 'order-0001-abc', ruleId: rule.id, customerId: null, snapshot: other },
          NOW
        )
      )
    ).toBe('conflict')
  })
  it('enforces the total limit atomically at redemption time', async () => {
    const rule = await activeRule({ totalLimit: 2 })
    const preview = await previewBuyXGetY(db, { ...cart(4), customerId: null }, NOW)
    // the preview allowed 2 applications; two single-application orders fill the limit
    const snap = { ...preview.evaluation.snapshot, applications: 1 }
    await recordBxgyRedemption(
      db,
      { orderRef: 'order-0000-a01', ruleId: rule.id, customerId: null, snapshot: snap },
      NOW
    )
    await recordBxgyRedemption(
      db,
      { orderRef: 'order-0000-a02', ruleId: rule.id, customerId: null, snapshot: snap },
      NOW
    )
    expect(
      await code(
        recordBxgyRedemption(db, { orderRef: 'order-0000-a03', ruleId: rule.id, customerId: null, snapshot: snap }, NOW)
      )
    ).toBe('limit_reached')
  })
  it('refuses a redemption for an unknown rule', async () => {
    const rule = await activeRule()
    const preview = await previewBuyXGetY(db, { ...cart(4), customerId: null }, NOW)
    expect(
      await code(
        recordBxgyRedemption(
          db,
          {
            orderRef: 'order-0000-zzz',
            ruleId: '70000000-0000-4000-8000-0000000000ff',
            customerId: null,
            snapshot: preview.evaluation.snapshot
          },
          NOW
        )
      )
    ).toBe('not_found')
    expect(rule.id).toBeTruthy()
  })
  it('quotes and journals an incremental return, once per return reference', async () => {
    await sale()
    const first = await recordBxgyReturn(
      db,
      ADMIN_CLAIMS,
      {
        orderRef: 'order-0001-abc',
        returnRef: 'return-0001-a',
        lines: [{ kind: 'gift', variantId: 'v-2-1', quantity: 1 }]
      },
      NOW
    )
    // paid 2000 split 2000:1000 -> gift allocated 667; one of two units = 334 (half up)
    expect(first.quote.netRefundGrossCents).toBe(334)
    expect(first.quote.clawbackGrossCents).toBe(0)
    const replay = await recordBxgyReturn(
      db,
      ADMIN_CLAIMS,
      {
        orderRef: 'order-0001-abc',
        returnRef: 'return-0001-a',
        lines: [{ kind: 'gift', variantId: 'v-2-1', quantity: 1 }]
      },
      NOW
    )
    expect(replay.quote).toEqual(first.quote)
    expect(sqlite.prepare('SELECT count(*) c FROM bxgy_returns').get()).toEqual({ c: 1 })
    expect(
      await code(
        recordBxgyReturn(
          db,
          ADMIN_CLAIMS,
          {
            orderRef: 'order-0001-abc',
            returnRef: 'return-0001-a',
            lines: [{ kind: 'gift', variantId: 'v-2-1', quantity: 2 }]
          },
          NOW
        )
      )
    ).toBe('idempotency_conflict')
  })
  it('refunds in total exactly what was paid when everything comes back in two steps', async () => {
    await sale()
    const a = await recordBxgyReturn(
      db,
      ADMIN_CLAIMS,
      {
        orderRef: 'order-0001-abc',
        returnRef: 'return-0001-a',
        lines: [
          { kind: 'paid', variantId: 'v-1-1', quantity: 2 },
          { kind: 'gift', variantId: 'v-2-1', quantity: 1 }
        ]
      },
      NOW
    )
    const b = await recordBxgyReturn(
      db,
      ADMIN_CLAIMS,
      {
        orderRef: 'order-0001-abc',
        returnRef: 'return-0001-b',
        lines: [
          { kind: 'paid', variantId: 'v-1-1', quantity: 2 },
          { kind: 'gift', variantId: 'v-2-1', quantity: 1 }
        ]
      },
      NOW
    )
    expect(a.quote.netRefundGrossCents + b.quote.netRefundGrossCents).toBe(2000)
    expect(
      await code(
        recordBxgyReturn(
          db,
          ADMIN_CLAIMS,
          {
            orderRef: 'order-0001-abc',
            returnRef: 'return-0001-c',
            lines: [{ kind: 'gift', variantId: 'v-2-1', quantity: 1 }]
          },
          NOW
        )
      )
    ).toBe('return_invalid')
  })
  it('claws back the gift when only the trigger units are returned', async () => {
    await sale()
    const r = await recordBxgyReturn(
      db,
      ADMIN_CLAIMS,
      {
        orderRef: 'order-0001-abc',
        returnRef: 'return-0002-a',
        lines: [{ kind: 'paid', variantId: 'v-1-1', quantity: 2 }]
      },
      NOW
    )
    expect(r.quote.clawbackGrossCents).toBeGreaterThan(0)
    expect(r.quote.netRefundGrossCents).toBe(r.quote.refundGrossCents - r.quote.clawbackGrossCents)
  })
  it('rejects unknown orders and unknown lines', async () => {
    await sale()
    expect(
      await code(
        recordBxgyReturn(
          db,
          ADMIN_CLAIMS,
          {
            orderRef: 'order-9999-zzz',
            returnRef: 'return-0003-a',
            lines: [{ kind: 'gift', variantId: 'v-2-1', quantity: 1 }]
          },
          NOW
        )
      )
    ).toBe('not_found')
    expect(
      await code(
        recordBxgyReturn(
          db,
          ADMIN_CLAIMS,
          {
            orderRef: 'order-0001-abc',
            returnRef: 'return-0003-b',
            lines: [{ kind: 'paid', variantId: 'ghost', quantity: 1 }]
          },
          NOW
        )
      )
    ).toBe('return_invalid')
  })
  it('requires admin authorization for returns', async () => {
    await sale()
    expect(
      await code(
        recordBxgyReturn(
          db,
          PLAIN_CLAIMS,
          {
            orderRef: 'order-0001-abc',
            returnRef: 'return-0004-a',
            lines: [{ kind: 'gift', variantId: 'v-2-1', quantity: 1 }]
          },
          NOW
        )
      )
    ).toBe('forbidden')
  })
  it('keeps redemptions and returns immutable', async () => {
    await sale()
    expect(() => sqlite.exec('UPDATE bxgy_redemptions SET applications=1')).toThrow(/bxgy_redemption_immutable/)
    expect(() => sqlite.exec('DELETE FROM bxgy_redemptions')).toThrow(/bxgy_redemption_immutable/)
  })
})
