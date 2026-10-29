import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  createCountPlan,
  decideCountLine,
  readCountPlan,
  startCountPlan,
  submitCount
} from '../../workers/catalog/inventory-cycle-counts'
import {
  executeInventoryOpsCommand,
  readPickConsistency
} from '../../workers/catalog/inventory-commitments-picking-purchasing'
import {
  PLANNING_VARIANT,
  claimsA,
  claimsB,
  isoNow,
  openPlanningFixture,
  uuid
} from '../support/inventory-planning-fixture'

// INV-014/015/016 (0139) and INV-017/018/020 (0140) share the same inventory ledger: both migrations must
// coexist in one database and a cycle-count adjustment must keep working next to picking locations.
let sqlite: DatabaseSync
let db: D1Database
beforeEach(async () => {
  ;({ sqlite, database: db } = await openPlanningFixture())
  sqlite.exec(
    await readFile(
      new URL('../../db/d1/migrations/0139_inventory_commitments_picking_purchasing.sql', import.meta.url),
      'utf8'
    )
  )
})
afterEach(() => sqlite.close())

describe('BI + BJ coexistence', () => {
  it('creates no object twice and keeps the movement ledger writable for cycle counts', async () => {
    const names = sqlite.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
      name: string
    }[]
    expect(new Set(names.map((n) => n.name)).size).toBe(names.length)
    for (const t of [
      'inventory_ops_commands',
      'inventory_planning_commands',
      'inventory_pick_stock',
      'cycle_count_lines'
    ])
      expect(names.some((n) => n.name === t)).toBe(true)
  })

  it('applies an approved count adjustment on a variant that has bin stock, and the BI consistency report flags the located excess', async () => {
    const stamp = isoNow()
    await executeInventoryOpsCommand(
      db,
      claimsA,
      'create_pick_location',
      uuid(),
      { code: 'A-01', zone: 'A', kind: 'pick', pickSequence: 10 },
      uuid(),
      { now: () => stamp }
    )
    const loc = (sqlite.prepare('SELECT id FROM inventory_pick_locations').get() as { id: string }).id
    await executeInventoryOpsCommand(
      db,
      claimsA,
      'putaway',
      uuid(),
      { variantId: PLANNING_VARIANT, pickLocationId: loc, quantity: 20, expectedVersion: 0 },
      uuid(),
      { now: () => stamp }
    )
    const p = await createCountPlan(
      db,
      claimsA,
      { name: 'Conteo con bins', scheduledFor: '2026-11-02T08:00:00Z', variantIds: [PLANNING_VARIANT] },
      uuid()
    )
    await startCountPlan(db, claimsA, p.id, { expectedVersion: 1 }, uuid())
    const l0 = (await readCountPlan(db, claimsA, p.id)).lines[0]
    await submitCount(
      db,
      claimsA,
      p.id,
      { variantId: PLANNING_VARIANT, countedQuantity: 18, expectedLineVersion: l0.version },
      uuid()
    )
    const l1 = (await readCountPlan(db, claimsB, p.id)).lines[0]
    await decideCountLine(
      db,
      claimsB,
      p.id,
      {
        variantId: PLANNING_VARIANT,
        expectedLineVersion: l1.version,
        decision: 'approve',
        note: 'Diferencia confirmada',
        rootCause: 'picking_error'
      },
      uuid()
    )
    const bal = sqlite
      .prepare('SELECT physical_quantity p FROM inventory_balances WHERE variant_id=?')
      .get(PLANNING_VARIANT) as { p: number }
    expect(bal.p).toBe(18)
    const report = await readPickConsistency(db, PLANNING_VARIANT)
    expect(report.items[0]).toMatchObject({
      physicalQuantity: 18,
      locatedQuantity: 20,
      consistent: false
    })
  })
})
