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
  decideD1AiopsRecommendation,
  ingestD1AiopsSignal,
  listD1AiopsRecommendations,
  readD1AiopsPrecision,
  recordD1AiopsOutcome,
  runD1AiopsCorrelation
} from '../../workers/observability/aiops'
import { PerformanceInsightError } from '../../shared/performance-insights-error'

let sqlite: DatabaseSync
let db: D1Database
beforeEach(async () => {
  ;({ sqlite, db } = await setupPerformanceInsightsDb())
})
afterEach(() => sqlite.close())

const opts = { now: NOW }
async function signal(over: Record<string, unknown> = {}, claims = ADMIN) {
  return ingestD1AiopsSignal(
    db,
    claims,
    {
      commandId: uuid(),
      idempotencyKey: uuid(),
      kind: 'error_rate',
      service: 'checkout',
      severity: 'high',
      metricValue: 9,
      thresholdValue: 2,
      observedAt: '2026-10-29T11:50:00Z',
      ...over
    } as never,
    opts
  )
}
async function seedDeployIncident() {
  await signal({ kind: 'deploy', service: 'storefront', severity: 'medium', observedAt: '2026-10-29T11:45:00Z' })
  await signal({ kind: 'error_rate', service: 'checkout', observedAt: '2026-10-29T11:50:00Z' })
}
const correlate = (claims = ADMIN, extra: Record<string, unknown> = {}) =>
  runD1AiopsCorrelation(db, claims, { commandId: uuid(), idempotencyKey: uuid(), ...extra } as never, opts)
async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code })
  await expect(promise).rejects.toBeInstanceOf(PerformanceInsightError)
}

describe('AIOps signals', () => {
  it('stores a signal and replays the same idempotent command', async () => {
    const input = {
      commandId: uuid(),
      idempotencyKey: 'sig-1',
      kind: 'error_rate',
      service: 'checkout',
      severity: 'high',
      metricValue: 9,
      thresholdValue: 2,
      observedAt: '2026-10-29T11:50:00Z'
    }
    const a = await ingestD1AiopsSignal(db, ADMIN, input as never, opts)
    const b = await ingestD1AiopsSignal(db, ADMIN, { ...input, commandId: uuid() } as never, opts)
    expect(b).toEqual(a)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM aiops_signals').get()).toEqual({ n: 1 })
  })

  it('rejects the same key with a different payload', async () => {
    await signal({ idempotencyKey: 'same' })
    await expectCode(signal({ idempotencyKey: 'same', metricValue: 99 }), 'idempotency_conflict')
  })

  it('rejects invalid input, future observations and stale ones', async () => {
    await expectCode(signal({ kind: 'nope' }), 'invalid_input')
    await expectCode(signal({ observedAt: '2026-10-29T13:00:00Z' }), 'signal_in_future')
    await expectCode(signal({ observedAt: '2026-10-20T13:00:00Z' }), 'signal_too_old')
  })

  it('enforces authorization (unauthenticated, no permission, no MFA)', async () => {
    await expectCode(signal({}, NOPERMS), 'forbidden')
    await expectCode(signal({}, NOMFA), 'mfa_required')
    await expectCode(signal({}, { ...ADMIN, sessionVersion: 7 }), 'unauthenticated')
  })

  it('signals are append-only', () => {
    sqlite.exec(
      `INSERT INTO aiops_signals VALUES ('${uuid()}','deploy','cdn','low',1,1,'${NOW}','${ADMIN.identityId}','${NOW}')`
    )
    expect(() => sqlite.exec("UPDATE aiops_signals SET severity = 'high'")).toThrow(/aiops_signal_immutable/)
    expect(() => sqlite.exec('DELETE FROM aiops_signals')).toThrow(/aiops_signal_immutable/)
  })
})

describe('AIOps correlation', () => {
  it('creates a recommendation with runbook, steps and flags destructive ones', async () => {
    await seedDeployIncident()
    const result = await correlate()
    expect(result.created).toBe(1)
    expect(result.recommendations[0]).toMatchObject({
      runbookId: 'rollback_release',
      destructive: true,
      status: 'proposed',
      outcome: 'pending',
      version: 1
    })
    expect(result.recommendations[0]!.steps.length).toBeGreaterThan(1)
  })

  it('is idempotent per command and does not duplicate on a new run over the same signals', async () => {
    await seedDeployIncident()
    const input = { commandId: uuid(), idempotencyKey: 'corr-1' }
    const a = await runD1AiopsCorrelation(db, ADMIN, input as never, opts)
    const replay = await runD1AiopsCorrelation(db, ADMIN, { ...input, commandId: uuid() } as never, opts)
    expect(replay).toEqual(a)
    const again = await correlate()
    expect(again.created).toBe(0)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM aiops_recommendations').get()).toEqual({ n: 1 })
  })

  it('does not re-propose a cluster that grew after its first recommendation', async () => {
    await seedDeployIncident()
    await correlate()
    await signal({ kind: 'latency_p95', service: 'checkout', observedAt: '2026-10-29T11:55:00Z' })
    expect((await correlate()).created).toBe(0)
  })

  it('produces nothing for isolated low-signal noise and respects the lookback', async () => {
    await signal({ severity: 'low' })
    expect((await correlate()).created).toBe(0)
    await signal({ kind: 'deploy', severity: 'critical', observedAt: '2026-10-29T08:00:00Z' })
    expect((await correlate(ADMIN, { lookbackMinutes: 30 })).created).toBe(0)
  })

  it('requires authorization', async () => {
    await expectCode(correlate(NOPERMS), 'forbidden')
  })
})

describe('AIOps human approval', () => {
  async function proposed() {
    await seedDeployIncident()
    return (await correlate()).recommendations[0]!
  }
  const decide = (rec: { id: string; version: number }, extra: Record<string, unknown> = {}, claims = ADMIN) =>
    decideD1AiopsRecommendation(
      db,
      claims,
      {
        commandId: uuid(),
        idempotencyKey: uuid(),
        recommendationId: rec.id,
        expectedVersion: rec.version,
        decision: 'approve',
        reason: 'Revisado el runbook y el impacto',
        ...extra
      } as never,
      opts
    )

  it('refuses to approve a destructive action without explicit confirmation', async () => {
    const rec = await proposed()
    await expectCode(decide(rec), 'destructive_confirmation_required')
    expect(sqlite.prepare('SELECT status FROM aiops_recommendations').get()).toEqual({ status: 'proposed' })
  })

  it('approves a destructive action with confirmation and records the human', async () => {
    const rec = await proposed()
    const out = await decide(rec, { confirmDestructive: true })
    expect(out).toMatchObject({ status: 'approved', decidedBy: ADMIN.identityId, version: 2 })
  })

  it('rejects without needing destructive confirmation', async () => {
    const rec = await proposed()
    expect(await decide(rec, { decision: 'reject' })).toMatchObject({ status: 'rejected', version: 2 })
  })

  it('detects stale versions and double decisions', async () => {
    const rec = await proposed()
    await decide(rec, { confirmDestructive: true })
    await expectCode(decide(rec, { confirmDestructive: true }), 'concurrency_conflict')
    await expectCode(decide({ id: rec.id, version: 2 }, { decision: 'reject' }), 'already_decided')
  })

  it('serialises two concurrent decisions: exactly one wins', async () => {
    const rec = await proposed()
    const results = await Promise.allSettled([
      decide(rec, { confirmDestructive: true }),
      decide(rec, { decision: 'reject' }, OTHER_ADMIN)
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM aiops_recommendations WHERE status <> 'proposed'").get()).toEqual({
      n: 1
    })
  })

  it('is idempotent on replay and conflicting on payload change', async () => {
    const rec = await proposed()
    const input = {
      commandId: uuid(),
      idempotencyKey: 'dec-1',
      recommendationId: rec.id,
      expectedVersion: 1,
      decision: 'approve',
      reason: 'Revisado el runbook y el impacto',
      confirmDestructive: true
    }
    const a = await decideD1AiopsRecommendation(db, ADMIN, input as never, opts)
    expect(await decideD1AiopsRecommendation(db, ADMIN, { ...input, commandId: uuid() } as never, opts)).toEqual(a)
    await expectCode(
      decideD1AiopsRecommendation(db, ADMIN, { ...input, commandId: uuid(), decision: 'reject' } as never, opts),
      'idempotency_conflict'
    )
  })

  it('re-checks live authorization and refuses missing MFA, missing permission and unknown ids', async () => {
    const rec = await proposed()
    await expectCode(decide(rec, { confirmDestructive: true }, NOMFA), 'mfa_required')
    await expectCode(decide(rec, { confirmDestructive: true }, NOPERMS), 'forbidden')
    await expectCode(decide({ id: uuid(), version: 1 }), 'not_found')
  })

  it('revoked permission between ingest and decision blocks the approval', async () => {
    const rec = await proposed()
    sqlite.exec(`DELETE FROM identity_roles WHERE identity_id = '${ADMIN.identityId}'`)
    await expectCode(decide(rec, { confirmDestructive: true }), 'forbidden')
  })

  it('does not allow approving a stale destructive proposal', async () => {
    const rec = await proposed()
    await expectCode(
      decideD1AiopsRecommendation(
        db,
        ADMIN,
        {
          commandId: uuid(),
          idempotencyKey: uuid(),
          recommendationId: rec.id,
          expectedVersion: 1,
          decision: 'approve',
          reason: 'Revisado el runbook y el impacto',
          confirmDestructive: true
        } as never,
        { now: '2026-10-31T12:00:00Z' }
      ),
      'recommendation_expired'
    )
  })

  it('has no execution path: approval only changes the record', async () => {
    const rec = await proposed()
    await decide(rec, { confirmDestructive: true })
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'aiops_%'").all()
    expect(tables.map((t) => (t as { name: string }).name).sort()).toEqual(['aiops_recommendations', 'aiops_signals'])
  })
})

describe('AIOps precision', () => {
  it('measures precision from labelled outcomes only once per recommendation', async () => {
    await seedDeployIncident()
    const rec = (await correlate()).recommendations[0]!
    expect(await readD1AiopsPrecision(db)).toMatchObject({ total: 1, reviewed: 0, precision: null })
    const label = (outcome: string, version: number, claims = ADMIN) =>
      recordD1AiopsOutcome(
        db,
        claims,
        {
          commandId: uuid(),
          idempotencyKey: uuid(),
          recommendationId: rec.id,
          expectedVersion: version,
          outcome
        } as never,
        opts
      )
    expect(await label('true_positive', 1)).toMatchObject({ outcome: 'true_positive', version: 2 })
    await expectCode(label('false_positive', 2), 'outcome_already_recorded')
    await expectCode(label('true_positive', 1), 'outcome_already_recorded')
    await expectCode(label('true_positive', 2, NOPERMS), 'forbidden')
    expect(await readD1AiopsPrecision(db)).toMatchObject({ reviewed: 1, truePositives: 1, precision: 1 })
  })

  it('rejects labelling with a stale version after a decision bumped it', async () => {
    await seedDeployIncident()
    const rec = (await correlate()).recommendations[0]!
    await decideD1AiopsRecommendation(
      db,
      ADMIN,
      {
        commandId: uuid(),
        idempotencyKey: uuid(),
        recommendationId: rec.id,
        expectedVersion: 1,
        decision: 'reject',
        reason: 'Falso positivo evidente'
      } as never,
      opts
    )
    await expectCode(
      recordD1AiopsOutcome(
        db,
        ADMIN,
        {
          commandId: uuid(),
          idempotencyKey: uuid(),
          recommendationId: rec.id,
          expectedVersion: 1,
          outcome: 'false_positive'
        } as never,
        opts
      ),
      'concurrency_conflict'
    )
  })

  it('lists recommendations newest first with bounded limit', async () => {
    await seedDeployIncident()
    await correlate()
    expect(await listD1AiopsRecommendations(db, 5000)).toHaveLength(1)
  })
})
