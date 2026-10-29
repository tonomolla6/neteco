import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ADMIN_CLAIMS,
  NOW,
  NO_MFA_CLAIMS,
  PLAIN_CLAIMS,
  growthDatabase,
  seedGrowthIdentities
} from './d1-growth-fixture'
import {
  analyzePromoExperiment,
  assignPromoSubject,
  createPromoExperiment,
  listPromoExperiments,
  recordPromoObservation,
  transitionPromoExperiment
} from '../../workers/growth/promo-experiments'
import { GrowthError } from '../../workers/growth/common'
import type { PromoExperimentInput } from '../../shared/promo-experiments'

const INPUT: PromoExperimentInput = {
  code: 'EXP-ENVIO80',
  name: 'Envío gratis sobre 80 EUR',
  promotionCode: 'ENVIO80',
  holdoutBasisPoints: 2000,
  minSamplePerArm: 50,
  minIncrementalMarginCents: 0
}
let n = 0
const key = () => `idem-key-${++n}-xxxx`
let sqlite: DatabaseSync
let db: D1Database

beforeEach(async () => {
  const fixture = await growthDatabase()
  sqlite = fixture.sqlite
  db = fixture.db
  seedGrowthIdentities(sqlite)
})
afterEach(() => {
  if (sqlite?.isOpen) sqlite.close()
})

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof GrowthError ? e.code : `unexpected:${String(e)}`)
  )

async function runningExperiment(patch: Partial<PromoExperimentInput> = {}) {
  const created = await createPromoExperiment(db, ADMIN_CLAIMS, { ...INPUT, ...patch }, key(), NOW)
  const started = await transitionPromoExperiment(db, ADMIN_CLAIMS, created.targetId, 'start', 1, key(), NOW)
  return { id: created.targetId, version: started.appliedVersion }
}

/** Assign `count` subjects and record one order each with margin from `marginOf(arm, i)`. */
async function populate(
  id: string,
  count: number,
  marginOf: (arm: 'holdout' | 'treatment', i: number) => { net: number; cogs: number; gross?: number }
) {
  for (let i = 0; i < count; i++) {
    const { arm } = await assignPromoSubject(db, id, `subject-${i}`, NOW)
    const m = marginOf(arm, i)
    await recordPromoObservation(
      db,
      id,
      {
        subjectKey: `subject-${i}`,
        orderRef: `order-${String(i).padStart(6, '0')}`,
        revenueGrossCents: m.gross ?? Math.round(m.net * 1.21),
        netRevenueCents: m.net,
        cogsCents: m.cogs,
        variableCostCents: 0
      },
      NOW
    )
  }
}

describe('PRI-022 experiment lifecycle', () => {
  it('creates a draft with a mandatory holdout and journals the command', async () => {
    const receipt = await createPromoExperiment(db, ADMIN_CLAIMS, INPUT, key(), NOW)
    expect(receipt).toMatchObject({ action: 'create', appliedVersion: 1 })
    expect(sqlite.prepare('SELECT status, holdout_basis_points h FROM promo_experiments').get()).toEqual({
      status: 'draft',
      h: 2000
    })
  })
  it('replays the same key and refuses the same key with a different payload', async () => {
    const k = key()
    const a = await createPromoExperiment(db, ADMIN_CLAIMS, INPUT, k, NOW)
    expect(await createPromoExperiment(db, ADMIN_CLAIMS, INPUT, k, NOW)).toEqual(a)
    expect(await code(createPromoExperiment(db, ADMIN_CLAIMS, { ...INPUT, code: 'OTRO-EXP' }, k, NOW))).toBe(
      'idempotency_conflict'
    )
  })
  it('rejects a duplicate code, invalid input and a missing holdout', async () => {
    await createPromoExperiment(db, ADMIN_CLAIMS, INPUT, key(), NOW)
    expect(await code(createPromoExperiment(db, ADMIN_CLAIMS, INPUT, key(), NOW))).toBe('conflict')
    expect(
      await code(
        createPromoExperiment(db, ADMIN_CLAIMS, { ...INPUT, code: 'SIN-HOLDOUT', holdoutBasisPoints: 0 }, key(), NOW)
      )
    ).toBe('invalid_input')
    expect(
      await code(
        createPromoExperiment(db, ADMIN_CLAIMS, { ...INPUT, code: 'POCO-HOLD', holdoutBasisPoints: 100 }, key(), NOW)
      )
    ).toBe('invalid_input')
  })
  it('enforces live admin authorization', async () => {
    expect(await code(createPromoExperiment(db, NO_MFA_CLAIMS, INPUT, key(), NOW))).toBe('mfa_required')
    expect(await code(createPromoExperiment(db, PLAIN_CLAIMS, INPUT, key(), NOW))).toBe('forbidden')
    expect(await code(listPromoExperiments(db, PLAIN_CLAIMS, NOW))).toBe('forbidden')
  })
  it('keeps the holdout immutable at storage level', async () => {
    await createPromoExperiment(db, ADMIN_CLAIMS, INPUT, key(), NOW)
    expect(() => sqlite.exec('UPDATE promo_experiments SET holdout_basis_points=500, version=2')).toThrow(
      /version_conflict/
    )
  })
  it('walks draft -> running -> stopped -> concluded with CAS versions', async () => {
    const created = await createPromoExperiment(db, ADMIN_CLAIMS, INPUT, key(), NOW)
    const id = created.targetId
    expect((await transitionPromoExperiment(db, ADMIN_CLAIMS, id, 'start', 1, key(), NOW)).appliedVersion).toBe(2)
    expect(await code(transitionPromoExperiment(db, ADMIN_CLAIMS, id, 'start', 2, key(), NOW))).toBe(
      'invalid_transition'
    )
    expect(await code(transitionPromoExperiment(db, ADMIN_CLAIMS, id, 'stop', 1, key(), NOW))).toBe('version_conflict')
    expect((await transitionPromoExperiment(db, ADMIN_CLAIMS, id, 'stop', 2, key(), NOW)).appliedVersion).toBe(3)
    expect((await transitionPromoExperiment(db, ADMIN_CLAIMS, id, 'conclude', 3, key(), NOW)).appliedVersion).toBe(4)
    expect(await code(transitionPromoExperiment(db, ADMIN_CLAIMS, id, 'stop', 4, key(), NOW))).toBe(
      'invalid_transition'
    )
  })
  it('cannot conclude a draft and cannot stop a draft', async () => {
    const { targetId } = await createPromoExperiment(db, ADMIN_CLAIMS, INPUT, key(), NOW)
    expect(await code(transitionPromoExperiment(db, ADMIN_CLAIMS, targetId, 'conclude', 1, key(), NOW))).toBe(
      'invalid_transition'
    )
    expect(await code(transitionPromoExperiment(db, ADMIN_CLAIMS, targetId, 'stop', 1, key(), NOW))).toBe(
      'invalid_transition'
    )
  })
  it('reports not_found and rejects an unknown action', async () => {
    expect(
      await code(
        transitionPromoExperiment(db, ADMIN_CLAIMS, '70000000-0000-4000-8000-0000000000ff', 'start', 1, key(), NOW)
      )
    ).toBe('not_found')
    const { targetId } = await createPromoExperiment(db, ADMIN_CLAIMS, INPUT, key(), NOW)
    expect(await code(transitionPromoExperiment(db, ADMIN_CLAIMS, targetId, 'promote' as never, 1, key(), NOW))).toBe(
      'invalid_input'
    )
  })
  it('lets only one of two concurrent transitions win', async () => {
    const { targetId } = await createPromoExperiment(db, ADMIN_CLAIMS, INPUT, key(), NOW)
    const r = await Promise.all([
      code(transitionPromoExperiment(db, ADMIN_CLAIMS, targetId, 'start', 1, key(), NOW)),
      code(transitionPromoExperiment(db, ADMIN_CLAIMS, targetId, 'start', 1, key(), NOW))
    ])
    expect(r.sort()).toEqual(['ok', 'version_conflict'])
  })
  it('keeps the command journal append-only', async () => {
    await createPromoExperiment(db, ADMIN_CLAIMS, INPUT, key(), NOW)
    expect(() => sqlite.exec('DELETE FROM promo_experiment_commands')).toThrow(/immutable/)
    expect(() => sqlite.exec('DELETE FROM promo_experiments')).toThrow(/immutable/)
  })
})

describe('PRI-022 assignment and observations', () => {
  it('only assigns while the experiment is running', async () => {
    const { targetId } = await createPromoExperiment(db, ADMIN_CLAIMS, INPUT, key(), NOW)
    expect(await code(assignPromoSubject(db, targetId, 'subject-1', NOW))).toBe('experiment_not_running')
    expect(await code(assignPromoSubject(db, '70000000-0000-4000-8000-0000000000ff', 'subject-1', NOW))).toBe(
      'not_found'
    )
  })
  it('assigns deterministically and idempotently, storing only a hash of the subject', async () => {
    const { id } = await runningExperiment()
    const a = await assignPromoSubject(db, id, 'customer-42', NOW)
    const b = await assignPromoSubject(db, id, 'customer-42', NOW)
    expect(b).toEqual({ ...a, created: false })
    expect(a.created).toBe(true)
    expect(sqlite.prepare('SELECT count(*) c FROM promo_experiment_assignments').get()).toEqual({ c: 1 })
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM promo_experiment_assignments').all())).not.toContain(
      'customer-42'
    )
  })
  it('rejects e-mail-like or malformed subject keys', async () => {
    const { id } = await runningExperiment()
    expect(await code(assignPromoSubject(db, id, 'ana@example.com', NOW))).toBe('invalid_input')
    expect(await code(assignPromoSubject(db, id, '', NOW))).toBe('invalid_input')
  })
  it('approximates the configured holdout share', async () => {
    const { id } = await runningExperiment({ holdoutBasisPoints: 2000 })
    for (let i = 0; i < 500; i++) await assignPromoSubject(db, id, `subject-${i}`, NOW)
    const row = sqlite.prepare("SELECT sum(arm='holdout') h, count(*) c FROM promo_experiment_assignments").get() as {
      h: number
      c: number
    }
    expect(row.h / row.c).toBeGreaterThan(0.15)
    expect(row.h / row.c).toBeLessThan(0.25)
  })
  it('records an observation once per order and refuses a divergent replay', async () => {
    const { id } = await runningExperiment()
    await assignPromoSubject(db, id, 'subject-1', NOW)
    const obs = {
      subjectKey: 'subject-1',
      orderRef: 'order-000001',
      revenueGrossCents: 1210,
      netRevenueCents: 1000,
      cogsCents: 600,
      variableCostCents: 50
    }
    await recordPromoObservation(db, id, obs, NOW)
    await recordPromoObservation(db, id, obs, NOW)
    expect(sqlite.prepare('SELECT count(*) c, sum(margin_cents) m FROM promo_experiment_observations').get()).toEqual({
      c: 1,
      m: 350
    })
    expect(await code(recordPromoObservation(db, id, { ...obs, cogsCents: 100 }, NOW))).toBe('conflict')
  })
  it('refuses observations of unassigned subjects and invalid payloads', async () => {
    const { id } = await runningExperiment()
    const obs = {
      subjectKey: 'ghost-subject',
      orderRef: 'order-000001',
      revenueGrossCents: 100,
      netRevenueCents: 100,
      cogsCents: 0,
      variableCostCents: 0
    }
    expect(await code(recordPromoObservation(db, id, obs, NOW))).toBe('not_found')
    expect(await code(recordPromoObservation(db, id, { ...obs, cogsCents: -1 }, NOW))).toBe('invalid_input')
  })
  it('accepts a loss-making order and keeps it negative', async () => {
    const { id } = await runningExperiment()
    await assignPromoSubject(db, id, 'subject-1', NOW)
    await recordPromoObservation(
      db,
      id,
      {
        subjectKey: 'subject-1',
        orderRef: 'order-000009',
        revenueGrossCents: 500,
        netRevenueCents: 400,
        cogsCents: 900,
        variableCostCents: 0
      },
      NOW
    )
    expect(sqlite.prepare('SELECT margin_cents m FROM promo_experiment_observations').get()).toEqual({ m: -500 })
  })
  it('accepts late observations after stop but never after conclusion', async () => {
    const { id, version } = await runningExperiment()
    await assignPromoSubject(db, id, 'subject-1', NOW)
    await transitionPromoExperiment(db, ADMIN_CLAIMS, id, 'stop', version, key(), NOW)
    const base = {
      subjectKey: 'subject-1',
      revenueGrossCents: 100,
      netRevenueCents: 100,
      cogsCents: 10,
      variableCostCents: 0
    }
    await recordPromoObservation(db, id, { ...base, orderRef: 'order-late-001' }, NOW)
    await transitionPromoExperiment(db, ADMIN_CLAIMS, id, 'conclude', version + 1, key(), NOW)
    expect(await code(recordPromoObservation(db, id, { ...base, orderRef: 'order-late-002' }, NOW))).toBe(
      'experiment_not_running'
    )
    expect(await code(assignPromoSubject(db, id, 'subject-2', NOW))).toBe('experiment_not_running')
  })
  it('keeps assignments and observations append-only', async () => {
    const { id } = await runningExperiment()
    await assignPromoSubject(db, id, 'subject-1', NOW)
    expect(() => sqlite.exec("UPDATE promo_experiment_assignments SET arm='holdout'")).toThrow(/immutable/)
    expect(() => sqlite.exec('DELETE FROM promo_experiment_assignments')).toThrow(/immutable/)
  })
})

describe('PRI-022 analysis and conclusion decided by margin only', () => {
  const wobble = (i: number) => (i % 2 === 0 ? 150 : -150)
  it('recommends rollout when the treatment lifts incremental margin with a positive lower bound', async () => {
    const { id, version } = await runningExperiment()
    await populate(id, 700, (arm, i) => ({ net: 3000 + wobble(i) + (arm === 'treatment' ? 400 : 0), cogs: 2000 }))
    const analysis = await analyzePromoExperiment(db, ADMIN_CLAIMS, id, NOW)
    expect(analysis.objective).toBe('incremental_margin')
    expect(analysis.decision).toBe('promote')
    expect(analysis.incrementalMarginPerSubjectCents).toBeGreaterThan(300)
    const done = await transitionPromoExperiment(db, ADMIN_CLAIMS, id, 'conclude', version, key(), NOW)
    expect(done.appliedVersion).toBe(version + 1)
    expect(sqlite.prepare('SELECT status, conclusion FROM promo_experiments').get()).toEqual({
      status: 'concluded',
      conclusion: 'rollout'
    })
  })
  it('does not roll out a promotion that inflates gross revenue but loses margin', async () => {
    const { id, version } = await runningExperiment()
    // treated customers spend 3x but at a loss; gross revenue is much higher than holdout
    await populate(id, 700, (arm, i) =>
      arm === 'treatment'
        ? { net: 9000 + wobble(i), cogs: 9400, gross: 11000 }
        : { net: 3000 + wobble(i), cogs: 2000, gross: 3600 }
    )
    const analysis = await analyzePromoExperiment(db, ADMIN_CLAIMS, id, NOW)
    expect(analysis.decision).toBe('reject')
    await transitionPromoExperiment(db, ADMIN_CLAIMS, id, 'conclude', version, key(), NOW)
    expect(sqlite.prepare('SELECT conclusion FROM promo_experiments').get()).toEqual({ conclusion: 'no_rollout' })
  })
  it('concludes as inconclusive when the sample is too small', async () => {
    const { id, version } = await runningExperiment({ minSamplePerArm: 500 })
    await populate(id, 100, (_arm, i) => ({ net: 3000 + wobble(i), cogs: 2000 }))
    const analysis = await analyzePromoExperiment(db, ADMIN_CLAIMS, id, NOW)
    expect(analysis.decision).toBe('insufficient_sample')
    await transitionPromoExperiment(db, ADMIN_CLAIMS, id, 'conclude', version, key(), NOW)
    expect(sqlite.prepare('SELECT conclusion FROM promo_experiments').get()).toEqual({ conclusion: 'inconclusive' })
  })
  it('counts assigned subjects without orders as zero margin', async () => {
    const { id } = await runningExperiment()
    for (let i = 0; i < 300; i++) await assignPromoSubject(db, id, `silent-${i}`, NOW)
    const a = await analyzePromoExperiment(db, ADMIN_CLAIMS, id, NOW)
    expect(a.holdoutN + a.treatmentN).toBe(300)
    expect(a.incrementalMarginPerSubjectCents).toBe(0)
  })
  it('analysis is read only and requires live admin authorization', async () => {
    const { id } = await runningExperiment()
    const before = sqlite.prepare('SELECT total_changes() n').get()
    await analyzePromoExperiment(db, ADMIN_CLAIMS, id, NOW)
    expect(sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
    expect(await code(analyzePromoExperiment(db, PLAIN_CLAIMS, id, NOW))).toBe('forbidden')
    expect(await code(analyzePromoExperiment(db, NO_MFA_CLAIMS, id, NOW))).toBe('mfa_required')
    expect(await code(analyzePromoExperiment(db, ADMIN_CLAIMS, '70000000-0000-4000-8000-0000000000ff', NOW))).toBe(
      'not_found'
    )
  })
  it('lists experiments for administrators', async () => {
    await runningExperiment()
    const list = await listPromoExperiments(db, ADMIN_CLAIMS, NOW)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ code: 'EXP-ENVIO80', status: 'running', holdoutBasisPoints: 2000 })
  })
})
