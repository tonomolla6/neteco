/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  closeScanTaskShort,
  createScanTask,
  listScanTasks,
  readScanTask,
  scanBarcode
} from '../../workers/fulfillment/warehouse-barcode-validation'
import {
  PLANNING_VARIANT,
  addVariant,
  claimsA,
  claimsNoRole,
  openPlanningFixture,
  uuid
} from '../support/inventory-planning-fixture'

let sqlite: DatabaseSync
let db: D1Database
beforeEach(async () => {
  ;({ sqlite, database: db } = await openPlanningFixture())
  addVariant(sqlite, { sku: 'SKU-B', ean: '8437009999990', physical: 10 })
})
afterEach(() => sqlite.close())

const EAN_A = '8437001234567'
const EAN_B = '8437009999990'
const newTask = (stage = 'receiving') =>
  createScanTask(
    db,
    claimsA,
    {
      stage,
      reference: 'ALB-1001',
      lines: [
        { sku: 'SYNTHETIC-SKU', quantity: 3 },
        { sku: 'SKU-B', quantity: 2 }
      ]
    },
    uuid()
  )
const events = () => sqlite.prepare('SELECT * FROM warehouse_scan_events ORDER BY created_at, rowid').all() as any[]
const lineQty = async (taskId: string, sku: string) =>
  ((await readScanTask(db, claimsA, taskId)).lines as any[]).find((l) => l.sku === sku)

describe('INV-018 scan tasks', () => {
  it('creates receiving, picking and packing tasks from explicit lines', async () => {
    for (const stage of ['receiving', 'picking', 'packing']) {
      expect(await newTask(stage)).toMatchObject({ stage, status: 'open', version: 1, lines: 2 })
    }
    expect((await listScanTasks(db, claimsA, { stage: 'picking' })).length).toBe(1)
  })
  it('builds picking/packing tasks from an order and rejects unknown orders', async () => {
    sqlite.exec('PRAGMA foreign_keys = OFF')
    sqlite.exec(`INSERT INTO order_lines(order_id,line_index,variant_id,sku,name,quantity,unit_gross_cents,net_cents,tax_cents,gross_cents,tax_rate_basis_points,price_version_id,location_id,created_at)
      VALUES('ord-1',0,'${PLANNING_VARIANT}','SYNTHETIC-SKU','x',2,100,166,34,200,2100,'pv','main','2026-01-01T00:00:00Z')`)
    sqlite.exec('PRAGMA foreign_keys = ON')
    const t = await createScanTask(db, claimsA, { stage: 'picking', orderId: 'ord-1' }, uuid())
    expect((await readScanTask(db, claimsA, t.id)).lines).toEqual([
      { variantId: PLANNING_VARIANT, sku: 'SYNTHETIC-SKU', expectedQuantity: 2, scannedQuantity: 0 }
    ])
    await expect(createScanTask(db, claimsA, { stage: 'packing', orderId: 'nope' }, uuid())).rejects.toMatchObject({
      code: 'not_found'
    })
    await expect(createScanTask(db, claimsA, { stage: 'receiving', orderId: 'ord-1' }, uuid())).rejects.toMatchObject({
      code: 'invalid_input'
    })
  })
  it('rejects duplicate/unknown SKUs, empty lines and replays the same command', async () => {
    const bad = (lines: unknown) =>
      createScanTask(db, claimsA, { stage: 'receiving', reference: 'ALB-2', lines }, uuid())
    await expect(
      bad([
        { sku: 'SKU-B', quantity: 1 },
        { sku: 'SKU-B', quantity: 1 }
      ])
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(bad([{ sku: 'NOPE', quantity: 1 }])).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(bad([])).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(bad([{ sku: 'SKU-B', quantity: 0 }])).rejects.toMatchObject({ code: 'invalid_input' })
    const cmd = uuid()
    const input = { stage: 'receiving', reference: 'ALB-3', lines: [{ sku: 'SKU-B', quantity: 1 }] }
    const a = await createScanTask(db, claimsA, input, cmd)
    expect(await createScanTask(db, claimsA, input, cmd)).toEqual(a)
    expect(sqlite.prepare('SELECT count(*) n FROM warehouse_scan_tasks').get()!.n).toBe(1)
  })
  it('requires inventory permission', async () => {
    await expect(
      createScanTask(
        db,
        claimsNoRole,
        { stage: 'receiving', reference: 'AB', lines: [{ sku: 'SKU-B', quantity: 1 }] },
        uuid()
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('INV-018 barcode scanning', () => {
  it('validates the barcode against the task line and tracks quantity until completion', async () => {
    const t = await newTask('picking')
    const one = await scanBarcode(db, claimsA, t.id, { barcode: EAN_A, quantity: 2 }, uuid())
    expect(one).toMatchObject({
      outcome: 'accepted',
      sku: 'SYNTHETIC-SKU',
      scannedQuantity: 2,
      remainingQuantity: 1,
      taskStatus: 'open'
    })
    await scanBarcode(db, claimsA, t.id, { barcode: EAN_A }, uuid())
    const last = await scanBarcode(db, claimsA, t.id, { barcode: EAN_B, quantity: 2 }, uuid())
    expect(last).toMatchObject({ outcome: 'accepted', remainingQuantity: 0, taskStatus: 'completed' })
    const detail = await readScanTask(db, claimsA, t.id)
    expect(detail).toMatchObject({ status: 'completed', metrics: { accepted: 3, rejected: 0, exceptions: 0 } })
    await expect(scanBarcode(db, claimsA, t.id, { barcode: EAN_A }, uuid())).rejects.toMatchObject({
      code: 'invalid_state'
    })
  })
  it('rejects unknown barcodes, lines outside the task and over-quantity, recording each attempt', async () => {
    const t = await newTask()
    addVariant(sqlite, { sku: 'STRAY', ean: '8437000000017' })
    expect(await scanBarcode(db, claimsA, t.id, { barcode: '0000000000000' }, uuid())).toMatchObject({
      outcome: 'rejected',
      code: 'barcode_unknown'
    })
    expect(await scanBarcode(db, claimsA, t.id, { barcode: '8437000000017' }, uuid())).toMatchObject({
      outcome: 'rejected',
      code: 'sku_not_in_task',
      sku: 'STRAY'
    })
    expect(await scanBarcode(db, claimsA, t.id, { barcode: EAN_A, quantity: 4 }, uuid())).toMatchObject({
      outcome: 'rejected',
      code: 'quantity_exceeds_expected',
      remainingQuantity: 3
    })
    expect(await lineQty(t.id, 'SYNTHETIC-SKU')).toMatchObject({ scannedQuantity: 0 })
    expect((await readScanTask(db, claimsA, t.id)).metrics).toMatchObject({ rejected: 3, accepted: 0 })
  })
  it('does not accept a bare SKU as a barcode outside exception mode', async () => {
    const t = await newTask()
    expect(await scanBarcode(db, claimsA, t.id, { barcode: 'SKU-B' }, uuid())).toMatchObject({
      outcome: 'rejected',
      code: 'barcode_unknown'
    })
  })
  it('exception mode accepts a typed SKU with reason and note, but never over-quantity', async () => {
    const t = await newTask()
    const exception = { reason: 'barcode_unreadable', note: 'Etiqueta rota en el palet' }
    const r = await scanBarcode(db, claimsA, t.id, { barcode: 'SKU-B', quantity: 1, exception }, uuid())
    expect(r).toMatchObject({ outcome: 'exception', sku: 'SKU-B', scannedQuantity: 1 })
    expect(events().at(-1)).toMatchObject({
      outcome: 'exception',
      exception_note: exception.note,
      reason_code: 'barcode_unreadable'
    })
    expect(await scanBarcode(db, claimsA, t.id, { barcode: 'SKU-B', quantity: 5, exception }, uuid())).toMatchObject({
      outcome: 'rejected',
      code: 'quantity_exceeds_expected'
    })
    await expect(
      scanBarcode(
        db,
        claimsA,
        t.id,
        { barcode: 'SKU-B', exception: { reason: 'barcode_unreadable', note: 'corto' } },
        uuid()
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('validates input shape', async () => {
    const t = await newTask()
    for (const bad of [
      { barcode: '' },
      { barcode: 'a b' },
      { barcode: EAN_A, quantity: 0 },
      { barcode: EAN_A, quantity: 1.5 },
      { barcode: EAN_A, x: 1 },
      { barcode: 'x'.repeat(65) }
    ]) {
      await expect(scanBarcode(db, claimsA, t.id, bad, uuid())).rejects.toMatchObject({ code: 'invalid_input' })
    }
    await expect(scanBarcode(db, claimsA, t.id, { barcode: EAN_A }, 'bad')).rejects.toMatchObject({
      code: 'invalid_input'
    })
    await expect(scanBarcode(db, claimsA, uuid(), { barcode: EAN_A }, uuid())).rejects.toMatchObject({
      code: 'not_found'
    })
  })
  it('is idempotent per command id and detects payload reuse', async () => {
    const t = await newTask()
    const cmd = uuid()
    const a = await scanBarcode(db, claimsA, t.id, { barcode: EAN_A }, cmd)
    expect(await scanBarcode(db, claimsA, t.id, { barcode: EAN_A }, cmd)).toEqual(a)
    expect(await lineQty(t.id, 'SYNTHETIC-SKU')).toMatchObject({ scannedQuantity: 1 })
    await expect(scanBarcode(db, claimsA, t.id, { barcode: EAN_B }, cmd)).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
    const rej = await scanBarcode(db, claimsA, t.id, { barcode: '0000000000000' }, uuid())
    expect(rej.outcome).toBe('rejected')
  })
  it('keeps the scan log append-only and the quantity monotonic and bounded by the schema', async () => {
    const t = await newTask()
    await scanBarcode(db, claimsA, t.id, { barcode: EAN_A }, uuid())
    expect(() => sqlite.exec('DELETE FROM warehouse_scan_events')).toThrow(/immutable/)
    expect(() => sqlite.exec('UPDATE warehouse_scan_events SET quantity=2')).toThrow(/immutable/)
    expect(() => sqlite.exec('UPDATE warehouse_scan_task_lines SET scanned_quantity=0, version=version+1')).toThrow()
    expect(() => sqlite.exec('UPDATE warehouse_scan_task_lines SET scanned_quantity=99, version=version+1')).toThrow()
  })
  it('never moves stock: scanning does not touch balances or the ledger', async () => {
    const t = await newTask()
    const before = sqlite.prepare('SELECT count(*) n, sum(physical_delta) s FROM inventory_movements').get()
    await scanBarcode(db, claimsA, t.id, { barcode: EAN_A }, uuid())
    expect(sqlite.prepare('SELECT count(*) n, sum(physical_delta) s FROM inventory_movements').get()).toEqual(before)
  })
  it('requires a live permission before and after reading the task', async () => {
    const t = await newTask()
    await expect(scanBarcode(db, claimsNoRole, t.id, { barcode: EAN_A }, uuid())).rejects.toMatchObject({
      code: 'forbidden'
    })
    await expect(readScanTask(db, claimsNoRole, t.id)).rejects.toMatchObject({ code: 'forbidden' })
    sqlite.exec(`DELETE FROM identity_roles WHERE identity_id='${claimsA.identityId}'`)
    await expect(scanBarcode(db, claimsA, t.id, { barcode: EAN_A }, uuid())).rejects.toMatchObject({
      code: 'forbidden'
    })
  })
})

describe('INV-018 closing short', () => {
  it('closes a task with shortages only with a justified exception and CAS', async () => {
    const t = await newTask()
    await scanBarcode(db, claimsA, t.id, { barcode: EAN_A, quantity: 3 }, uuid())
    const note = 'Proveedor entregó solo 3 de 5 unidades'
    await expect(
      closeScanTaskShort(db, claimsA, t.id, { expectedVersion: 1, note: 'corto' }, uuid())
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(closeScanTaskShort(db, claimsA, t.id, { expectedVersion: 7, note }, uuid())).rejects.toMatchObject({
      code: 'version_conflict'
    })
    const cmd = uuid()
    const done = await closeScanTaskShort(db, claimsA, t.id, { expectedVersion: 1, note }, cmd)
    expect(done).toMatchObject({ status: 'completed_with_exceptions', shortages: [{ sku: 'SKU-B', missing: 2 }] })
    expect(await closeScanTaskShort(db, claimsA, t.id, { expectedVersion: 1, note }, cmd)).toEqual(done)
    await expect(closeScanTaskShort(db, claimsA, t.id, { expectedVersion: 2, note }, uuid())).rejects.toMatchObject({
      code: 'invalid_state'
    })
    await expect(scanBarcode(db, claimsA, t.id, { barcode: EAN_B }, uuid())).rejects.toMatchObject({
      code: 'invalid_state'
    })
  })
  it('refuses to close a fully scanned task as short', async () => {
    const t = await createScanTask(
      db,
      claimsA,
      { stage: 'packing', reference: 'PACK-1', lines: [{ sku: 'SKU-B', quantity: 1 }] },
      uuid()
    )
    await scanBarcode(db, claimsA, t.id, { barcode: EAN_B }, uuid())
    await expect(
      closeScanTaskShort(db, claimsA, t.id, { expectedVersion: 2, note: 'Cierre injustificado' }, uuid())
    ).rejects.toMatchObject({ code: 'invalid_state' })
  })
})

describe('INV-018 concurrency', () => {
  it('a concurrent scan on the same line makes the stale scan fail without double counting', async () => {
    const t = await newTask()
    const real = db.batch.bind(db)
    ;(db as any).batch = async (stmts: any[]) => {
      sqlite
        .prepare(
          'UPDATE warehouse_scan_task_lines SET scanned_quantity=scanned_quantity+1, version=version+1 WHERE variant_id=?'
        )
        .run(PLANNING_VARIANT)
      return real(stmts)
    }
    await expect(scanBarcode(db, claimsA, t.id, { barcode: EAN_A }, uuid())).rejects.toMatchObject({
      code: 'version_conflict'
    })
    ;(db as any).batch = real
    expect((await readScanTask(db, claimsA, t.id)).lines.find((l: any) => l.sku === 'SYNTHETIC-SKU')).toMatchObject({
      scannedQuantity: 1
    })
    expect((await readScanTask(db, claimsA, t.id)).metrics).toMatchObject({ accepted: 0 })
  })
})
