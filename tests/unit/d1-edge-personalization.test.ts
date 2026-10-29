import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ADMIN,
  NOMFA,
  NOPERMS,
  NOW,
  OTHER_ADMIN,
  setupPerformanceInsightsDb,
  uuid
} from './performance-insights-fixture'
import {
  createD1EdgeRule,
  disableD1EdgeRule,
  enableD1EdgeRule,
  listD1EdgeRules,
  recordD1EdgeEvidence,
  resolveD1EdgePersonalization
} from '../../workers/performance/edge-personalization'

let sqlite: DatabaseSync
let db: D1Database
beforeEach(async () => {
  ;({ sqlite, db } = await setupPerformanceInsightsDb())
})
afterEach(() => sqlite.close())
const opts = { now: NOW }
const expectCode = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code })

const create = (over: Record<string, unknown> = {}, claims = ADMIN) =>
  createD1EdgeRule(
    db,
    claims,
    {
      commandId: uuid(),
      idempotencyKey: uuid(),
      slot: 'home_hero',
      segment: 'b2b',
      variantKey: 'bulk_offer',
      ...over
    } as never,
    opts
  )
const good = {
  controlVisitors: 5000,
  controlConversions: 100,
  treatmentVisitors: 5000,
  treatmentConversions: 150,
  lcpDeltaMs: 10,
  cacheHitRateBps: 9000,
  baselineCacheHitRateBps: 9100
}
const evidence = (ruleId: string, over: Record<string, unknown> = {}, claims = ADMIN) =>
  recordD1EdgeEvidence(
    db,
    claims,
    { commandId: uuid(), idempotencyKey: uuid(), ruleId, ...good, ...over } as never,
    opts
  )
const enable = (rule: { id: string; version: number }, claims = ADMIN) =>
  enableD1EdgeRule(
    db,
    claims,
    { commandId: uuid(), idempotencyKey: uuid(), ruleId: rule.id, expectedVersion: rule.version } as never,
    opts
  )
const disable = (rule: { id: string; version: number }, claims = ADMIN) =>
  disableD1EdgeRule(
    db,
    claims,
    { commandId: uuid(), idempotencyKey: uuid(), ruleId: rule.id, expectedVersion: rule.version } as never,
    opts
  )
const resolve = (over: Record<string, unknown> = {}) =>
  resolveD1EdgePersonalization(db, {
    slot: 'home_hero',
    isB2b: true,
    returning: false,
    consent: true,
    ...over
  } as never)

describe('rule lifecycle', () => {
  it('creates a draft rule, idempotently, one per slot+segment', async () => {
    const input = {
      commandId: uuid(),
      idempotencyKey: 'r1',
      slot: 'home_hero',
      segment: 'b2b',
      variantKey: 'bulk_offer'
    }
    const a = await createD1EdgeRule(db, ADMIN, input as never, opts)
    expect(a).toMatchObject({ status: 'draft', version: 1, evidenceId: null })
    expect(await createD1EdgeRule(db, ADMIN, { ...input, commandId: uuid() } as never, opts)).toEqual(a)
    await expectCode(create(), 'conflict')
    await create({ segment: 'b2c_new' })
    expect(await listD1EdgeRules(db)).toHaveLength(2)
  })

  it('refuses to enable a rule with no evidence', async () => {
    const rule = await create()
    await expectCode(enable(rule), 'evidence_required')
    expect(sqlite.prepare('SELECT status FROM edge_personalization_rules').get()).toEqual({ status: 'draft' })
  })

  it('refuses to enable on weak evidence and lists the reasons', async () => {
    const rule = await create()
    await evidence(rule.id, { treatmentVisitors: 200, treatmentConversions: 10 })
    await expect(enable(rule)).rejects.toMatchObject({
      code: 'evidence_insufficient',
      message: expect.stringContaining('insufficient_sample')
    })
  })

  it('refuses when personalisation would hurt caching or LCP', async () => {
    const rule = await create()
    await evidence(rule.id, { cacheHitRateBps: 6000 })
    await expect(enable(rule)).rejects.toMatchObject({ code: 'evidence_insufficient' })
    await evidence(rule.id, { lcpDeltaMs: 300 })
    await expect(enable(rule)).rejects.toMatchObject({
      code: 'evidence_insufficient',
      message: expect.stringContaining('lcp_regression')
    })
  })

  it('enables with proven value, recording the evidence id; newest evidence decides', async () => {
    const rule = await create()
    await evidence(rule.id, { lcpDeltaMs: 300 })
    const ev = await evidence(rule.id)
    const enabled = await enable(rule)
    expect(enabled).toMatchObject({ status: 'enabled', version: 2, evidenceId: ev.id })
  })

  it('disables an enabled rule, can re-enable only with fresh passing evidence, and CAS applies', async () => {
    const rule = await create()
    await evidence(rule.id)
    const enabled = await enable(rule)
    await expectCode(enable(rule), 'concurrency_conflict')
    await expectCode(enable(enabled), 'already_enabled')
    const off = await disable(enabled)
    expect(off).toMatchObject({ status: 'disabled', version: 3 })
    await expectCode(disable(off), 'not_enabled')
    expect(await enable(off)).toMatchObject({ status: 'enabled', version: 4 })
  })

  it('serialises concurrent enables', async () => {
    const rule = await create()
    await evidence(rule.id)
    const results = await Promise.allSettled([enable(rule), enable(rule, OTHER_ADMIN)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  })

  it('enforces authorisation on every mutation and rejects unknown rules', async () => {
    await expectCode(create({}, NOPERMS), 'forbidden')
    await expectCode(create({}, NOMFA), 'mfa_required')
    const rule = await create()
    await expectCode(evidence(rule.id, {}, NOPERMS), 'forbidden')
    await expectCode(evidence(uuid()), 'not_found')
    await expectCode(enable({ id: uuid(), version: 1 }), 'not_found')
    await expectCode(create({ segment: 'vip' }), 'invalid_input')
  })

  it('evidence is append-only and the database refuses enabled rules without evidence', async () => {
    const rule = await create()
    await evidence(rule.id)
    expect(() => sqlite.exec(`DELETE FROM edge_personalization_evidence`)).toThrow(/immutable/)
    expect(() => sqlite.exec(`UPDATE edge_personalization_rules SET status = 'enabled'`)).toThrow()
  })

  it('rejects impossible evidence counts', async () => {
    const rule = await create()
    await expectCode(evidence(rule.id, { treatmentConversions: 6000 }), 'invalid_evidence')
  })
})

describe('runtime resolution', () => {
  async function enabledRule() {
    const rule = await create()
    await evidence(rule.id)
    return enable(rule)
  }

  it('personalises only enabled rules and only with consent', async () => {
    await enabledRule()
    expect(await resolve()).toMatchObject({ variant: 'bulk_offer', personalized: true, cacheVariant: 'b2b' })
    expect(await resolve({ consent: false })).toMatchObject({ variant: 'default', reason: 'no_consent' })
    expect(await resolve({ isB2b: false })).toMatchObject({ variant: 'default', reason: 'no_rule' })
    expect(await resolve({ slot: 'checkout_banner' })).toMatchObject({ reason: 'no_rule' })
  })

  it('is deterministic and falls back after disabling or with the kill switch', async () => {
    const rule = await enabledRule()
    expect(await resolve()).toEqual(await resolve())
    expect(await resolve({ killSwitch: true })).toMatchObject({ variant: 'default', reason: 'kill_switch' })
    await disable(rule)
    expect(await resolve()).toMatchObject({ variant: 'default', reason: 'no_rule' })
  })

  it('falls back to the default when the database fails', async () => {
    await enabledRule()
    sqlite.exec('DROP TABLE edge_personalization_evidence')
    sqlite.exec('DROP TABLE edge_personalization_rules')
    expect(await resolve()).toMatchObject({ variant: 'default', personalized: false, reason: 'error_fallback' })
  })

  it('rejects malformed runtime input by falling back rather than throwing', async () => {
    expect(await resolve({ slot: 'Not A Slot!' })).toMatchObject({ variant: 'default', reason: 'error_fallback' })
  })
})
