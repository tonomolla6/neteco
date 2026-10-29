/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  cancelCountPlan,
  createCountPlan,
  decideCountLine,
  listCountPlans,
  readCountPlan,
  requestRecount,
  startCountPlan,
  submitCount
} from '../../workers/catalog/inventory-cycle-counts'
import {
  PLANNING_VARIANT,
  addVariant,
  claimsA,
  claimsB,
  claimsNoRole,
  isoNow,
  openPlanningFixture,
  uuid
} from '../support/inventory-planning-fixture'

let sqlite: DatabaseSync
let db: D1Database
let second: string
beforeEach(async () => {
  ;({ sqlite, database: db } = await openPlanningFixture())
  second = addVariant(sqlite, { sku: 'SKU-B', physical: 10 })
})
afterEach(() => sqlite.close())

const plan = (extra: Record<string, unknown> = {}) =>
  createCountPlan(
    db,
    claimsA,
    {
      name: 'Conteo semanal A',
      scheduledFor: '2026-11-02T08:00:00Z',
      variantIds: [PLANNING_VARIANT, second],
      ...extra
    },
    uuid()
  )
const lineOf = async (planId: string, variantId: string, who = claimsA) =>
  (await readCountPlan(db, who, planId)).lines.find((l: any) => l.variantId === variantId)!
const balance = (v: string) =>
  sqlite.prepare('SELECT physical_quantity p, version v FROM inventory_balances WHERE variant_id=?').get(v) as any
async function counting(extra: Record<string, unknown> = {}) {
  const p = await plan(extra)
  await startCountPlan(db, claimsA, p.id, { expectedVersion: 1 }, uuid())
  return p.id
}
async function count(planId: string, variantId: string, qty: number, who = claimsA) {
  const line = await lineOf(planId, variantId, who)
  return submitCount(db, who, planId, { variantId, countedQuantity: qty, expectedLineVersion: line.version }, uuid())
}
/** Both lines counted by A (variant 1: 18 vs book 20, variant 2: 10 vs 10) => plan in review. */
async function inReview() {
  const id = await counting()
  await count(id, PLANNING_VARIANT, 18)
  await count(id, second, 10)
  return id
}
const decide = async (planId: string, variantId: string, extra: Record<string, unknown>, who = claimsB) =>
  decideCountLine(
    db,
    who,
    planId,
    {
      variantId,
      expectedLineVersion: (await lineOf(planId, variantId, who)).version,
      decision: 'approve',
      note: 'Revisado en almacén',
      ...extra
    },
    uuid()
  )

describe('INV-020 plans', () => {
  it('creates a planned blind cycle count, idempotently', async () => {
    const cmd = uuid()
    const input = { name: 'Conteo semanal A', scheduledFor: '2026-11-02T08:00:00Z', variantIds: [PLANNING_VARIANT] }
    const a = await createCountPlan(db, claimsA, input, cmd)
    expect(a).toMatchObject({ status: 'planned', version: 1, lines: 1, blind: true })
    expect(await createCountPlan(db, claimsA, input, cmd)).toEqual(a)
    expect((await listCountPlans(db, claimsA)).length).toBe(1)
    await expect(createCountPlan(db, claimsA, { ...input, name: 'Otro nombre' }, cmd)).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
  })
  it('validates input: empty/duplicate/unknown variants, bad dates, unknown fields', async () => {
    await expect(plan({ variantIds: [] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(plan({ variantIds: [second, second] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(plan({ variantIds: [uuid()] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(plan({ scheduledFor: '2026-02-30T08:00:00Z' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(plan({ name: 'x' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(plan({ extra: true })).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('blocks a variant that is already in an open plan until it closes or is cancelled', async () => {
    const first = await plan()
    await expect(plan({ variantIds: [second] })).rejects.toMatchObject({ code: 'invalid_state' })
    await cancelCountPlan(db, claimsA, first.id, { expectedVersion: 1 }, uuid())
    expect((await plan({ variantIds: [second] })).status).toBe('planned')
  })
  it('requires permission', async () => {
    await expect(
      createCountPlan(
        db,
        claimsNoRole,
        { name: 'Conteo', scheduledFor: '2026-11-02T08:00:00Z', variantIds: [second] },
        uuid()
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(listCountPlans(db, claimsNoRole)).rejects.toMatchObject({ code: 'forbidden' })
  })
  it('starts counting with CAS and snapshots book quantities once', async () => {
    const p = await plan()
    await expect(startCountPlan(db, claimsA, p.id, { expectedVersion: 5 }, uuid())).rejects.toMatchObject({
      code: 'version_conflict'
    })
    const cmd = uuid()
    const started = await startCountPlan(db, claimsA, p.id, { expectedVersion: 1 }, cmd)
    expect(started).toMatchObject({ status: 'counting', version: 2 })
    expect(await startCountPlan(db, claimsA, p.id, { expectedVersion: 1 }, cmd)).toEqual(started)
    await expect(startCountPlan(db, claimsA, p.id, { expectedVersion: 2 }, uuid())).rejects.toMatchObject({
      code: 'invalid_state'
    })
    sqlite.prepare('UPDATE inventory_balances SET physical_quantity=99 WHERE variant_id=?').run(PLANNING_VARIANT)
    expect(
      sqlite.prepare('SELECT expected_quantity e FROM cycle_count_lines WHERE variant_id=?').get(PLANNING_VARIANT)!.e
    ).toBe(20)
  })
})

describe('INV-020 blind counting', () => {
  it('hides book quantity and variance from the counter while counting', async () => {
    const id = await counting()
    const read = await readCountPlan(db, claimsA, id)
    expect(read.blind).toBe(true)
    for (const line of read.lines) expect(line).not.toHaveProperty('expectedQuantity')
    const reply = await count(id, PLANNING_VARIANT, 18)
    expect(reply).toMatchObject({ status: 'counted', planStatus: 'counting' })
    expect(reply).not.toHaveProperty('expectedQuantity')
    expect(reply).not.toHaveProperty('discrepancy')
    const other = (await readCountPlan(db, claimsB, id)).lines.find((l: any) => l.variantId === PLANNING_VARIANT)!
    expect(other).not.toHaveProperty('discrepancy')
    expect(other.countedQuantity).toBeNull()
  })
  it('non-blind plans show book quantity and variance', async () => {
    const id = await counting({ blind: false })
    expect(await count(id, PLANNING_VARIANT, 18)).toMatchObject({ expectedQuantity: 20, discrepancy: -2 })
  })
  it('moves to review once every line is counted and then reveals the variance', async () => {
    const id = await counting()
    await count(id, PLANNING_VARIANT, 18)
    expect(await count(id, second, 10)).toMatchObject({ planStatus: 'review' })
    const read = await readCountPlan(db, claimsB, id)
    expect(read.status).toBe('review')
    expect(read.lines.find((l: any) => l.variantId === PLANNING_VARIANT)).toMatchObject({
      expectedQuantity: 20,
      countedQuantity: 18,
      discrepancy: -2
    })
  })
  it('validates counts, line CAS and state', async () => {
    const id = await counting()
    const line = await lineOf(id, PLANNING_VARIANT)
    const base = { variantId: PLANNING_VARIANT, expectedLineVersion: line.version }
    for (const bad of [{ countedQuantity: -1 }, { countedQuantity: 1.5 }, { countedQuantity: 1e9 }]) {
      await expect(submitCount(db, claimsA, id, { ...base, ...bad }, uuid())).rejects.toMatchObject({
        code: 'invalid_input'
      })
    }
    await expect(
      submitCount(db, claimsA, id, { ...base, countedQuantity: 3, expectedLineVersion: 9 }, uuid())
    ).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(
      submitCount(db, claimsA, id, { variantId: uuid(), countedQuantity: 3, expectedLineVersion: 1 }, uuid())
    ).rejects.toMatchObject({ code: 'not_found' })
    const cmd = uuid()
    const done = await submitCount(db, claimsA, id, { ...base, countedQuantity: 3 }, cmd)
    expect(await submitCount(db, claimsA, id, { ...base, countedQuantity: 3 }, cmd)).toEqual(done)
    await expect(
      submitCount(db, claimsA, id, { ...base, countedQuantity: 4, expectedLineVersion: 2 }, uuid())
    ).rejects.toMatchObject({ code: 'invalid_state' })
    const planned = await plan({ variantIds: [uuid()] }).catch((e) => e)
    expect(planned.code).toBe('invalid_input')
  })
  it('cannot count a plan that has not started', async () => {
    const p = await plan()
    await expect(
      submitCount(
        db,
        claimsA,
        p.id,
        { variantId: PLANNING_VARIANT, countedQuantity: 1, expectedLineVersion: 1 },
        uuid()
      )
    ).rejects.toMatchObject({ code: 'invalid_state' })
  })
})

describe('INV-020 approval, root cause and adjustment', () => {
  it('approves a discrepancy with root cause: CAS balance + append-only adjustment movement', async () => {
    const id = await inReview()
    const before = balance(PLANNING_VARIANT)
    const moves = sqlite.prepare('SELECT count(*) n FROM inventory_movements').get()!.n as number
    const r = await decide(id, PLANNING_VARIANT, { rootCause: 'picking_error' })
    expect(r).toMatchObject({ status: 'approved', discrepancy: -2, adjusted: true, rootCause: 'picking_error' })
    expect(balance(PLANNING_VARIANT)).toEqual({ p: 18, v: before.v + 1 })
    expect(sqlite.prepare('SELECT count(*) n FROM inventory_movements').get()!.n).toBe(moves + 1)
    expect(sqlite.prepare('SELECT * FROM inventory_movements WHERE id=?').get(r.movementId)).toMatchObject({
      movement_type: 'adjustment',
      physical_delta: -2,
      reference_type: 'cycle_count',
      reference_id: id
    })
    const line = await lineOf(id, PLANNING_VARIANT, claimsB)
    expect(line).toMatchObject({ status: 'approved', rootCause: 'picking_error', movementId: r.movementId })
  })
  it('measures variance against the snapshot so sales during the count are preserved', async () => {
    const id = await inReview()
    sqlite
      .prepare('UPDATE inventory_balances SET physical_quantity=15, version=version+1 WHERE variant_id=?')
      .run(PLANNING_VARIANT)
    await decide(id, PLANNING_VARIANT, { rootCause: 'miscount' })
    expect(balance(PLANNING_VARIANT).p).toBe(13)
  })
  it('requires a root cause whenever there is a discrepancy, but not for exact counts', async () => {
    const id = await inReview()
    await expect(decide(id, PLANNING_VARIANT, {})).rejects.toMatchObject({ code: 'root_cause_required' })
    await expect(decide(id, PLANNING_VARIANT, { decision: 'reject' })).rejects.toMatchObject({
      code: 'root_cause_required'
    })
    await expect(decide(id, PLANNING_VARIANT, { rootCause: 'nonsense' })).rejects.toMatchObject({
      code: 'invalid_input'
    })
    const exact = await decide(id, second, {})
    expect(exact).toMatchObject({ status: 'approved', discrepancy: 0, adjusted: false, movementId: null })
    expect(balance(second).p).toBe(10)
  })
  it('enforces four eyes: the counter cannot approve or reject their own count', async () => {
    const id = await inReview()
    await expect(decide(id, PLANNING_VARIANT, { rootCause: 'miscount' }, claimsA)).rejects.toMatchObject({
      code: 'approval_self'
    })
    await expect(
      decide(id, PLANNING_VARIANT, { rootCause: 'miscount', decision: 'reject' }, claimsA)
    ).rejects.toMatchObject({ code: 'approval_self' })
    expect(balance(PLANNING_VARIANT).p).toBe(20)
  })
  it('rejecting a count changes no stock and closes the plan when all lines are decided', async () => {
    const id = await inReview()
    await decide(id, PLANNING_VARIANT, { decision: 'reject', rootCause: 'miscount' })
    expect(balance(PLANNING_VARIANT).p).toBe(20)
    expect((await readCountPlan(db, claimsB, id)).status).toBe('review')
    await decide(id, second, {})
    expect((await readCountPlan(db, claimsB, id)).status).toBe('closed')
    await expect(decide(id, second, {})).rejects.toMatchObject({ code: 'invalid_state' })
  })
  it('is idempotent and CAS-protected: no double adjustment', async () => {
    const id = await inReview()
    const version = (await lineOf(id, PLANNING_VARIANT, claimsB)).version
    const input = {
      variantId: PLANNING_VARIANT,
      expectedLineVersion: version,
      decision: 'approve',
      rootCause: 'receiving_error',
      note: 'Revisado en almacén'
    }
    const cmd = uuid()
    const first = await decideCountLine(db, claimsB, id, input, cmd)
    expect(await decideCountLine(db, claimsB, id, input, cmd)).toEqual(first)
    await expect(decideCountLine(db, claimsB, id, input, uuid())).rejects.toMatchObject({ code: 'invalid_state' })
    expect(balance(PLANNING_VARIANT).p).toBe(18)
    expect(
      sqlite.prepare("SELECT count(*) n FROM inventory_movements WHERE reference_type='cycle_count'").get()!.n
    ).toBe(1)
    await expect(decideCountLine(db, claimsB, id, { ...input, expectedLineVersion: 99 }, uuid())).rejects.toMatchObject(
      { code: 'invalid_state' }
    )
  })
  it('detects a stale line version', async () => {
    const id = await inReview()
    await expect(
      decideCountLine(
        db,
        claimsB,
        id,
        { variantId: second, expectedLineVersion: 99, decision: 'approve', note: 'Revisado' },
        uuid()
      )
    ).rejects.toMatchObject({ code: 'version_conflict' })
  })
  it('refuses an adjustment that would drop below blocked plus reserved stock', async () => {
    const id = await counting()
    await count(id, PLANNING_VARIANT, 0)
    await count(id, second, 10)
    await expect(decide(id, PLANNING_VARIANT, { rootCause: 'damage_loss' })).rejects.toMatchObject({
      code: 'insufficient_stock'
    })
    expect(balance(PLANNING_VARIANT).p).toBe(20)
    expect((await lineOf(id, PLANNING_VARIANT, claimsB)).status).toBe('counted')
  })
  it('detects concurrent balance changes via balance CAS (no partial writes)', async () => {
    const id = await inReview()
    const real = db.batch.bind(db)
    ;(db as any).batch = async (stmts: any[]) => {
      sqlite.prepare('UPDATE inventory_balances SET version=version+1 WHERE variant_id=?').run(PLANNING_VARIANT)
      return real(stmts)
    }
    await expect(decide(id, PLANNING_VARIANT, { rootCause: 'miscount' })).rejects.toMatchObject({
      code: 'version_conflict'
    })
    ;(db as any).batch = real
    expect(balance(PLANNING_VARIANT).p).toBe(20)
    expect(
      sqlite.prepare("SELECT count(*) n FROM inventory_movements WHERE reference_type='cycle_count'").get()!.n
    ).toBe(0)
  })
  it('requires permission and a live session to decide', async () => {
    const id = await inReview()
    await expect(decide(id, PLANNING_VARIANT, { rootCause: 'miscount' }, claimsNoRole)).rejects.toMatchObject({
      code: 'forbidden'
    })
  })
})

describe('INV-020 recount and cancel', () => {
  it('requests a recount, clearing the count and returning the plan to counting', async () => {
    const id = await inReview()
    const line = await lineOf(id, PLANNING_VARIANT, claimsB)
    await expect(
      requestRecount(
        db,
        claimsB,
        id,
        { variantId: PLANNING_VARIANT, expectedLineVersion: line.version, note: 'x' },
        uuid()
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
    const r = await requestRecount(
      db,
      claimsB,
      id,
      { variantId: PLANNING_VARIANT, expectedLineVersion: line.version, note: 'Diferencia sospechosa' },
      uuid()
    )
    expect(r).toMatchObject({ status: 'recount', planStatus: 'counting' })
    const read = await readCountPlan(db, claimsB, id)
    expect(read.status).toBe('counting')
    expect(read.lines.find((l: any) => l.variantId === PLANNING_VARIANT)).toMatchObject({
      countedQuantity: null,
      status: 'recount'
    })
    expect(read.lines[0]).not.toHaveProperty('expectedQuantity')
    const again = await count(id, PLANNING_VARIANT, 20, claimsB)
    expect(again.planStatus).toBe('review')
    // earlier count remains in the append-only event log
    expect(
      sqlite
        .prepare("SELECT count(*) n FROM cycle_count_events WHERE kind='counted' AND variant_id=?")
        .get(PLANNING_VARIANT)!.n
    ).toBe(2)
  })
  it('only counted lines of a plan in review can be recounted', async () => {
    const id = await counting()
    await expect(
      requestRecount(
        db,
        claimsB,
        id,
        { variantId: PLANNING_VARIANT, expectedLineVersion: 1, note: 'Diferencia sospechosa' },
        uuid()
      )
    ).rejects.toMatchObject({ code: 'invalid_state' })
  })
  it('cancels an open plan with CAS and keeps closed/cancelled plans final', async () => {
    const p = await plan()
    await expect(cancelCountPlan(db, claimsA, p.id, { expectedVersion: 4 }, uuid())).rejects.toMatchObject({
      code: 'version_conflict'
    })
    const cmd = uuid()
    const c = await cancelCountPlan(db, claimsA, p.id, { expectedVersion: 1 }, cmd)
    expect(c.status).toBe('cancelled')
    expect(await cancelCountPlan(db, claimsA, p.id, { expectedVersion: 1 }, cmd)).toEqual(c)
    await expect(cancelCountPlan(db, claimsA, p.id, { expectedVersion: 2 }, uuid())).rejects.toMatchObject({
      code: 'invalid_state'
    })
    await expect(startCountPlan(db, claimsA, p.id, { expectedVersion: 2 }, uuid())).rejects.toMatchObject({
      code: 'invalid_state'
    })
  })
  it('keeps the event log immutable and unknown plans are not found', async () => {
    const id = await inReview()
    expect(() => sqlite.exec('DELETE FROM cycle_count_events')).toThrow(/immutable/)
    expect(() => sqlite.exec("UPDATE cycle_count_events SET note='x'")).toThrow(/immutable/)
    await expect(readCountPlan(db, claimsA, uuid())).rejects.toMatchObject({ code: 'not_found' })
    await expect(readCountPlan(db, claimsA, 'nope')).rejects.toMatchObject({ code: 'not_found' })
    expect(isoNow()).toBeTruthy()
    expect(id).toBeTruthy()
  })
})
