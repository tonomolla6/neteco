import { describe, expect, it } from 'vitest'
import { pricingFixture, CLAIMS, BUYER_CLAIMS, OTHER_CLAIMS, key, utc } from './d1-pricing-fixture'
import {
  createFreeShippingRule,
  listFreeShippingRules,
  setFreeShippingRuleStatus,
  simulateFreeShipping,
  updateFreeShippingRule
} from '../../workers/pricing/free-shipping'
import { mapShippingOptions, type RateRow } from '../../workers/catalog/shipping'
import { freeShippingGuard, type FreeShippingRule } from '../../shared/free-shipping-policy'

const rule = (over: Record<string, unknown> = {}) => ({
  code: 'PARCEL-PEN',
  profile: 'parcel',
  zone: 'peninsular',
  customerProfile: 'any',
  thresholdGrossCents: 15000,
  minMarginBasisPoints: 1500,
  consciousSubsidy: false,
  subsidyCapNetCents: null,
  subsidyReason: null,
  ...over
})
async function world() {
  const f = await pricingFixture()
  const now = utc(-60000)
  f.sqlite.exec(`
    UPDATE variants SET cost_net_cents = 100;
    INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at)
      VALUES('pen-zone','peninsular','Peninsula','parcel_peninsular','["peninsular"]',1,'${now}');
    INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at)
      VALUES('pen-parcel','pen-zone','parcel','parcel',600,2100,1,3,1,1,'${now}'),
        ('pen-pallet','pen-zone','parcel','pallet',9000,2100,2,5,1,1,'${now}');
  `)
  return f
}
async function activate(f: Awaited<ReturnType<typeof world>>, over: Record<string, unknown> = {}) {
  const r = await createFreeShippingRule(f.database, CLAIMS, rule(over), key(), utc())
  await setFreeShippingRuleStatus(f.database, CLAIMS, r.targetId, 'active', 1, key(), utc())
  return r.targetId
}
const sim = (f: Awaited<ReturnType<typeof world>>, over: Record<string, unknown> = {}) =>
  simulateFreeShipping(
    f.database,
    CLAIMS,
    { lines: [{ variantId: 'v-1-1', quantity: 40 }], postalCode: '28001', customerProfile: 'consumer', ...over },
    utc()
  )

describe('free shipping rules (admin, PRI-017)', () => {
  it('creates, replays, audits and lists rules; admin only', async () => {
    const f = await world()
    const k = key()
    const a = await createFreeShippingRule(f.database, CLAIMS, rule(), k, utc())
    expect(await createFreeShippingRule(f.database, CLAIMS, rule(), k, utc())).toEqual(a)
    expect(f.sqlite.prepare('SELECT count(*) c FROM free_shipping_rules').get()).toEqual({ c: 1 })
    expect(f.sqlite.prepare("SELECT action FROM pricing_audit WHERE domain='free_shipping'").all()).toEqual([
      { action: 'create' }
    ])
    expect(await listFreeShippingRules(f.database, CLAIMS, utc())).toHaveLength(1)
    await expect(
      createFreeShippingRule(f.database, OTHER_CLAIMS, rule({ code: 'ZZZ' }), key(), utc())
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      createFreeShippingRule(f.database, BUYER_CLAIMS, rule({ code: 'ZZZ' }), key(), utc())
    ).rejects.toMatchObject({ code: expect.stringMatching(/forbidden|mfa_required/) })
  })
  it('rejects implicit subsidies of pallet, ADR and remote zones', async () => {
    const f = await world()
    for (const over of [{ profile: 'pallet' }, { profile: 'adr' }, { zone: 'remote' }])
      await expect(createFreeShippingRule(f.database, CLAIMS, rule(over), key(), utc())).rejects.toMatchObject({
        code: 'invalid_input'
      })
    const conscious = rule({
      profile: 'pallet',
      code: 'PALLET-OK',
      consciousSubsidy: true,
      subsidyCapNetCents: 9000,
      subsidyReason: 'Contrato anual con cliente estrategico'
    })
    expect((await createFreeShippingRule(f.database, CLAIMS, conscious, key(), utc())).appliedVersion).toBe(1)
  })
  it('the database also refuses an unconscious pallet subsidy', async () => {
    const f = await world()
    expect(() =>
      f.sqlite
        .exec(`INSERT INTO free_shipping_rules(id,code,status,version,profile,zone,customer_profile,threshold_gross_cents,min_margin_basis_points,conscious_subsidy,created_at,updated_at,updated_by)
        VALUES('${crypto.randomUUID()}','HACK-1','active',1,'pallet','peninsular','any',0,0,0,'${utc()}','${utc()}','${CLAIMS.identityId}')`)
    ).toThrow(/CHECK/)
  })
  it('update is compare-and-set and only one rule can be active per profile/zone/customer', async () => {
    const f = await world()
    const id = await activate(f)
    await expect(
      updateFreeShippingRule(f.database, CLAIMS, id, rule({ thresholdGrossCents: 20000 }), 1, key(), utc())
    ).rejects.toMatchObject({ code: 'version_conflict' })
    expect(
      (await updateFreeShippingRule(f.database, CLAIMS, id, rule({ thresholdGrossCents: 20000 }), 2, key(), utc()))
        .appliedVersion
    ).toBe(3)
    const other = await createFreeShippingRule(f.database, CLAIMS, rule({ code: 'DUP-1' }), key(), utc())
    await expect(
      setFreeShippingRuleStatus(f.database, CLAIMS, other.targetId, 'active', 1, key(), utc())
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      setFreeShippingRuleStatus(f.database, CLAIMS, other.targetId, 'paused', 1, key(), utc())
    ).rejects.toMatchObject({ code: 'invalid_transition' })
  })
})

describe('free shipping simulation (server facts only)', () => {
  it('grants when threshold and margin hold and reports the subsidy', async () => {
    const f = await world()
    await activate(f)
    const r = await sim(f)
    expect(r).toMatchObject({
      free: true,
      reason: 'granted',
      zone: 'peninsular',
      profile: 'parcel',
      goodsGrossCents: 20000,
      shippingNetCents: 600,
      subsidyNetCents: 600
    })
  })
  it('denies below the threshold, with unknown cost and below the margin floor', async () => {
    const f = await world()
    await activate(f)
    expect((await sim(f, { lines: [{ variantId: 'v-1-1', quantity: 29 }] })).reason).toBe('below_threshold')
    f.sqlite.exec('UPDATE variants SET cost_net_cents = 350')
    expect((await sim(f)).reason).toBe('margin_floor') // 16529 - 14000 - 600 = 1929 (11.7 %) < 15 %
    f.sqlite.exec('UPDATE variants SET cost_net_cents = NULL')
    expect((await sim(f)).reason).toBe('cost_unknown')
  })
  it('no rule, no subsidy; remote destinations are never subsidised implicitly', async () => {
    const f = await world()
    expect((await sim(f)).reason).toBe('no_rule')
    await activate(f)
    expect((await sim(f, { postalCode: '07001' })).reason).toBe('no_rule')
  })
  it('pallet baskets (heavy) do not ride a parcel rule', async () => {
    const f = await world()
    await activate(f)
    f.sqlite.exec('UPDATE variants SET weight_grams = 1000') // 40 kg -> pallet profile
    const r = await sim(f)
    expect(r.free).toBe(false)
    expect(r.profile).toBe('pallet')
    expect(r.reason).toMatch(/no_rule|not_subsidised/)
  })
  it('requires admin authorization and strict input', async () => {
    const f = await world()
    await expect(
      simulateFreeShipping(
        f.database,
        OTHER_CLAIMS,
        { lines: [{ variantId: 'v-1-1', quantity: 1 }], postalCode: '28001', customerProfile: 'consumer' },
        utc()
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(sim(f, { postalCode: 'abc' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(sim(f, { shippingNetCents: 0 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(sim(f, { lines: [{ variantId: 'ghost', quantity: 1 }] })).rejects.toMatchObject({
      code: 'variant_not_available'
    })
  })
})

describe('checkout shipping guard', () => {
  const lines = [{ quantity: 40, weightGrams: 100, published: 1, profileKind: 'parcel' }]
  const rates: RateRow[] = [
    {
      method_code: 'parcel',
      service_profile: 'parcel',
      zone_code: 'peninsular',
      net_cents: 600,
      tax_rate_basis_points: 2100,
      eta_min_days: 1,
      eta_max_days: 3,
      rate_version: 1,
      prefixes_json: '["peninsular"]'
    }
  ]
  const destination = { city: 'Madrid', postalCode: '28001' }
  const base: FreeShippingRule = {
    id: 'r',
    code: 'R',
    status: 'active',
    version: 1,
    profile: 'parcel',
    zone: 'peninsular',
    customerProfile: 'any',
    thresholdGrossCents: 15000,
    minMarginBasisPoints: 1500,
    consciousSubsidy: false,
    subsidyCapNetCents: null,
    subsidyReason: null
  }
  const facts = {
    zone: 'peninsular' as const,
    customerProfile: 'consumer' as const,
    goodsGrossCents: 20000,
    goodsNetCents: 16529,
    goodsCostNetCents: 4000
  }
  it('legacy behaviour is unchanged without a guard', () => {
    expect(mapShippingOptions(lines, rates, destination, { threshold: 15000, goodsGross: 20000 })[0]!.netCents).toBe(0)
  })
  it('the guard keeps the paid rate when free shipping would break the margin floor', () => {
    const ok = mapShippingOptions(lines, rates, destination, {
      threshold: 15000,
      goodsGross: 20000,
      allowFree: freeShippingGuard(base, facts)
    })
    expect(ok[0]!.netCents).toBe(0)
    const tight = mapShippingOptions(lines, rates, destination, {
      threshold: 15000,
      goodsGross: 20000,
      allowFree: freeShippingGuard(base, { ...facts, goodsCostNetCents: 15500 })
    })
    expect(tight[0]!.netCents).toBe(600)
    expect(tight[0]!.grossCents).toBe(726)
    const noRule = mapShippingOptions(lines, rates, destination, {
      threshold: 15000,
      goodsGross: 20000,
      allowFree: freeShippingGuard(null, facts)
    })
    expect(noRule[0]!.netCents).toBe(600)
  })
})
