import { describe, expect, it } from 'vitest'
import {
  classifyShippingZone,
  decideFreeShipping,
  freeShippingRuleInputSchema,
  type FreeShippingContext,
  type FreeShippingRule
} from '../../shared/free-shipping-policy'

const rule = (over: Partial<FreeShippingRule> = {}): FreeShippingRule => ({
  id: 'r1',
  code: 'PARCEL',
  status: 'active',
  version: 1,
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
const ctx = (over: Partial<FreeShippingContext> = {}): FreeShippingContext => ({
  profile: 'parcel',
  zone: 'peninsular',
  customerProfile: 'consumer',
  goodsGrossCents: 20000,
  goodsNetCents: 16529,
  goodsCostNetCents: 10000,
  shippingNetCents: 600,
  ...over
})

describe('free shipping policy (PRI-017)', () => {
  it('grants free shipping when threshold, zone, profile and margin all hold', () => {
    expect(decideFreeShipping(rule(), ctx())).toEqual({ free: true, reason: 'granted', subsidyNetCents: 600 })
  })
  it('denies below the threshold and exactly one cent below', () => {
    expect(decideFreeShipping(rule(), ctx({ goodsGrossCents: 14999 })).reason).toBe('below_threshold')
    expect(decideFreeShipping(rule(), ctx({ goodsGrossCents: 15000 })).free).toBe(true)
  })
  it('denies when absorbing the shipping cost would break the margin floor', () => {
    // margin after shipping = 16529-10000-600 = 5929 -> 35.9 %; raise the floor to 40 %
    expect(decideFreeShipping(rule({ minMarginBasisPoints: 4000 }), ctx()).reason).toBe('margin_floor')
    // exact boundary: margin 5929 over net 16529 is >= 3587 bp
    expect(decideFreeShipping(rule({ minMarginBasisPoints: 3587 }), ctx()).free).toBe(true)
    expect(decideFreeShipping(rule({ minMarginBasisPoints: 3588 }), ctx()).reason).toBe('margin_floor')
  })
  it('fails closed when the goods cost is unknown', () => {
    expect(decideFreeShipping(rule(), ctx({ goodsCostNetCents: null })).reason).toBe('cost_unknown')
  })
  it('never subsidises pallet, ADR or remote without a conscious rule', () => {
    for (const over of [{ profile: 'pallet' }, { profile: 'adr' }, { zone: 'remote' }] as const) {
      const r = rule({ ...over } as Partial<FreeShippingRule>)
      expect(decideFreeShipping(r, ctx({ ...over } as Partial<FreeShippingContext>)).reason).toBe('not_subsidised')
    }
  })
  it('a conscious rule subsidises pallet up to its cap only', () => {
    const conscious = rule({
      profile: 'pallet',
      consciousSubsidy: true,
      subsidyCapNetCents: 5000,
      subsidyReason: 'Cliente estrategico con contrato anual firmado',
      minMarginBasisPoints: 0
    })
    expect(decideFreeShipping(conscious, ctx({ profile: 'pallet', shippingNetCents: 5000 })).free).toBe(true)
    expect(decideFreeShipping(conscious, ctx({ profile: 'pallet', shippingNetCents: 5001 })).reason).toBe('subsidy_cap')
  })
  it('does not match another profile, zone or customer profile, nor inactive rules', () => {
    expect(decideFreeShipping(rule(), ctx({ zone: 'local' })).reason).toBe('rule_mismatch')
    expect(decideFreeShipping(rule({ customerProfile: 'company' }), ctx()).reason).toBe('rule_mismatch')
    expect(decideFreeShipping(rule({ status: 'paused' }), ctx()).reason).toBe('inactive')
    expect(decideFreeShipping(null, ctx()).reason).toBe('no_rule')
  })
  it('classifies zones from the postal code using configured own-delivery prefixes', () => {
    expect(classifyShippingZone('46870', ['468'])).toBe('local')
    expect(classifyShippingZone('28001', ['468'])).toBe('peninsular')
    expect(classifyShippingZone('07001', ['468'])).toBe('remote')
    expect(classifyShippingZone('35001', [])).toBe('remote')
    expect(classifyShippingZone('abc', [])).toBe('remote')
  })
  it('validates rules: conscious subsidy needs cap and reason; implicit subsidy is impossible', () => {
    const base = {
      code: 'ABC',
      profile: 'parcel',
      zone: 'peninsular',
      customerProfile: 'any',
      thresholdGrossCents: 100,
      minMarginBasisPoints: 0,
      consciousSubsidy: false,
      subsidyCapNetCents: null,
      subsidyReason: null
    }
    expect(freeShippingRuleInputSchema.safeParse(base).success).toBe(true)
    expect(freeShippingRuleInputSchema.safeParse({ ...base, profile: 'pallet' }).success).toBe(false)
    expect(freeShippingRuleInputSchema.safeParse({ ...base, zone: 'remote' }).success).toBe(false)
    expect(freeShippingRuleInputSchema.safeParse({ ...base, profile: 'adr', consciousSubsidy: true }).success).toBe(
      false
    )
    expect(
      freeShippingRuleInputSchema.safeParse({
        ...base,
        profile: 'adr',
        consciousSubsidy: true,
        subsidyCapNetCents: 100,
        subsidyReason: 'corto'
      }).success
    ).toBe(false)
    expect(
      freeShippingRuleInputSchema.safeParse({
        ...base,
        profile: 'adr',
        consciousSubsidy: true,
        subsidyCapNetCents: 100,
        subsidyReason: 'Motivo comercial documentado y aprobado'
      }).success
    ).toBe(true)
    expect(freeShippingRuleInputSchema.safeParse({ ...base, thresholdGrossCents: 1.5 }).success).toBe(false)
  })
})
