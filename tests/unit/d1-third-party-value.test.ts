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
  listD1ThirdPartyScripts,
  readD1ThirdPartyManifest,
  recordD1ThirdPartyExperiment,
  registerD1ThirdPartyScript,
  removeD1ThirdPartyScript
} from '../../workers/performance/third-party-value'

let sqlite: DatabaseSync
let db: D1Database
beforeEach(async () => {
  ;({ sqlite, db } = await setupPerformanceInsightsDb())
})
afterEach(() => sqlite.close())
const opts = { now: NOW }
const expectCode = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code })

const register = (over: Record<string, unknown> = {}, claims = ADMIN) =>
  registerD1ThirdPartyScript(
    db,
    claims,
    {
      commandId: uuid(),
      idempotencyKey: uuid(),
      vendor: 'Meta',
      name: 'Pixel',
      kind: 'pixel',
      monthlyCostCents: 5000,
      loadMsP75: 180,
      ...over
    } as never,
    opts
  )
const arm = (visitors: number, conversions: number, revenueCents: number, lcpMsP75: number) => ({
  visitors,
  conversions,
  revenueCents,
  lcpMsP75
})
const experiment = (scriptId: string, over: Record<string, unknown> = {}, claims = ADMIN) =>
  recordD1ThirdPartyExperiment(
    db,
    claims,
    {
      commandId: uuid(),
      idempotencyKey: uuid(),
      scriptId,
      periodDays: 14,
      marginBps: 3000,
      control: arm(10000, 200, 2_000_000, 2400),
      treatment: arm(10000, 200, 2_000_000, 2450),
      ...over
    } as never,
    opts
  )
const remove = (script: { id: string; version: number }, over: Record<string, unknown> = {}, claims = ADMIN) =>
  removeD1ThirdPartyScript(
    db,
    claims,
    {
      commandId: uuid(),
      idempotencyKey: uuid(),
      scriptId: script.id,
      expectedVersion: script.version,
      reason: 'Sin retorno medido en el A/B',
      ...over
    } as never,
    opts
  )

describe('third-party registry', () => {
  it('registers a script and is idempotent', async () => {
    const input = {
      commandId: uuid(),
      idempotencyKey: 'reg',
      vendor: 'Meta',
      name: 'Pixel',
      kind: 'pixel',
      monthlyCostCents: 0,
      loadMsP75: 100
    }
    const a = await registerD1ThirdPartyScript(db, ADMIN, input as never, opts)
    const b = await registerD1ThirdPartyScript(db, ADMIN, { ...input, commandId: uuid() } as never, opts)
    expect(b).toEqual(a)
    expect(a).toMatchObject({ status: 'active', version: 1, latestVerdict: null })
  })
  it('rejects duplicates (vendor+name), invalid data and unauthorised callers', async () => {
    await register()
    await expectCode(register(), 'conflict')
    await expectCode(register({ name: 'Other', kind: 'tracker' }), 'invalid_input')
    await expectCode(register({ name: 'X1', monthlyCostCents: -5 }), 'invalid_input')
    await expectCode(register({ name: 'X2' }, NOPERMS), 'forbidden')
    await expectCode(register({ name: 'X3' }, NOMFA), 'mfa_required')
  })
  it('rejects key reuse with a different payload', async () => {
    await register({ idempotencyKey: 'k' })
    await expectCode(register({ idempotencyKey: 'k', name: 'Another' }), 'idempotency_conflict')
  })
})

describe('experiments and verdicts', () => {
  it('records an A/B result, persists the verdict and exposes it in the listing', async () => {
    const script = await register()
    const result = await experiment(script.id)
    expect(result.evaluation.verdict).toBe('remove')
    const listed = await listD1ThirdPartyScripts(db)
    expect(listed[0]).toMatchObject({ id: script.id, latestVerdict: 'remove' })
  })
  it('keeps a valuable script and reports the newest verdict only', async () => {
    const script = await register()
    await experiment(script.id)
    await experiment(script.id, { treatment: arm(10000, 300, 3_100_000, 2450) })
    expect((await listD1ThirdPartyScripts(db))[0]!.latestVerdict).toBe('keep')
  })
  it('refuses experiments for unknown, removed or invalid inputs', async () => {
    await expectCode(experiment(uuid()), 'not_found')
    const script = await register()
    await expectCode(experiment(script.id, { control: arm(10, 11, 0, 0) }), 'invalid_input')
    const removed = await remove(script)
    expect(removed.status).toBe('removed')
    await expectCode(experiment(script.id), 'script_not_active')
  })
  it('experiments are append-only evidence', async () => {
    const script = await register()
    await experiment(script.id)
    expect(() => sqlite.exec(`UPDATE third_party_experiments SET verdict = 'keep'`)).toThrow(/immutable/)
    expect(() => sqlite.exec(`DELETE FROM third_party_experiments`)).toThrow(/immutable/)
  })
  it('requires administration', async () => {
    const script = await register()
    await expectCode(experiment(script.id, {}, NOPERMS), 'forbidden')
  })
})

describe('removal of scripts without return', () => {
  it('removes with reason and removes it from the manifest', async () => {
    const keep = await register({ name: 'Keep' })
    const gone = await register({ name: 'Gone' })
    expect((await readD1ThirdPartyManifest(db)).map((s) => s.name).sort()).toEqual(['Gone', 'Keep'])
    const out = await remove(gone)
    expect(out).toMatchObject({ status: 'removed', version: 2, removalReason: 'Sin retorno medido en el A/B' })
    expect((await readD1ThirdPartyManifest(db)).map((s) => s.id)).toEqual([keep.id])
  })
  it('uses CAS and refuses a second removal', async () => {
    const script = await register()
    await remove(script)
    await expectCode(remove(script), 'concurrency_conflict')
    await expectCode(remove({ id: script.id, version: 2 }), 'already_removed')
  })
  it('only one of two concurrent removals wins', async () => {
    const script = await register()
    const results = await Promise.allSettled([remove(script), remove(script, {}, OTHER_ADMIN)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  })
  it('needs a meaningful reason, authorisation and a known id', async () => {
    const script = await register()
    await expectCode(remove(script, { reason: 'corto' }), 'invalid_input')
    await expectCode(remove(script, {}, NOPERMS), 'forbidden')
    await expectCode(remove({ id: uuid(), version: 1 }), 'not_found')
  })
  it('removal is blocked if the actor loses permission before commit', async () => {
    const script = await register()
    sqlite.exec(`DELETE FROM identity_roles WHERE identity_id = '${ADMIN.identityId}'`)
    await expectCode(remove(script), 'forbidden')
    expect(sqlite.prepare('SELECT status FROM third_party_scripts').get()).toEqual({ status: 'active' })
  })
  it('the manifest exposes only non-sensitive fields', async () => {
    await register()
    const manifest = await readD1ThirdPartyManifest(db)
    expect(Object.keys(manifest[0]!).sort()).toEqual(['id', 'kind', 'name', 'vendor'])
  })
})
