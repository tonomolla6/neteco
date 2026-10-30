import { describe, expect, it } from 'vitest'
import { allocateRedemption, evaluateIssuance, STORE_CREDIT_POLICY } from '../../shared/store-credit'

const at = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
const now = at()
const grant = (id: string, remainingCents: number, expiresAt: string) => ({ id, remainingCents, expiresAt })

describe('store credit pure rules (PRI-018)', () => {
  it('spends the earliest-expiring grant first and conserves cents', () => {
    const a = allocateRedemption([grant('b', 500, at(2_000_000)), grant('a', 300, at(1_000_000))], 600, now)
    expect(a).toEqual([
      { grantId: 'a', cents: 300 },
      { grantId: 'b', cents: 300 }
    ])
  })
  it('skips expired and empty grants and returns null when funds are insufficient', () => {
    const grants = [grant('old', 900, at(-1000)), grant('empty', 0, at(5_000_000)), grant('ok', 200, at(5_000_000))]
    expect(allocateRedemption(grants, 200, now)).toEqual([{ grantId: 'ok', cents: 200 }])
    expect(allocateRedemption(grants, 201, now)).toBeNull()
  })
  it('expires exactly at the expiry instant', () => {
    expect(allocateRedemption([grant('a', 100, now)], 100, now)).toBeNull()
  })
  it('rejects non-positive or non-integer amounts', () => {
    for (const bad of [0, -5, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])
      expect(() => allocateRedemption([grant('a', 100, at(1_000_000))], bad, now)).toThrow()
  })
  it('blocks single issuances above the cap', () => {
    expect(evaluateIssuance({ amountCents: STORE_CREDIT_POLICY.maxSingleIssueCents, recent: [] }).allowed).toBe(true)
    expect(evaluateIssuance({ amountCents: STORE_CREDIT_POLICY.maxSingleIssueCents + 1, recent: [] })).toEqual({
      allowed: false,
      reason: 'single_cap'
    })
  })
  it('blocks rolling-window totals and issuance velocity', () => {
    const half = STORE_CREDIT_POLICY.maxRollingIssueCents / 2
    expect(evaluateIssuance({ amountCents: 1, recent: [half, half] })).toEqual({
      allowed: false,
      reason: 'rolling_cap'
    })
    expect(evaluateIssuance({ amountCents: 1, recent: [half] }).allowed).toBe(true)
    const many = Array.from({ length: STORE_CREDIT_POLICY.maxIssuesPerWindow }, () => 1)
    expect(evaluateIssuance({ amountCents: 1, recent: many })).toEqual({ allowed: false, reason: 'velocity' })
  })
})
