import { describe, expect, it } from 'vitest'
import { pricingFixture, CLAIMS, BUYER_CLAIMS, OTHER_CLAIMS, key, utc } from './d1-pricing-fixture'
import {
  createAutoDiscountRule,
  listAutoDiscountRules,
  previewAutoDiscounts,
  setAutoDiscountRuleStatus,
  updateAutoDiscountRule
} from '../../workers/pricing/auto-discounts'
import { testUuid } from '../support/deterministic'

const input = (over: Record<string, unknown> = {}) => ({
  code: 'CAT-10',
  name: 'Diez por ciento en categoria',
  kind: 'category',
  scopeIds: ['c1'],
  benefit: { kind: 'percent', basisPoints: 1000 },
  minBasketGrossCents: 0,
  priority: 10,
  stacking: 'exclusive',
  segment: 'all',
  marginFloorBasisPoints: 1000,
  customerMessage: 'Descuento del 10% en limpieza',
  startsAt: utc(-3_600_000),
  endsAt: null,
  ...over
})
async function world() {
  const f = await pricingFixture()
  f.sqlite.exec('UPDATE variants SET cost_net_cents = 100')
  return f
}
async function activeRule(f: Awaited<ReturnType<typeof world>>, over: Record<string, unknown> = {}, id?: string) {
  const r = await createAutoDiscountRule(f.database, CLAIMS, input(over), key(), utc())
  await setAutoDiscountRuleStatus(f.database, CLAIMS, r.targetId, 'active', 1, key(), utc())
  return id ?? r.targetId
}
const preview = (f: Awaited<ReturnType<typeof world>>, lines: unknown, claims = null as typeof CLAIMS | null) =>
  previewAutoDiscounts(f.database, claims, { lines }, utc())

describe('auto discount rules (admin, PRI-014)', () => {
  it('creates a draft rule with version 1, an audit row and an idempotent replay', async () => {
    const f = await world()
    const k = key()
    const a = await createAutoDiscountRule(f.database, CLAIMS, input(), k, utc())
    const b = await createAutoDiscountRule(f.database, CLAIMS, input(), k, utc())
    expect(b).toEqual(a)
    expect(a.appliedVersion).toBe(1)
    expect(f.sqlite.prepare('SELECT count(*) c FROM auto_discount_rules').get()).toEqual({ c: 1 })
    expect(f.sqlite.prepare("SELECT outcome, action FROM pricing_audit WHERE domain='auto_discount'").all()).toEqual([
      { outcome: 'applied', action: 'create' }
    ])
    const [row] = (await listAutoDiscountRules(f.database, CLAIMS, utc())) as Array<Record<string, unknown>>
    expect(row).toMatchObject({ code: 'CAT-10', status: 'draft', version: 1, priority: 10 })
  })
  it('same key with a different payload is an idempotency conflict; duplicate code is a conflict', async () => {
    const f = await world()
    const k = key()
    await createAutoDiscountRule(f.database, CLAIMS, input(), k, utc())
    await expect(createAutoDiscountRule(f.database, CLAIMS, input({ priority: 11 }), k, utc())).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
    await expect(createAutoDiscountRule(f.database, CLAIMS, input(), key(), utc())).rejects.toMatchObject({
      code: 'conflict'
    })
  })
  it('requires live administrative authorization and valid input', async () => {
    const f = await world()
    for (const claims of [BUYER_CLAIMS, OTHER_CLAIMS, { ...CLAIMS, sessionVersion: 2 }])
      await expect(createAutoDiscountRule(f.database, claims, input(), key(), utc())).rejects.toMatchObject({
        code: expect.stringMatching(/forbidden|unauthenticated|mfa_required/)
      })
    await expect(
      createAutoDiscountRule(f.database, CLAIMS, input({ benefit: { kind: 'percent', basisPoints: 0 } }), key(), utc())
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(createAutoDiscountRule(f.database, CLAIMS, input(), 'short', utc())).rejects.toMatchObject({
      code: 'invalid_input'
    })
    await expect(listAutoDiscountRules(f.database, OTHER_CLAIMS, utc())).rejects.toMatchObject({ code: 'forbidden' })
    f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified = 0 WHERE id = ?').run(CLAIMS.sessionId)
    await expect(createAutoDiscountRule(f.database, CLAIMS, input(), key(), utc())).rejects.toMatchObject({
      code: 'mfa_required'
    })
  })
  it('update is compare-and-set; stale versions and code changes are rejected', async () => {
    const f = await world()
    const r = await createAutoDiscountRule(f.database, CLAIMS, input(), key(), utc())
    const u = await updateAutoDiscountRule(f.database, CLAIMS, r.targetId, input({ priority: 20 }), 1, key(), utc())
    expect(u.appliedVersion).toBe(2)
    await expect(
      updateAutoDiscountRule(f.database, CLAIMS, r.targetId, input({ priority: 30 }), 1, key(), utc())
    ).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(
      updateAutoDiscountRule(f.database, CLAIMS, r.targetId, input({ code: 'OTHER-1' }), 2, key(), utc())
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      updateAutoDiscountRule(f.database, CLAIMS, testUuid(), input(), 1, key(), utc())
    ).rejects.toMatchObject({ code: 'not_found' })
  })
  it('concurrent updates with the same expected version: exactly one wins', async () => {
    const f = await world()
    const r = await createAutoDiscountRule(f.database, CLAIMS, input(), key(), utc())
    const results = await Promise.allSettled(
      [21, 22, 23].map((priority) =>
        updateAutoDiscountRule(f.database, CLAIMS, r.targetId, input({ priority }), 1, key(), utc())
      )
    )
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(f.sqlite.prepare('SELECT version FROM auto_discount_rules').get()).toEqual({ version: 2 })
    expect(f.sqlite.prepare("SELECT count(*) c FROM pricing_commands WHERE domain='auto_discount'").get()).toEqual({
      c: 2
    })
  })
  it('status machine: draft->active->paused->archived, archived is terminal', async () => {
    const f = await world()
    const r = await createAutoDiscountRule(f.database, CLAIMS, input(), key(), utc())
    await expect(
      setAutoDiscountRuleStatus(f.database, CLAIMS, r.targetId, 'paused', 1, key(), utc())
    ).rejects.toMatchObject({ code: 'invalid_transition' })
    await setAutoDiscountRuleStatus(f.database, CLAIMS, r.targetId, 'active', 1, key(), utc())
    await setAutoDiscountRuleStatus(f.database, CLAIMS, r.targetId, 'paused', 2, key(), utc())
    await setAutoDiscountRuleStatus(f.database, CLAIMS, r.targetId, 'archived', 3, key(), utc())
    await expect(
      setAutoDiscountRuleStatus(f.database, CLAIMS, r.targetId, 'active', 4, key(), utc())
    ).rejects.toMatchObject({ code: 'invalid_transition' })
    await expect(
      updateAutoDiscountRule(f.database, CLAIMS, r.targetId, input(), 4, key(), utc())
    ).rejects.toMatchObject({ code: 'invalid_transition' })
  })
  it('the audit trail and command journal are append-only', async () => {
    const f = await world()
    await createAutoDiscountRule(f.database, CLAIMS, input(), key(), utc())
    expect(() => f.sqlite.exec("UPDATE pricing_audit SET action = 'x'")).toThrow(/immutable/)
    expect(() => f.sqlite.exec('DELETE FROM pricing_audit')).toThrow(/immutable/)
    expect(() => f.sqlite.exec('DELETE FROM pricing_commands')).toThrow(/immutable/)
    expect(() => f.sqlite.exec('DELETE FROM auto_discount_rules')).toThrow(/immutable/)
  })
})

describe('auto discount preview (customer, server-priced)', () => {
  it('applies an active rule using server prices and explains it without leaking cost', async () => {
    const f = await world()
    await activeRule(f)
    const r = await preview(f, [{ variantId: 'v-1-1', quantity: 2 }])
    expect(r.totals.discountGrossCents).toBe(100) // 2 x 500 gross, 10 %
    expect(r.explanations).toEqual([{ message: 'Descuento del 10% en limpieza', discountGrossCents: 100 }])
    expect(r.lines[0]).toMatchObject({ variantId: 'v-1-1', quantity: 2, unitGrossCents: 500, discountGrossCents: 100 })
    expect(JSON.stringify(r)).not.toMatch(/cost|margin|priority|CAT-10/i)
  })
  it('does not apply paused, expired or not-yet-active rules', async () => {
    const f = await world()
    const id = await activeRule(f)
    await setAutoDiscountRuleStatus(f.database, CLAIMS, id, 'paused', 2, key(), utc())
    expect((await preview(f, [{ variantId: 'v-1-1', quantity: 1 }])).totals.discountGrossCents).toBe(0)
    const g = await world()
    await activeRule(g, { startsAt: utc(60_000) })
    expect((await preview(g, [{ variantId: 'v-1-1', quantity: 1 }])).totals.discountGrossCents).toBe(0)
    const h = await world()
    await activeRule(h, { startsAt: utc(-7_200_000), endsAt: utc(-3_600_000) })
    expect((await preview(h, [{ variantId: 'v-1-1', quantity: 1 }])).totals.discountGrossCents).toBe(0)
  })
  it('never goes below the margin floor and fails closed with an unknown cost', async () => {
    const f = await world()
    await activeRule(f, { marginFloorBasisPoints: 5000, benefit: { kind: 'percent', basisPoints: 9000 } })
    f.sqlite.exec('UPDATE variants SET cost_net_cents = 150')
    const r = await preview(f, [{ variantId: 'v-1-1', quantity: 1 }])
    expect(r.lines[0]!.netCents * 5000).toBeGreaterThanOrEqual(150 * 10000)
    f.sqlite.exec('UPDATE variants SET cost_net_cents = NULL')
    expect((await preview(f, [{ variantId: 'v-1-1', quantity: 1 }])).totals.discountGrossCents).toBe(0)
  })
  it('segment comes from the live session, never from the body', async () => {
    const f = await world()
    await activeRule(f, { segment: 'registered' })
    const lines = [{ variantId: 'v-1-1', quantity: 1 }]
    expect((await preview(f, lines)).totals.discountGrossCents).toBe(0)
    expect((await preview(f, lines, BUYER_CLAIMS)).totals.discountGrossCents).toBe(50)
    await expect(
      previewAutoDiscounts(f.database, null, { lines, customerId: 'x', unitGrossCents: 1 }, utc())
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('rejects bad lines and unavailable variants', async () => {
    const f = await world()
    await expect(preview(f, [])).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(preview(f, [{ variantId: 'v-1-1', quantity: 0 }])).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(preview(f, [{ variantId: 'v-1-1', quantity: 1.5 }])).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      preview(f, [
        { variantId: 'v-1-1', quantity: 1 },
        { variantId: 'v-1-1', quantity: 1 }
      ])
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(preview(f, [{ variantId: 'ghost', quantity: 1 }])).rejects.toMatchObject({
      code: 'variant_not_available'
    })
  })
})
