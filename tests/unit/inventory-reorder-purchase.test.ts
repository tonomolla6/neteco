/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  computeReorder,
  decidePurchaseSuggestion,
  evaluateReorderSuggestions,
  readPurchaseSuggestions,
  readReorderPolicies,
  upsertReorderPolicy
} from '../../workers/catalog/inventory-reorder-purchase'
import {
  PLANNING_VARIANT,
  addMovement,
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
beforeEach(async () => {
  ;({ sqlite, database: db } = await openPlanningFixture())
})
afterEach(() => sqlite.close())

const policy = (extra: Record<string, unknown> = {}) => ({
  variantId: PLANNING_VARIANT,
  leadTimeDays: 7,
  reviewDays: 7,
  demandWindowDays: 30,
  ...extra
})
/** 30 units shipped in the window = 1.0/day; stock 5, blocked 1, safety 2 => position 4, ROP 9. */
function lowStock(physical = 5) {
  sqlite.prepare('UPDATE inventory_balances SET physical_quantity=? WHERE variant_id=?').run(physical, PLANNING_VARIANT)
  addMovement(sqlite, PLANNING_VARIANT, 'ship', -30, isoNow(-5 * 86400000))
}
const count = (table: string) => sqlite.prepare(`SELECT count(*) n FROM ${table}`).get()!.n as number

describe('INV-017 reorder math', () => {
  it('computes reorder point = demand*lead + safety and order-up-to level', () => {
    const r = computeReorder({
      position: 4,
      safetyStock: 2,
      leadTimeDays: 7,
      reviewDays: 7,
      demandMilliPerDay: 1000,
      orderMultiple: 1,
      minOrderQuantity: 1
    })
    expect(r).toMatchObject({ reorderPoint: 9, target: 16, needed: true, suggestedQuantity: 12 })
  })
  it('rounds up to the order multiple and honours the minimum order', () => {
    const base = {
      position: 4,
      safetyStock: 2,
      leadTimeDays: 7,
      reviewDays: 7,
      demandMilliPerDay: 1000,
      minOrderQuantity: 1
    }
    expect(computeReorder({ ...base, orderMultiple: 12 }).suggestedQuantity).toBe(12)
    expect(computeReorder({ ...base, orderMultiple: 5 }).suggestedQuantity).toBe(15)
    expect(computeReorder({ ...base, orderMultiple: 1, minOrderQuantity: 40 }).suggestedQuantity).toBe(40)
  })
  it('does not flag stock above the reorder point and caps absurd quantities', () => {
    const r = computeReorder({
      position: 50,
      safetyStock: 2,
      leadTimeDays: 7,
      reviewDays: 7,
      demandMilliPerDay: 1000,
      orderMultiple: 1,
      minOrderQuantity: 1
    })
    expect(r.needed).toBe(false)
    expect(
      computeReorder({
        position: 0,
        safetyStock: 0,
        leadTimeDays: 365,
        reviewDays: 90,
        demandMilliPerDay: 9e9,
        orderMultiple: 1,
        minOrderQuantity: 1
      }).suggestedQuantity
    ).toBe(1_000_000)
  })
})

describe('INV-017 reorder policies', () => {
  it('creates and updates a policy with CAS and replays the same command', async () => {
    const cmd = uuid()
    const first = await upsertReorderPolicy(db, claimsA, policy(), cmd)
    expect(first).toEqual({ variantId: PLANNING_VARIANT, version: 1 })
    expect(await upsertReorderPolicy(db, claimsA, policy(), cmd)).toEqual(first)
    expect(count('inventory_planning_commands')).toBe(1)
    await expect(upsertReorderPolicy(db, claimsA, policy(), uuid())).rejects.toMatchObject({ code: 'version_conflict' })
    const second = await upsertReorderPolicy(db, claimsA, policy({ leadTimeDays: 10, expectedVersion: 1 }), uuid())
    expect(second.version).toBe(2)
    expect((await readReorderPolicies(db, claimsA))[0]).toMatchObject({ leadTimeDays: 10, version: 2, safetyStock: 2 })
  })
  it('rejects a command id reused with a different payload', async () => {
    const cmd = uuid()
    await upsertReorderPolicy(db, claimsA, policy(), cmd)
    await expect(upsertReorderPolicy(db, claimsA, policy({ leadTimeDays: 9 }), cmd)).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
  })
  it('validates input and unknown variants', async () => {
    await expect(upsertReorderPolicy(db, claimsA, policy({ leadTimeDays: -1 }), uuid())).rejects.toMatchObject({
      code: 'invalid_input'
    })
    await expect(upsertReorderPolicy(db, claimsA, policy({ demandWindowDays: 3 }), uuid())).rejects.toMatchObject({
      code: 'invalid_input'
    })
    await expect(upsertReorderPolicy(db, claimsA, { ...policy(), extra: 1 }, uuid())).rejects.toMatchObject({
      code: 'invalid_input'
    })
    await expect(upsertReorderPolicy(db, claimsA, policy({ variantId: uuid() }), uuid())).rejects.toMatchObject({
      code: 'not_found'
    })
    await expect(upsertReorderPolicy(db, claimsA, policy(), 'not-a-uuid')).rejects.toMatchObject({
      code: 'invalid_input'
    })
  })
  it('requires a live MFA session with the inventory permission', async () => {
    await expect(upsertReorderPolicy(db, claimsNoRole, policy(), uuid())).rejects.toMatchObject({ code: 'forbidden' })
    await expect(readReorderPolicies(db, claimsNoRole)).rejects.toMatchObject({ code: 'forbidden' })
    sqlite.exec("UPDATE auth_sessions SET mfa_verified=0 WHERE id='" + claimsA.sessionId + "'")
    await expect(upsertReorderPolicy(db, claimsA, policy(), uuid())).rejects.toMatchObject({ code: 'mfa_required' })
    await expect(upsertReorderPolicy(db, { ...claimsA, sessionVersion: 0 }, policy(), uuid())).rejects.toMatchObject({
      code: 'unauthenticated'
    })
  })
})

describe('INV-017 purchase suggestions', () => {
  beforeEach(async () => {
    await upsertReorderPolicy(db, claimsA, policy(), uuid())
  })
  it('suggests nothing while stock is above the reorder point', async () => {
    const r = await evaluateReorderSuggestions(db, claimsA, {}, uuid())
    expect(r).toMatchObject({ evaluated: 1, created: [], superseded: [], unchanged: 1 })
    expect(count('inventory_purchase_suggestions')).toBe(0)
  })
  it('suggests from lead time, demand and safety stock, never touching the ledger', async () => {
    lowStock()
    const movements = count('inventory_movements')
    const r = await evaluateReorderSuggestions(db, claimsA, {}, uuid())
    expect(r.created).toHaveLength(1)
    const [s] = await readPurchaseSuggestions(db, claimsA)
    expect(s).toMatchObject({
      status: 'pending',
      positionQuantity: 4,
      safetyStock: 2,
      leadTimeDays: 7,
      dailyDemand: 1,
      reorderPoint: 9,
      suggestedQuantity: 12,
      approvedQuantity: null,
      version: 1
    })
    expect(count('inventory_movements')).toBe(movements)
  })
  it('ignores demand older than the window and active reservations reduce the position', async () => {
    sqlite.prepare('UPDATE inventory_balances SET physical_quantity=5 WHERE variant_id=?').run(PLANNING_VARIANT)
    addMovement(sqlite, PLANNING_VARIANT, 'ship', -300, isoNow(-90 * 86400000))
    expect((await evaluateReorderSuggestions(db, claimsA, {}, uuid())).created).toEqual([])
    // position 4 > ROP 2 (no demand, safety 2) until a reservation takes 3 units
    sqlite.exec(`INSERT INTO inventory_reservations(id,idempotency_key,payload_hash,status,correlation_id,expires_at,created_at,updated_at)
      VALUES('r1','r1','${'a'.repeat(64)}','reserved','c','${isoNow(3600000)}','${isoNow()}','${isoNow()}')`)
    sqlite.exec(`INSERT INTO inventory_reservation_lines VALUES('r1','${PLANNING_VARIANT}','main',3)`)
    const r = await evaluateReorderSuggestions(db, claimsA, {}, uuid())
    expect(r.created).toHaveLength(1)
    expect((await readPurchaseSuggestions(db, claimsA))[0]).toMatchObject({ positionQuantity: 1 })
  })
  it('is idempotent: same command replays, same basis leaves the pending suggestion untouched', async () => {
    lowStock()
    const cmd = uuid()
    const first = await evaluateReorderSuggestions(db, claimsA, {}, cmd)
    expect(await evaluateReorderSuggestions(db, claimsA, {}, cmd)).toEqual(first)
    const again = await evaluateReorderSuggestions(db, claimsA, {}, uuid())
    expect(again).toMatchObject({ created: [], superseded: [], unchanged: 1 })
    expect(count('inventory_purchase_suggestions')).toBe(1)
  })
  it('supersedes a stale pending suggestion when the basis changes or the need disappears', async () => {
    lowStock()
    const a = (await evaluateReorderSuggestions(db, claimsA, {}, uuid())).created[0]
    sqlite.prepare('UPDATE inventory_balances SET physical_quantity=3 WHERE variant_id=?').run(PLANNING_VARIANT)
    const b = await evaluateReorderSuggestions(db, claimsA, {}, uuid())
    expect(b.superseded).toEqual([a])
    expect(b.created).toHaveLength(1)
    sqlite.prepare('UPDATE inventory_balances SET physical_quantity=500 WHERE variant_id=?').run(PLANNING_VARIANT)
    const c = await evaluateReorderSuggestions(db, claimsA, {}, uuid())
    expect(c).toMatchObject({ created: [], superseded: [b.created[0]] })
    expect((await readPurchaseSuggestions(db, claimsA, { status: 'pending' })).length).toBe(0)
  })
  it('counts recently approved quantities as incoming so the same need is not suggested twice', async () => {
    lowStock()
    const id = (await evaluateReorderSuggestions(db, claimsA, {}, uuid())).created[0]!
    await decidePurchaseSuggestion(
      db,
      claimsA,
      id,
      { decision: 'approve', expectedVersion: 1, approvedQuantity: 20, note: 'Pedido a proveedor' },
      uuid()
    )
    const r = await evaluateReorderSuggestions(db, claimsA, {}, uuid())
    expect(r.created).toEqual([])
  })
  it('limits evaluation to requested variants and enforces one pending suggestion per variant in the schema', async () => {
    lowStock()
    const other = addVariant(sqlite, { sku: 'OTHER', physical: 0 })
    await upsertReorderPolicy(db, claimsA, policy({ variantId: other }), uuid())
    const r = await evaluateReorderSuggestions(db, claimsA, { variantIds: [other] }, uuid())
    expect(r.evaluated).toBe(1)
    expect(() =>
      sqlite.exec(`INSERT INTO inventory_purchase_suggestions(id,variant_id,status,position_quantity,safety_stock,lead_time_days,daily_demand_milli,reorder_point,suggested_quantity,basis_hash,generated_by,created_at,updated_at)
        VALUES('${uuid()}','${other}','pending',0,0,1,0,0,1,'${'b'.repeat(64)}','${claimsA.identityId}','${isoNow()}','${isoNow()}')`)
    ).toThrow(/UNIQUE/)
  })
  it('requires explicit human approval with quantity and note, with CAS', async () => {
    lowStock()
    const id = (await evaluateReorderSuggestions(db, claimsA, {}, uuid())).created[0]!
    const ok = { decision: 'approve', expectedVersion: 1, approvedQuantity: 24, note: 'Aprobado por compras' }
    await expect(decidePurchaseSuggestion(db, claimsA, id, { ...ok, note: '' }, uuid())).rejects.toMatchObject({
      code: 'invalid_input'
    })
    await expect(
      decidePurchaseSuggestion(db, claimsA, id, { ...ok, approvedQuantity: 0 }, uuid())
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      decidePurchaseSuggestion(db, claimsA, id, { ...ok, expectedVersion: 9 }, uuid())
    ).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(decidePurchaseSuggestion(db, claimsA, uuid(), ok, uuid())).rejects.toMatchObject({ code: 'not_found' })
    await expect(decidePurchaseSuggestion(db, claimsNoRole, id, ok, uuid())).rejects.toMatchObject({
      code: 'forbidden'
    })
    const cmd = uuid()
    const done = await decidePurchaseSuggestion(db, claimsB, id, ok, cmd)
    expect(done).toEqual({ id, status: 'approved', version: 2 })
    expect(await decidePurchaseSuggestion(db, claimsB, id, ok, cmd)).toEqual(done)
    await expect(decidePurchaseSuggestion(db, claimsB, id, ok, uuid())).rejects.toMatchObject({ code: 'invalid_state' })
    expect((await readPurchaseSuggestions(db, claimsA))[0]).toMatchObject({ status: 'approved', approvedQuantity: 24 })
  })
  it('rejects a suggestion and keeps decided rows immutable', async () => {
    lowStock()
    const id = (await evaluateReorderSuggestions(db, claimsA, {}, uuid())).created[0]!
    await decidePurchaseSuggestion(
      db,
      claimsA,
      id,
      { decision: 'reject', expectedVersion: 1, note: 'Sin presupuesto' },
      uuid()
    )
    expect(() =>
      sqlite.prepare("UPDATE inventory_purchase_suggestions SET status='pending' WHERE id=?").run(id)
    ).toThrow()
    expect(() => sqlite.prepare('DELETE FROM inventory_purchase_suggestions WHERE id=?').run(id)).toThrow(/immutable/)
    expect(() => sqlite.prepare('DELETE FROM inventory_planning_commands').run()).toThrow(/immutable/)
  })
  it('a concurrent decision that wins the race makes the loser fail instead of recording a false success', async () => {
    lowStock()
    const id = (await evaluateReorderSuggestions(db, claimsA, {}, uuid())).created[0]!
    const real = db.batch.bind(db)
    ;(db as any).batch = async (stmts: any[]) => {
      sqlite
        .prepare(
          "UPDATE inventory_purchase_suggestions SET status='rejected', decided_by=?, decision_note='ganador', version=2 WHERE id=?"
        )
        .run(claimsB.identityId, id)
      return real(stmts)
    }
    await expect(
      decidePurchaseSuggestion(
        db,
        claimsA,
        id,
        { decision: 'approve', expectedVersion: 1, approvedQuantity: 5, note: 'Aprobar' },
        uuid()
      )
    ).rejects.toMatchObject({ code: 'version_conflict' })
    ;(db as any).batch = real
    expect(count('inventory_planning_commands')).toBe(2)
    expect((await readPurchaseSuggestions(db, claimsA))[0]).toMatchObject({ status: 'rejected' })
  })
})
