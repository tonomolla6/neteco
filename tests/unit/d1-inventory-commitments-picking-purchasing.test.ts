import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import {
  openAdminInventoryFixture,
  INVENTORY_FIXTURE_ACTOR,
  INVENTORY_FIXTURE_SESSION,
  INVENTORY_FIXTURE_VARIANT
} from '../support/admin-inventory-fixture'
import { deterministicUuid } from '../fixtures/deterministic'
import {
  executeInventoryOpsCommand,
  listCommitments,
  listPickLocations,
  planPick,
  readPickConsistency,
  listPurchaseOrders,
  readPurchaseOrder,
  InventoryOpsError
} from '../../workers/catalog/inventory-commitments-picking-purchasing'
import { lineDiscrepancy, maxCumulativeReceipt } from '../../shared/inventory-commitments-picking-purchasing'
import { reconcileInventory, expireExpiredReservations } from '../../workers/catalog/inventory'

const claims = { identityId: INVENTORY_FIXTURE_ACTOR, sessionId: INVENTORY_FIXTURE_SESSION, sessionVersion: 1 }
const NOW = '2026-10-29T12:00:00Z'
const clock = { now: () => NOW }
const V = INVENTORY_FIXTURE_VARIANT
const SUPPLIER = deterministicUuid('supplier')
const CUSTOMER = deterministicUuid('customer')
let n = 0
const id = (label = 'x') => deterministicUuid(`${label}-${++n}`)
const plusDays = (days: number) => new Date(Date.parse(NOW) + days * 86400000).toISOString().replace('.000Z', 'Z')

let sqlite: DatabaseSync
let database: D1Database
const run = (
  action: Parameters<typeof executeInventoryOpsCommand>[2],
  target: string,
  input: unknown,
  cmd = id('cmd')
) => executeInventoryOpsCommand(database, claims, action, target, input, cmd, clock)
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    if (error instanceof InventoryOpsError) return error.code
    throw error
  }
  return 'no_error'
}
const row = <T = Record<string, unknown>>(sql: string, ...args: (string | number)[]) =>
  sqlite.prepare(sql).get(...args) as T

beforeEach(async () => {
  n = 0
  ;({ sqlite, database } = await openAdminInventoryFixture())
  sqlite.exec(
    await readFile(
      new URL('../../db/d1/migrations/0139_inventory_commitments_picking_purchasing.sql', import.meta.url),
      'utf8'
    )
  )
  sqlite.exec(`INSERT INTO catalog_suppliers(id,code,name,currency,created_at,updated_at)
      VALUES('${SUPPLIER}','SUP-1','Proveedor Uno','EUR','${NOW}','${NOW}');
    INSERT INTO customers(id,name,phone,status,created_at,updated_at)
      VALUES('${CUSTOMER}','Cliente Contrato',NULL,'active','${NOW}','${NOW}');`)
})
afterEach(() => sqlite.close())

describe('shared rules', () => {
  it('classifies discrepancies', () => {
    expect(lineDiscrepancy({ expectedQuantity: 10, receivedQuantity: 0, rejectedQuantity: 0 })).toBe('pending')
    expect(lineDiscrepancy({ expectedQuantity: 10, receivedQuantity: 10, rejectedQuantity: 0 })).toBe('none')
    expect(lineDiscrepancy({ expectedQuantity: 10, receivedQuantity: 8, rejectedQuantity: 0 })).toBe('short')
    expect(lineDiscrepancy({ expectedQuantity: 10, receivedQuantity: 11, rejectedQuantity: 0 })).toBe('over')
    expect(lineDiscrepancy({ expectedQuantity: 10, receivedQuantity: 9, rejectedQuantity: 1 })).toBe('rejected')
    expect(maxCumulativeReceipt(10)).toBe(11)
    expect(maxCumulativeReceipt(3)).toBe(4)
  })
})

describe('INV-014 contract commitments', () => {
  const create = (overrides: Record<string, unknown> = {}, target = id('commitment'), cmd = id('cmd')) =>
    run(
      'create_commitment',
      target,
      {
        variantId: V,
        customerId: CUSTOMER,
        contractRef: 'CONTRATO-2026-001',
        quantity: 5,
        expiresAt: plusDays(30),
        maxRenewals: 1,
        reason: 'Contrato anual limpieza',
        ...overrides
      },
      cmd
    )
  const sellable = () =>
    row<{ s: number }>(
      `SELECT max(0, b.physical_quantity - b.blocked_quantity - 2 - COALESCE((SELECT SUM(l.quantity) FROM inventory_reservation_lines l JOIN inventory_reservations r ON r.id=l.reservation_id WHERE r.status='reserved' AND l.variant_id=b.variant_id),0)) AS s FROM inventory_balances b WHERE variant_id=?`,
      V
    ).s

  it('creates a commitment backed by a real reservation that lowers sellable stock', async () => {
    expect(sellable()).toBe(17)
    const target = id('commitment')
    const receipt = await create({}, target)
    expect(receipt.data).toMatchObject({ commitmentId: target, quantity: 5, status: 'active' })
    expect(sellable()).toBe(12)
    const movement = row<{ reserved_delta: number; movement_type: string }>(
      "SELECT movement_type, reserved_delta FROM inventory_movements WHERE movement_type='reserve'"
    )
    expect(movement).toMatchObject({ movement_type: 'reserve', reserved_delta: 5 })
    expect((await reconcileInventory(database)).violations).toEqual([])
  })

  it('lists commitments with contract, customer, expiry and visible status', async () => {
    const target = id('commitment')
    await create({}, target)
    const items = await listCommitments(database, {}, NOW)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: target,
      contractRef: 'CONTRATO-2026-001',
      customerId: CUSTOMER,
      quantity: 5,
      status: 'active',
      expiringSoon: false,
      renewalsRemaining: 1,
      version: 1
    })
    expect(await listCommitments(database, { customerId: id('other') }, NOW)).toEqual([])
    expect(await listCommitments(database, { status: 'released' }, NOW)).toEqual([])
  })

  it('flags commitments expiring within 7 days', async () => {
    await create({ expiresAt: plusDays(3) })
    expect((await listCommitments(database, {}, NOW))[0]!.expiringSoon).toBe(true)
  })

  it('is idempotent per command id and rejects a different payload', async () => {
    const target = id('commitment')
    const cmd = id('cmd')
    const first = await create({}, target, cmd)
    const again = await create({}, target, cmd)
    expect(again).toEqual(first)
    expect(sellable()).toBe(12)
    expect(row<{ c: number }>('SELECT count(*) c FROM inventory_contract_commitments').c).toBe(1)
    expect(await codeOf(create({ quantity: 6 }, target, cmd))).toBe('idempotency_payload_mismatch')
  })

  it('rejects quantity above sellable stock', async () => {
    expect(await codeOf(create({ quantity: 18 }))).toBe('insufficient_stock')
    expect(sellable()).toBe(17)
    expect(row<{ c: number }>('SELECT count(*) c FROM inventory_contract_commitments').c).toBe(0)
  })

  it('rejects past, too-far and invalid terms', async () => {
    expect(await codeOf(create({ expiresAt: NOW }))).toBe('commitment_term_invalid')
    expect(await codeOf(create({ expiresAt: plusDays(400) }))).toBe('commitment_term_invalid')
    expect(await codeOf(create({ quantity: 0 }))).toBe('invalid_input')
    expect(await codeOf(create({ contractRef: 'ab' }))).toBe('invalid_input')
    expect(await codeOf(create({ unknown: 1 }))).toBe('invalid_input')
    expect(await codeOf(create({ variantId: id('nope') }))).toBe('variant_not_found')
  })

  it('does not allow committing beyond backorder: backorder variants still need stock', async () => {
    sqlite.exec(`UPDATE variants SET backorder_allowed=1 WHERE id='${V}'`)
    expect(await codeOf(create({ quantity: 18 }))).toBe('insufficient_stock')
  })

  it('renews with CAS, exhausts renewals and keeps the reservation in sync', async () => {
    const target = id('commitment')
    await create({}, target)
    const renewed = await run('renew_commitment', target, {
      expectedVersion: 1,
      expiresAt: plusDays(60),
      reason: 'Renovación pactada'
    })
    expect(renewed.resultVersion).toBe(2)
    const reservation = row<{ expires_at: string; renewed_at: string }>(
      'SELECT expires_at, renewed_at FROM inventory_reservations'
    )
    expect(reservation.expires_at).toBe(plusDays(60))
    expect(reservation.renewed_at).toBe(NOW)
    expect(
      await codeOf(run('renew_commitment', target, { expectedVersion: 2, expiresAt: plusDays(90), reason: 'Otra más' }))
    ).toBe('commitment_renewals_exhausted')
  })

  it('renew rejects stale version, earlier or too-far expiry', async () => {
    const target = id('commitment')
    await create({ maxRenewals: 3 }, target)
    const renew = (v: number, expiresAt: string) =>
      run('renew_commitment', target, { expectedVersion: v, expiresAt, reason: 'Renovación pactada' })
    expect(await codeOf(renew(7, plusDays(60)))).toBe('concurrency_conflict')
    expect(await codeOf(renew(1, plusDays(10)))).toBe('commitment_term_invalid')
    expect(await codeOf(renew(1, plusDays(500)))).toBe('commitment_term_invalid')
    expect(
      await codeOf(
        run('renew_commitment', id('missing'), { expectedVersion: 1, expiresAt: plusDays(60), reason: 'Renovación' })
      )
    ).toBe('not_found')
  })

  it('releases with CAS, appends a release movement and frees stock', async () => {
    const target = id('commitment')
    await create({}, target)
    expect(await codeOf(run('release_commitment', target, { expectedVersion: 9, reason: 'Contrato cancelado' }))).toBe(
      'concurrency_conflict'
    )
    expect(sellable()).toBe(12)
    const released = await run('release_commitment', target, { expectedVersion: 1, reason: 'Contrato cancelado' })
    expect(released.data).toMatchObject({ status: 'released' })
    expect(sellable()).toBe(17)
    expect(row<{ c: number }>("SELECT count(*) c FROM inventory_movements WHERE movement_type='release'").c).toBe(1)
    expect((await listCommitments(database, {}, NOW))[0]).toMatchObject({
      status: 'released',
      releaseReason: 'Contrato cancelado'
    })
    expect((await reconcileInventory(database)).violations).toEqual([])
    expect(await codeOf(run('release_commitment', target, { expectedVersion: 2, reason: 'Segunda vez' }))).toBe(
      'commitment_not_active'
    )
    expect(
      await codeOf(
        run('renew_commitment', target, { expectedVersion: 2, expiresAt: plusDays(60), reason: 'Ya liberado' })
      )
    ).toBe('commitment_not_active')
  })

  it('shows expired status once the reservation expiry sweep ran and frees stock', async () => {
    await create({ expiresAt: plusDays(1) })
    await expireExpiredReservations(database, { at: plusDays(2), correlationId: 'sweep' })
    expect((await listCommitments(database, {}, plusDays(2)))[0]!.status).toBe('expired')
    expect(sellable()).toBe(17)
  })

  it('journal and movements are append-only', async () => {
    await create()
    expect(() => sqlite.exec('DELETE FROM inventory_ops_commands')).toThrow(/immutable/)
    expect(() => sqlite.exec("UPDATE inventory_ops_commands SET action='x'")).toThrow(/immutable/)
    expect(() => sqlite.exec('DELETE FROM inventory_contract_commitments')).toThrow(/permanent/)
  })
})

describe('INV-015 picking locations in the single warehouse', () => {
  const loc = async (code: string, extra: Record<string, unknown> = {}) => {
    const target = id('pick')
    await run('create_pick_location', target, { code, zone: 'A', kind: 'pick', pickSequence: 10, ...extra })
    return target
  }
  const putaway = (pickLocationId: string, quantity: number, expectedVersion = 0) =>
    run('putaway', id('movement'), { variantId: V, pickLocationId, quantity, expectedVersion })

  it('creates pick locations bound to the only active warehouse and lists them', async () => {
    const a = await loc('a-01')
    const items = await listPickLocations(database, {})
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: a,
      code: 'A-01',
      warehouseLocationId: 'main',
      active: true,
      stockUnits: 0,
      version: 1
    })
  })

  it('rejects duplicate codes, bad codes and unknown fields', async () => {
    await loc('A-01')
    expect(await codeOf(loc('a-01'))).toBe('duplicate_pick_location')
    expect(await codeOf(loc('a b'))).toBe('invalid_input')
    expect(await codeOf(loc('A-02', { kind: 'truck' }))).toBe('invalid_input')
    expect(await codeOf(loc('A-03', { warehouse: 'x' }))).toBe('invalid_input')
  })

  it('refuses pick locations when there is no single active warehouse', async () => {
    sqlite.exec(
      "INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES('second','SECOND','Otro','warehouse',1,'2020-01-01T00:00:00Z')"
    )
    expect(await codeOf(loc('A-01'))).toBe('single_warehouse_required')
  })

  it('puts stock away with CAS and never exceeds physical stock', async () => {
    const a = await loc('A-01')
    await putaway(a, 15)
    expect(
      row<{ quantity: number; version: number }>('SELECT quantity, version FROM inventory_pick_stock').quantity
    ).toBe(15)
    expect(await codeOf(putaway(a, 6, 1))).toBe('pick_stock_exceeds_physical')
    expect(await codeOf(putaway(a, 1, 0))).toBe('concurrency_conflict')
    await putaway(a, 5, 1)
    expect(row<{ quantity: number; version: number }>('SELECT quantity, version FROM inventory_pick_stock')).toEqual({
      quantity: 20,
      version: 2
    })
    expect(row<{ c: number }>('SELECT count(*) c FROM inventory_pick_movements').c).toBe(2)
  })

  it('enforces capacity and active bins', async () => {
    const a = await loc('A-01', { capacityUnits: 10 })
    expect(await codeOf(putaway(a, 11))).toBe('pick_location_capacity_exceeded')
    await putaway(a, 10)
    expect(await codeOf(putaway(a, 1, 1))).toBe('pick_location_capacity_exceeded')
    const b = await loc('B-01')
    await run('update_pick_location', b, { expectedVersion: 1, active: false })
    expect(await codeOf(putaway(b, 1))).toBe('pick_location_inactive')
  })

  it('relocates between bins of the same warehouse with CAS on both sides', async () => {
    const a = await loc('A-01')
    const b = await loc('B-01')
    await putaway(a, 10)
    const move = (qty: number, fromV: number, toV: number) =>
      run('relocate', id('movement'), {
        variantId: V,
        fromPickLocationId: a,
        toPickLocationId: b,
        quantity: qty,
        expectedFromVersion: fromV,
        expectedToVersion: toV
      })
    expect(await codeOf(move(11, 1, 0))).toBe('pick_stock_insufficient')
    expect(await codeOf(move(4, 5, 0))).toBe('concurrency_conflict')
    await move(4, 1, 0)
    const stock = sqlite
      .prepare('SELECT pick_location_id p, quantity q FROM inventory_pick_stock ORDER BY quantity')
      .all() as { p: string; q: number }[]
    expect(stock.map((s) => s.q)).toEqual([4, 6])
    expect(row<{ s: number }>('SELECT sum(quantity) s FROM inventory_pick_stock').s).toBe(10)
    expect(row<{ p: number }>('SELECT physical_quantity p FROM inventory_balances').p).toBe(20)
  })

  it('confirms picks removing located stock only and keeps ledger reconcilable', async () => {
    const a = await loc('A-01')
    await putaway(a, 10)
    await run('confirm_pick', id('movement'), {
      variantId: V,
      pickLocationId: a,
      quantity: 3,
      expectedVersion: 1,
      reference: 'ORDER-123'
    })
    expect(row<{ quantity: number }>('SELECT quantity FROM inventory_pick_stock').quantity).toBe(7)
    expect(
      await codeOf(
        run('confirm_pick', id('movement'), {
          variantId: V,
          pickLocationId: a,
          quantity: 8,
          expectedVersion: 2,
          reference: 'ORDER-124'
        })
      )
    ).toBe('pick_stock_insufficient')
    expect((await reconcileInventory(database)).violations).toEqual([])
  })

  it('cannot deactivate a bin that still holds stock', async () => {
    const a = await loc('A-01')
    await putaway(a, 2)
    expect(await codeOf(run('update_pick_location', a, { expectedVersion: 1, active: false }))).toBe(
      'pick_location_not_empty'
    )
    await run('update_pick_location', a, { expectedVersion: 1, pickSequence: 3, capacityUnits: 50 })
    expect((await listPickLocations(database, {}))[0]).toMatchObject({ pickSequence: 3, capacityUnits: 50, version: 2 })
    expect(await codeOf(run('update_pick_location', a, { expectedVersion: 1, pickSequence: 4 }))).toBe(
      'concurrency_conflict'
    )
  })

  it('forbids transfer movements at the database level', () => {
    expect(() =>
      sqlite.exec(`INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,reference_id,idempotency_key,correlation_id,created_at)
        VALUES('t1','${V}','main','transfer_in',1,0,'x',NULL,'t1','c','${NOW}')`)
    ).toThrow(/single_warehouse_no_transfers/)
  })

  it('plans picks by pick sequence from pick bins only and reports shortfall', async () => {
    const far = await loc('Z-09', { pickSequence: 90 })
    const near = await loc('A-01', { pickSequence: 1 })
    const bulk = await loc('BULK-1', { kind: 'bulk', pickSequence: 0 })
    await putaway(near, 4)
    await putaway(far, 6)
    await putaway(bulk, 5)
    const plan = await planPick(database, V, 8)
    expect(plan.allocations.map((x) => [x.code, x.quantity])).toEqual([
      ['A-01', 4],
      ['Z-09', 4]
    ])
    expect(plan.shortfall).toBe(0)
    const big = await planPick(database, V, 12)
    expect(big.shortfall).toBe(2)
  })

  it('reports consistency: physical, reserved, sellable, located and unlocated', async () => {
    const a = await loc('A-01')
    await putaway(a, 8)
    await run('create_commitment', id('c'), {
      variantId: V,
      contractRef: 'CONTRATO-9',
      quantity: 4,
      expiresAt: plusDays(10),
      reason: 'Reserva contrato'
    })
    const report = await readPickConsistency(database, V)
    expect(report.items[0]).toMatchObject({
      variantId: V,
      physicalQuantity: 20,
      blockedQuantity: 1,
      reservedQuantity: 4,
      sellableQuantity: 13,
      locatedQuantity: 8,
      unlocatedQuantity: 12,
      consistent: true
    })
  })

  it('flags inconsistency when physical drops below located stock', async () => {
    const a = await loc('A-01')
    await putaway(a, 8)
    sqlite.exec(`UPDATE inventory_balances SET physical_quantity=5`)
    const report = await readPickConsistency(database, V)
    expect(report.items[0]).toMatchObject({ consistent: false, unlocatedQuantity: -3 })
  })
})

describe('INV-016 purchase orders and receipts', () => {
  const orderLines = [{ variantId: V, expectedQuantity: 10, unitCostCents: 250 }]
  const createPo = (overrides: Record<string, unknown> = {}, target = id('po'), cmd = id('cmd')) =>
    run(
      'create_purchase_order',
      target,
      { supplierId: SUPPLIER, poNumber: 'PO-2026-001', lines: orderLines, ...overrides },
      cmd
    )
  let lastPo = ''
  const submitted = async () => {
    const po = id('po')
    lastPo = po
    await createPo({}, po)
    await run('submit_purchase_order', po, { expectedVersion: 1 })
    return po
  }
  const doc = (n = 1) => ({
    kind: 'delivery_note',
    reference: `ALB-${n}`,
    sha256: String(n).padStart(64, 'a'),
    sizeBytes: 1000,
    mediaType: 'application/pdf'
  })

  it('creates a draft PO with supplier, expected quantities and cost total', async () => {
    const po = id('po')
    const receipt = await createPo({ expectedAt: plusDays(7), notes: 'Entrega en muelle' }, po)
    expect(receipt.data).toMatchObject({ purchaseOrderId: po, status: 'draft', totalCostCents: 2500 })
    const detail = await readPurchaseOrder(database, po)
    expect(detail).toMatchObject({
      id: po,
      supplierId: SUPPLIER,
      supplierName: 'Proveedor Uno',
      status: 'draft',
      currency: 'EUR',
      totalCostCents: 2500,
      receivedCostCents: 0
    })
    expect(detail!.lines[0]).toMatchObject({
      lineIndex: 0,
      variantId: V,
      expectedQuantity: 10,
      receivedQuantity: 0,
      discrepancy: 'pending'
    })
  })

  it('validates POs: supplier, variant, duplicates and numbers', async () => {
    expect(await codeOf(createPo({ supplierId: id('s') }))).toBe('supplier_not_found')
    sqlite.exec(`UPDATE catalog_suppliers SET is_active=0`)
    expect(await codeOf(createPo())).toBe('supplier_not_found')
    sqlite.exec(`UPDATE catalog_suppliers SET is_active=1`)
    expect(await codeOf(createPo({ lines: [{ variantId: id('v'), expectedQuantity: 1, unitCostCents: 1 }] }))).toBe(
      'variant_not_found'
    )
    expect(await codeOf(createPo({ lines: [] }))).toBe('invalid_input')
    expect(await codeOf(createPo({ lines: [...orderLines, ...orderLines] }))).toBe('invalid_input')
    expect(await codeOf(createPo({ lines: [{ variantId: V, expectedQuantity: 0, unitCostCents: 1 }] }))).toBe(
      'invalid_input'
    )
    expect(await codeOf(createPo({ lines: [{ variantId: V, expectedQuantity: 1, unitCostCents: -1 }] }))).toBe(
      'invalid_input'
    )
    await createPo()
    expect(await codeOf(createPo())).toBe('duplicate_po_number')
  })

  it('is idempotent on create and rejects payload mismatch', async () => {
    const po = id('po')
    const cmd = id('cmd')
    const a = await createPo({}, po, cmd)
    expect(await createPo({}, po, cmd)).toEqual(a)
    expect(row<{ c: number }>('SELECT count(*) c FROM purchase_orders').c).toBe(1)
    expect(await codeOf(createPo({ poNumber: 'PO-OTHER' }, po, cmd))).toBe('idempotency_payload_mismatch')
  })

  it('submits and cancels with CAS and state rules', async () => {
    const po = id('po')
    await createPo({}, po)
    expect(await codeOf(run('submit_purchase_order', po, { expectedVersion: 4 }))).toBe('concurrency_conflict')
    await run('submit_purchase_order', po, { expectedVersion: 1 })
    expect(await codeOf(run('submit_purchase_order', po, { expectedVersion: 2 }))).toBe('purchase_order_state_invalid')
    const cancelled = await run('cancel_purchase_order', po, { expectedVersion: 2, reason: 'Proveedor sin stock' })
    expect(cancelled.data).toMatchObject({ status: 'cancelled' })
    expect(await codeOf(run('cancel_purchase_order', po, { expectedVersion: 3, reason: 'Otra vez' }))).toBe(
      'purchase_order_state_invalid'
    )
    expect(await codeOf(run('submit_purchase_order', id('missing'), { expectedVersion: 1 }))).toBe('not_found')
  })

  it('refuses receipts on draft or cancelled POs', async () => {
    const po = id('po')
    await createPo({}, po)
    expect(
      await codeOf(
        run('record_receipt', id('receipt'), {
          purchaseOrderId: po,
          expectedVersion: 1,
          receiptNumber: 'REC-001',
          receivedAt: NOW,
          lines: [{ lineIndex: 0, receivedQuantity: 1 }]
        })
      )
    ).toBe('purchase_order_state_invalid')
  })

  it('records a full receipt: ledger movement, balance CAS bump, costs and documents', async () => {
    const po = await submitted()
    const before = row<{ physical_quantity: number; version: number }>(
      'SELECT physical_quantity, version FROM inventory_balances'
    )
    const target = id('receipt')
    const r = await run('record_receipt', target, {
      purchaseOrderId: lastPo,
      expectedVersion: 2,
      receiptNumber: 'REC-001',
      receivedAt: NOW,
      lines: [{ lineIndex: 0, receivedQuantity: 10 }],
      documents: [doc(1)]
    })
    expect(r.data).toMatchObject({ receiptId: target, status: 'received', discrepancies: [] })
    const after = row<{ physical_quantity: number; version: number }>(
      'SELECT physical_quantity, version FROM inventory_balances'
    )
    expect(after.physical_quantity).toBe(before.physical_quantity + 10)
    expect(after.version).toBe(before.version + 1)
    const movement = row<{
      movement_type: string
      physical_delta: number
      reference_type: string
      reference_id: string
    }>("SELECT * FROM inventory_movements WHERE movement_type='receipt'")
    expect(movement).toMatchObject({ physical_delta: 10, reference_type: 'purchase_receipt', reference_id: target })
    const detail = await readPurchaseOrder(database, po)
    expect(detail).toMatchObject({ status: 'received', receivedCostCents: 2500, version: 3 })
    expect(detail!.receipts).toHaveLength(1)
    expect(detail!.receipts[0]!.lines[0]).toMatchObject({ receivedQuantity: 10, unitCostCents: 250 })
    expect(detail!.documents).toMatchObject([{ kind: 'delivery_note', reference: 'ALB-1', receiptId: target }])
    expect((await reconcileInventory(database)).violations).toEqual([])
  })

  it('handles partial, short and rejected quantities as discrepancies', async () => {
    const po = await submitted()
    const r1 = await run('record_receipt', id('receipt'), {
      purchaseOrderId: lastPo,
      expectedVersion: 2,
      receiptNumber: 'REC-001',
      receivedAt: NOW,
      lines: [{ lineIndex: 0, receivedQuantity: 6, rejectedQuantity: 1 }]
    })
    expect(r1.data).toMatchObject({ status: 'partially_received' })
    expect((r1.data as { discrepancies: unknown[] }).discrepancies).toEqual([
      expect.objectContaining({
        lineIndex: 0,
        kind: 'rejected',
        expectedQuantity: 10,
        receivedQuantity: 6,
        rejectedQuantity: 1
      })
    ])
    const detail = await readPurchaseOrder(database, po)
    expect(detail!.lines[0]).toMatchObject({
      receivedQuantity: 6,
      rejectedQuantity: 1,
      discrepancy: 'rejected',
      openQuantity: 4
    })
    expect(detail!.summary).toMatchObject({
      expectedUnits: 10,
      receivedUnits: 6,
      rejectedUnits: 1,
      hasDiscrepancy: true
    })
    await run('record_receipt', id('receipt'), {
      purchaseOrderId: lastPo,
      expectedVersion: 3,
      receiptNumber: 'REC-002',
      receivedAt: NOW,
      lines: [{ lineIndex: 0, receivedQuantity: 4 }]
    })
    expect((await readPurchaseOrder(database, po))!.status).toBe('received')
    expect(
      row<{ s: number }>("SELECT sum(physical_delta) s FROM inventory_movements WHERE movement_type='receipt'").s
    ).toBe(10)
  })

  it('tolerates limited over-delivery and flags it; larger overages are rejected atomically', async () => {
    const po = await submitted()
    expect(
      await codeOf(
        run('record_receipt', id('receipt'), {
          purchaseOrderId: lastPo,
          expectedVersion: 2,
          receiptNumber: 'REC-001',
          receivedAt: NOW,
          lines: [{ lineIndex: 0, receivedQuantity: 12 }]
        })
      )
    ).toBe('over_receipt_exceeds_tolerance')
    expect(row<{ c: number }>('SELECT count(*) c FROM purchase_receipts').c).toBe(0)
    expect((await readPurchaseOrder(database, po))!.version).toBe(2)
    const r = await run('record_receipt', id('receipt'), {
      purchaseOrderId: lastPo,
      expectedVersion: 2,
      receiptNumber: 'REC-002',
      receivedAt: NOW,
      lines: [{ lineIndex: 0, receivedQuantity: 11 }]
    })
    expect((r.data as { discrepancies: { kind: string }[] }).discrepancies[0]!.kind).toBe('over')
  })

  it('rejects stale PO version without touching stock (CAS)', async () => {
    const po = await submitted()
    await run('record_receipt', id('receipt'), {
      purchaseOrderId: lastPo,
      expectedVersion: 2,
      receiptNumber: 'REC-001',
      receivedAt: NOW,
      lines: [{ lineIndex: 0, receivedQuantity: 5 }]
    })
    const physical = row<{ p: number }>('SELECT physical_quantity p FROM inventory_balances').p
    expect(
      await codeOf(
        run('record_receipt', id('receipt'), {
          purchaseOrderId: lastPo,
          expectedVersion: 2,
          receiptNumber: 'REC-002',
          receivedAt: NOW,
          lines: [{ lineIndex: 0, receivedQuantity: 5 }]
        })
      )
    ).toBe('concurrency_conflict')
    expect(row<{ p: number }>('SELECT physical_quantity p FROM inventory_balances').p).toBe(physical)
    expect((await readPurchaseOrder(database, po))!.lines[0]!.receivedQuantity).toBe(5)
  })

  it('rejects unknown lines, duplicate receipt numbers and empty lines', async () => {
    await submitted()
    expect(
      await codeOf(
        run('record_receipt', id('receipt'), {
          purchaseOrderId: lastPo,
          expectedVersion: 2,
          receiptNumber: 'REC-001',
          receivedAt: NOW,
          lines: [{ lineIndex: 5, receivedQuantity: 1 }]
        })
      )
    ).toBe('receipt_line_not_found')
    expect(
      await codeOf(
        run('record_receipt', id('receipt'), {
          purchaseOrderId: lastPo,
          expectedVersion: 2,
          receiptNumber: 'REC-001',
          receivedAt: NOW,
          lines: [{ lineIndex: 0, receivedQuantity: 0 }]
        })
      )
    ).toBe('invalid_input')
    expect(
      await codeOf(
        run('record_receipt', id('receipt'), {
          purchaseOrderId: lastPo,
          expectedVersion: 2,
          receiptNumber: 'REC-001',
          receivedAt: NOW,
          lines: [
            { lineIndex: 0, receivedQuantity: 1 },
            { lineIndex: 0, receivedQuantity: 1 }
          ]
        })
      )
    ).toBe('invalid_input')
    await run('record_receipt', id('receipt'), {
      purchaseOrderId: lastPo,
      expectedVersion: 2,
      receiptNumber: 'REC-001',
      receivedAt: NOW,
      lines: [{ lineIndex: 0, receivedQuantity: 1 }]
    })
    expect(
      await codeOf(
        run('record_receipt', id('receipt'), {
          purchaseOrderId: lastPo,
          expectedVersion: 3,
          receiptNumber: 'REC-001',
          receivedAt: NOW,
          lines: [{ lineIndex: 0, receivedQuantity: 1 }]
        })
      )
    ).toBe('duplicate_receipt_number')
  })

  it('receipt is idempotent per command id', async () => {
    await submitted()
    const target = id('receipt')
    const cmd = id('cmd')
    const body = {
      purchaseOrderId: lastPo,
      expectedVersion: 2,
      receiptNumber: 'REC-001',
      receivedAt: NOW,
      lines: [{ lineIndex: 0, receivedQuantity: 5 }]
    }
    const a = await run('record_receipt', target, body, cmd)
    const b = await run('record_receipt', target, body, cmd)
    expect(b).toEqual(a)
    expect(
      row<{ s: number }>("SELECT sum(physical_delta) s FROM inventory_movements WHERE movement_type='receipt'").s
    ).toBe(5)
  })

  it('can put received goods straight into a pick location', async () => {
    await submitted()
    const bin = id('pick')
    await run('create_pick_location', bin, { code: 'RECV-1', zone: 'R', kind: 'receiving', pickSequence: 0 })
    await run('record_receipt', id('receipt'), {
      purchaseOrderId: lastPo,
      expectedVersion: 2,
      receiptNumber: 'REC-001',
      receivedAt: NOW,
      lines: [{ lineIndex: 0, receivedQuantity: 10, pickLocationId: bin }]
    })
    expect(row<{ quantity: number }>('SELECT quantity FROM inventory_pick_stock').quantity).toBe(10)
    expect(row<{ kind: string }>('SELECT kind FROM inventory_pick_movements').kind).toBe('receipt_putaway')
    expect((await readPickConsistency(database, V)).items[0]).toMatchObject({ locatedQuantity: 10, consistent: true })
  })

  it('attaches receipt documents later, once per hash', async () => {
    const po = await submitted()
    const docId = id('doc')
    await run('attach_document', docId, { purchaseOrderId: po, ...doc(7) })
    expect((await readPurchaseOrder(database, po))!.documents).toHaveLength(1)
    expect(await codeOf(run('attach_document', id('doc'), { purchaseOrderId: po, ...doc(7) }))).toBe(
      'duplicate_document'
    )
    expect(await codeOf(run('attach_document', id('doc'), { purchaseOrderId: id('nope'), ...doc(8) }))).toBe(
      'not_found'
    )
    expect(
      await codeOf(run('attach_document', id('doc'), { purchaseOrderId: po, ...doc(9), mediaType: 'text/html' }))
    ).toBe('invalid_input')
    expect(await codeOf(run('attach_document', id('doc'), { purchaseOrderId: po, ...doc(10), sha256: 'xyz' }))).toBe(
      'invalid_input'
    )
  })

  it('lists POs by status and supplier with discrepancy flag', async () => {
    const po = await submitted()
    await createPo({ poNumber: 'PO-DRAFT' })
    await run('record_receipt', id('receipt'), {
      purchaseOrderId: lastPo,
      expectedVersion: 2,
      receiptNumber: 'REC-001',
      receivedAt: NOW,
      lines: [{ lineIndex: 0, receivedQuantity: 4 }]
    })
    expect((await listPurchaseOrders(database, {})).map((x) => x.poNumber).sort()).toEqual(['PO-2026-001', 'PO-DRAFT'])
    const partial = await listPurchaseOrders(database, { status: 'partially_received' })
    expect(partial).toHaveLength(1)
    expect(partial[0]).toMatchObject({ id: po, hasDiscrepancy: false, expectedUnits: 10, receivedUnits: 4 })
    expect(await listPurchaseOrders(database, { supplierId: id('s') })).toEqual([])
  })

  it('closes a partially received PO and then flags the shortfall as discrepancy', async () => {
    const po = await submitted()
    expect(await codeOf(run('close_purchase_order', po, { expectedVersion: 2, reason: 'Sin recepcion' }))).toBe(
      'purchase_order_state_invalid'
    )
    await run('record_receipt', id('receipt'), {
      purchaseOrderId: po,
      expectedVersion: 2,
      receiptNumber: 'REC-001',
      receivedAt: NOW,
      lines: [{ lineIndex: 0, receivedQuantity: 7 }]
    })
    expect((await readPurchaseOrder(database, po))!.summary.hasDiscrepancy).toBe(false)
    const closed = await run('close_purchase_order', po, {
      expectedVersion: 3,
      reason: 'Proveedor no entregara el resto'
    })
    expect(closed.data).toMatchObject({ status: 'closed' })
    const detail = await readPurchaseOrder(database, po)
    expect(detail!.lines[0]).toMatchObject({ discrepancy: 'short', openQuantity: 3 })
    expect(detail!.summary.hasDiscrepancy).toBe(true)
    expect(
      await codeOf(
        run('record_receipt', id('receipt'), {
          purchaseOrderId: po,
          expectedVersion: 4,
          receiptNumber: 'REC-002',
          receivedAt: NOW,
          lines: [{ lineIndex: 0, receivedQuantity: 1 }]
        })
      )
    ).toBe('purchase_order_state_invalid')
  })

  it('receipts, lines and documents are append-only', async () => {
    await submitted()
    await run('record_receipt', id('receipt'), {
      purchaseOrderId: lastPo,
      expectedVersion: 2,
      receiptNumber: 'REC-001',
      receivedAt: NOW,
      lines: [{ lineIndex: 0, receivedQuantity: 3 }],
      documents: [doc(1)]
    })
    expect(() => sqlite.exec('DELETE FROM purchase_receipts')).toThrow(/immutable/)
    expect(() => sqlite.exec('UPDATE purchase_receipt_lines SET received_quantity=99')).toThrow(/immutable/)
    expect(() => sqlite.exec('DELETE FROM purchase_documents')).toThrow(/immutable/)
    expect(() => sqlite.exec('UPDATE purchase_order_lines SET expected_quantity=99')).toThrow(/frozen/)
    expect(() => sqlite.exec('DELETE FROM purchase_orders')).toThrow(/permanent/)
  })
})

describe('concurrency (CAS) across the three capabilities', () => {
  it('two receipts racing on the same PO version: exactly one wins and stock is received once', async () => {
    const po = id('po')
    await run('create_purchase_order', po, {
      supplierId: SUPPLIER,
      poNumber: 'PO-RACE',
      lines: [{ variantId: V, expectedQuantity: 10, unitCostCents: 100 }]
    })
    await run('submit_purchase_order', po, { expectedVersion: 1 })
    const before = row<{ p: number }>('SELECT physical_quantity p FROM inventory_balances').p
    const attempt = (number: string) =>
      run('record_receipt', id('receipt'), {
        purchaseOrderId: po,
        expectedVersion: 2,
        receiptNumber: number,
        receivedAt: NOW,
        lines: [{ lineIndex: 0, receivedQuantity: 4 }]
      }).then(
        () => 'ok',
        (e: InventoryOpsError) => e.code
      )
    const outcomes = await Promise.all([attempt('REC-A'), attempt('REC-B')])
    expect(outcomes.sort()).toEqual(['concurrency_conflict', 'ok'])
    expect(row<{ p: number }>('SELECT physical_quantity p FROM inventory_balances').p).toBe(before + 4)
    expect(row<{ c: number }>('SELECT count(*) c FROM purchase_receipts').c).toBe(1)
    expect((await reconcileInventory(database)).violations).toEqual([])
  })

  it('two putaways racing on the same stock version: one wins', async () => {
    const bin = id('pick')
    await run('create_pick_location', bin, { code: 'A-01', zone: 'A', pickSequence: 1 })
    await run('putaway', id('m'), { variantId: V, pickLocationId: bin, quantity: 5, expectedVersion: 0 })
    const attempt = () =>
      run('putaway', id('m'), { variantId: V, pickLocationId: bin, quantity: 3, expectedVersion: 1 }).then(
        () => 'ok',
        (e: InventoryOpsError) => e.code
      )
    expect((await Promise.all([attempt(), attempt()])).sort()).toEqual(['concurrency_conflict', 'ok'])
    expect(row<{ q: number }>('SELECT quantity q FROM inventory_pick_stock').q).toBe(8)
  })

  it('two releases and a renewal racing on one commitment leave one consistent outcome', async () => {
    const target = id('c')
    await run('create_commitment', target, {
      variantId: V,
      contractRef: 'CONTRATO-RACE',
      quantity: 5,
      expiresAt: plusDays(30),
      maxRenewals: 2,
      reason: 'Carrera'
    })
    const release = () =>
      run('release_commitment', target, { expectedVersion: 1, reason: 'Liberar ya' }).then(
        () => 'ok',
        (e: InventoryOpsError) => e.code
      )
    const renew = () =>
      run('renew_commitment', target, { expectedVersion: 1, expiresAt: plusDays(60), reason: 'Renovar ya' }).then(
        () => 'ok',
        (e: InventoryOpsError) => e.code
      )
    const outcomes = await Promise.all([release(), release(), renew()])
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1)
    expect((await reconcileInventory(database)).violations).toEqual([])
  })
})
